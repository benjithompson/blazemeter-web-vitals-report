// Cross-sink helpers shared by every Destination — route derivation and the env readers
// that resolve the location/engine tiers and the global push kill switch. These are
// sink-AGNOSTIC (they know nothing about BlazeMeter's metricPath or Influx's line
// protocol), so both destinations resolve identity from ONE source of truth: a location
// tier, an engine tier, and a route are computed identically no matter where they land.
//
// Both sinks (and the mapping unit tests) import these from HERE directly — not re-exported
// through blazemeter-destination.ts, so the single-file standalone bundle never carries a
// dangling relative re-export. When the Influx feed is ever extracted to its own package,
// this module travels with it.

import type { Sample } from 'bzm-vitals-format';

export type Env = Record<string, string | undefined>;

/**
 * Derive the Route for a Sample — the SAME routing the file report uses (dashboard
 * aggregate.ts routeOf): a declared Route wins verbatim; otherwise the URL pathname,
 * with a hand-rolled query/fragment strip for addresses the URL parser rejects.
 */
export function routeOf(sample: Sample): string {
  if (sample.route !== undefined) return sample.route;
  try {
    return new URL(sample.url).pathname;
  } catch {
    return sample.url.split(/[?#]/, 1)[0]!;
  }
}

/** The global kill switch: BZM_VITALS_PUSH in {0, off, false} disables ALL pushing. */
export function isPushKilled(env: Env): boolean {
  const v = (env.BZM_VITALS_PUSH ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false';
}

/**
 * Per-Engine breakdown vs per-location aggregation. Default is AGGREGATE (no Engine tier)
 * — a run with many Engines would otherwise flood the series space with #1…#N per
 * route/metric. Set BZM_VITALS_PER_ENGINE to 1/true/on to keep each Engine as its own
 * series (e.g. to spot one slow Engine within a location).
 */
export function isPerEngine(env: Env): boolean {
  const v = (env.BZM_VITALS_PER_ENGINE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * The location tier. Confirmed on a live Engine: there is NO location-name env var and
 * GET /sessions/{id} returns locationId:null at runtime, so the human name (us-west-1) is
 * unavailable on the Engine — BlazeMeter recovers it from the master status. So: an
 * explicit BZM_VITALS_LOCATION / LOCATION override wins; else the numeric Taurus location
 * index as `loc-{n}` (keeps distinct locations on distinct series); else a stable fallback
 * for local runs.
 */
export function resolveLocation(env: Env): string {
  const override = env.BZM_VITALS_LOCATION?.trim() || env.LOCATION?.trim();
  if (override) return override;
  const idx = env.TAURUS_LOCATIONS_INDEX?.trim();
  if (idx !== undefined && idx !== '' && Number.isFinite(Number(idx))) return `loc-${Number(idx)}`;
  return 'unknown-location';
}

/**
 * The per-Engine label. An explicit BZM_VITALS_ENGINE override wins; otherwise a
 * `#`-ordinal from Taurus's 1-based per-Engine session index (TAURUS_SESSIONS_INDEX) so
 * concurrent Engines never share a series; otherwise `#1`. (Confirmed on a live Engine:
 * TAURUS_SESSIONS_INDEX is 1 and 2 across two Engines; TAURUS_INDEX_ALL does not exist.
 * The value is unique per Engine, so with the location tier it never pools distinct ones.)
 */
export function resolveEngine(env: Env): string {
  const override = env.BZM_VITALS_ENGINE?.trim();
  if (override) return override;
  const idx = env.TAURUS_SESSIONS_INDEX?.trim();
  if (idx !== undefined && idx !== '' && Number.isFinite(Number(idx))) {
    return `#${Number(idx)}`;
  }
  return '#1';
}

/** The identity every sink derives from the environment the same way: the global kill
 *  switch, the location tier, and the engine tier (null = aggregate per location). Resolving
 *  it in one place means a new tier env var is a one-line edit here, not in every sink. */
export interface SinkIdentity {
  killed: boolean;
  location: string;
  engine: string | null;
}

export function resolveIdentity(env: Env): SinkIdentity {
  return {
    killed: isPushKilled(env),
    location: resolveLocation(env),
    engine: isPerEngine(env) ? resolveEngine(env) : null,
  };
}
