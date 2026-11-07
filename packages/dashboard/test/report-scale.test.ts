// Report-scale — the full pipeline through the REAL cached demo bytes.
//
// Master 82723459: two Engines (us-west-1, us-west-2), 377 files each, 50
// incumbent performance-audit records per Engine. The run is cache-only — the
// transport THROWS if touched — so these tests need no network and no account.
//
// Fixture policy (SPEC.md → "Where the fixture bytes come from"): the cache is
// gitignored and re-fetchable. With an empty cache these tests SKIP LOUDLY —
// a green suite that silently tested nothing is this project's signature
// failure and must not be reproduced in its own harness.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import { defaultCacheRoot } from '../src/cache.js';
import { parseBlob } from './helpers/blob.js';
import { renderedHtml } from './helpers/rendered.js';
import {
  assembleReportData,
  type EngineRecords,
  type RecordFile,
  type ReportData,
} from '../src/report.js';
import { buildReportVariants } from '../src/view-model.js';
import { renderHtml } from '../src/render.js';
import { syntheticEngines } from './helpers/synthetic.js';
import { appState, chromium, haveChromium, openReport, until, warnNoChromium } from './helpers/browser.js';

const DEMO_MASTER = '82723459';
// The repo-root cache that scripts/fetch-cache.ts fills (BZM_VITALS_CACHE_DIR still wins).
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const cacheRoot = defaultCacheRoot({ cwd: REPO_ROOT });
const cachePresent = existsSync(path.join(cacheRoot, DEMO_MASTER, 'manifest.json'));
warnNoChromium('report-scale.test.ts');

if (!cachePresent) {
  // Loud, and it names the remedy.
  console.warn(
    `\n[report-scale] SKIPPED — no cached Report ${DEMO_MASTER} at ${cacheRoot}.\n` +
      `[report-scale] Populate it with:\n` +
      `[report-scale]   BLAZEMETER_API_KEY=./api-key.json npx tsx packages/dashboard/scripts/fetch-cache.ts ${DEMO_MASTER}\n`,
  );
}

