// KNOWN-ANSWER TESTS — the real demo 50-Sample Report, distilled and committed.
// These tests own their fixture (test/fixtures/known-answers/landing-50.json) and
// NEVER skip: the arithmetic is pinned even with an empty artifact cache.
//
// The honest path, chosen and documented:
//   The fixture's samples are LEGACY-SHAPED — the incumbent's performance-audit
//   extract. Each test row is rebuilt into a legacy audit record and fed through
//   the REAL legacy adapter (adaptLegacyAuditRecord), so the whole production
//   path from incumbent record to aggregate is exercised, not a shortcut.
//
//   INP reconciliation: on adapted legacy data inp:null becomes status
//   "unknown" — the incumbent cannot say WHY, and the adapter never guesses.
//   So the model's known answer HERE is reason "unknown" (0 of 50). The
//   "no-interaction (0 of 50)" rendering of the same underlying fact is
//   asserted separately over collector-provenance samples carrying the status
//   the incumbent could not express. Nothing is fudged.
//
//   Cold Starts: legacy records carry no workerIndex, so first-ts-per-
//   (sessionId, workerIndex) is structurally impossible on this data. The model
//   must say so (coldStarts null) — never guess. The pinned known answer
//   "repeats 0..4 are the five slowest" is verified against the fixture data
//   in-test, as data about that Report, not via a fabricated worker.
//
//   The mean LCP 2218.4 is VERIFICATION ONLY: computed inside this test from
//   the raw fixture values to prove these are the right 50 samples. The model
//   itself exposes no mean, and the structural tests in aggregate.test.ts
//   assert that.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateRoutes, markColdStarts } from '../src/aggregate.js';
import { adaptLegacyAuditRecord } from '../src/legacy-adapter.js';
import { attributeSample, type AttributedSample } from '../src/attribute.js';
import type { Metric } from '@bzm/vitals-format';

interface FixtureSample {
  repeat: number;
  ts: string;
  url: string;
  lcp: number;
  fcp: number;
  cls: number;
  inp: number | null;
  ttfb: number;
  dcl: number;
  load: number;
  req: number;
  failed: number;
}

interface Fixture {
  lcp: { mean: number; p50: number; p75: number; p95: number; max: number };
  inp: { noInteraction: number; of: number };
  cls: { counts: Record<string, number> };
  coldStarts: { repeats: number[] };
  samples: FixtureSample[];
}

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'known-answers',
  'landing-50.json',
);

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Fixture;
}

const ENGINE = {
  masterId: '82723459',
  sessionId: 'r-v4-demo-engine',
  locationId: 'us-west-1',
  engineLabel: 'us-west-1',
};

/** Rebuild the incumbent's audit record from a fixture row and run it through
 *  the REAL legacy adapter — the production path, not a shortcut. */
function adaptFixtureSample(s: FixtureSample): AttributedSample {
  const adapted = adaptLegacyAuditRecord({
    url: s.url,
    generatedAt: s.ts,
    coreWebVitals: { fcp: s.fcp, lcp: s.lcp, cls: s.cls, inp: s.inp, ttfb: s.ttfb },
    navigation: { domContentLoadedMs: s.dcl, loadEventMs: s.load },
    requestCount: s.req,
    failedRequests: s.failed,
  });
  if (!adapted.ok) throw new Error(`fixture row failed the legacy adapter: ${adapted.reason}`);
  return attributeSample(adapted.sample, 'legacy', ENGINE);
}

