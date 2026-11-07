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

import { routeOf, type Sample, type Metric } from 'bzm-vitals-format';
import {
  PushError,
  isRetryableStatus,
  parseRetryAfter,
  realClock,
  sendWithRetry,
  type Clock,
  type Destination,
} from './pusher.js';
import { resolveIdentity, type Env } from './shared.js';
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
  /** This Engine's numeric index — the per-Engine part of the timestamp offset. */
  engineIndex: number;
}

/**
 * The point time, in ns: `ts_ms·1e6 + (engineIndex·1000 + workerIndex) % 1e6`.
 *
 * Influx identifies a point by (measurement, tag set, timestamp) and silently OVERWRITES a
 * second write with the same identity. Two Samples measured in the same millisecond with the
 * same tags — two Engines in one location (aggregate mode has no engine tag), or two workers
 * — would otherwise collapse into one. The sub-millisecond offset is deterministic and
 * distinct for every (Engine, worker) writer while both indices stay under 1000, and never
 * moves the point out of its millisecond, so a query at ms resolution still reads Sample.ts.
 * BigInt because ns epochs (~1.7e18) exceed Number.MAX_SAFE_INTEGER.
 */
export function timestampNs(tsMs: number, engineIndex: number, workerIndex: number): bigint {
  const offset = (nonNegativeInt(engineIndex) * 1000 + nonNegativeInt(workerIndex)) % 1_000_000;
  return BigInt(Math.floor(tsMs)) * BigInt(1_000_000) + BigInt(offset);
}

function nonNegativeInt(n: number): number {
  return Number.isInteger(n) && n >= 0 ? n : 0;
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
 * we never build it). Timestamp is ns (see timestampNs; the writer posts at precision=ns).
 * Tags are the bounded dimensions: route, location, project, title, worker — and engine when
 * broken out. `worker` is there so concurrent workers' points stay distinct; its cardinality
 * is bounded by --workers, and it is not an analysis dimension (aggregate across it). `repeat`
 * is deliberately NOT a tag: it would fragment series for no analytical value.
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
    worker: String(sample.test.worker),
  };
  if (ctx.engine !== null) tags.engine = ctx.engine;

  return {
    measurement: ctx.measurement,
    tags,
    fields,
    timestamp: timestampNs(sample.ts, ctx.engineIndex, sample.test.worker),
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

/**
 * This Engine's numeric index for the timestamp offset: Taurus's 1-based per-Engine
 * TAURUS_SESSIONS_INDEX (unique per Engine in a Report — the same var the engine tier's
 * `#N` label derives from), else 0 for a local run. The BZM_VITALS_ENGINE override is a
 * free-form LABEL, not an index, so it does not feed this.
 */
export function resolveEngineIndex(env: Env): number {
  const raw = env.TAURUS_SESSIONS_INDEX?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
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
  /** Clock for request timeouts and retry backoff (tests inject a manual one). */
  clock?: Clock;
  /** Jitter source in [0, 1) for retry backoff (tests pin it). */
  random?: () => number;
}

/** The write path, for failure reasons — the query (org/bucket) is left out of them. */
const WRITE_PATH = '/api/v2/write';
/** Per-request timeout default, matching the writer's own. */
const INFLUX_REQUEST_TIMEOUT_MS = 8_000;

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
  private readonly engineIndex: number;
  private readonly fetchImpl: InfluxFetchLike;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly random: (() => number) | undefined;

  constructor(deps: InfluxDeps = {}) {
    const env = deps.env ?? process.env;
    // Kill switch + location/engine tiers resolve identically for every sink.
    const identity = resolveIdentity(env);
    this.config = resolveInfluxConfig(env);
    this.killed = identity.killed;
    this.measurement = resolveMeasurement(env);
    this.location = identity.location;
    this.engine = identity.engine;
    this.engineIndex = resolveEngineIndex(env);
    this.fetchImpl =
      deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<InfluxFetchLike>);
    this.timeoutMs = deps.timeoutMs ?? INFLUX_REQUEST_TIMEOUT_MS;
    this.clock = deps.clock ?? realClock;
    this.random = deps.random;
  }

  isEnabled(): boolean {
    return !this.killed && this.config !== null;
  }

  /** Identity is static — nothing to resolve. Live iff enabled. */
  async init(): Promise<boolean> {
    return this.isEnabled();
  }

  /** Map the batch's ok vitals to wide-format Points and write them, retrying transient
   *  failures (429, 5xx, timeouts, network errors) with backoff. No-op when empty. */
  async send(batch: Sample[], signal?: AbortSignal): Promise<void> {
    if (this.config === null) return;
    const points = samplesToPoints(batch, {
      measurement: this.measurement,
      location: this.location,
      engine: this.engine,
      engineIndex: this.engineIndex,
    });
    if (points.length === 0) return;
    const config = this.config;
    await sendWithRetry(() => this.writeOnce(config, points, signal), {
      clock: this.clock,
      signal,
      random: this.random,
    });
  }

  /**
   * One write attempt. The writer stays transport-agnostic (it knows nothing of retries), so
   * the destination hands it a transport that bounds the request on the injected clock,
   * aborts it at the drain deadline, and observes the response status and Retry-After — the
   * two facts the retry decision needs. Failures surface as a PushError whose message is
   * status + path (+ the server's error detail), never the token.
   */
  private async writeOnce(config: InfluxConfig, points: Point[], outer: AbortSignal | undefined): Promise<void> {
    const seen: { status: number | null; retryAfter: string | null } = { status: null, retryAfter: null };
    const base = this.fetchImpl;
    const timeoutMs = this.timeoutMs;
    const clock = this.clock;
    const transport: InfluxFetchLike = async (url, init) => {
      const controller = new AbortController();
      let timedOut = false;
      const timer = clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const forward = () => controller.abort();
      for (const s of [init?.signal, outer]) {
        if (s?.aborted) controller.abort();
        s?.addEventListener('abort', forward, { once: true });
      }
      try {
        const res = await base(url, { ...init, signal: controller.signal });
        seen.status = res.status;
        seen.retryAfter = (res as { headers?: { get(n: string): string | null } }).headers?.get('retry-after') ?? null;
        return res;
      } catch (err) {
        if (timedOut || init?.signal?.aborted) {
          throw new PushError(`timed out after ${timeoutMs}ms on POST ${WRITE_PATH}`, true);
        }
        if (outer?.aborted) throw new PushError(`aborted at the drain deadline on POST ${WRITE_PATH}`, false);
        throw new PushError(`network error on POST ${WRITE_PATH}: ${transportMessage(err)}`, true);
      } finally {
        timer.clear();
        for (const s of [init?.signal, outer]) s?.removeEventListener('abort', forward);
      }
    };
    const writer = new InfluxWriter({ config, precision: 'ns', fetch: transport, timeoutMs });
    try {
      await writer.write(points);
    } catch (err) {
      if (err instanceof PushError || seen.status === null) throw err;
      // The writer's non-2xx error: "influx write → <status>: <detail>". Keep the detail.
      const detail = (err instanceof Error ? err.message : String(err)).replace(/^influx write → \d+:?\s*/, '');
      throw new PushError(
        `${seen.status} on POST ${WRITE_PATH}${detail ? `: ${detail}` : ''}`,
        isRetryableStatus(seen.status),
        parseRetryAfter(seen.retryAfter),
      );
    }
  }

  async close(): Promise<void> {
    // The pusher owns the drain; the Influx sink holds no per-worker resource to free.
  }
}

/** A transport error's message, with its cause code (ECONNREFUSED…) when fetch wraps one. */
function transportMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' ? `${err.message} (${code})` : err.message;
}