describe.skipIf(!cachePresent)('report-scale: the real demo Report through the CLI, cache-only', () => {
  let workDir: string;
  let html: string;
  let data: ReportData;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'bzm-demo-'));
    const outPath = path.join(workDir, 'demo.html');
    await runCli({
      argv: ['--master', DEMO_MASTER, '--out', outPath],
      env: {}, // cache-only: no credentials needed
      transport: () => {
        throw new Error('network call during a cache-only run');
      },
      cacheRoot,
    });
    html = await readFile(outPath, 'utf8');
    data = parseBlob(html);
  });
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('adapts all 100 legacy Samples — 50 per Engine, html twins never double-counted', () => {
    expect(data.samples).toHaveLength(100);
    expect(data.samples.every((s) => s.provenance === 'legacy')).toBe(true);
    // Legacy Samples carry no fabricated identity.
    expect(data.samples.every((s) => s.sample.test === null)).toBe(true);
    // And nothing was recorded unreadable — the html twins were excluded by
    // name, not parsed and rejected.
    for (const session of data.sessions) expect(session.unreadable).toEqual([]);
  });

  it('attributes both sessions, with single-Engine-per-location labels', () => {
    expect(data.sessions).toHaveLength(2);
    const counts = new Map<string, number>();
    for (const s of data.samples) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([50, 50]);
    // One Engine per location → plain locationId labels, no ordinal chrome.
    expect(new Set(data.samples.map((s) => s.engineLabel))).toEqual(
      new Set(['us-west-1', 'us-west-2']),
    );
    for (const s of data.samples) expect(s.masterId).toBe(DEMO_MASTER);
  });

  it('renders a Route table row with p50/p75/p95 over the expected coverage', () => {
    // Every audit hit https://example.com/ → Route "/".
    const row = data.routes.find((r) => r.route === '/')!;
    expect(row).toBeDefined();
    expect(row.sampleCount).toBe(100);

    // LCP measured on all 100 (both Engines pooled — Samples weighted, not
    // Engines); all three percentiles are real numbers by the pinned method,
    // ordered as percentiles must be.
    expect(row.metrics.lcp.ok).toBe(100);
    expect(row.metrics.lcp.total).toBe(100);
    expect(row.metrics.lcp.breakdown).toEqual({});
    expect(row.metrics.lcp.p50).toBeGreaterThan(0);
    expect(row.metrics.lcp.p75).toBeGreaterThanOrEqual(row.metrics.lcp.p50!);
    expect(row.metrics.lcp.p95).toBeGreaterThanOrEqual(row.metrics.lcp.p75!);

    // INP was null on every incumbent record. Through the legacy adapter that
    // is status "unknown" — the incumbent cannot say WHY (the distilled
    // fixture's "no-interaction 0 of 50" is the collector-provenance phrasing
    // of the same fact; see known-answers.test.ts). The aggregate carries the
    // reason as data, and p50/p75/p95 are null, never 0.
    expect(row.metrics.inp).toEqual({
      p50: null,
      p75: null,
      p95: null,
      ok: 0,
      total: 100,
      breakdown: { unknown: 100 },
      reason: 'unknown',
    });

    // The blob carries no mean, anywhere.
    expect(JSON.stringify(data.routes)).not.toMatch(/"mean"|"avg"/i);
  });

  it('is honest about what legacy data cannot say: Cold Starts unidentifiable, outcomes unavailable', () => {
    const row = data.routes.find((r) => r.route === '/')!;
    // No legacy record carries a workerIndex → first-ts-per-(sessionId,
    // workerIndex) is structurally impossible: null, never a guessed 0.
    expect(row.coldStarts).toBeNull();
    expect(data.samples.every((s) => s.coldStart === null)).toBe(true);

    // Zero Outcome records anywhere → outcome-awareness unavailable; nothing
    // is marked crashed on a session that was never emitting outcomes.
    expect(data.outcomes).toEqual([]);
    for (const session of data.sessions) expect(session.outcomeCount).toBe(0);
    expect(data.samples.every((s) => s.executionStatus === 'unavailable')).toBe(true);
  });

  it('legacy Report: the toggle is disabled WITH the reason, and the breakdown says outcomes are unavailable — never all-passed', () => {
    // Zero Outcome records anywhere → outcome-awareness unavailable. The line
    // says so in words; the toggle exists but is disabled with its reason; no
    // excluded variant exists at all. (The rendered report: see rendered.ts.)
    const rendered = renderedHtml(data);
    expect(rendered).toContain('outcome records unavailable — legacy collector');
    expect(rendered).toContain('id="bzm-include-failed" checked disabled');
    expect(rendered).toContain('cannot exclude — outcome records unavailable');
    expect(rendered).not.toContain('id="bzm-variant-excluded"');
    expect(rendered).not.toMatch(/all \d+ Executions passed/);
  });

  it("renders INP's legacy 'unknown' distinctly — the incumbent cannot say why", () => {
    expect(renderedHtml(data)).toContain('unknown — legacy collector cannot say why');
    // The no-JS fallback summary says it too.
    expect(html).toContain('unknown — legacy collector cannot say why');
  });

  it('emits no pre-signed URL and no external fetchable reference, even at real scale', () => {
    expect(html).not.toContain('storage.blazemeter.com');
    expect(JSON.stringify(data)).not.toContain('storage.blazemeter.com');
    expect(html).not.toMatch(/<script[^>]+\bsrc\s*=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<img[^>]+\bsrc\s*=\s*["']?https?:/i);
  });
});

// ------------------------------------------------------------ 200k Samples
//
// At 200k Samples nothing in the view model may spread the measured values
// onto the call stack (`Math.min(...values)` throws `RangeError: Maximum call
// stack size exceeded` there). Unlike the block above, this one NEVER skips: it builds its Samples synthetically (one cheap
// template with a varying ts, Route and LCP) and drives the same two calls
// the CLI makes — assembleReportData, then buildReportVariants. @slow, but it
// runs in CI and stays well under its 15 s budget.

