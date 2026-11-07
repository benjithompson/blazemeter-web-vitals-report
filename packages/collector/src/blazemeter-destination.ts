// The BlazeMeter destination — the only Destination implementation this ships.
// It owns EVERYTHING BlazeMeter-specific: the Sample→time-series mapping, the locked
// metricPath, value encoding, masterId resolution, the injection POST, and api-key auth.
// The shared pusher (pusher.ts) knows none of this — it hands over neutral format-v1
// Samples and this module projects them onto BlazeMeter's custom time-series API.
//
// This file is split into two halves:
//   1. PURE mapping + env readers (unit-tested in blazemeter-mapping.test.ts) — no I/O.
//   2. The BlazeMeterDestination class (init/send/close) — the one place fetch is called.
//
// Security, by construction: only the NAMED credential vars are read; process.env is
// never serialized; the key travels only in the Authorization header (never in a Sample,
// a log line, or any on-disk artifact).

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
// The identity/kill-switch env readers live in the shared cross-sink module (both sinks
// resolve identity from one source); routeOf comes from bzm-vitals-format. Imported, not
// re-exported: importers take them from the shared module directly, which keeps the
// single-file standalone bundle free of a dangling relative re-export that would break at load.
import { resolveIdentity, type Env } from './shared.js';

// ---------------------------------------------------------------------------
// 1. PURE mapping — the injection contract, expressed as data transforms.
// ---------------------------------------------------------------------------

/** One BlazeMeter custom-data injection interval — exactly the wire shape. */
export interface Interval {
  _id: { masterId: number; metricPath: string; ts: number };
  kpis: Array<{ value: number; ts: number }>;
  profileName: string;
}

/** Everything the mapping needs beyond the Sample itself — resolved once per worker. */
export interface MappingContext {
  masterId: number;
  location: string;
  /** The Engine tier, or null to AGGREGATE per location (omit the tier so every Engine in
   *  a location shares one series and BlazeMeter averages them). */
  engine: string | null;
  profileName: string;
}

/** metricPath root tier — literal, the top of the Timeline tree. */
const ROOT_TIER = 'Web Vitals';
/** Tier separator. The tier ORDER is the locked decision; this exact string is not. */
const TIER_SEP = ' | ';

/**
 * Encode one metric into its Timeline leaf + integer value, or null when it must not be
 * pushed. Only `status: 'ok'` with a finite value is pushable — every other status
 * yields NO interval (never a placeholder, never 0). ms vitals round to the nearest
 * integer under an uppercase leaf; CLS scales ×1000 under the self-describing `CLS×1000`
 * leaf so a good page's 0.08 reads as 80, not a collapsed 0.
 */
function encodeMetric(name: string, metric: Metric): { leaf: string; value: number } | null {
  if (metric.status !== 'ok') return null;
  if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return null;
  if (name === 'cls') return { leaf: 'CLS×1000', value: Math.round(metric.value * 1000) };
  return { leaf: name.toUpperCase(), value: Math.round(metric.value) };
}

/**
 * Project one Sample onto its injection intervals — one per ok vital, none for the rest.
 * ts is floored to epoch seconds (Sample.ts is epoch-ms at Navigation start) and shared
 * by both `_id.ts` and the kpi's `ts`. metricPath carries the locked tier order with the
 * metric as the leaf.
 */
export function sampleToIntervals(sample: Sample, ctx: MappingContext): Interval[] {
  const ts = Math.floor(sample.ts / 1000);
  const route = routeOf(sample);
  const intervals: Interval[] = [];
  for (const [name, metric] of Object.entries(sample.vitals)) {
    const encoded = encodeMetric(name, metric);
    if (encoded === null) continue;
    // Engine tier is included only in per-Engine mode; otherwise it is omitted so every
    // Engine in a location aggregates onto one series.
    const tiers =
      ctx.engine !== null
        ? [ROOT_TIER, ctx.location, ctx.engine, route, encoded.leaf]
        : [ROOT_TIER, ctx.location, route, encoded.leaf];
    const metricPath = tiers.join(TIER_SEP);
    intervals.push({
      _id: { masterId: ctx.masterId, metricPath, ts },
      kpis: [{ value: encoded.value, ts }],
      profileName: ctx.profileName,
    });
  }
  return intervals;
}

/** The full POST body for a batch — every sample's intervals flattened into one array. */
export function buildInjectionBody(samples: Sample[], ctx: MappingContext): { intervals: Interval[] } {
  return { intervals: samples.flatMap((s) => sampleToIntervals(s, ctx)) };
}

// ---------------------------------------------------------------------------
// 1b. Env readers — activation + identity, from NAMED vars only.
// ---------------------------------------------------------------------------

/** api-key id + secret — the pair that ever names the credential in this module. */
export interface Credentials {
  id: string;
  secret: string;
}

