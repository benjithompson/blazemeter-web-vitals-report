// E3 (issue #45) — canvas timeline, lazy drill-downs, local-time labels.
//
// What is pinned:
//   - the speed-ups change no answer: percentiles by selection equal the
//     pinned sorted method; the one-pass Route aggregation equals the
//     per-metric walk; the exclude-failed view derived from the included
//     one's timeline tallies deep-equals one built from scratch; the lazily
//     built drill-down fields are real (accessors until first read);
//   - every drill-down level is emitted EMPTY in 'lazy' mode and filled on
//     its first expand — Route, Test, Engine, and an Engine's Navigation rows
//     NAV_CHUNK at a time;
//   - the timeline reads in the viewer's local time zone, names the zone on
//     the axis, and the UTC toggle re-reads it (Chromium with an emulated
//     America/New_York zone);
//   - the plain points are painted on the canvas, crisp at devicePixelRatio
//     2, and hovering one shows that Navigation's tooltip.
// The 200k-Sample budgets (DOM size at first paint, toggle time) are in
// report-scale.test.ts, next to E1's.
//
// The browser cases skip with a reason when no Chromium is installed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metric } from 'bzm-vitals-format';
import {
  aggregateRoutes,
  excludeFailedExecutions,
  joinOutcomes,
  markColdStarts,
  percentile,
  percentiles,
  routeOf,
  NOT_CARRIED,
  type MetricAggregate,
} from '../src/aggregate.js';
import type { AttributedOutcome, AttributedSample } from '../src/attribute.js';
import { assembleReportData, type ReportData } from '../src/report.js';
import { renderHtml } from '../src/render.js';
import {
  drillContentHtml,
  engineBodyHtml,
  NAV_CHUNK,
  pointTip,
  tickText,
  timelineHtml,
  zoneLabel,
} from '../src/browser/views.js';
import { UI_STRINGS as S } from '../src/ui-strings.js';
import { buildReportVariants, buildView, seriesColumns, testKeyFor } from '../src/view-model.js';
import { syntheticEngines } from './helpers/synthetic.js';
import { appState, chromium, haveChromium, openReport, warnNoChromium, type Browser, type Page } from './helpers/browser.js';

warnNoChromium('timeline-canvas.test.ts');

// ---------------------------------------------------------------- fixture

// 2026-11-07T16:46:40.000Z — 11:46:40 EST in New York, 22:16:40 IST.
const T0 = 1794070000000;
const BIG = NAV_CHUNK + 110; // one Engine's Navigations on /checkout: more than one chunk

const tid = (repeat: number, title = 'checkout') => ({
  file: 'shop.spec.ts',
  title,
  project: 'chromium',
  repeat,
  worker: repeat % 2,
});
const failedRepeat = (repeat: number): boolean => repeat % 7 === 6;

function sample(
  sessionId: string,
  repeat: number,
  url: string,
  ts: number,
  title = 'checkout',
): AttributedSample {
  const failed = failedRepeat(repeat);
  const vitals: Record<string, Metric> = {
    lcp: { value: 1500 + ((repeat * 37) % 2000) + (failed ? 1500 : 0), status: 'ok' },
    cls: repeat % 5 === 0 ? { value: null, status: 'unsupported' } : { value: (repeat % 9) / 100, status: 'ok' },
    // INP is measured ONLY on failed Executions: the excluded view keeps the
    // metric (as no-interaction) with zero ok points — the re-tally path.
    inp: failed ? { value: 120 + repeat, status: 'ok' } : { value: null, status: 'no-interaction' },
  };
  // TTFB is carried by some Samples only — not-carried, never 0.
  if (repeat % 3 === 0) vitals['ttfb'] = { value: 90 + repeat, status: 'ok' };
  return {
    masterId: '90000045',
    sessionId,
    locationId: 'us-west-1',
    engineLabel: sessionId === 'r-v4-e3-a' ? 'us-west-1 #1' : 'us-west-1 #2',
    provenance: 'collector',
    sample: {
      schemaVersion: 1,
      ts,
      url,
      test: tid(repeat, title),
      navigationIndex: 0,
      vitals,
      navigation: { domContentLoadedMs: 800, loadEventMs: 1200 },
      context: { workers: 2, resourceCount: 10, requestCount: 12, failedRequests: 0 },
    },
  };
}

