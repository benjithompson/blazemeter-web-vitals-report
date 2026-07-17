// A fake BlazeMeter custom-data API — the server DOUBLE the Seam A push test drives a real
// `npx playwright test` against. It answers exactly the two endpoints the BlazeMeter
// destination calls and records every request (URL, method, Authorization header, parsed
// JSON body) so the test can assert what the live run actually put on the wire — the
// resolution GET and the injection POST(s) — never a mock of "send was called".
//
// Sibling to fixture-server.ts (which serves the PAGES under test); this serves the API.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  /** The request path, e.g. "/api/v4/sessions/r-v4-abc" (no host). */
  path: string;
  /** The raw Authorization header exactly as received (undefined if none). */
  authorization: string | undefined;
  /** The parsed JSON body for POSTs; undefined for GETs / empty bodies. */
  body: unknown;
}

export interface BlazeMeterServer {
  url: string;
  /** Every request the double received, in arrival order. */
  requests: CapturedRequest[];
  /** GET /api/v4/sessions/{id} — the masterId resolutions. */
  sessionRequests(): CapturedRequest[];
  /** GET /api/v4/masters/{id}/status — the location-name resolutions. */
  statusRequests(): CapturedRequest[];
  /** POST /api/v4/data/timeseries — the injections. */
  injectionRequests(): CapturedRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // keep the raw text so a malformed body is still inspectable
  }
}

export interface BlazeMeterServerOptions {
  /** What GET /sessions/{id} resolves to; the test checks the injection bodies carry it. */
  masterId: number;
  /** Force GET /sessions/{id} to this status (default 200) — for the resolution-failure path. */
  sessionStatus?: number;
  /** Force POST /data/timeseries to this status (default 200) — for the push-failure path. */
  injectionStatus?: number;
  /** Sessions GET /masters/{id}/status returns — the collector reads its own locationId here
   *  (LOCATION is absent on a real Engine). Empty by default (location falls back). */
  statusSessions?: Array<{ id: string; locationId: string | null }>;
}

/**
 * Start the double. Beyond the happy path it can be told to FAIL a given endpoint
 * (sessionStatus / injectionStatus) so a real run can prove that a broken API never
 * fails the test — the best-effort guarantee.
 */
export async function startBlazeMeterServer(opts: BlazeMeterServerOptions): Promise<BlazeMeterServer> {
  const requests: CapturedRequest[] = [];
  const sessionStatus = opts.sessionStatus ?? 200;
  const injectionStatus = opts.injectionStatus ?? 200;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    void readBody(req).then((body) => {
      requests.push({
        method: req.method ?? 'GET',
        path,
        authorization: req.headers.authorization,
        body,
      });

      if (req.method === 'GET' && path.startsWith('/api/v4/sessions/')) {
        res.writeHead(sessionStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sessionStatus === 200 ? { result: { masterId: opts.masterId } } : { error: 'forced' }));
        return;
      }
      if (req.method === 'GET' && /^\/api\/v4\/masters\/\d+\/status$/.test(path)) {
        // The location name lives here (matched by session id), as on a real Engine.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { sessions: opts.statusSessions ?? [] } }));
        return;
      }
      if (req.method === 'POST' && path === '/api/v4/data/timeseries') {
        res.writeHead(injectionStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(injectionStatus === 200 ? { result: {} } : { error: 'forced' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sessionRequests: () => requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/v4/sessions/')),
    statusRequests: () => requests.filter((r) => r.method === 'GET' && /^\/api\/v4\/masters\/\d+\/status$/.test(r.path)),
    injectionRequests: () => requests.filter((r) => r.method === 'POST' && r.path === '/api/v4/data/timeseries'),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Decode a `Basic base64(id:secret)` header back to its id:secret pair (for leak assertions). */
export function decodeBasicAuth(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Basic ')) return null;
  return Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
}
