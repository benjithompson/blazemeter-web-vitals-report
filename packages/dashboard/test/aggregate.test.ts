// The aggregation model (issue #6) — the dashboard's central claim, done
// correctly. What is pinned here:
//   - the percentile method: sorted[floor((n-1)*q)] — verified against the real
//     50-Sample known answers (the arithmetic tests never skip);
//   - percentiles computed ONCE over the pooled Attributed Samples — never the
//     mean of per-Engine percentiles, never per-Engine-equalized pools;
//   - p50/p75/p95 over status==="ok" values ONLY; anything else (including
//     statuses the dashboard has never heard of, even with a numeric value) is
//     not-ok and never pooled;
//   - coverage {ok, total} plus the not-ok breakdown beside every aggregate;
//     "not carried" (metric absent from the record) is distinguished;
//   - all-non-ok metrics carry the DOMINANT REASON as data, never a number;
//   - Cold Starts flagged (first Navigation by ts per (sessionId, workerIndex)),
//     kept in every aggregate, counted per node; null-worker records are
//     honestly unidentifiable, never guessed;
//   - Execution Outcomes join on (sessionId, test identity, repeat, worker);
//     a missing outcome among emitted ones = crashed; failed Executions are
//     INCLUDED by default with an exclude variant the caller applies;
//   - NO MEAN anywhere in the model. Ever. Asserted structurally.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  percentile,
  routeOf,
  aggregateRoutes,
  markColdStarts,
  joinOutcomes,
  excludeFailedExecutions,
} from '../src/aggregate.js';
import * as aggregateModule from '../src/aggregate.js';
import * as dashboardModule from '../src/index.js';
import { attributeSample } from '../src/attribute.js';
import type { AttributedSample, AttributedOutcome } from '../src/attribute.js';
import type { DashboardSample } from '../src/parse.js';
import type { Metric, TestIdentity, ExecutionStatus } from 'bzm-vitals-format';

const KNOWN_ANSWERS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'known-answers',
  'landing-50.json',
);

