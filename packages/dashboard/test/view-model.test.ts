// The view model — everything the renderer needs, PRECOMPUTED as data.
//
// The rendering layer consumes this and decides nothing: threshold dots (p75
// only, ever), test/engine groupings, blend caveats, histogram bins, and the
// engine spread are all computed here where they are unit-testable. Rendering
// geometry is deliberately NOT tested — it is looked at instead.

import { describe, it, expect } from 'vitest';
import type { Metric } from 'bzm-vitals-format';
import { aggregateRoutes, joinOutcomes, markColdStarts } from '../src/aggregate.js';
import type { AttributedOutcome, AttributedSample } from '../src/attribute.js';
import type { ReportData, SessionSummary } from '../src/report.js';
import { threshold } from '../src/thresholds.js';
import { buildView, histogramBins } from '../src/view-model.js';

// ---------------------------------------------------------------- fixtures

interface MkOpts {
  sessionId?: string;
  locationId?: string;
  engineLabel?: string;
  url?: string;
  route?: string;
  ts?: number;
  vitals?: Record<string, Metric>;
  test?: { file: string; title: string; project: string; repeat: number; worker: number } | null;
  navigationIndex?: number | null;
}

let tsCounter = 1752700000000;

function mk(opts: MkOpts = {}): AttributedSample {
  const test =
    opts.test === undefined
      ? { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat: 0, worker: 0 }
      : opts.test;
  return {
    masterId: '90000001',
    sessionId: opts.sessionId ?? 'r-v4-eng-a',
    locationId: opts.locationId ?? 'us-west-1',
    engineLabel: opts.engineLabel ?? 'us-west-1',
    provenance: test === null ? 'legacy' : 'collector',
    sample: {
      schemaVersion: 1,
      ts: opts.ts ?? tsCounter++,
      url: opts.url ?? 'https://example.com/checkout',
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      test,
      navigationIndex: opts.navigationIndex ?? 0,
      vitals: opts.vitals ?? { lcp: { value: 2000, status: 'ok' } },
      navigation: { domContentLoadedMs: null, loadEventMs: null },
      context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
    },
  };
}

function sessionSummary(sessionId: string, locationId: string, engineLabel: string): SessionSummary {
  return {
    sessionId,
    locationId,
    status: 'ENDED',
    engineLabel,
    artifact: 'present',
    sampleCount: 0,
    outcomeCount: 0,
    unreadable: [],
  };
}

/** Assemble a ReportData the way report.ts does: mark, join, aggregate. */
function reportData(raw: AttributedSample[], outcomes: AttributedOutcome[] = []): ReportData {
  const samples = joinOutcomes(markColdStarts(raw), outcomes);
  const seen = new Map<string, { locationId: string; engineLabel: string }>();
  for (const s of raw) {
    if (!seen.has(s.sessionId)) {
      seen.set(s.sessionId, { locationId: s.locationId, engineLabel: s.engineLabel });
    }
  }
  return {
    masterId: '90000001',
    generatedAt: '2026-07-16T00:00:00.000Z',
    sessions: [...seen.entries()].map(([id, v]) => sessionSummary(id, v.locationId, v.engineLabel)),
    routes: aggregateRoutes(samples),
    samples,
    outcomes,
  };
}

const lcp = (value: number): Record<string, Metric> => ({ lcp: { value, status: 'ok' } });

// ------------------------------------------------------------------- tests

describe('view model — threshold dots live on p75 and NOWHERE else', () => {
  it('the dot is the p75 band even when p50 sits in a different band', () => {
    // pooled lcp [1000, 1000, 4500, 4500]: p50=1000 (good), p75=4500 (poor).
    const view = buildView(reportData([1000, 1000, 4500, 4500].map((v) => mk({ vitals: lcp(v) }))));
    const cell = view.routes[0]!.cells.find((c) => c.metric === 'lcp')!;
    expect(cell.p50).toBe(1000);
    expect(cell.p75).toBe(4500);
    expect(cell.dot).toBe('poor'); // p75's band, not p50's
    expect(cell.dot).toBe(threshold('lcp', cell.p75!));
  });

  it('a poor p95 never colours the dot: p75 good → dot good', () => {
    // 18×2000 + 2×5000: p75=2000 (good), p95=5000 (poor).
    const values = [...Array<number>(18).fill(2000), 5000, 5000];
    const view = buildView(reportData(values.map((v) => mk({ vitals: lcp(v) }))));
    const cell = view.routes[0]!.cells.find((c) => c.metric === 'lcp')!;
    expect(cell.p75).toBe(2000);
    expect(cell.p95).toBe(5000);
    expect(cell.dot).toBe('good');
  });

  it('a cell exposes exactly ONE dot field — no per-statistic dots exist structurally', () => {
    const view = buildView(reportData([mk()]));
    for (const route of view.routes) {
      for (const cell of route.cells) {
        const dotKeys = Object.keys(cell).filter((k) => /dot/i.test(k));
        expect(dotKeys).toEqual(['dot']);
      }
    }
  });

  it('open-set extra metrics get no dot, and sort after the known five', () => {
    const view = buildView(
      reportData([
        mk({ vitals: { lcp: { value: 9999, status: 'ok' }, tbt: { value: 9999, status: 'ok' } } }),
      ]),
    );
    expect(view.metricNames).toEqual(['lcp', 'tbt']);
    const tbt = view.routes[0]!.cells.find((c) => c.metric === 'tbt')!;
    expect(tbt.p75).toBe(9999);
    expect(tbt.dot).toBeNull(); // no band → no dot, even at an alarming value
  });
});

