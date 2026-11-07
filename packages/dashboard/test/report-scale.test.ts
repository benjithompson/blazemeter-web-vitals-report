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
import { appState, chromium, haveChromium, openReport, warnNoChromium } from './helpers/browser.js';

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
// Issue #33 (D4): at 200k Samples `Math.min(...values)` in the view model
// spread every measured value onto the call stack and threw
// `RangeError: Maximum call stack size exceeded`. Unlike the block above,
// this one NEVER skips: it builds its Samples synthetically (one cheap
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
// Issue #43 (E1): the server used to render BOTH variants (failed Executions
// included and excluded) as full HTML — every Navigation row and every
// timeline point twice — so the file grew with Samples × charts × variants:
// 38.2 MB at 20k Samples on the 2026-11-07 measurement. Now the data is
// embedded ONCE (gzip + base64) and the browser renders it. These NEVER skip:
// the Samples are synthetic, shaped like a real run (helpers/synthetic.ts).
//
// Recorded (this synthetic run: 5 vitals per Navigation, 1 in 10 Executions
// failed; one developer machine):
//   20k Samples:  1.27 MiB  (the pre-E1 renderer: 55.0 MiB on the same data)
//   200k Samples: 12.3 MiB, generated in ~6.5 s, opened in Chromium in ~3.4 s.

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
});