/**
 * api-key id/secret — read from the DISCRETE env vars, checked in this order:
 *   1. `BLAZEMETER_API_KEY_ID` / `BLAZEMETER_API_KEY_SECRET` (set directly, local / CI) —
 *      or, if the pointer vars below are set, the env vars they name.
 *   2. `BZM_SECRET_apikeyid` / `BZM_SECRET_apikeysecret` — the BlazeMeter managed-secret
 *      convention: secret names are lowercase-only, and listing two secrets named
 *      `apikeyid` / `apikeysecret` under the Taurus `secrets:` param injects them into the
 *      worker env under exactly these names — nothing else in config, and the key never in
 *      an uploaded file or artifact.
 *
 * The pointer vars are the escape hatch for any other secret naming (they carry only a var
 * NAME, never the value): `BZM_VITALS_KEY_ID_ENV` / `BZM_VITALS_KEY_SECRET_ENV` say WHICH
 * env var holds each credential. The file-path BLAZEMETER_API_KEY form is a local
 * convenience, irrelevant on an Engine and deliberately ignored. `process.env` is never
 * serialized — only the resolved id/secret are read, and only into the Authorization header.
 */
export function readDiscreteCredentials(env: Env): Credentials | null {
  const idVar = env.BZM_VITALS_KEY_ID_ENV?.trim() || 'BLAZEMETER_API_KEY_ID';
  const secretVar = env.BZM_VITALS_KEY_SECRET_ENV?.trim() || 'BLAZEMETER_API_KEY_SECRET';
  const id = env[idVar] || env.BZM_SECRET_apikeyid;
  const secret = env[secretVar] || env.BZM_SECRET_apikeysecret;
  if (id && secret) return { id, secret };
  return null;
}

// ---------------------------------------------------------------------------
// 2. The BlazeMeterDestination — the one place fetch is called.
// ---------------------------------------------------------------------------

/** Minimal response shape — the subset of the global fetch Response this uses. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Read for Retry-After only; optional so a minimal test double can omit it. */
  headers?: { get(name: string): string | null };
}

/** The injectable transport. The default wraps the global fetch; tests pass a double. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

const DEFAULT_API_BASE = 'https://a.blazemeter.com';
const DEFAULT_PROFILE = 'Web Vitals';
/** Per-request timeout — a slow endpoint costs one request, never the run. */
const REQUEST_TIMEOUT_MS = 8_000;

export interface BlazeMeterDeps {
  env?: Env;
  /** Injected transport (tests); defaults to the global fetch. */
  fetch?: FetchLike;
  /** Per-request timeout override (tests). */
  timeoutMs?: number;
  /** Clock for request timeouts and retry backoff (tests inject a manual one). */
  clock?: Clock;
  /** Jitter source in [0, 1) for retry backoff (tests pin it). */
  random?: () => number;
}

/** Basic api_key_id:api_key_secret — the ONLY place the credential is ever materialised. */
function basicAuth(creds: Credentials): string {
  return 'Basic ' + Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
}

/** Coerce a masterId of unknown JSON type to a positive integer, or null if it isn't one. */
function coerceMasterId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The BlazeMeter destination. Self-enables only when discrete api-key creds are present,
 * the push is not kill-switched, and a master is resolvable (SESSION_ID or an explicit
 * override). init() resolves the masterId once per worker; send() POSTs the mapped
 * intervals. Everything BlazeMeter-specific lives here; the pusher stays neutral.
 */
export class BlazeMeterDestination implements Destination {
  readonly name = 'blazemeter';

  private readonly creds: Credentials | null;
  private readonly killed: boolean;
  private readonly apiBase: string;
  private readonly profileName: string;
  /** Location tier. Seeded from env (override / loc-{index}), upgraded to the real
   *  BlazeMeter location name from the master status in init() unless env set it explicitly. */
  private location: string;
  private readonly locationExplicit: boolean;
  /** The Engine tier label, or null to aggregate per location (default). */
  private readonly engine: string | null;
  private readonly sessionId: string | undefined;
  private readonly masterIdOverride: number | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly random: (() => number) | undefined;

  private masterId: number | null = null;
  /** Why init() came up dead — status + path, never a credential. Read by the pusher. */
  initFailure: string | null = null;

