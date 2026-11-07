// HTTP transport + credentials. The API client accepts an injectable transport so
// the test suite never touches the network (SPEC.md → "No live-network tests").

import { readFile } from 'node:fs/promises';

/** Minimal response shape — a subset of the global fetch Response. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpInit {
  headers?: Record<string, string>;
  /** Picks the timeout policy: 'api' (the default) for the JSON listing calls,
   *  'download' for an artifact zip. */
  kind?: 'api' | 'download';
}

/** The seam the tests stub. The default implementation wraps global fetch. */
export type Transport = (url: string, init?: HttpInit) => Promise<HttpResponse>;

/** TLS codes Node reports when a proxy re-signs HTTPS with a root it doesn't trust. */
const UNTRUSTED_CERT_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);

/** Global fetch buries the TLS code on `cause` (possibly nested); walk the chain. */
function untrustedCertCode(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && UNTRUSTED_CERT_CODES.has(code)) return code;
  }
  return undefined;
}

/**
 * Global fetch reports an untrusted certificate as a bare "fetch failed". Behind a
 * corporate proxy that is the common case, so rethrow it naming the fix. npm's
 * `cafile` doesn't reach Node's fetch — the fix must be Node-level.
 */
export function withCertHint(transport: Transport): Transport {
  return async (url, init) => {
    try {
      return await transport(url, init);
    } catch (err) {
      const code = untrustedCertCode(err);
      if (!code) throw err;
      throw new Error(
        `TLS certificate not trusted reaching ${new URL(url).host} (${code}). ` +
          `A corporate proxy is probably re-signing HTTPS traffic. Make Node trust your ` +
          `organization's root certificate: set NODE_OPTIONS=--use-system-ca (Node 22.15+/23.8+), ` +
          `or set NODE_EXTRA_CA_CERTS to the root certificate's PEM file.`,
        { cause: err },
      );
    }
  };
}

// ---------------------------------------------------------------- timeouts + retry

export interface TransportPolicy {
  /** Whole-request budget for an API call, headers and body. Default 30 s. */
  apiTimeoutMs: number;
  /** Whole-request budget for an artifact download. Default 120 s. */
  downloadTimeoutMs: number;
  /** A download that delivers no bytes for this long is abandoned. Default 30 s. */
  downloadStallMs: number;
  /** Retries after the first attempt, for 429, 5xx and network errors. Default 3. */
  retries: number;
  /** Backoff before retry n (0-based) is base·2ⁿ plus up to base of jitter. Default 500 ms. */
  backoffBaseMs: number;
  /** The longest Retry-After honoured; a longer one is clamped. Default 60 s. */
  maxRetryAfterMs: number;
  /** Seams for tests. */
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  fetch: typeof fetch;
}

const DEFAULT_POLICY: TransportPolicy = {
  apiTimeoutMs: 30_000,
  downloadTimeoutMs: 120_000,
  downloadStallMs: 30_000,
  retries: 3,
  backoffBaseMs: 500,
  maxRetryAfterMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  fetch: (input, init) => fetch(input, init),
};

/**
 * Where a request went, for an error message: the host, plus the path for an
 * API call. NEVER the query string: an artifact URL is pre-signed, and its
 * query is a live credential until it expires. A download names only the host.
 */
export function describeUrl(url: string, kind: 'api' | 'download' = 'api'): string {
  try {
    const u = new URL(url);
    return kind === 'download' ? `artifact download from ${u.host}` : `GET ${u.host}${u.pathname}`;
  } catch {
    return kind === 'download' ? 'artifact download' : 'GET <unparseable URL>';
  }
}

/** Seconds or an HTTP-date, as RFC 9110 allows; null when absent or garbage. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** A timeout or stall — final, never retried: a hung server stays hung, and
 *  retrying it would multiply the wait the timeout exists to bound. */
class TransportTimeout extends Error {}

/** A buffered response: the body was read inside the timeout, so a stall
 *  mid-body is a timeout too, and json()/arrayBuffer() cannot hang. */
function bufferedResponse(status: number, body: Uint8Array): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}

