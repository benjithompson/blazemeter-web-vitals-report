// The InfluxDB destination — the second Destination this ships (after BlazeMeter). It rides
// the SAME pusher seam: the pusher hands it neutral format-v1 Samples and this module
// projects them onto InfluxDB 2.x line-protocol Points via the shared InfluxWriter. When
// both sinks are configured they fan out side by side — BlazeMeter gets rounded integers
// because its API wants them; Influx gets the honest float64 because it can hold it.
//
// Split like the BlazeMeter sink:
//   1. PURE mapping (Sample→Point, wide format) + env readers — unit-tested, no I/O.
//   2. The InfluxDestination class (isEnabled/init/send/close) — delegates all I/O to the
//      writer, which owns the one fetch.
//
// Security, by construction: only NAMED vars are read; process.env is never serialized; the
// token travels only in the writer's Authorization header (never a Sample, log, or artifact).

import type { Sample, Metric } from 'bzm-vitals-format';
import type { Destination } from './pusher.js';
import { routeOf, resolveIdentity, type Env } from './shared.js';
import { InfluxWriter, type InfluxConfig, type InfluxFetchLike, type Point } from './influx-writer.js';

// ---------------------------------------------------------------------------
// 1. PURE mapping — Sample → wide-format Point.
// ---------------------------------------------------------------------------

/** The default measurement for the vitals feed. The KPI feed will name its own. */
export const DEFAULT_MEASUREMENT = 'web_vitals';

/** Everything the mapping needs beyond the Sample itself — resolved once per worker. */
export interface InfluxMappingContext {
  measurement: string;
  location: string;
  /** The Engine tier, or null to AGGREGATE per location (omit the engine tag entirely). */
  engine: string | null;
}

/**
 * A vital is pushable only when status is 'ok' with a finite value — every other status
 * yields NO field (never a placeholder, never 0), so a not-ok vital is simply absent from
 * the point. Values are kept NATIVE (float64): ms as measured, CLS as its true float — no
 * rounding, no ×1000 scaling. Influx stores float64 losslessly, so there is nothing to gain
 * by degrading precision the way the integer-only BlazeMeter API forces.
 */
function fieldValue(metric: Metric): number | null {
  if (metric.status !== 'ok') return null;
  if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return null;
  return metric.value;
}

/**
 * Project one Sample onto a single wide-format Point — one field per ok vital, keyed by the
 * lowercase vital name (ttfb/fcp/lcp/cls/inp, exactly the Sample.vitals keys). Returns null
 * when NO vital is ok (an empty field set is not a valid line — the writer would skip it, so
 * we never build it). Timestamp is Sample.ts verbatim (epoch-ms; the writer posts at
 * precision=ms). Tags are the bounded dimensions only: route, location, project, title — and
 * engine when broken out. Load-generation mechanics (worker/repeat) are deliberately NOT
 * tags: they would fragment series for no analytical value.
 */
export function sampleToPoint(sample: Sample, ctx: InfluxMappingContext): Point | null {
  const fields: Record<string, number> = {};
  for (const [name, metric] of Object.entries(sample.vitals)) {
    const value = fieldValue(metric);
    if (value !== null) fields[name] = value;
  }
  if (Object.keys(fields).length === 0) return null;

  const tags: Record<string, string> = {
    route: routeOf(sample),
    location: ctx.location,
    project: sample.test.project,
    title: sample.test.title,
  };
  if (ctx.engine !== null) tags.engine = ctx.engine;

  return {
    measurement: ctx.measurement,
    tags,
    fields,
    timestamp: sample.ts,
  };
}

/** Map a batch of Samples to Points, dropping those with no ok vital. */
export function samplesToPoints(samples: Sample[], ctx: InfluxMappingContext): Point[] {
  return samples
    .map((s) => sampleToPoint(s, ctx))
    .filter((p): p is Point => p !== null);
}

// ---------------------------------------------------------------------------
// 1b. Env readers — connection config + token, from NAMED vars only.
// ---------------------------------------------------------------------------

