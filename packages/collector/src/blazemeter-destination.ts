// The BlazeMeter destination — the only Destination implementation this ships (issue #15).
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

import type { Sample, Metric } from 'bzm-vitals-format';
import type { Destination } from './pusher.js';

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
  engine: string;
  profileName: string;
}

/** metricPath root tier — literal, the top of the Timeline tree. */
const ROOT_TIER = 'Web Vitals';
/** Tier separator. The tier ORDER is the locked decision; this exact string is not. */
const TIER_SEP = ' | ';

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
    const metricPath = [ROOT_TIER, ctx.location, ctx.engine, route, encoded.leaf].join(TIER_SEP);
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

type Env = Record<string, string | undefined>;

/** The global kill switch: BZM_VITALS_PUSH in {0, off, false} disables ALL pushing. */
export function isPushKilled(env: Env): boolean {
  const v = (env.BZM_VITALS_PUSH ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false';
}

/** The BlazeMeter LOCATION (e.g. "us-west-1"), with a stable fallback for local runs. */
export function resolveLocation(env: Env): string {
  return env.LOCATION?.trim() || 'unknown-location';
}

/**
 * The per-location Engine label. An explicit BZM_VITALS_ENGINE override wins; otherwise
 * a `#`-ordinal derived from Taurus's 0-based sequential index (TAURUS_INDEX_ALL) so
 * concurrent Engines never share a series; otherwise `#1`. (The exact Taurus var is
 * confirmed on the live acceptance run; the override keeps this correct meanwhile.)
 */
export function resolveEngine(env: Env): string {
  const override = env.BZM_VITALS_ENGINE?.trim();
  if (override) return override;
  const idx = env.TAURUS_INDEX_ALL?.trim();
  if (idx !== undefined && idx !== '' && Number.isFinite(Number(idx))) {
    return `#${Number(idx) + 1}`;
  }
  return '#1';
}

/** api-key id + secret — the pair that ever names the credential in this module. */
export interface Credentials {
  id: string;
  secret: string;
}

/**
 * api-key id/secret — read from the DISCRETE env vars. By default those are
 * `BLAZEMETER_API_KEY_ID` / `BLAZEMETER_API_KEY_SECRET` (set directly for local / CI).
 *
 * On a BlazeMeter Engine the key is better supplied as a managed secret so it never lands
 * in an uploaded file or artifact — but a secret's name is lowercase-only, so it reaches
 * the worker under a name like `BZM_SECRET_apikeyid`, not `BLAZEMETER_API_KEY_ID`. Two
 * non-secret pointer vars let the config say WHICH env var holds each credential:
 *   BZM_VITALS_KEY_ID_ENV      -> name of the env var holding the id     (e.g. BZM_SECRET_apikeyid)
 *   BZM_VITALS_KEY_SECRET_ENV  -> name of the env var holding the secret (e.g. BZM_SECRET_apikeysecret)
 * These carry only a var NAME, never the value, so the key stays out of config.yml — and
 * this is also robust to the exact secret-env prefix. The file-path BLAZEMETER_API_KEY
 * form is a local convenience, irrelevant on an Engine and deliberately ignored.
 * `process.env` is never serialized — only the two named values are read, into the header.
 */
export function readDiscreteCredentials(env: Env): Credentials | null {
  const idVar = env.BZM_VITALS_KEY_ID_ENV?.trim() || 'BLAZEMETER_API_KEY_ID';
  const secretVar = env.BZM_VITALS_KEY_SECRET_ENV?.trim() || 'BLAZEMETER_API_KEY_SECRET';
  const id = env[idVar];
  const secret = env[secretVar];
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
  private readonly location: string;
  private readonly engine: string;
  private readonly sessionId: string | undefined;
  private readonly masterIdOverride: number | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  private masterId: number | null = null;

  constructor(deps: BlazeMeterDeps = {}) {
    const env = deps.env ?? process.env;
    this.creds = readDiscreteCredentials(env);
    this.killed = isPushKilled(env);
    this.apiBase = (env.BLAZEMETER_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.profileName = env.BZM_VITALS_PROFILE?.trim() || DEFAULT_PROFILE;
    this.location = resolveLocation(env);
    this.engine = resolveEngine(env);
    this.sessionId = env.SESSION_ID?.trim() || undefined;
    this.masterIdOverride = coerceMasterId(env.BLAZEMETER_MASTER_ID);
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
    this.timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  isEnabled(): boolean {
    if (this.killed || this.creds === null) return false;
    // A master must be resolvable — either overridden, or discoverable from a session.
    return this.masterIdOverride !== null || this.sessionId !== undefined;
  }

  /** Resolve the masterId once. Override wins; else GET the session. Off on any failure. */
  async init(): Promise<boolean> {
    if (this.masterIdOverride !== null) {
      this.masterId = this.masterIdOverride;
      return true;
    }
    if (this.sessionId === undefined || this.creds === null) return false;
    try {
      const res = await this.request('GET', `/api/v4/sessions/${this.sessionId}`);
      if (!res.ok) return false;
      const body = (await res.json()) as { result?: { masterId?: unknown } };
      const resolved = coerceMasterId(body?.result?.masterId);
      if (resolved === null) return false;
      this.masterId = resolved;
      return true;
    } catch {
      return false; // network/timeout — the pusher isolates; nothing is retried
    }
  }

  /** POST the batch's ok vitals as injection intervals. No-op when nothing is pushable. */
  async send(batch: Sample[]): Promise<void> {
    if (this.masterId === null || this.creds === null) return;
    const body = buildInjectionBody(batch, {
      masterId: this.masterId,
      location: this.location,
      engine: this.engine,
      profileName: this.profileName,
    });
    if (body.intervals.length === 0) return; // never POST an empty payload
    await this.request('POST', '/api/v4/data/timeseries', body);
  }

  async close(): Promise<void> {
    // The pusher owns the drain; the BlazeMeter sink holds no per-worker resource to free.
  }

  /** One authenticated, timeout-bounded request. Throws on transport failure or non-ok
   *  POST (the pusher swallows it); the credential appears ONLY in the Authorization header. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<FetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const headers: Record<string, string> = { Authorization: basicAuth(this.creds!) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (method === 'POST' && !res.ok) throw new Error(`injection POST ${path} → ${res.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the enabled destination set from the environment. Only BlazeMeter ships today;
 *  a future sink is one more entry here. The pusher re-checks isEnabled(), so returning a
 *  disabled destination is harmless — but we keep the set tight. */
export function createDestinationsFromEnv(deps: BlazeMeterDeps = {}): Destination[] {
  const bzm = new BlazeMeterDestination(deps);
  return bzm.isEnabled() ? [bzm] : [];
}