/** Engine A: BIG Navigations of Test "checkout" on /checkout (one Test, one
 *  Engine there — so its Test and Engine open by default), and Test "browse"
 *  on /cart. Engine B: a few of each Test on /cart, so /cart is blended and
 *  multi-Engine. 1 in 7 Executions failed. */
function fixture(): ReportData {
  const raw: AttributedSample[] = [];
  const outcomes: AttributedOutcome[] = [];
  for (let r = 0; r < BIG; r++) {
    raw.push(sample('r-v4-e3-a', r, `https://shop.example.com/checkout?step=${r}`, T0 + r * 100));
    outcomes.push({ sessionId: 'r-v4-e3-a', outcome: { schemaVersion: 1, test: tid(r), status: failedRepeat(r) ? 'failed' : 'passed', retry: 0 } });
  }
  for (let r = 0; r < 20; r++) {
    raw.push(sample('r-v4-e3-a', 1000 + r, 'https://shop.example.com/cart', T0 + 50 + r * 2000, 'browse'));
    outcomes.push({ sessionId: 'r-v4-e3-a', outcome: { schemaVersion: 1, test: tid(1000 + r, 'browse'), status: failedRepeat(1000 + r) ? 'failed' : 'passed', retry: 0 } });
    raw.push(sample('r-v4-e3-b', r, 'https://shop.example.com/cart', T0 + 75 + r * 2000));
    raw.push(sample('r-v4-e3-b', 500 + r, 'https://shop.example.com/cart', T0 + 80 + r * 2000, 'browse'));
    outcomes.push({ sessionId: 'r-v4-e3-b', outcome: { schemaVersion: 1, test: tid(r), status: failedRepeat(r) ? 'failed' : 'passed', retry: 0 } });
    outcomes.push({ sessionId: 'r-v4-e3-b', outcome: { schemaVersion: 1, test: tid(500 + r, 'browse'), status: failedRepeat(500 + r) ? 'failed' : 'passed', retry: 0 } });
  }
  const samples = joinOutcomes(markColdStarts(raw), outcomes);
  const session = (sessionId: string, engineLabel: string) => ({
    sessionId,
    locationId: 'us-west-1',
    status: 'ENDED',
    engineLabel,
    artifact: 'present' as const,
    sampleCount: samples.filter((s) => s.sessionId === sessionId).length,
    outcomeCount: outcomes.filter((o) => o.sessionId === sessionId).length,
    unreadable: [],
  });
  return {
    masterId: '90000045',
    reportName: 'E3 fixture',
    generatedAt: '2026-11-07T00:00:00.000Z',
    sessions: [session('r-v4-e3-a', 'us-west-1 #1'), session('r-v4-e3-b', 'us-west-1 #2')],
    routes: aggregateRoutes(samples),
    samples,
    outcomes,
  };
}