/**
 * The write token, read from the DISCRETE var, checked in this order:
 *   1. The var named by BZM_INFLUX_TOKEN_ENV (pointer escape hatch — carries only a NAME),
 *      else BZM_INFLUX_TOKEN.
 *   2. BZM_SECRET_influxtoken — the BlazeMeter managed-secret convention: a secret listed
 *      as `influxtoken` under the Taurus `secrets:` param is injected into the Engine worker
 *      env under exactly this name, so live vitals→Influx works from an Engine without the
 *      token ever landing in an uploaded file or artifact.
 * process.env is never serialized — only the resolved token is read, only into the header.
 */
export function resolveInfluxToken(env: Env): string | undefined {
  const tokenVar = env.BZM_INFLUX_TOKEN_ENV?.trim() || 'BZM_INFLUX_TOKEN';
  return env[tokenVar]?.trim() || env.BZM_SECRET_influxtoken?.trim() || undefined;
}

/**
 * The full Influx connection, or null when any of the four required parts is missing. URL,
 * org, and bucket come from their named vars directly; the token resolves via the token
 * indirection above. A null here means the sink simply does not exist (the local path).
 */
export function resolveInfluxConfig(env: Env): InfluxConfig | null {
  const url = env.BZM_INFLUX_URL?.trim();
  const org = env.BZM_INFLUX_ORG?.trim();
  const bucket = env.BZM_INFLUX_BUCKET?.trim();
  const token = resolveInfluxToken(env);
  if (!url || !org || !bucket || !token) return null;
  return { url, org, bucket, token };
}

/** The measurement for the vitals feed — override via BZM_INFLUX_MEASUREMENT, else default. */
export function resolveMeasurement(env: Env): string {
  return env.BZM_INFLUX_MEASUREMENT?.trim() || DEFAULT_MEASUREMENT;
}

// ---------------------------------------------------------------------------
// 2. The InfluxDestination — delegates all I/O to the shared writer.
// ---------------------------------------------------------------------------

export interface InfluxDeps {
  env?: Env;
  /** Injected transport (tests); defaults to the writer's global fetch. */
  fetch?: InfluxFetchLike;
  /** Per-request timeout override (tests). */
  timeoutMs?: number;
}

/**
 * The InfluxDB destination. Self-enables only when a full connection is resolvable and the
 * push is not kill-switched. Identity is entirely static (all from env), so init() has
 * nothing to resolve remotely — unlike the BlazeMeter sink it needs no masterId round-trip,
 * and it does NOT reach the BlazeMeter API to upgrade the location name (that would recouple
 * the sinks). Set BZM_VITALS_LOCATION for a human location tier; otherwise the Taurus
 * loc-{index} fallback keeps distinct locations on distinct series.
 */
export class InfluxDestination implements Destination {
  readonly name = 'influxdb';

  private readonly config: InfluxConfig | null;
  private readonly killed: boolean;
  private readonly measurement: string;
  private readonly location: string;
  /** The Engine tag, or null to aggregate per location (default). */
  private readonly engine: string | null;
  private readonly writer: InfluxWriter | null;

  constructor(deps: InfluxDeps = {}) {
    const env = deps.env ?? process.env;
    // Kill switch + location/engine tiers resolve identically for every sink.
    const identity = resolveIdentity(env);
    this.config = resolveInfluxConfig(env);
    this.killed = identity.killed;
    this.measurement = resolveMeasurement(env);
    this.location = identity.location;
    this.engine = identity.engine;
    // The writer is built only when a config exists; a disabled sink allocates nothing.
    this.writer =
      this.config !== null
        ? new InfluxWriter({ config: this.config, precision: 'ms', fetch: deps.fetch, timeoutMs: deps.timeoutMs })
        : null;
  }

  isEnabled(): boolean {
    return !this.killed && this.config !== null;
  }

  /** Identity is static — nothing to resolve. Live iff enabled. */
  async init(): Promise<boolean> {
    return this.isEnabled();
  }

  /** Map the batch's ok vitals to wide-format Points and write them. No-op when empty. */
  async send(batch: Sample[]): Promise<void> {
    if (this.writer === null) return;
    const points = samplesToPoints(batch, {
      measurement: this.measurement,
      location: this.location,
      engine: this.engine,
    });
    if (points.length === 0) return;
    await this.writer.write(points);
  }

  async close(): Promise<void> {
    // The pusher owns the drain; the Influx sink holds no per-worker resource to free.
  }
}