const SCALE_SAMPLES = 200_000;
const SCALE_ROUTES = 4;

function syntheticEngine(sessionId: string, count: number, offset: number): EngineRecords {
  const files: RecordFile[] = [];
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    files.push({
      file: `${sessionId}/bzm-vitals-sample-${n}.json`,
      read: async () =>
        JSON.stringify({
          schemaVersion: 1,
          ts: 1752700000000 + n,
          url: `https://example.com/p${n % SCALE_ROUTES}`,
          test: { file: 'scale.spec.ts', title: 'scale', project: 'chromium', repeat: n, worker: n % 8 },
          navigationIndex: 0,
          vitals: {
            lcp: { value: 1000 + (n % 5000), status: 'ok' },
            cls: { value: (n % 100) / 1000, status: 'ok' },
          },
          navigation: { domContentLoadedMs: null, loadEventMs: null },
          context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
        }),
    });
  }
  return { sessionId, locationId: 'us-west-1', status: 'ENDED', artifact: 'present', files };
}

describe('report-scale @slow: 200k synthetic Samples (issue #33)', () => {
  it(
    'assembleReportData + buildReportVariants complete without a call-stack RangeError',
    async () => {
      const half = SCALE_SAMPLES / 2;
      const data = await assembleReportData({
        masterId: '90000033',
        reportName: null,
        engines: [
          syntheticEngine('r-v4-scale-a', half, 0),
          syntheticEngine('r-v4-scale-b', half, half),
        ],
      });
      expect(data.samples).toHaveLength(SCALE_SAMPLES);

      const { included } = buildReportVariants(data);
      expect(included.totalSamples).toBe(SCALE_SAMPLES);
      expect(included.routes).toHaveLength(SCALE_ROUTES);
      for (const route of included.routes) {
        expect(route.sampleCount).toBe(SCALE_SAMPLES / SCALE_ROUTES);
        const lcp = route.histograms.find((h) => h.metric === 'lcp')!;
        expect(lcp.okCount).toBe(SCALE_SAMPLES / SCALE_ROUTES);
        // Route /pK holds n ≡ K (mod 4); 5000 is a multiple of 4, so its LCP
        // values are exactly 1000+K, 1004+K, …, 5996+K.
        const k = Number(route.route.slice('/p'.length));
        expect(lcp.min).toBe(1000 + k);
        expect(lcp.max).toBe(5996 + k);
        expect(lcp.bins.reduce((n, b) => n + b.count, 0)).toBe(lcp.okCount);
        expect(lcp.maxBinCount).toBe(lcp.bins.reduce((m, b) => (b.count > m ? b.count : m), 0));
      }
    },
    15_000,
  );
});

// ------------------------------------------- E1: size and speed at scale
//
// The data is embedded ONCE (gzip + base64) and the browser renders both
// variants (failed Executions included and excluded) from it. Rendered on the
// server as full HTML, every Navigation row and timeline point would be
// written twice, and the file would grow with Samples × charts × variants
// (55 MiB at 20k Samples on the same data). These NEVER skip: the Samples are
// synthetic, shaped like a real run (helpers/synthetic.ts).
//
// Recorded (this synthetic run: 5 vitals per Navigation, 1 in 10 Executions
// failed; one developer machine):
//   20k Samples:  1.28 MiB
//   200k Samples: 12.3 MiB, generated in ~5 s, opened in Chromium in ~1.8–2.0 s.

const MB = 1024 * 1024;

describe('report-scale E1: a 20k-Sample report', () => {
  it('is under 8 MiB — the data once, compressed; nothing pre-rendered per Sample', async () => {
    const data = await assembleReportData({
      masterId: '90000043',
      reportName: null,
      engines: syntheticEngines(20_000),
    });
    expect(data.samples).toHaveLength(20_000);
    const html = renderHtml(data);
    const bytes = Buffer.byteLength(html, 'utf8');
    console.log(`[report-scale] 20k-Sample report: ${(bytes / MB).toFixed(2)} MiB`);
    expect(bytes).toBeLessThan(8 * MB);
    // The blob round-trips every Sample.
    expect(parseBlob(html).samples).toHaveLength(20_000);
  }, 30_000);
});