/** Read a body to the end, aborting when `stallMs` passes with no new bytes. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  stallMs: number,
  onStall: () => void,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(onStall, stallMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      arm();
    }
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const seconds = (ms: number) => `${ms / 1000} s`;

/** One attempt: fetch and read the whole body under the attempt's timeouts. */
async function attempt(
  url: string,
  init: HttpInit | undefined,
  policy: TransportPolicy,
): Promise<{ res: HttpResponse; retryAfter: string | null }> {
  const kind = init?.kind ?? 'api';
  const totalMs = kind === 'download' ? policy.downloadTimeoutMs : policy.apiTimeoutMs;
  const stallMs = kind === 'download' ? policy.downloadStallMs : totalMs;
  const total = AbortSignal.timeout(totalMs);
  const stall = new AbortController();
  const signal = AbortSignal.any([total, stall.signal]);
  const where = describeUrl(url, kind);
  try {
    const res = await policy.fetch(url, { headers: init?.headers, signal });
    const body = await readBody(res.body, stallMs, () => stall.abort());
    return { res: bufferedResponse(res.status, body), retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    if (total.aborted) {
      throw new TransportTimeout(`${where} timed out after ${seconds(totalMs)}`, { cause: err });
    }
    if (stall.signal.aborted) {
      throw new TransportTimeout(`${where} stalled: no data for ${seconds(stallMs)}`, { cause: err });
    }
    throw err;
  }
}

const retryableStatus = (status: number) => status === 429 || (status >= 500 && status <= 599);

/** The innermost message on a fetch error's cause chain ("connect
 *  ECONNREFUSED 127.0.0.1:8080"), which says more than "fetch failed". */
function rootMessage(err: unknown): string {
  let e = err;
  for (let depth = 0; depth < 5; depth++) {
    const cause = (e as { cause?: unknown } | null)?.cause;
    if (!(cause instanceof Error)) break;
    e = cause;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The real transport: global fetch, with
 *   - every call bounded by AbortSignal.timeout (30 s for an API call; 120 s
 *     for a download, which is also abandoned after 30 s with no bytes),
 *   - up to 3 retries of 429, 5xx and network errors, with exponential backoff
 *     plus jitter, honouring Retry-After (clamped to 60 s),
 *   - the TLS-certificate hint (withCertHint).
 * A timeout and an untrusted certificate are final, not retried. After the
 * last retry a 429/5xx response is returned as-is, for the caller's own
 * "failed: 503" message. Errors name the host, never a signed query string.
 */
export function createTransport(overrides: Partial<TransportPolicy> = {}): Transport {
  const policy: TransportPolicy = { ...DEFAULT_POLICY, ...overrides };
  // Retry-After rides beside the response rather than widening HttpResponse.
  const retryAfterOf = new WeakMap<HttpResponse, string | null>();
  const once: Transport = withCertHint(async (url, init) => {
    const { res, retryAfter } = await attempt(url, init, policy);
    retryAfterOf.set(res, retryAfter);
    return res;
  });

  return async (url, init) => {
    const where = describeUrl(url, init?.kind ?? 'api');
    for (let n = 0; ; n++) {
      let wait: number;
      try {
        const res = await once(url, init);
        if (!retryableStatus(res.status) || n >= policy.retries) return res;
        const asked = parseRetryAfter(retryAfterOf.get(res) ?? null);
        wait = asked !== null ? Math.min(asked, policy.maxRetryAfterMs) : backoff(n);
      } catch (err) {
        if (err instanceof TransportTimeout) throw err;
        if (untrustedCertCode(err)) throw err; // withCertHint's hint; a retry cannot fix trust
        if (n >= policy.retries) {
          throw new Error(`${where} failed after ${n + 1} attempts: ${rootMessage(err)}`, {
            cause: err,
          });
        }
        wait = backoff(n);
      }
      await policy.sleep(wait);
    }
  };

  function backoff(n: number): number {
    return policy.backoffBaseMs * 2 ** n + policy.random() * policy.backoffBaseMs;
  }
}

export const defaultTransport: Transport = createTransport();

export interface Credentials {
  id: string;
  secret: string;
}

/** Basic api_key_id:api_key_secret — needed only for the two listing calls. */
export function basicAuthHeader(creds: Credentials): string {
  const token = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Read credentials the way BlazeMeter's own tooling does:
 *   BLAZEMETER_API_KEY               -> path to an api-key.json {id, secret}
 *   BLAZEMETER_API_KEY_ID / _SECRET  -> discrete vars for CI
 * The file form wins when present; discrete vars are the CI fallback.
 */
export async function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Credentials> {
  const keyPath = env.BLAZEMETER_API_KEY;
  if (keyPath) {
    const raw = await readFile(keyPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (!parsed.id || !parsed.secret) {
      throw new Error(`BLAZEMETER_API_KEY file ${keyPath} is missing id/secret`);
    }
    return { id: parsed.id, secret: parsed.secret };
  }
  const id = env.BLAZEMETER_API_KEY_ID;
  const secret = env.BLAZEMETER_API_KEY_SECRET;
  if (id && secret) return { id, secret };
  throw new Error(
    'No BlazeMeter credentials. Set BLAZEMETER_API_KEY to an api-key.json path, ' +
      'or BLAZEMETER_API_KEY_ID and BLAZEMETER_API_KEY_SECRET.',
  );
}