  constructor(deps: BlazeMeterDeps = {}) {
    const env = deps.env ?? process.env;
    // Kill switch + location/engine tiers resolve identically for every sink.
    const identity = resolveIdentity(env);
    this.creds = readDiscreteCredentials(env);
    this.killed = identity.killed;
    this.apiBase = (env.BLAZEMETER_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.profileName = env.BZM_VITALS_PROFILE?.trim() || DEFAULT_PROFILE;
    this.location = identity.location;
    this.locationExplicit = Boolean(env.BZM_VITALS_LOCATION?.trim() || env.LOCATION?.trim());
    // engine: null → aggregate per location (the default); a label → per-Engine series.
    this.engine = identity.engine;
    this.sessionId = env.SESSION_ID?.trim() || undefined;
    this.masterIdOverride = coerceMasterId(env.BLAZEMETER_MASTER_ID);
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
    this.timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.clock = deps.clock ?? realClock;
    this.random = deps.random;
  }

  isEnabled(): boolean {
    if (this.killed || this.creds === null) return false;
    // A master must be resolvable — either overridden, or discoverable from a session.
    return this.masterIdOverride !== null || this.sessionId !== undefined;
  }

  /**
   * Resolve identity once. masterId: override wins, else GET the session. Off on any
   * failure. Then best-effort upgrade the location tier to the real BlazeMeter location
   * name (LOCATION is absent on the Engine and GET /sessions returns a null locationId —
   * the name only lives in the master status, matched by our own SESSION_ID).
   */
  async init(): Promise<boolean> {
    if (this.masterIdOverride !== null) {
      this.masterId = this.masterIdOverride;
    } else {
      if (this.sessionId === undefined || this.creds === null) return false;
      const path = `/api/v4/sessions/${this.sessionId}`;
      try {
        const res = await this.request('GET', path);
        if (!res.ok) return this.dead(`${res.status} on GET ${path}${authHint(res.status)}; push off for this worker`);
        const body = (await res.json()) as { result?: { masterId?: unknown } };
        const resolved = coerceMasterId(body?.result?.masterId);
        if (resolved === null) return this.dead(`GET ${path} returned no usable masterId; push off for this worker`);
        this.masterId = resolved;
      } catch (err) {
        // network/timeout — the pusher isolates it; resolution is not retried
        return this.dead(`${errMessage(err)}; push off for this worker`);
      }
    }
    await this.upgradeLocationFromStatus();
    return true;
  }

  /**
   * Replace the env-derived location tier with the real BlazeMeter location name
   * (e.g. "us-west-1") read from GET /masters/{masterId}/status — the same source the
   * dashboard uses. Skipped when the operator set the location explicitly; best-effort,
   * so a failure or a not-yet-assigned locationId keeps the env-derived fallback.
   */
  private async upgradeLocationFromStatus(): Promise<void> {
    if (this.locationExplicit || this.masterId === null || this.sessionId === undefined) return;
    try {
      const res = await this.request('GET', `/api/v4/masters/${this.masterId}/status`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        result?: { sessions?: Array<{ id?: string; locationId?: unknown }> };
      };
      const mine = (body?.result?.sessions ?? []).find((s) => s.id === this.sessionId);
      const loc = typeof mine?.locationId === 'string' ? mine.locationId.trim() : '';
      if (loc) this.location = loc;
    } catch {
      // keep the env-derived fallback (loc-{index} / override / unknown-location)
    }
  }

  private dead(reason: string): false {
    this.initFailure = reason;
    return false;
  }

  /** POST the batch's ok vitals as injection intervals, retrying transient failures (429,
   *  5xx, timeouts, network errors) with backoff. No-op when nothing is pushable. */
  async send(batch: Sample[], signal?: AbortSignal): Promise<void> {
    if (this.masterId === null || this.creds === null) return;
    const body = buildInjectionBody(batch, {
      masterId: this.masterId,
      location: this.location,
      engine: this.engine,
      profileName: this.profileName,
    });
    if (body.intervals.length === 0) return; // never POST an empty payload
    await sendWithRetry(() => this.request('POST', '/api/v4/data/timeseries', body, signal).then(() => {}), {
      clock: this.clock,
      signal,
      random: this.random,
    });
  }

  async close(): Promise<void> {
    // The pusher owns the drain; the BlazeMeter sink holds no per-worker resource to free.
  }

  /**
   * One authenticated, timeout-bounded request. Throws a PushError on transport failure,
   * timeout or a non-ok POST, classified for retry (the pusher isolates it); its message is
   * status + method + path only. The credential appears ONLY in the Authorization header.
   * `outer` (the drain deadline) aborts the request early, like the per-request timeout.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    outer?: AbortSignal,
  ): Promise<FetchResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = this.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    let res: FetchResponse;
    try {
      const headers: Record<string, string> = { Authorization: basicAuth(this.creds!) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new PushError(`timed out after ${this.timeoutMs}ms on ${method} ${path}`, true);
      if (outer?.aborted) throw new PushError(`aborted at the drain deadline on ${method} ${path}`, false);
      throw new PushError(`network error on ${method} ${path}: ${errMessage(err)}`, true);
    } finally {
      timer.clear();
      outer?.removeEventListener('abort', onOuterAbort);
    }
    if (method === 'POST' && !res.ok) {
      throw new PushError(
        `${res.status} on ${method} ${path}${authHint(res.status)}`,
        isRetryableStatus(res.status),
        parseRetryAfter(res.headers?.get('retry-after')),
      );
    }
    return res;
  }
}

/** A pointer at the credential VARIABLES (never their values) for an auth failure. */
function authHint(status: number): string {
  return status === 401 || status === 403 ? ' (check the BlazeMeter api-key id/secret)' : '';
}

/** A transport error's message, with its cause code (ECONNREFUSED…) when fetch wraps one. */
function errMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' ? `${err.message} (${code})` : err.message;
}