describe('report-scale E1 @slow: a 200k-Sample report', () => {
  let html = '';
  let generateMs = 0;

  beforeAll(async () => {
    const t0 = performance.now();
    const data = await assembleReportData({
      masterId: '90000043',
      reportName: null,
      engines: syntheticEngines(200_000),
    });
    html = renderHtml(data);
    generateMs = performance.now() - t0;
  }, 60_000);

  it('generates in under 15 s (assemble + render, as the CLI does)', () => {
    console.log(
      `[report-scale] 200k-Sample report: generated in ${(generateMs / 1000).toFixed(1)} s, ` +
        `${(Buffer.byteLength(html, 'utf8') / MB).toFixed(1)} MiB`,
    );
    expect(html.length).toBeGreaterThan(0);
    expect(generateMs).toBeLessThan(15_000);
  });

  it.skipIf(!haveChromium)('opens in Chromium in under 5 s — rendered and interactive', async () => {
    const browser = await chromium.launch();
    const dir = mkdtempSync(path.join(tmpdir(), 'bzm-e1-scale-'));
    try {
      const { page, ms, errors } = await openReport(browser, html, dir, { timeout: 60_000 });
      const timings = await page.evaluate(() => window.bzmVitals?.timings);
      const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
      console.log(
        `[report-scale] 200k-Sample report: opened in ${(ms / 1000).toFixed(2)} s ` +
          `(${JSON.stringify(timings)}), ${nodes} DOM elements`,
      );
      expect(await appState(page)).toBe('ready');
      expect(errors).toEqual([]);
      expect(ms).toBeLessThan(5_000);
      // The Route table is there, one row per Route.
      await expect(page.locator('#bzm-variant-included table.routes tr.route-row').count()).resolves.toBe(5);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // The timeline's points on a canvas, the drill-downs built on first expand
  // at every level, the excluded variant's view built at idle from the
  // columnar Sample index built at load (the one pass over every Sample's
  // vitals). Recorded (this synthetic run, Chromium headless, one developer
  // machine; timings are window.bzmVitals.timings):
  //   first paint: 472 elements / 706 nodes (the points: zero DOM nodes);
  //   load: index ~230–280 ms, view ~310–410 ms;
  //   the excluded view's build (excludedView): ~130–165 ms;
  //   toggle, worst case (flipped the instant the report is ready, so the
  //   click builds the excluded view, renders it and paints): ~0.16–0.22 s;
  //   toggle after the idle-time build (the first flip renders the variant's
  //   markup): ~20–35 ms; later flips: ~5–20 ms; opened in ~1.8–2.0 s.
  it.skipIf(!haveChromium)(
    'E3: under 5k DOM nodes at first paint, a variant toggle under 500 ms, and a canvas point\'s tooltip on hover',
    async () => {
      const browser = await chromium.launch();
      const dir = mkdtempSync(path.join(tmpdir(), 'bzm-e3-scale-'));
      type Cold = { ms: number; builtBefore: boolean; elements: number; nodes: number };
      try {
        // 1. First paint, and the worst-case toggle, measured in the page: a
        //    MutationObserver callback runs as a microtask right after the
        //    report turns ready — ahead of any idle callback — so it counts
        //    the DOM as first painted, then flips the toggle before the
        //    excluded view is built: this click builds it, renders it, paints.
        const cold = await openReport(browser, html, dir, {
          timeout: 60_000,
          before: (p) =>
            p.addInitScript(() => {
              const w = window as unknown as { __cold?: Cold };
              const watch = new MutationObserver(() => {
                const app = document.getElementById('bzm-app');
                if (app?.getAttribute('data-bzm-state') !== 'ready') return;
                watch.disconnect();
                const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
                let nodes = 0;
                while (walker.nextNode()) nodes++;
                const elements = document.getElementsByTagName('*').length;
                const builtBefore = window.bzmVitals?.variants.excluded !== undefined;
                const t0 = performance.now();
                (document.getElementById('bzm-include-failed') as HTMLInputElement).click();
                requestAnimationFrame(() =>
                  setTimeout(() => {
                    w.__cold = { ms: Math.round(performance.now() - t0), builtBefore, elements, nodes };
                  }, 0),
                );
              });
              // From the start: the report can turn ready before DOMContentLoaded.
              watch.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-bzm-state'] });
            }),
        });
        await until(cold.page, () => (window as unknown as { __cold?: unknown }).__cold !== undefined, null);
        const first = await cold.page.evaluate(() => (window as unknown as { __cold: Cold }).__cold);
        expect(first.builtBefore).toBe(false);
        await expect(cold.page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(true);
        expect(cold.errors).toEqual([]);
        await cold.page.close();

        // 2. The usual case: the page has been idle a moment, so the excluded
        //    view is built; the first flip renders its markup, later ones swap.
        //    Click → the next frame painted.
        const { page, errors } = await openReport(browser, html, dir, { timeout: 60_000 });
        expect(await appState(page)).toBe('ready');
        await until(page, () => window.bzmVitals?.variants.excluded !== undefined, null);
        const flip = () =>
          page.evaluate(async () => {
            const box = document.getElementById('bzm-include-failed') as HTMLInputElement;
            const t0 = performance.now();
            box.click();
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            return Math.round(performance.now() - t0);
          });
        const settled = [await flip(), await flip(), await flip()];
        const timings = await page.evaluate(() => window.bzmVitals?.timings);
        console.log(
          `[report-scale] E3 200k: first paint ${first.elements} elements / ${first.nodes} nodes; ` +
            `toggle at ready (builds the excluded view) ${first.ms} ms; ` +
            `after the idle build ${settled.join(' / ')} ms (render, swap, swap); ${JSON.stringify(timings)}`,
        );
        expect(first.nodes).toBeLessThan(5_000);
        expect(first.elements).toBeLessThan(5_000);
        expect(first.ms).toBeLessThan(500);
        for (const ms of settled) expect(ms).toBeLessThan(500);
        await expect(page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(true);

        // Hover a canvas point in the visible (excluded) variant's LCP chart.
        const at = await page.evaluate(() => {
          const v = window.bzmVitals!.variants.excluded!;
          const index = v.timeline.charts.findIndex((c) => c.metric === 'lcp');
          const chart = v.timeline.charts[index]!;
          const axis = v.timeline.axis!;
          const p = chart.series[0]!.points.at(-1)!;
          const x = 56 + ((p.ts - axis.minTs) / (axis.maxTs - axis.minTs)) * (1240 - 56 - 14);
          const y = 12 + (1 - p.value / chart.yMax) * 120;
          const svg = document.querySelector(`#bzm-variant-excluded svg.tl-front[data-chart="${index}"]`) as SVGSVGElement;
          svg.scrollIntoView({ block: 'center' });
          const screen = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
          return { x: screen.x, y: screen.y };
        });
        // Scrolled into view, the chart is painted (charts off screen wait for it).
        const painted = await until(
          page,
          ({ x, y }) => {
            const canvas = [...document.querySelectorAll<HTMLCanvasElement>('#bzm-variant-excluded canvas.tl-points')].find(
              (c) => {
                const b = c.getBoundingClientRect();
                return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
              },
            );
            if (!canvas || canvas.width === 0) return false;
            const b = canvas.getBoundingClientRect();
            const px = canvas
              .getContext('2d')!
              .getImageData(Math.round(((x - b.left) / b.width) * canvas.width), Math.round(((y - b.top) / b.height) * canvas.height), 1, 1);
            return px.data[3]! > 0;
          },
          at,
        );
        expect(painted).toBe(true);
        await page.mouse.move(at.x, at.y);
        const tip = page.locator('#bzm-tip');
        await expect(tip.isVisible()).resolves.toBe(true);
        // One Navigation's tooltip: its time (local zone), value, Engine and URL.
        expect(await tip.textContent()).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \S+ · [\d,]+\u2009ms · us-west-1 #\d\nhttps:\/\/shop\.example\.com\//);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
