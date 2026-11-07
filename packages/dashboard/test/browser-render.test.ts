// E1 (issue #43) — the report renders in the browser, from one embedded data
// blob, with the SAME view-model and markup code Node runs. What is pinned:
//   - THE DRIFT GUARD: the view the browser builds (window.bzmVitals) deep-
//     equals the one Node builds from the same ReportData — the included
//     variant at load, the excluded one after the toggle's first flip;
//   - the DOM is exactly the markup Node renders with the same functions
//     (test/helpers/rendered.ts), so the string assertions elsewhere
//     (outcome-toggle, report-scale) are assertions on the rendered report;
//   - one Test-key function, over the FULL Sample set, serves both variants:
//     group keys are stable across the toggle (D6), and a key's leading NUL
//     rides percent-encoded in the DOM;
//   - the fallbacks: no DecompressionStream, a corrupt blob, and JavaScript
//     off each leave the server-rendered p75 summary, with the reason stated;
//   - hovering a batched timeline point shows that Navigation's tooltip.
//
// The browser cases skip with a reason when no Chromium is installed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionStatus, TestIdentity } from 'bzm-vitals-format';
import { assembleReportData, type EngineRecords, type ReportData } from '../src/report.js';
import { renderHtml } from '../src/render.js';
import { domKey, drillContentHtml, excludedVariantHtml, pointTip } from '../src/browser/views.js';
import { UI_STRINGS as S } from '../src/ui-strings.js';
import { buildReportVariants } from '../src/view-model.js';
import { bundleBrowser } from '../scripts/build-browser.ts';
import { BLOB_RE, inlineScript } from './helpers/blob.js';
import { renderedHtml } from './helpers/rendered.js';
import { appState, chromium, haveChromium, openReport, warnNoChromium, type Browser, type Page } from './helpers/browser.js';

warnNoChromium('browser-render.test.ts');

// ---------------------------------------------------------------- fixture

let ts = 1794070000000;

function sampleJson(test: TestIdentity, url: string, lcp: number | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    ts: (ts += 1000),
    url,
    test,
    navigationIndex: 0,
    vitals: {
      ttfb: { value: 100 + (ts % 300), status: 'ok' },
      lcp: lcp === null ? { value: null, status: 'unsupported' } : { value: lcp, status: 'ok' },
      cls: { value: 0.02, status: 'ok' },
      inp: { value: null, status: 'no-interaction' },
    },
    navigation: { domContentLoadedMs: 800, loadEventMs: 1200 },
    context: { workers: 2, resourceCount: 10, requestCount: 12, failedRequests: 0 },
    ...extra,
  });
}

function outcomeJson(test: TestIdentity, status: ExecutionStatus): string {
  return JSON.stringify({ schemaVersion: 1, test, status, retry: 0 });
}

/** Two same-title Tests told apart only by id (D6); Test Z whose id appears
 *  ONLY on a failed Execution, plus an id-less (0.2.x) Sample of the same
 *  triple that passed — the shared-key case; a crashed Execution; a timed-out
 *  one; two Engines on one location, and one with no artifact. */