describe('view model — reason rows: nothing measured renders the reason, never a number', () => {
  it('all-non-ok INP carries reason "no-interaction" and a null p75 with no dot', () => {
    const view = buildView(
      reportData([
        mk({ vitals: { lcp: { value: 2000, status: 'ok' }, inp: { value: null, status: 'no-interaction' } } }),
        mk({ vitals: { lcp: { value: 2100, status: 'ok' }, inp: { value: null, status: 'no-interaction' } } }),
      ]),
    );
    const inp = view.routes[0]!.cells.find((c) => c.metric === 'inp')!;
    expect(inp.p75).toBeNull();
    expect(inp.dot).toBeNull();
    expect(inp.reason).toBe('no-interaction');
    expect(inp.ok).toBe(0);
    expect(inp.total).toBe(2);
  });

  it('a Route that never carried a metric gets a not-carried cell, never a 0', () => {
    const view = buildView(
      reportData([
        mk({ url: 'https://example.com/a', vitals: { lcp: { value: 2000, status: 'ok' }, tbt: { value: 5, status: 'ok' } } }),
        mk({ url: 'https://example.com/b', vitals: lcp(2000) }),
      ]),
    );
    const rowB = view.routes.find((r) => r.route === '/b')!;
    const tbt = rowB.cells.find((c) => c.metric === 'tbt')!;
    expect(tbt.carried).toBe(false);
    expect(tbt.p75).toBeNull();
    expect(tbt.dot).toBeNull();
    expect(tbt.ok).toBe(0);
  });
});

describe('view model — the blend caveat is a computed predicate', () => {
  const testA = { file: 'a.spec.ts', title: 'journey A', project: 'chromium', repeat: 0, worker: 0 };
  const testB = { file: 'b.spec.ts', title: 'journey B', project: 'chromium', repeat: 0, worker: 0 };

  it('a Route fed by two Tests is blended; a single-Test Route is not', () => {
    const view = buildView(
      reportData([
        mk({ test: testA, url: 'https://example.com/x' }),
        mk({ test: testB, url: 'https://example.com/x' }),
        mk({ test: testA, url: 'https://example.com/solo' }),
      ]),
    );
    const blended = view.routes.find((r) => r.route === '/x')!;
    expect(blended.blended).toBe(true);
    expect(blended.testCount).toBe(2);
    const solo = view.routes.find((r) => r.route === '/solo')!;
    expect(solo.blended).toBe(false);
    expect(solo.testCount).toBe(1);
  });

  it('legacy Samples (null test identity) group as one legacy Test group', () => {
    const view = buildView(
      reportData([
        mk({ test: null, url: 'https://example.com/x' }),
        mk({ test: null, url: 'https://example.com/x' }),
      ]),
    );
    const route = view.routes[0]!;
    expect(route.blended).toBe(false);
    expect(route.testCount).toBe(1);
    expect(route.tests).toHaveLength(1);
    expect(route.tests[0]!.legacy).toBe(true);
    // Mixed legacy + real identity IS a blend of journeys.
    const mixed = buildView(
      reportData([
        mk({ test: null, url: 'https://example.com/x' }),
        mk({ test: testA, url: 'https://example.com/x' }),
      ]),
    );
    expect(mixed.routes[0]!.blended).toBe(true);
    expect(mixed.routes[0]!.testCount).toBe(2);
  });
});

