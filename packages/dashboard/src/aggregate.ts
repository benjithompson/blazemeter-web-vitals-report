// Crude aggregation — the tracer bullet's statistics (issue #5).
//
// CRUDE means: correct enough to render, with the non-negotiables already
// right. Issue #6 replaces the internals (p50/p95, Cold Start labelling,
// failed-Execution toggle, per-Test/per-Engine slicing) — but what is pinned
// here must survive it:
//   - the percentile method: sorted[floor((n-1)*q)] — the ONLY common method
//     reproducing the real Report's known answers (p75=2276, p95=3120);
//   - percentiles over status === "ok" values only; any other status —
//     including ones this code has never heard of — is not-ok and never pooled;
//   - coverage (n_ok of n_total) beside every aggregate;
//   - NO MEAN anywhere in the model. Ever.
//
// Route derivation is likewise crude (issue #7 owns the table): the URL's path
// with query and fragment stripped, no further normalization. A declared route
// always wins over a derived one, and the raw URL is always kept on the Sample.

import type { AttributedSample } from './attribute.js';
import type { DashboardSample } from './parse.js';

/**
 * The pinned percentile method: sorted ascending, take sorted[floor((n-1)*q)].
 * Verified against the known-answer fixture — nearest-rank and linear
 * interpolation both fail to reproduce the real Report's values.
 */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    throw new Error('percentile of zero values — callers must render coverage, not a number');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)]!;
}

/** Derive the Route for a Sample. A declared Route always wins. */
export function routeOf(sample: DashboardSample): string {
  if (sample.route !== undefined) return sample.route;
  try {
    return new URL(sample.url).pathname;
  } catch {
    // Not URL-parseable — strip query/fragment by hand and keep the rest.
    return sample.url.split(/[?#]/, 1)[0]!;
  }
}

export interface MetricAggregate {
  /** null when nothing was measured — never 0. Render the coverage instead. */
  p75: number | null;
  /** Coverage: n_ok of n_total, stated wherever the aggregate is stated. */
  ok: number;
  total: number;
}

export interface RouteRow {
  route: string;
  sampleCount: number;
  /** Metric names are open — whatever the Samples carried. */
  metrics: Record<string, MetricAggregate>;
}

/**
 * Pool ALL Attributed Samples per Route (over sessionId and repeat — everything
 * else is a dimension to slice by) and compute p75 once over the pooled ok
 * values. The denominator for every metric is the Route's full Sample pool, so
 * "p75 over 41 of 50" reads directly off {ok, total}.
 */
export function aggregateRoutes(samples: AttributedSample[]): RouteRow[] {
  const byRoute = new Map<string, AttributedSample[]>();
  for (const s of samples) {
    const route = routeOf(s.sample);
    const pool = byRoute.get(route);
    if (pool) pool.push(s);
    else byRoute.set(route, [s]);
  }

  const rows: RouteRow[] = [];
  for (const [route, pool] of byRoute) {
    const metricNames = new Set<string>();
    for (const s of pool) for (const name of Object.keys(s.sample.vitals)) metricNames.add(name);

    const metrics: Record<string, MetricAggregate> = {};
    for (const name of metricNames) {
      const okValues: number[] = [];
      for (const s of pool) {
        const metric = s.sample.vitals[name];
        // Closed status vocabulary: only exactly "ok" is pooled. An
        // unrecognized status is not-ok even when it carries a number.
        if (metric && metric.status === 'ok' && typeof metric.value === 'number') {
          okValues.push(metric.value);
        }
      }
      metrics[name] = {
        p75: okValues.length > 0 ? percentile(okValues, 0.75) : null,
        ok: okValues.length,
        total: pool.length,
      };
    }
    rows.push({ route, sampleCount: pool.length, metrics });
  }

  // Busiest Route first — a stable, crude ordering for the tracer.
  rows.sort((a, b) => b.sampleCount - a.sampleCount || a.route.localeCompare(b.route));
  return rows;
}