async function fixture(): Promise<ReportData> {
  const guest = (repeat: number, worker = 0): TestIdentity => ({
    file: 'checkout.spec.ts', title: 'pays', project: 'chromium', repeat, worker,
    id: 'guest-id', titlePath: ['Guest', 'pays'], path: 'guest/checkout.spec.ts',
  });
  const member = (repeat: number, worker = 1): TestIdentity => ({
    file: 'checkout.spec.ts', title: 'pays', project: 'chromium', repeat, worker,
    id: 'member-id', titlePath: ['Member', 'pays'], path: 'member/checkout.spec.ts',
  });
  const z = (repeat: number, withId: boolean): TestIdentity => ({
    file: 'z.spec.ts', title: 'z', project: 'chromium', repeat, worker: 0,
    ...(withId ? { id: 'z-id' } : {}),
  });
  const filesA = [
    ...[0, 1, 2, 3].flatMap((r) => [
      { name: `bzm-vitals-sample-g${r}a.json`, body: sampleJson(guest(r), 'https://shop.example.com/cart', 1800 + r * 150) },
      { name: `bzm-vitals-sample-g${r}b.json`, body: sampleJson(guest(r), 'https://shop.example.com/pay?x=1', 2400 + r * 300) },
    ]),
    ...[0, 1, 2, 3].map((r) => ({ name: `bzm-vitals-outcome-g${r}.json`, body: outcomeJson(guest(r), r === 3 ? 'failed' : 'passed') })),
    { name: 'bzm-vitals-sample-z0.json', body: sampleJson(z(0, true), 'https://shop.example.com/pay', 5200) },
    { name: 'bzm-vitals-outcome-z0.json', body: outcomeJson(z(0, true), 'failed') },
    { name: 'bzm-vitals-sample-z1.json', body: sampleJson(z(1, false), 'https://shop.example.com/pay', null) },
    { name: 'bzm-vitals-outcome-z1.json', body: outcomeJson(z(1, false), 'passed') },
  ];
  const filesB = [
    ...[0, 1, 2].flatMap((r) => [
      { name: `bzm-vitals-sample-m${r}a.json`, body: sampleJson(member(r), 'https://shop.example.com/cart', 2100 + r * 90) },
      { name: `bzm-vitals-sample-m${r}b.json`, body: sampleJson(member(r), 'https://shop.example.com/pay', 2900 + r * 120) },
    ]),
    { name: 'bzm-vitals-outcome-m0.json', body: outcomeJson(member(0), 'passed') },
    { name: 'bzm-vitals-outcome-m1.json', body: outcomeJson(member(1), 'timedOut') },
    // member repeat 2 has Samples but no Outcome → crashed before finishing.
  ];
  const engine = (sessionId: string, files: Array<{ name: string; body: string }>): EngineRecords => ({
    sessionId,
    locationId: 'us-west-1',
    status: 'ENDED',
    artifact: 'present',
    files: files.map((f) => ({ file: `${sessionId}/${f.name}`, read: async () => f.body })),
  });
  const data = await assembleReportData({
    masterId: '90000043',
    reportName: 'E1 fixture — "quotes" & <angles>',
    engines: [
      engine('r-v4-eng-a', filesA),
      engine('r-v4-eng-b', filesB),
      { sessionId: 'r-v4-eng-dead', locationId: 'us-west-2', status: 'ENDED', artifact: 'no-artifact', files: [] },
    ],
  });
  return { ...data, generatedAt: '2026-11-07T00:00:00.000Z' };
}

/** Plain JSON, as both sides compare it (undefined fields dropped alike). */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// -------------------------------------------------- Node-side guarantees

describe('E1 — one Test-key function serves both variants (D6 follow-up)', () => {
  it('a Test keeps its group key across the toggle, even when its only id-carrying Execution is excluded', async () => {
    const variants = buildReportVariants(await fixture());
    const keysOf = (view: typeof variants.included) =>
      view.routes.find((r) => r.route === '/pay')!.tests.map((t) => t.key).sort();
    const included = keysOf(variants.included);
    const excluded = keysOf(variants.excluded!);
    // z.spec.ts folds into z-id in BOTH variants. Built per variant (before
    // E1), the excluded pool no longer saw z-id and keyed it on its triple.
    expect(included).toContain('\u0000id\u0000z-id');
    expect(excluded).toContain('\u0000id\u0000z-id');
    expect(excluded.every((k) => included.includes(k))).toBe(true);
  });

  it('the key rides percent-encoded in the DOM — no NUL in any attribute', async () => {
    const html = renderedHtml(await fixture());
    expect(html).toContain('data-test-key="%00id%00z-id"');
    expect(html).not.toContain('\u0000');
    // Total and reversible: control characters and '%' only.
    expect(domKey('\u0000legacy')).toBe('%00legacy');
    expect(domKey('a%b\u001f\ud800')).toBe('a%25b%1f\ud800');
  });

  it('the inline script is the browser bundle of the CURRENT sources, and nothing else', async () => {
    const html = renderHtml(await fixture());
    expect(inlineScript(html)).toBe(await bundleBrowser());
    // Exactly two <script> elements: the data blob and the bundle.
    expect(html.match(/<script\b/g)).toHaveLength(2);
  });

  it('the browser bundle build FAILS on a node:* import — view-model.ts must stay isomorphic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bzm-e1-bundle-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n");
      await expect(bundleBrowser(entry)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the emitted file embeds the data once, compressed, and pre-renders no variant', async () => {
    const data = await fixture();
    const html = renderHtml(data);
    expect(html.match(new RegExp(BLOB_RE.source, 'g'))).toHaveLength(1);
    // The interactive report is rendered in the browser: neither variant's
    // container, nor a drill-down, nor a timeline is in the bytes' markup.
    const markup = html.replace(BLOB_RE, '').replace(/<script>[\s\S]*?<\/script>/, '');
    expect(markup).not.toContain('id="bzm-variant-');
    expect(markup).not.toContain('class="drill"');
    expect(markup).not.toContain('<section class="timeline">');
    // …but the fallback summary is: every Route, p75 with coverage.
    expect(markup).toContain('<table class="routes summary">');
    for (const route of data.routes) expect(markup).toContain(`<code>${route.route}</code>`);
    expect(markup).toContain(`<noscript><p class="status-note">${S.noscriptNote}</p></noscript>`);
  });
});