describe('known answers — the real demo 50 Samples through the legacy adapter and the model', () => {
  it('reproduces the LCP known answers exactly: p50 2152 · p75 2276 · p95 3120', async () => {
    const fixture = await loadFixture();
    const samples = fixture.samples.map(adaptFixtureSample);
    expect(samples).toHaveLength(50);

    const rows = aggregateRoutes(samples);
    expect(rows).toHaveLength(1); // every audit hit the same Route
    const lcp = rows[0]!.metrics.lcp;
    expect(lcp.p50).toBe(2152);
    expect(lcp.p75).toBe(2276);
    expect(lcp.p95).toBe(3120);
    expect(lcp.ok).toBe(50);
    expect(lcp.total).toBe(50);
    expect(lcp.breakdown).toEqual({});

    // VERIFICATION ONLY — computed here from the raw values to prove these are
    // the right 50 samples. The model exposes NO mean; max is likewise not a
    // model output.
    const raw = fixture.samples.map((s) => s.lcp);
    const meanForVerification = raw.reduce((a, b) => a + b, 0) / raw.length;
    expect(meanForVerification).toBeCloseTo(2218.4, 9); // fixture.lcp.mean
    expect(meanForVerification).toBeCloseTo(fixture.lcp.mean, 9);
    expect(Math.max(...raw)).toBe(fixture.lcp.max); // 3364
  });

  it('INP on adapted legacy data: 0 of 50 with reason "unknown" — the incumbent cannot say why', async () => {
    const fixture = await loadFixture();
    const samples = fixture.samples.map(adaptFixtureSample);
    const inp = aggregateRoutes(samples)[0]!.metrics.inp;
    // The incumbent's inp was null on all 50; the adapter maps null to status
    // "unknown" (never a guessed "no-interaction"). The reason is data, not a
    // number — the UI renders "INP — unknown (0 of 50)".
    expect(inp).toEqual({
      p50: null,
      p75: null,
      p95: null,
      ok: 0,
      total: 50,
      breakdown: { unknown: 50 },
      reason: 'unknown',
    });
    expect(fixture.inp).toEqual({ noInteraction: 50, of: 50 });
  });

  it('INP as the collector would have said it: no-interaction (0 of 50) — the reason, not a number', async () => {
    // The same underlying fact, expressed with collector provenance: the
    // incumbent's audit browser only goto()s, so no interaction ever happened —
    // a structural null the collector's format states outright.
    const fixture = await loadFixture();
    const samples = fixture.samples.map((s, i) => {
      const vitals: Record<string, Metric> = {
        lcp: { value: s.lcp, status: 'ok' },
        inp: { value: null, status: 'no-interaction' },
      };
      return attributeSample(
        {
          schemaVersion: 1,
          ts: Date.parse(s.ts),
          url: s.url,
          test: { file: 'audit.spec.ts', title: 'demo landing', project: 'chromium', repeat: s.repeat, worker: i % 5 },
          navigationIndex: 0,
          vitals,
          navigation: { domContentLoadedMs: s.dcl, loadEventMs: s.load },
          context: { workers: 5, resourceCount: null, requestCount: s.req, failedRequests: s.failed },
        },
        'collector',
        ENGINE,
      );
    });
    const inp = aggregateRoutes(samples)[0]!.metrics.inp;
    expect(inp.p75).toBeNull();
    expect(inp.ok).toBe(0);
    expect(inp.total).toBe(50);
    expect(inp.breakdown).toEqual({ 'no-interaction': 50 });
    expect(inp.reason).toBe('no-interaction'); // "INP — no interaction (0 of 50)"
  });

  it('reproduces the CLS known answers: 0.00059 ×35, 0.00062 ×6, 0 ×9 — zero measured is not zero missing', async () => {
    const fixture = await loadFixture();
    const samples = fixture.samples.map(adaptFixtureSample);
    const cls = aggregateRoutes(samples)[0]!.metrics.cls;

    // All 50 measured — the exact 0s are real values, pooled as values.
    expect(cls.ok).toBe(50);
    expect(cls.total).toBe(50);
    expect(cls.breakdown).toEqual({});
    // p75 lands in the 0.00059 band: sorted = 9×0 then 35×0.00059… then 6×0.00062….
    expect(Math.round(cls.p75! * 100000) / 100000).toBe(0.00059);
    expect(cls.p50).toBeGreaterThan(0); // the 9 zeros do not drag p50 to 0

    // The distribution itself, verified from the raw fixture values (5 dp).
    const counts = new Map<string, number>();
    for (const s of fixture.samples) {
      const key = String(Math.round(s.cls * 100000) / 100000);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ '0.00059': 35, '0.00062': 6, '0': 9 });
    expect(fixture.cls.counts).toEqual({ '0.00059': 35, '0.00062': 6, '0': 9 });
  });

  it('Cold Starts on legacy data are honestly unidentifiable — and repeats 0..4 ARE the five slowest', async () => {
    const fixture = await loadFixture();
    const samples = fixture.samples.map(adaptFixtureSample);

    // The model: no workerIndex on any legacy record, so no Cold Start can be
    // identified structurally. The flag is null on every Sample and the
    // aggregate says null — never 0, never a guess.
    const marked = markColdStarts(samples);
    expect(marked.every((s) => s.coldStart === null)).toBe(true);
    expect(aggregateRoutes(samples)[0]!.coldStarts).toBeNull();

    // The pinned known answer for THIS Report, verified as data: the five
    // slowest Samples by LCP are exactly repeats 0..4 — one per Worker, the
    // first Execution on each of the five workers, ~45% inflated.
    const slowestFive = [...fixture.samples]
      .sort((a, b) => b.lcp - a.lcp)
      .slice(0, 5)
      .map((s) => s.repeat)
      .sort((a, b) => a - b);
    expect(slowestFive).toEqual(fixture.coldStarts.repeats); // [0,1,2,3,4]
  });
});