/** Plain JSON, as the drift guard compares it. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// ------------------------------------------------- the speed-ups change no answer

describe('E3 — the faster model gives the same answers', () => {
  it('percentiles by selection equal the pinned method: sorted[floor((n-1)q)], on any input', () => {
    let seed = 7;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const qs = [0, 0.05, 0.5, 0.75, 0.95, 0.99, 1];
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * (trial < 200 ? 40 : 5000));
      // Few distinct values (heavy ties), wide ranges, negatives, sorted and reversed runs.
      const kind = trial % 4;
      const values = Array.from({ length: n }, (_, i) =>
        kind === 0 ? Math.floor(rand() * 4) : kind === 1 ? rand() * 1e6 - 5e5 : kind === 2 ? i : n - i,
      );
      const sorted = [...values].sort((a, b) => a - b);
      const expected = qs.map((q) => sorted[Math.floor((n - 1) * q)]);
      expect(percentiles(values, qs)).toEqual(expected);
      expect(percentile(values, 0.75)).toBe(sorted[Math.floor((n - 1) * 0.75)]);
    }
    // The input is never reordered.
    const input = [5, 1, 4, 2, 3];
    percentiles(input, [0.5]);
    expect(input).toEqual([5, 1, 4, 2, 3]);
    expect(() => percentile([], 0.5)).toThrow(/zero values/);
  });

  it('the one-pass Route aggregation equals the per-metric walk it replaced', () => {
    // The pre-E3 algorithm, verbatim in spirit: per Route, per metric name
    // (first-seen order), one walk of the pool.
    function reference(samples: AttributedSample[]): Map<string, Record<string, MetricAggregate>> {
      const pools = new Map<string, AttributedSample[]>();
      for (const s of samples) {
        const r = routeOf(s.sample);
        pools.set(r, [...(pools.get(r) ?? []), s]);
      }
      const out = new Map<string, Record<string, MetricAggregate>>();
      for (const [route, pool] of pools) {
        const names = new Set<string>();
        for (const s of pool) for (const n of Object.keys(s.sample.vitals)) names.add(n);
        const metrics: Record<string, MetricAggregate> = {};
        for (const name of names) {
          const ok: number[] = [];
          const breakdown: Record<string, number> = {};
          for (const s of pool) {
            const m = s.sample.vitals[name];
            if (m === undefined) breakdown[NOT_CARRIED] = (breakdown[NOT_CARRIED] ?? 0) + 1;
            else if (m.status === 'ok' && typeof m.value === 'number') ok.push(m.value);
            else breakdown[m.status] = (breakdown[m.status] ?? 0) + 1;
          }
          const sorted = [...ok].sort((a, b) => a - b);
          const at = (q: number) => (ok.length > 0 ? sorted[Math.floor((ok.length - 1) * q)]! : null);
          const agg: MetricAggregate = { p50: at(0.5), p75: at(0.75), p95: at(0.95), ok: ok.length, total: pool.length, breakdown };
          if (ok.length === 0) {
            agg.reason = Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
          }
          metrics[name] = agg;
        }
        out.set(route, metrics);
      }
      return out;
    }
    const data = fixture();
    for (const samples of [data.samples, excludeFailedExecutions(data.samples)]) {
      const expected = reference(samples);
      const rows = aggregateRoutes(samples, { coldStartsPreMarked: true });
      expect(rows.map((r) => r.route).sort()).toEqual([...expected.keys()].sort());
      for (const row of rows) {
        expect(row.metrics).toEqual(expected.get(row.route));
        // Metric names keep their first-seen order.
        expect(Object.keys(row.metrics)).toEqual(Object.keys(expected.get(row.route)!));
      }
    }
  });

  it('the exclude-failed view, derived from the included one\'s timeline tallies, deep-equals one built from scratch', async () => {
    const big = await assembleReportData({ masterId: '90000045', reportName: null, engines: syntheticEngines(20_000) });
    for (const data of [fixture(), big]) {
      const variants = buildReportVariants(data); // included first: its tallies are cached
      const kept = excludeFailedExecutions(data.samples).slice(); // a fresh array: no cache hit
      const scratch = buildView(
        { ...data, samples: kept, routes: aggregateRoutes(kept, { coldStartsPreMarked: true }) },
        testKeyFor(data.samples),
      );
      expect(variants.excluded).not.toBeNull();
      expect(plain(variants.excluded)).toEqual(plain(scratch));
    }
    // The fixture's INP chart is the re-tally path: no ok point survives.
    const excluded = buildReportVariants(fixture()).excluded!;
    const inp = excluded.timeline.charts.find((c) => c.metric === 'inp')!;
    expect(inp.okCount).toBe(0);
    expect(inp.reason).toBe('no-interaction');
  });

  it('drill-down contents and timeline points are built when first READ — and are the same data', () => {
    const view = buildView(fixture());
    const route = view.routes[0]!;
    // Accessors until read…
    expect(typeof Object.getOwnPropertyDescriptor(route, 'tests')!.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(route, 'histograms')!.get).toBe('function');
    const series = view.timeline.charts[0]!.series[0]!;
    expect(typeof Object.getOwnPropertyDescriptor(series, 'points')!.get).toBe('function');
    // …data properties after, holding what was computed (memoized, not rebuilt).
    const tests = route.tests;
    expect(Object.getOwnPropertyDescriptor(route, 'tests')!.value).toBe(tests);
    expect(route.tests).toBe(tests);
    const engine = tests[0]!.engines[0]!;
    expect(typeof Object.getOwnPropertyDescriptor(engine, 'navigations')!.get).toBe('function');
    expect(engine.navigations).toHaveLength(engine.sampleCount);
    // The columns the canvas reads ARE the points.
    const cols = seriesColumns(series);
    expect([...cols.ts]).toEqual(series.points.map((p) => p.ts));
    expect([...cols.value]).toEqual(series.points.map((p) => p.value));
    series.points.forEach((p, i) => expect(cols.meta(i)).toEqual(p.meta));
    // And the key order is the eager one (JSON identical to a fully read copy).
    expect(Object.keys(route)).toEqual(['route', 'sampleCount', 'coldStarts', 'blended', 'testCount', 'cells', 'histograms', 'tests']);
  });
});

// ------------------------------------------------------ lazy drill-down markup

describe('E3 — every drill-down level is emitted empty, and filled on first expand', () => {
  const view = buildView(fixture());
  const checkout = view.routes.find((r) => r.route === '/checkout')!;
  const cart = view.routes.find((r) => r.route === '/cart')!;

  it('a Route with several Tests: each Test is a closed, empty <details data-lazy>', () => {
    expect(cart.tests.length).toBeGreaterThan(1);
    const html = drillContentHtml(cart, view.metricNames, 'lazy');
    const groups = [...html.matchAll(/<details class="test-group"[^>]*>/g)].map((m) => m[0]);
    expect(groups).toHaveLength(cart.tests.length);
    for (const g of groups) {
      expect(g).toContain('data-lazy=""');
      expect(g).not.toContain(' open');
    }
    // No Engine, no Navigation row is built until a Test is opened.
    expect(html).not.toContain('class="engine"');
    expect(html).not.toContain('<table class="navs">');
    // Eager mode (the tests' view of it) still fills every level.
    const eager = drillContentHtml(cart, view.metricNames, 'eager');
    expect(eager).not.toContain('data-lazy');
    expect(eager.match(/<tr><td class="num" title=/g)).toHaveLength(cart.sampleCount);
  });

  it('the only Test and only Engine open by default — filled at once — with the first NAV_CHUNK Navigations and a "show more"', () => {
    expect(checkout.tests).toHaveLength(1);
    const html = drillContentHtml(checkout, view.metricNames, 'lazy');
    expect(html).toMatch(/<details class="test-group"[^>]* open>/);
    expect(html).toMatch(/<details class="engine"[^>]* open>/);
    expect(html).not.toContain('data-lazy');
    expect(html.match(/<tr><td class="num" title=/g)).toHaveLength(NAV_CHUNK);
    expect(html).toContain(
      `<button class="more" data-shown="${NAV_CHUNK}">${S.showWord} ${BIG - NAV_CHUNK} ${S.moreOfWord} ${BIG} ${S.navigationsHeading}</button>`,
    );
    const engine = checkout.tests[0]!.engines[0]!;
    expect(engineBodyHtml(engine, view.metricNames, 'eager').match(/<tr><td class="num" title=/g)).toHaveLength(BIG);
    expect(engineBodyHtml(engine, view.metricNames, 'eager')).not.toContain('button class="more"');
  });
});

// ------------------------------------------------------------- time zones

describe('E3 — the timeline reads in a named time zone', () => {
  it('tick labels, the zone label and tooltips follow the zone; UTC reads exactly as the model', () => {
    expect(tickText(T0, 5_000, 'UTC')).toBe('16:46:40');
    expect(tickText(T0, 5_000, 'America/New_York')).toBe('11:46:40');
    expect(tickText(T0, 5_000, 'Asia/Kolkata')).toBe('22:16:40');
    expect(tickText(T0, 86_400_000, 'America/New_York')).toBe('11-07 11:46');
    expect(zoneLabel(T0, 'UTC')).toBe('UTC');
    expect(zoneLabel(T0, 'America/New_York')).toBe('EST');
    expect(zoneLabel(Date.parse('2026-07-01T12:00:00Z'), 'America/New_York')).toBe('EDT');
    expect(zoneLabel(T0, 'Asia/Kolkata')).toBe('GMT+5:30');

    const view = buildView(fixture());
    const chart = view.timeline.charts.find((c) => c.metric === 'lcp')!;
    const p = chart.series[0]!.points[0]!;
    expect(pointTip(chart, p)).toMatch(/^16:46:40\.000 UTC · /);
    expect(pointTip(chart, p, 'America/New_York')).toMatch(/^11:46:40\.000 EST · /);
    // The model's labels are the UTC reading; the renderer's UTC labels are them.
    const html = timelineHtml(view, 'UTC');
    for (const tick of view.timeline.axis!.ticks) expect(html).toContain(`>${tick.label}</text>`);
  });

  it('the section names the zone in force, beside the toggle, and on every chart\'s axis', () => {
    const view = buildView(fixture());
    const local = timelineHtml(view, 'America/New_York', 'America/New_York');
    expect(local).toContain(`<span class="tz-shown">${S.tzShownLocal} America/New_York</span>`);
    expect(local).toContain('<input type="checkbox" class="bzm-tz-utc">');
    const charts = view.timeline.charts.filter((c) => c.okCount > 0).length;
    expect(local.match(/<text class="tzlab"[^>]*>EST<\/text>/g)).toHaveLength(charts);
    const utc = timelineHtml(view, 'UTC', 'America/New_York');
    expect(utc).toContain(`<span class="tz-shown">${S.tzShownUtc}</span>`);
    expect(utc).toContain('<input type="checkbox" class="bzm-tz-utc" checked>');
    expect(utc.match(/<text class="tzlab"[^>]*>UTC<\/text>/g)).toHaveLength(charts);
  });

  it('each chart carries a text alternative: what, how many, over which span, p75, Cold Starts', () => {
    const view = buildView(fixture());
    const lcp = view.timeline.charts.findIndex((c) => c.metric === 'lcp');
    const chart = view.timeline.charts[lcp]!;
    const html = timelineHtml(view, 'America/New_York');
    const labels = [...html.matchAll(/<div class="tl-plot" role="img" aria-label="([^"]*)">/g)].map((m) => m[1]!);
    expect(labels).toHaveLength(view.timeline.charts.filter((c) => c.okCount > 0).length);
    const label = labels.find((l) => l.startsWith('LCP'))!;
    expect(label).toContain(`${S.timelineChartAria}: ${chart.okCount} ${S.ofWord} ${chart.total} ${S.samplesWord}`);
    expect(label).toContain(`${S.fromWord} 11:46:40.000 EST`);
    expect(label).toContain(`${S.p75} ${chart.p75!.toLocaleString('en-US')}\u2009ms`);
    expect(label).toContain(`${chart.coldStartCount} ${S.coldStartsSuffix}`);
    // The canvas and both svg layers are hidden from assistive tech: the box speaks.
    expect(html).toContain('<canvas class="tl-points" data-chart="');
    expect(html).not.toMatch(/<canvas(?![^>]*aria-hidden="true")/);
  });
});

// ------------------------------------------------------------ in the browser

describe.skipIf(!haveChromium)('E3 — in Chromium (America/New_York, devicePixelRatio 2)', () => {
  let browser: Browser;
  let dir: string;
  let data: ReportData;
  let html: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), 'bzm-e3-'));
    data = fixture();
    html = renderHtml(data);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(): Promise<Page> {
    const context = await browser.newContext({ timezoneId: 'America/New_York', deviceScaleFactor: 2 });
    const { page, errors } = await openReport(context, html, dir);
    expect(await appState(page)).toBe('ready');
    expect(errors).toEqual([]);
    return page;
  }

  it('the time-zone label is visible, local by default, and the UTC toggle re-reads the timeline', async () => {
    const page = await open();
    try {
      const section = page.locator('#bzm-variant-included section.timeline');
      await expect(section.locator('.tz-shown').textContent()).resolves.toBe(`${S.tzShownLocal} America/New_York`);
      const tzlab = section.locator('text.tzlab').first();
      await expect(tzlab.isVisible()).resolves.toBe(true);
      await expect(tzlab.textContent()).resolves.toBe('EST');
      const axis = data.samples.length > 0 ? buildView(data).timeline.axis! : null;
      const firstTick = axis!.ticks[0]!;
      await expect(section.locator('text.xlab').first().textContent()).resolves.toBe(
        tickText(firstTick.ts, axis!.stepMs, 'America/New_York'),
      );
      await expect(section.locator('.tl-plot').first().getAttribute('aria-label')).resolves.toContain('EST');

      // Flip to UTC: the axis, the zone label and the note all follow.
      await section.locator('input.bzm-tz-utc').check();
      const after = page.locator('#bzm-variant-included section.timeline');
      await expect(after.locator('.tz-shown').textContent()).resolves.toBe(S.tzShownUtc);
      await expect(after.locator('text.tzlab').first().textContent()).resolves.toBe('UTC');
      await expect(after.locator('text.xlab').first().textContent()).resolves.toBe(firstTick.label);
      await expect(after.locator('input.bzm-tz-utc').isChecked()).resolves.toBe(true);
      // The excluded variant, built after the flip, reads in UTC too.
      await page.locator('#bzm-include-failed').uncheck();
      const exc = page.locator('#bzm-variant-excluded section.timeline');
      await expect(exc.locator('text.tzlab').first().textContent()).resolves.toBe('UTC');
      // …and flipping back from there returns both to local time.
      await exc.locator('input.bzm-tz-utc').uncheck();
      await expect(exc.locator('text.tzlab').first().textContent()).resolves.toBe('EST');
      await page.locator('#bzm-include-failed').check();
      await expect(page.locator('#bzm-variant-included text.tzlab').first().textContent()).resolves.toBe('EST');
      await expect(page.locator('#bzm-variant-included input.bzm-tz-utc').isChecked()).resolves.toBe(false);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('the points are painted on a devicePixelRatio-sized canvas, and hovering one shows its Navigation\'s tooltip (local time)', async () => {
    const page = await open();
    try {
      const view = buildView(data);
      const chartIndex = view.timeline.charts.findIndex((c) => c.metric === 'lcp');
      const chart = view.timeline.charts[chartIndex]!;
      // A plain point (not a Cold Start diamond) well clear of its neighbours: the last one.
      const points = chart.series[0]!.points;
      const pointIndex = points.length - 1;
      const point = points[pointIndex]!;
      expect(point.meta?.coldStart).not.toBe(true);
      const probe = await page.evaluate(
        ({ chartIndex, pointIndex }) => {
          const v = window.bzmVitals!.variants.included;
          const chart = v.timeline.charts[chartIndex]!;
          const axis = v.timeline.axis!;
          const p = chart.series[0]!.points[pointIndex]!;
          const frac = axis.maxTs === axis.minTs ? 0.5 : (p.ts - axis.minTs) / (axis.maxTs - axis.minTs);
          const x = 56 + frac * (1240 - 56 - 14);
          const y = 12 + (1 - p.value / chart.yMax) * 120;
          const svg = document.querySelector(`#bzm-variant-included svg.tl-front[data-chart="${chartIndex}"]`) as SVGSVGElement;
          const canvas = document.querySelector(`#bzm-variant-included canvas[data-chart="${chartIndex}"]`) as HTMLCanvasElement;
          svg.scrollIntoView({ block: 'center' });
          const screen = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
          const box = canvas.getBoundingClientRect();
          const ctx = canvas.getContext('2d')!;
          const alphaAt = (cx: number, cy: number) =>
            ctx.getImageData(Math.round(((cx - box.left) / box.width) * canvas.width), Math.round(((cy - box.top) / box.height) * canvas.height), 1, 1).data[3]!;
          return {
            x: screen.x,
            y: screen.y,
            dpr: window.devicePixelRatio,
            cssWidth: box.width,
            width: canvas.width,
            alphaAtPoint: alphaAt(screen.x, screen.y),
            // The plot's top edge: above every value (yMax has 5% headroom), so unpainted.
            alphaAtTop: (() => {
              const top = new DOMPoint(x, 12).matrixTransform(svg.getScreenCTM()!);
              return alphaAt(top.x, top.y);
            })(),
          };
        },
        { chartIndex, pointIndex },
      );
      expect(probe.dpr).toBe(2);
      expect(probe.width).toBe(Math.round(probe.cssWidth * 2)); // crisp: device pixels, not css pixels
      expect(probe.alphaAtPoint).toBe(255);
      expect(probe.alphaAtTop).toBe(0);

      await page.mouse.move(probe.x, probe.y);
      const tip = page.locator('#bzm-tip');
      await expect(tip.isVisible()).resolves.toBe(true);
      expect(await tip.textContent()).toBe(pointTip(chart, point, 'America/New_York'));
      expect(await tip.textContent()).toMatch(/^\d\d:\d\d:\d\d\.\d{3} EST · /);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('drill-downs build level by level: Route, then Test, then Engine, then Navigation rows a chunk at a time', async () => {
    const page = await open();
    try {
      const view = buildView(data);
      const cartIndex = view.routes.findIndex((r) => r.route === '/cart');
      const checkoutIndex = view.routes.findIndex((r) => r.route === '/checkout');
      const app = page.locator('#bzm-app');
      const count = (sel: string) => app.locator(sel).count();
      // First paint: no Test, Engine or Navigation row anywhere.
      await expect(count('details.test-group')).resolves.toBe(0);
      await expect(count('table.navs tr')).resolves.toBe(0);

      // /cart: several Tests, each closed and empty.
      await page.locator(`button[aria-controls="drill-inc-${cartIndex}"]`).click();
      const cart = page.locator(`#drill-inc-${cartIndex}`);
      await expect(cart.locator('details.test-group[data-lazy]').count()).resolves.toBe(view.routes[cartIndex]!.tests.length);
      await expect(cart.locator('details.engine').count()).resolves.toBe(0);
      // Open one Test: its Engines appear, closed and empty.
      const group = cart.locator('details.test-group').first();
      await group.locator('summary').click();
      // The <details> toggle event is async: wait for the fill.
      await group.locator('details.engine').first().waitFor({ state: 'attached' });
      await expect(group.getAttribute('data-lazy')).resolves.toBeNull();
      const engines = view.routes[cartIndex]!.tests[0]!.engines.length;
      await expect(group.locator('details.engine[data-lazy]').count()).resolves.toBe(engines);
      await expect(group.locator('table.navs').count()).resolves.toBe(0);
      // Open one Engine: its Navigation rows.
      const engine = group.locator('details.engine').first();
      await engine.locator('summary').click();
      await engine.locator('table.navs').waitFor({ state: 'attached' });
      const rows =view.routes[cartIndex]!.tests[0]!.engines[0]!.navigations.length;
      await expect(engine.locator('table.navs tbody tr').count()).resolves.toBe(rows);

      // /checkout: its only Test and Engine open at once, NAV_CHUNK rows, then more.
      await page.locator(`button[aria-controls="drill-inc-${checkoutIndex}"]`).click();
      const checkout = page.locator(`#drill-inc-${checkoutIndex}`);
      await expect(checkout.locator('table.navs tbody tr').count()).resolves.toBe(NAV_CHUNK);
      await checkout.locator('button.more').click();
      await expect(checkout.locator('table.navs tbody tr').count()).resolves.toBe(BIG);
      await expect(checkout.locator('button.more').count()).resolves.toBe(0);
      // The rows are Node's rows, in order.
      const expected = engineBodyHtml(view.routes[checkoutIndex]!.tests[0]!.engines[0]!, view.metricNames, 'eager');
      const dom = await checkout.locator('details.engine').evaluate((d) => ({ rows: d.querySelector('tbody')!.innerHTML }));
      const expectedRows = await page.evaluate((markup) => {
        const t = document.createElement('template');
        t.innerHTML = markup;
        return t.content.querySelector('tbody')!.innerHTML;
      }, expected);
      expect(dom.rows).toBe(expectedRows);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