// ------------------------------------------------------------ in the browser

describe.skipIf(!haveChromium)('E1 — in Chromium: the browser renders what Node renders', () => {
  let browser: Browser;
  let dir: string;
  let data: ReportData;
  let html: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), 'bzm-e1-'));
    data = await fixture();
    html = renderHtml(data);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** innerHTML of `selector`, and `markup` parsed and re-serialized by the
   *  same browser — so the comparison is DOM-to-DOM, not quote style. */
  async function domVsMarkup(page: Page, selector: string, markup: string): Promise<{ dom: string; expected: string }> {
    return page.evaluate(
      ({ selector, markup }) => {
        const t = document.createElement('template');
        t.innerHTML = markup;
        const box = document.createElement('div');
        box.appendChild(t.content.cloneNode(true));
        return { dom: document.querySelector(selector)!.innerHTML, expected: box.innerHTML };
      },
      { selector, markup },
    );
  }

  it('THE DRIFT GUARD: the browser-built view deep-equals Node\'s — included at load, excluded after the toggle', async () => {
    const { page, errors } = await openReport(browser, html, dir);
    try {
      expect(await appState(page)).toBe('ready');
      const node = buildReportVariants(data);
      const inBrowser = async () =>
        JSON.parse(
          await page.evaluate(() => {
            const v = window.bzmVitals!.variants;
            return JSON.stringify({ outcomes: v.outcomes, included: v.included, excluded: v.excluded ?? 'not built' });
          }),
        ) as Record<string, unknown>;
      // At load: the excluded variant is not built yet — it is built on demand.
      const atLoad = await inBrowser();
      expect(atLoad['excluded']).toBe('not built');
      expect(atLoad['outcomes']).toEqual(plain(node.outcomes));
      expect(atLoad['included']).toEqual(plain(node.included));
      // The toggle's first flip builds it, from the same data and code.
      await page.locator('#bzm-include-failed').uncheck();
      const flipped = await inBrowser();
      expect(node.excluded).not.toBeNull();
      expect(flipped['excluded']).toEqual(plain(node.excluded));
      // And the browser's copy of the data IS the blob's.
      const blobData = JSON.parse(await page.evaluate(() => JSON.stringify(window.bzmVitals!.data)));
      expect(blobData).toEqual(plain(data));
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('the DOM is the markup Node renders: at load, after the toggle, and in a lazily built drill-down', async () => {
    const { page, errors } = await openReport(browser, html, dir);
    try {
      const variants = buildReportVariants(data);
      const atLoad = await domVsMarkup(page, '#bzm-app', renderedHtml(data, 'lazy'));
      expect(atLoad.dom).toBe(atLoad.expected);

      // The drill-down is built on first expand — with Node's markup.
      const btn = page.locator('#bzm-variant-included button.expand').first();
      expect(await btn.getAttribute('aria-controls')).toBe('drill-inc-0');
      await btn.click();
      const drill = await domVsMarkup(
        page,
        '#drill-inc-0 > td',
        drillContentHtml(variants.included.routes[0]!, variants.included.metricNames),
      );
      expect(drill.dom).toBe(drill.expected);
      expect(drill.dom).toContain('class="test-group"');
      await expect(page.locator('#drill-inc-0').isVisible()).resolves.toBe(true);
      await btn.click();
      await expect(page.locator('#drill-inc-0').isVisible()).resolves.toBe(false);

      // The excluded variant, recomputed in the browser on the first flip.
      await page.locator('#bzm-include-failed').uncheck();
      await expect(page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(true);
      await expect(page.locator('#bzm-variant-included').isVisible()).resolves.toBe(false);
      const excluded = await domVsMarkup(
        page,
        '#bzm-variant-excluded',
        excludedVariantHtml(variants.excluded!, variants.included, 'lazy'),
      );
      expect(excluded.dom).toBe(excluded.expected);
      expect(excluded.dom).toContain(S.excludedNote);
      // …and its drill-downs build lazily too.
      await page.locator('#bzm-variant-excluded button.expand').first().click();
      await expect(page.locator('#drill-exc-0 .test-group').first().isVisible()).resolves.toBe(true);
      await page.locator('#bzm-include-failed').check();
      await expect(page.locator('#bzm-variant-included').isVisible()).resolves.toBe(true);
      await expect(page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('hovering a batched timeline point shows that Navigation\'s tooltip', async () => {
    const { page } = await openReport(browser, html, dir);
    try {
      const view = buildReportVariants(data).included;
      const chartIndex = view.timeline.charts.findIndex((c) => c.metric === 'lcp');
      const chart = view.timeline.charts[chartIndex]!;
      // A plain (non-Cold-Start) point — those are batched, with no element of their own.
      const pointIndex = chart.series[0]!.points.findIndex((p) => p.meta?.coldStart !== true);
      const point = chart.series[0]!.points[pointIndex]!;
      const at = await page.evaluate(
        ({ chartIndex, pointIndex }) => {
          // Where the renderer put it: parse the batched paths' subpaths back out.
          const svg = document.querySelector(`#bzm-variant-included svg[data-chart="${chartIndex}"]`) as SVGSVGElement;
          const v = window.bzmVitals!.variants.included;
          const chart = v.timeline.charts[chartIndex]!;
          const axis = v.timeline.axis!;
          const p = chart.series[0]!.points[pointIndex]!;
          const frac = axis.maxTs === axis.minTs ? 0.5 : (p.ts - axis.minTs) / (axis.maxTs - axis.minTs);
          const x = 56 + frac * (1240 - 56 - 14);
          const y = 12 + (1 - p.value / chart.yMax) * 120;
          svg.scrollIntoView();
          const screen = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
          return { x: screen.x, y: screen.y };
        },
        { chartIndex, pointIndex },
      );
      await page.mouse.move(at.x, at.y);
      const tip = page.locator('#bzm-tip');
      await expect(tip.isVisible()).resolves.toBe(true);
      // The nearest point may be a coincident neighbour; it is always a point
      // of this chart, and with this fixture's spacing it is this one.
      expect(await tip.textContent()).toBe(pointTip(chart, point));
      await page.mouse.move(1, 1);
      await expect(tip.isVisible()).resolves.toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('without DecompressionStream: the p75 summary stays, and a note says why', async () => {
    const { page } = await openReport(browser, html, dir, {
      before: (p) =>
        p.addInitScript(() => {
          delete (window as unknown as { DecompressionStream?: unknown }).DecompressionStream;
        }),
    });
    try {
      expect(await appState(page)).toBe('unsupported');
      await expect(page.locator('#bzm-status').textContent()).resolves.toBe(S.noDecompressionNote);
      await expect(page.locator('#bzm-app table.routes.summary').isVisible()).resolves.toBe(true);
      await expect(page.locator('#bzm-app .p75').count()).resolves.toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('a corrupt blob: the p75 summary stays, with the failure stated — never a blank Report', async () => {
    const corrupt = html.replace(BLOB_RE, (m) => m.replace(/>[A-Za-z0-9+/]{8}/, '>AAAAAAAA'));
    expect(corrupt).not.toBe(html);
    const { page } = await openReport(browser, corrupt, dir);
    try {
      expect(await appState(page)).toBe('error');
      await expect(page.locator('#bzm-status').textContent()).resolves.toContain(S.renderFailedNote);
      await expect(page.locator('#bzm-app table.routes.summary').isVisible()).resolves.toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('JavaScript off: the <noscript> note and the server-rendered p75 summary', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const file = join(dir, 'nojs.html');
    writeFileSync(file, html);
    const page = await context.newPage();
    try {
      await page.goto(`file://${file}`);
      expect(await appState(page)).toBe('static');
      const note = page.locator('noscript > p.status-note');
      await expect(note.textContent()).resolves.toBe(S.noscriptNote);
      await expect(note.isVisible()).resolves.toBe(true);
      await expect(page.locator('#bzm-app table.routes.summary').isVisible()).resolves.toBe(true);
      const rows = await page.locator('#bzm-app table.routes.summary tbody tr').count();
      expect(rows).toBe(data.routes.length);
    } finally {
      await context.close();
    }
  }, 60_000);
});
