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

export const defaultTransport: Transport = withCertHint(
  (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>,
);

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