function sample(
  url: string,
  vitals: Record<string, Metric>,
  opts: { route?: string; ts?: number; test?: TestIdentity | null } = {},
): DashboardSample {
  return {
    schemaVersion: 1,
    ts: opts.ts ?? 1752700745069,
    url,
    ...(opts.route === undefined ? {} : { route: opts.route }),
    test: opts.test ?? null,
    navigationIndex: null,
    vitals,
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

function identity(repeat: number, worker: number): TestIdentity {
  return { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat, worker };
}

function attributed(
  s: DashboardSample,
  opts: { sessionId?: string; locationId?: string } = {},
): AttributedSample {
  return attributeSample(s, 'collector', {
    masterId: 'm',
    sessionId: opts.sessionId ?? 'r-v4-aaa',
    locationId: opts.locationId ?? 'us-west-1',
    engineLabel: opts.locationId ?? 'us-west-1',
  });
}

function outcomeOf(
  sessionId: string,
  test: TestIdentity,
  status: ExecutionStatus,
  retry = 0,
): AttributedOutcome {
  return { sessionId, outcome: { schemaVersion: 1, test, status, retry } };
}

describe('percentile — the pinned method, verified against the real 50 Samples', () => {
  // These arithmetic tests own their fixture and never skip.
  it('reproduces the known-answer LCP percentiles exactly', async () => {
    const known = JSON.parse(await readFile(KNOWN_ANSWERS, 'utf8')) as {
      lcp: { p50: number; p75: number; p95: number; max: number };
      samples: Array<{ lcp: number }>;
    };
    const lcps = known.samples.map((s) => s.lcp);
    expect(lcps).toHaveLength(50);
    expect(percentile(lcps, 0.5)).toBe(known.lcp.p50); // 2152
    expect(percentile(lcps, 0.75)).toBe(known.lcp.p75); // 2276
    expect(percentile(lcps, 0.95)).toBe(known.lcp.p95); // 3120
  });

  it('is sorted[floor((n-1)*q)] — the lower method, not nearest-rank, not interpolated', () => {
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(30); // floor(3*0.75)=2
    expect(percentile([7], 0.75)).toBe(7);
    expect(percentile([3, 1], 0.5)).toBe(1); // sorts first
  });
});

describe('routeOf', () => {
  it('derives the Route from the URL path, stripping query and fragment', () => {
    expect(routeOf(sample('https://example.com/', {}))).toBe('/');
    expect(routeOf(sample('https://example.com/order/12345?x=1#frag', {}))).toBe('/order/12345');
  });

  it('a declared route always wins over a derived one', () => {
    expect(routeOf(sample('https://example.com/order/12345', {}, { route: '/order/{id}' }))).toBe(
      '/order/{id}',
    );
  });
});

describe('aggregateRoutes — pooling', () => {
  it('pools all Attributed Samples per Route with p50/p75/p95 and coverage', () => {
    const samples = [
      attributed(sample('https://x.com/a', { lcp: { value: 100, status: 'ok' } })),
      attributed(sample('https://x.com/a', { lcp: { value: 200, status: 'ok' } })),
      attributed(sample('https://x.com/a', { lcp: { value: 300, status: 'ok' } })),
      attributed(sample('https://x.com/b', { lcp: { value: 900, status: 'ok' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.route === '/a')!;
    expect(a.sampleCount).toBe(3);
    expect(a.metrics.lcp).toEqual({
      p50: 200, // floor(2*0.5)=1
      p75: 200, // floor(2*0.75)=1
      p95: 200, // floor(2*0.95)=1
      ok: 3,
      total: 3,
      breakdown: {},
    });
    const b = rows.find((r) => r.route === '/b')!;
    expect(b.metrics.lcp).toEqual({ p50: 900, p75: 900, p95: 900, ok: 1, total: 1, breakdown: {} });
  });

  it('computes the percentile ONCE over the pooled Samples — never the mean of per-Engine p75s', () => {
    // Engine A carries [100, 200, 300]; Engine B carries [1000].
    const perEngineA = [100, 200, 300];
    const perEngineB = [1000];
    const samples = [
      ...perEngineA.map((v) =>
        attributed(sample('https://x.com/a', { lcp: { value: v, status: 'ok' } }), {
          sessionId: 'r-v4-eng-a',
        }),
      ),
      ...perEngineB.map((v) =>
        attributed(sample('https://x.com/a', { lcp: { value: v, status: 'ok' } }), {
          sessionId: 'r-v4-eng-b',
        }),
      ),
    ];

    // The WRONG answer, computed here to prove the model does not produce it:
    // mean of per-Engine p75s = (200 + 1000) / 2 = 600.
    const meanOfPerEngineP75s =
      (percentile(perEngineA, 0.75) + percentile(perEngineB, 0.75)) / 2;
    expect(meanOfPerEngineP75s).toBe(600);

    // The RIGHT answer: percentile of the pooled values [100,200,300,1000].
    const pooled = percentile([...perEngineA, ...perEngineB], 0.75);
    expect(pooled).toBe(300);

    const row = aggregateRoutes(samples).find((r) => r.route === '/a')!;
    expect(row.metrics.lcp.p75).toBe(pooled);
    expect(row.metrics.lcp.p75).not.toBe(meanOfPerEngineP75s);
  });

  it('weights Samples, not Engines — imbalanced Engines pool as a plain concatenation', () => {
    // Engine A: 3 Samples. Engine B: 1 Sample. Equal-weighting Engines would
    // upweight B's lone Sample by 3x; the model must not.
    const a = [100, 200, 300];
    const b = [1000];
    const samples = [
      ...a.map((v) =>
        attributed(sample('https://x.com/a', { lcp: { value: v, status: 'ok' } }), {
          sessionId: 'r-v4-eng-a',
        }),
      ),
      ...b.map((v) =>
        attributed(sample('https://x.com/a', { lcp: { value: v, status: 'ok' } }), {
          sessionId: 'r-v4-eng-b',
        }),
      ),
    ];

    // Per-Engine-equalized (WRONG): replicate B's pool to match A's count.
    const equalized = percentile([...a, ...b, ...b, ...b], 0.75);
    expect(equalized).toBe(1000);

    const row = aggregateRoutes(samples).find((r) => r.route === '/a')!;
    expect(row.metrics.lcp.p75).toBe(percentile([...a, ...b], 0.75)); // 300
    expect(row.metrics.lcp.p75).not.toBe(equalized);
  });

  it('computes an n=2 aggregate normally and carries its coverage — no minimum sample count', () => {
    const samples = [
      attributed(sample('https://x.com/a', { lcp: { value: 100, status: 'ok' } })),
      attributed(sample('https://x.com/a', { lcp: { value: 400, status: 'ok' } })),
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.metrics.lcp).toEqual({
      p50: 100,
      p75: 100, // floor(1*0.75)=0
      p95: 100,
      ok: 2,
      total: 2,
      breakdown: {},
    });
  });
});

describe('aggregateRoutes — coverage and the not-ok breakdown', () => {
  it('excludes every not-ok status from percentiles, keeps it in the denominator, and itemizes it', () => {
    const samples = [
      attributed(sample('https://x.com/a', { cls: { value: 0.1, status: 'ok' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unsupported' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unknown' } })),
      // An unrecognized status is not-ok — even with a numeric value.
      attributed(sample('https://x.com/a', { cls: { value: 0.9, status: 'brand-new-status' as never } })),
      // A NON-NULL value under a recognized not-ok status is still never pooled.
      attributed(sample('https://x.com/a', { cls: { value: 0.7, status: 'error' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.cls).toEqual({
      p50: 0.1,
      p75: 0.1,
      p95: 0.1,
      ok: 1,
      total: 5,
      breakdown: { unsupported: 1, unknown: 1, 'brand-new-status': 1, error: 1 },
    });
  });

  it('distinguishes "not carried" (metric absent from the record) in the breakdown', () => {
    const samples = [
      attributed(sample('https://x.com/a', { lcp: { value: 100, status: 'ok' } })),
      attributed(sample('https://x.com/a', { lcp: { value: 300, status: 'ok' } })),
      attributed(sample('https://x.com/a', { ttfb: { value: 50, status: 'ok' } })), // no lcp at all
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.metrics.lcp).toEqual({
      p50: 100, // over [100,300] only — the absent record is never a 0
      p75: 100, // floor(1*0.75)=0
      p95: 100,
      ok: 2,
      total: 3,
      breakdown: { 'not-carried': 1 },
    });
    // And ttfb's denominator is still the whole pool, with the absences named.
    expect(row.metrics.ttfb).toEqual({
      p50: 50,
      p75: 50,
      p95: 50,
      ok: 1,
      total: 3,
      breakdown: { 'not-carried': 2 },
    });
  });

  it('renders an all-non-ok metric as the DOMINANT REASON, never a number and never 0', () => {
    const samples = [
      attributed(sample('https://x.com/a', { inp: { value: null, status: 'no-interaction' } })),
      attributed(sample('https://x.com/a', { inp: { value: null, status: 'no-interaction' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.inp).toEqual({
      p50: null,
      p75: null,
      p95: null,
      ok: 0,
      total: 2,
      breakdown: { 'no-interaction': 2 },
      reason: 'no-interaction',
    });
  });

  it('picks the dominant reason from a mixed all-non-ok breakdown', () => {
    const samples = [
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unsupported' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unsupported' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unsupported' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unknown' } })),
      attributed(sample('https://x.com/a', { ttfb: { value: 1, status: 'ok' } })), // no cls
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.metrics.cls.ok).toBe(0);
    expect(row.metrics.cls.total).toBe(5);
    expect(row.metrics.cls.breakdown).toEqual({ unsupported: 3, unknown: 1, 'not-carried': 1 });
    expect(row.metrics.cls.reason).toBe('unsupported');
  });

  it('carries no reason when at least one Sample is ok — coverage says the rest', () => {
    const samples = [
      attributed(sample('https://x.com/a', { lcp: { value: 100, status: 'ok' } })),
      attributed(sample('https://x.com/a', { lcp: { value: null, status: 'error' } })),
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.metrics.lcp.ok).toBe(1);
    expect('reason' in row.metrics.lcp).toBe(false);
  });

  it('carries unknown metric names through — the name set is open', () => {
    const samples = [
      attributed(sample('https://x.com/a', { myCustomTiming: { value: 5, status: 'ok' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.myCustomTiming).toEqual({
      p50: 5,
      p75: 5,
      p95: 5,
      ok: 1,
      total: 1,
      breakdown: {},
    });
  });
});

describe('Cold Starts — first Navigation by ts per (sessionId, workerIndex)', () => {
  it('flags the first Navigation per (sessionId, workerIndex) and no other', () => {
    const samples = [
      // Session A, worker 0: ts 100 is the Cold Start.
      attributed(sample('https://x.com/a', {}, { ts: 100, test: identity(0, 0) }), { sessionId: 'r-v4-a' }),
      attributed(sample('https://x.com/a', {}, { ts: 200, test: identity(5, 0) }), { sessionId: 'r-v4-a' }),
      // Session A, worker 1: ts 150 is the Cold Start.
      attributed(sample('https://x.com/a', {}, { ts: 150, test: identity(1, 1) }), { sessionId: 'r-v4-a' }),
      attributed(sample('https://x.com/a', {}, { ts: 160, test: identity(6, 1) }), { sessionId: 'r-v4-a' }),
      // Session B, worker 0: its own Cold Start — per (sessionId, workerIndex).
      attributed(sample('https://x.com/a', {}, { ts: 500, test: identity(0, 0) }), { sessionId: 'r-v4-b' }),
    ];
    const marked = markColdStarts(samples);
    expect(marked.map((s) => s.coldStart)).toEqual([true, false, true, false, true]);
  });

  it('marks a Sample with no worker as coldStart null — unidentifiable, never guessed', () => {
    const marked = markColdStarts([
      attributed(sample('https://x.com/a', {}, { ts: 100, test: null })),
    ]);
    expect(marked[0]!.coldStart).toBeNull();
  });

  it('keeps Cold Starts in every aggregate — never trimmed — and counts them per node', () => {
    const samples = [
      // The Cold Start is the slowest; trimming it would move p75.
      attributed(sample('https://x.com/a', { lcp: { value: 3000, status: 'ok' } }, { ts: 100, test: identity(0, 0) })),
      attributed(sample('https://x.com/a', { lcp: { value: 1000, status: 'ok' } }, { ts: 200, test: identity(1, 0) })),
      attributed(sample('https://x.com/a', { lcp: { value: 1100, status: 'ok' } }, { ts: 300, test: identity(2, 0) })),
      attributed(sample('https://x.com/a', { lcp: { value: 1200, status: 'ok' } }, { ts: 400, test: identity(3, 0) })),
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.coldStarts).toBe(1);
    expect(row.metrics.lcp.ok).toBe(4); // the Cold Start is in the pool
    expect(row.metrics.lcp.p75).toBe(1200); // [1000,1100,1200,3000] floor(3*.75)=2
  });

  it('reports coldStarts null when no Sample in the pool carries a worker', () => {
    const samples = [
      attributed(sample('https://x.com/a', { lcp: { value: 100, status: 'ok' } }, { test: null })),
      attributed(sample('https://x.com/a', { lcp: { value: 200, status: 'ok' } }, { test: null })),
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.coldStarts).toBeNull();
  });

  it('counts only the identifiable Cold Starts in a mixed collector/legacy pool', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { ts: 100, test: identity(0, 0) })),
      attributed(sample('https://x.com/a', {}, { ts: 200, test: identity(1, 0) })),
      attributed(sample('https://x.com/a', {}, { ts: 50, test: null })), // legacy: unknowable
    ];
    const row = aggregateRoutes(samples)[0]!;
    expect(row.coldStarts).toBe(1);
  });
});

describe('Execution Outcomes — join, crashed detection, and the excludeFailed variant', () => {
  const eng = 'r-v4-eng-a';

  it('joins an Outcome to its Samples on (sessionId, test identity, repeat, worker)', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: identity(0, 0) }), { sessionId: eng }),
      attributed(sample('https://x.com/a', {}, { test: identity(1, 0) }), { sessionId: eng }),
    ];
    const joined = joinOutcomes(samples, [
      outcomeOf(eng, identity(0, 0), 'passed'),
      outcomeOf(eng, identity(1, 0), 'failed'),
    ]);
    expect(joined.map((s) => s.executionStatus)).toEqual(['passed', 'failed']);
  });

  it('does NOT join across sessions — Engine A\'s repeat1 is not Engine B\'s repeat1', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: identity(1, 0) }), { sessionId: 'r-v4-eng-b' }),
    ];
    const joined = joinOutcomes(samples, [
      outcomeOf('r-v4-eng-b', identity(1, 0), 'passed'),
      outcomeOf(eng, identity(1, 0), 'failed'),
    ]);
    expect(joined[0]!.executionStatus).toBe('passed');
  });

  it('marks a Sample whose Execution has NO outcome as crashed — but only when the session was emitting outcomes', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: identity(0, 0) }), { sessionId: eng }),
      attributed(sample('https://x.com/a', {}, { test: identity(1, 0) }), { sessionId: eng }),
    ];
    const joined = joinOutcomes(samples, [outcomeOf(eng, identity(0, 0), 'passed')]);
    expect(joined[0]!.executionStatus).toBe('passed');
    expect(joined[1]!.executionStatus).toBe('crashed'); // others emitted; this one is missing
  });

  it('marks outcome-awareness unavailable for a session with zero outcome records anywhere', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: identity(0, 0) }), { sessionId: eng }),
    ];
    const joined = joinOutcomes(samples, []); // the collector clearly was not emitting outcomes
    expect(joined[0]!.executionStatus).toBe('unavailable');
  });

  it('marks a legacy Sample (no test identity) unavailable — it cannot join', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: null }), { sessionId: eng }),
    ];
    const joined = joinOutcomes(samples, [outcomeOf(eng, identity(0, 0), 'passed')]);
    expect(joined[0]!.executionStatus).toBe('unavailable');
  });

  it('a retried Execution\'s final retry carries the verdict', () => {
    const samples = [
      attributed(sample('https://x.com/a', {}, { test: identity(0, 0) }), { sessionId: eng }),
    ];
    const joined = joinOutcomes(samples, [
      outcomeOf(eng, identity(0, 0), 'failed', 0),
      outcomeOf(eng, identity(0, 0), 'passed', 1),
    ]);
    expect(joined[0]!.executionStatus).toBe('passed');
  });

  it('aggregation INCLUDES failed Executions by default; excludeFailedExecutions moves p75 down when failures are the slow Samples', () => {
    const values: Array<[number, ExecutionStatus]> = [
      [100, 'passed'],
      [200, 'passed'],
      [300, 'passed'],
      [400, 'passed'],
      [500, 'passed'],
      [600, 'passed'],
      [5000, 'failed'], // the failures ARE the slow samples —
      [6000, 'failed'], // excluding them must move p75 down.
    ];
    const samples = values.map(([v], i) =>
      attributed(sample('https://x.com/a', { fcp: { value: v, status: 'ok' } }, { test: identity(i, 0) }), {
        sessionId: eng,
      }),
    );
    const outcomes = values.map(([, status], i) => outcomeOf(eng, identity(i, 0), status));
    const joined = joinOutcomes(samples, outcomes);

    // Default: failed included.
    const withFailed = aggregateRoutes(joined)[0]!;
    expect(withFailed.metrics.fcp.total).toBe(8);
    expect(withFailed.metrics.fcp.p75).toBe(600); // [100..600,5000,6000] floor(7*.75)=5

    // The exclude variant: a pure filter the caller applies.
    const excluded = excludeFailedExecutions(joined);
    const without = aggregateRoutes(excluded)[0]!;
    expect(without.metrics.fcp.total).toBe(6);
    expect(without.metrics.fcp.p75).toBe(400); // [100..600] floor(5*.75)=3
    expect(without.metrics.fcp.p75).toBeLessThan(withFailed.metrics.fcp.p75!);

    // And the original samples are untouched — the variant is pure.
    expect(joined).toHaveLength(8);
  });

  it('excludeFailedExecutions drops failed, timedOut and crashed; keeps passed, skipped and unavailable', () => {
    const mk = (status: string | undefined, repeat: number) => {
      const s = attributed(sample('https://x.com/a', {}, { test: identity(repeat, 0) }), { sessionId: eng });
      return status === undefined ? s : { ...s, executionStatus: status as never };
    };
    const kept = excludeFailedExecutions([
      mk('passed', 0),
      mk('failed', 1),
      mk('timedOut', 2),
      mk('skipped', 3),
      mk('crashed', 4),
      mk('unavailable', 5),
    ]);
    expect(kept.map((s) => s.executionStatus)).toEqual(['passed', 'skipped', 'unavailable']);
  });
});

describe('NO MEAN anywhere in the model — asserted structurally', () => {
  it('no exported symbol of the aggregation module (or the package) computes or exposes a mean', () => {
    const banned = /mean|average|(^|[^a-z])avg/i;
    for (const name of Object.keys(aggregateModule)) {
      expect(name).not.toMatch(banned);
    }
    for (const name of Object.keys(dashboardModule)) {
      expect(name).not.toMatch(banned);
    }
  });

  it('the aggregate output contains no field named mean/avg/average, at any depth', () => {
    const rows = aggregateRoutes([
      attributed(sample('https://x.com/a', { lcp: { value: 1, status: 'ok' } }, { test: identity(0, 0) })),
      attributed(sample('https://x.com/a', { lcp: { value: 2, status: 'ok' } }, { test: identity(1, 0) })),
    ]);
    const banned = /mean|average|(^|[^a-z])avg/i;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          expect(k).not.toMatch(banned);
          walk(v);
        }
      }
    };
    walk(rows);
    // Belt and braces: the serialized blob carries no such key either.
    expect(JSON.stringify(rows)).not.toMatch(/"(mean|avg|average)"/i);
  });
});