describe('view model — drill-down walks Route → Test → Engine → Navigation', () => {
  const testA = { file: 'a.spec.ts', title: 'journey A', project: 'chromium', repeat: 0, worker: 0 };

  it('a Test splits by Engine, keyed on sessionId with the label riding along', () => {
    const view = buildView(
      reportData([
        mk({ test: testA, sessionId: 'r-v4-a', engineLabel: 'us-west-1 #1', vitals: lcp(1000) }),
        mk({ test: testA, sessionId: 'r-v4-a', engineLabel: 'us-west-1 #1', vitals: lcp(1200) }),
        mk({ test: testA, sessionId: 'r-v4-b', engineLabel: 'us-west-1 #2', vitals: lcp(3000) }),
      ]),
    );
    const group = view.routes[0]!.tests[0]!;
    expect(group.engines).toHaveLength(2);
    const [a, b] = group.engines;
    expect(a!.sessionId).toBe('r-v4-a'); // the join key is carried, always
    expect(a!.engineLabel).toBe('us-west-1 #1');
    expect(a!.sampleCount).toBe(2);
    expect(b!.sessionId).toBe('r-v4-b');
    expect(b!.sampleCount).toBe(1);
    // Engine spread: per-Engine p75s side by side — shown, never adjudicated.
    // The pinned percentile method: sorted[floor((n-1)*q)] → n=2 gives sorted[0].
    // Coverage accompanies every aggregate — the spread's cells included.
    expect(a!.p75s.lcp).toEqual({ p75: 1000, ok: 2, total: 2 });
    expect(b!.p75s.lcp).toEqual({ p75: 3000, ok: 1, total: 1 });
  });

  it('an Engine lists its Navigations ordered by ts, with Cold Start and Execution status', () => {
    const outcomes: AttributedOutcome[] = [
      {
        sessionId: 'r-v4-a',
        outcome: { schemaVersion: 1, test: testA, status: 'failed', retry: 0 },
      },
    ];
    const view = buildView(
      reportData(
        [
          mk({ test: testA, sessionId: 'r-v4-a', ts: 2000, url: 'https://example.com/checkout?step=2', navigationIndex: 1 }),
          mk({ test: testA, sessionId: 'r-v4-a', ts: 1000, url: 'https://example.com/checkout?step=1', navigationIndex: 0 }),
        ],
        outcomes,
      ),
    );
    const navs = view.routes[0]!.tests[0]!.engines[0]!.navigations;
    expect(navs.map((n) => n.ts)).toEqual([1000, 2000]); // by ts, not input order
    expect(navs[0]!.url).toBe('https://example.com/checkout?step=1');
    expect(navs[0]!.coldStart).toBe(true); // first Navigation by ts for (session, worker)
    expect(navs[1]!.coldStart).toBe(false);
    expect(navs[0]!.executionStatus).toBe('failed');
    expect(navs[0]!.vitals.lcp).toEqual({ value: 2000, status: 'ok' });
  });

  it('Cold Starts are counted on the Route row when identifiable, null when not', () => {
    const view = buildView(
      reportData([
        mk({ test: { ...testA, worker: 0 }, ts: 1 }),
        mk({ test: { ...testA, worker: 0 }, ts: 2 }),
        mk({ test: { ...testA, worker: 1 }, ts: 3 }),
      ]),
    );
    expect(view.routes[0]!.coldStarts).toBe(2); // one per (session, worker)

    const legacy = buildView(reportData([mk({ test: null }), mk({ test: null })]));
    expect(legacy.routes[0]!.coldStarts).toBeNull(); // unidentifiable ≠ zero
  });
});

describe('view model — histograms are precomputed bins over ok values only', () => {
  it('bins cover [min, max] and sum to the ok count; not-ok values never bin', () => {
    const samples = [
      ...[1000, 1500, 2000, 2500, 3000, 3500, 4000].map((v) => mk({ vitals: lcp(v) })),
      mk({ vitals: { lcp: { value: 99999, status: 'error' } } }), // never binned
    ];
    const view = buildView(reportData(samples));
    const histo = view.routes[0]!.histograms.find((h) => h.metric === 'lcp')!;
    expect(histo.okCount).toBe(7);
    expect(histo.bins.reduce((n, b) => n + b.count, 0)).toBe(7);
    expect(histo.min).toBe(1000);
    expect(histo.max).toBe(4000);
  });

  it('an all-identical distribution (the real CLS case) collapses to one bin', () => {
    const bins = histogramBins([0.00059, 0.00059, 0.00059]);
    expect(bins).toEqual([{ x0: 0.00059, x1: 0.00059, count: 3 }]);
  });

  it('a metric with zero ok values gets no histogram at all', () => {
    const view = buildView(
      reportData([mk({ vitals: { lcp: { value: 2000, status: 'ok' }, inp: { value: null, status: 'no-interaction' } } })]),
    );
    expect(view.routes[0]!.histograms.map((h) => h.metric)).toEqual(['lcp']);
  });
});

describe('view model — single- vs multi-Engine chrome', () => {
  it('reports how many Engines exist so a single-Engine run reads naturally', () => {
    const single = buildView(reportData([mk(), mk()]));
    expect(single.engineCount).toBe(1);
    expect(single.multiEngine).toBe(false);

    const multi = buildView(
      reportData([mk({ sessionId: 'r-v4-a' }), mk({ sessionId: 'r-v4-b', locationId: 'us-west-2', engineLabel: 'us-west-2' })]),
    );
    expect(multi.engineCount).toBe(2);
    expect(multi.multiEngine).toBe(true);
  });
});
