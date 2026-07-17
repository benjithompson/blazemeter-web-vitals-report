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

export const defaultTransport: Transport = (url, init) =>
  fetch(url, init) as unknown as Promise<HttpResponse>;

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
