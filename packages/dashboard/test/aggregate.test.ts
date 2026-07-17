// Crude aggregation — correct enough to render; issue #6 replaces the internals.
// What is pinned HERE and must survive #6:
//   - the percentile method: sorted[floor((n-1)*q)] — verified against the real
//     50-Sample known answers (the arithmetic tests never skip);
//   - p75 over status==="ok" values ONLY; anything else (including statuses the
//     dashboard has never heard of) is not-ok and never pooled;
//   - coverage (n_ok of n_total) beside every aggregate;
//   - NO MEAN anywhere in the model.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile, routeOf, aggregateRoutes } from '../src/aggregate.js';
import { attributeSample } from '../src/attribute.js';
import type { AttributedSample } from '../src/attribute.js';
import type { DashboardSample } from '../src/parse.js';
import type { Metric } from '@bzm/vitals-format';

const KNOWN_ANSWERS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'known-answers',
  'landing-50.json',
);

function sample(
  url: string,
  vitals: Record<string, Metric>,
  route?: string,
): DashboardSample {
  return {
    schemaVersion: 1,
    ts: 1752700745069,
    url,
    ...(route === undefined ? {} : { route }),
    test: null,
    navigationIndex: null,
    vitals,
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

function attributed(s: DashboardSample): AttributedSample {
  return attributeSample(s, 'collector', {
    masterId: 'm',
    sessionId: 'r-v4-aaa',
    locationId: 'us-west-1',
    engineLabel: 'us-west-1',
  });
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
    expect(routeOf(sample('https://example.com/order/12345', {}, '/order/{id}'))).toBe('/order/{id}');
  });
});

describe('aggregateRoutes', () => {
  it('pools all Attributed Samples per Route with p75 and coverage', () => {
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
    expect(a.metrics.lcp).toEqual({ p75: 200, ok: 3, total: 3 }); // floor(2*0.75)=1
    const b = rows.find((r) => r.route === '/b')!;
    expect(b.metrics.lcp).toEqual({ p75: 900, ok: 1, total: 1 });
  });

  it('excludes every not-ok status from the percentile but keeps it in the denominator', () => {
    const samples = [
      attributed(sample('https://x.com/a', { cls: { value: 0.1, status: 'ok' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unsupported' } })),
      attributed(sample('https://x.com/a', { cls: { value: null, status: 'unknown' } })),
      // An unrecognized status is treated as not-ok — even with a numeric value.
      attributed(sample('https://x.com/a', { cls: { value: 0.9, status: 'brand-new-status' as never } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.cls).toEqual({ p75: 0.1, ok: 1, total: 4 });
  });

  it('renders a metric with nothing measured as p75 null, never 0', () => {
    const samples = [
      attributed(sample('https://x.com/a', { inp: { value: null, status: 'no-interaction' } })),
      attributed(sample('https://x.com/a', { inp: { value: null, status: 'no-interaction' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.inp).toEqual({ p75: null, ok: 0, total: 2 });
  });

  it('carries unknown metric names through — the name set is open', () => {
    const samples = [
      attributed(sample('https://x.com/a', { myCustomTiming: { value: 5, status: 'ok' } })),
    ];
    const rows = aggregateRoutes(samples);
    expect(rows[0]!.metrics.myCustomTiming).toEqual({ p75: 5, ok: 1, total: 1 });
  });

  it('has NO MEAN anywhere in the model', () => {
    const rows = aggregateRoutes([
      attributed(sample('https://x.com/a', { lcp: { value: 1, status: 'ok' } })),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/mean|avg|average/i);
  });
});
