import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  listSessions,
  findArtifactUrl,
  fetchArtifactBytes,
  getMaster,
  resolveApiBase,
} from '../src/api.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import {
  createTransport,
  parseRetryAfter,
  type Credentials,
  type Transport,
  type TransportPolicy,
} from '../src/http.js';
import { runCli } from '../src/cli.js';

const creds: Credentials = { id: 'key-id', secret: 'key-secret' };

const STATUS_RE = /\/masters\/([^/]+)\/status$/;
const LOGS_RE = /\/sessions\/([^/]+)\/reports\/logs$/;

describe('listSessions', () => {
  it('enumerates every session — never assumes exactly one', async () => {
    const { transport, calls } = recordingTransport((url) => {
      if (STATUS_RE.test(url)) {
        return jsonResponse({
          result: {
            sessions: [
              { id: 'r-v4-aaa', status: 'ENDED', locationId: 'us-west-1' },
              { id: 'r-v4-bbb', status: 'ENDED', locationId: 'us-west-2' },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const sessions = await listSessions('82724289', { creds, transport });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).toEqual(['r-v4-aaa', 'r-v4-bbb']);
    expect(sessions[1]!.locationId).toBe('us-west-2');
    expect(calls[0]).toContain('/api/v4/masters/82724289/status');
    expect(calls[0]).toMatch(/^https:\/\/a\.blazemeter\.com/);
  });

  it('sends Basic auth on the listing call', async () => {
    let seenAuth: string | undefined;
    const transport = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenAuth = init?.headers?.Authorization;
      return jsonResponse({ result: { sessions: [{ id: 'r-v4-a' }] } });
    };
    await listSessions('1', { creds, transport });
    expect(seenAuth).toBe(`Basic ${Buffer.from('key-id:key-secret').toString('base64')}`);
  });
});

describe('findArtifactUrl', () => {
  it('picks the artifacts.zip dataUrl from /reports/logs', async () => {
    const { transport } = recordingTransport((url) => {
      if (LOGS_RE.test(url)) {
        return jsonResponse({
          result: {
            data: [
              { filename: 'bzt.log', dataUrl: 'https://storage/bzt' },
              { filename: 'artifacts.zip', dataUrl: 'https://storage/artifacts?sig=1' },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const url = await findArtifactUrl('r-v4-aaa', { creds, transport });
    expect(url).toBe('https://storage/artifacts?sig=1');
  });

  it('returns null when the session has no artifacts.zip entry', async () => {
    const { transport } = recordingTransport(() =>
      jsonResponse({ result: { data: [{ filename: 'bzt.log', dataUrl: 'x' }] } }),
    );
    const url = await findArtifactUrl('r-v4-dead', { creds, transport });
    expect(url).toBeNull();
  });
});

describe('fetchArtifactBytes', () => {
  it('re-lists /reports/logs immediately before downloading (never a cached url)', async () => {
    const zip = Buffer.from('PK-fake-zip');
    const { transport, calls } = recordingTransport((url) => {
      if (LOGS_RE.test(url)) {
        return jsonResponse({
          result: { data: [{ filename: 'artifacts.zip', dataUrl: 'https://storage/dl?sig=1' }] },
        });
      }
      if (url.startsWith('https://storage/dl')) return bytesResponse(zip);
      throw new Error(`unexpected ${url}`);
    });

    const bytes = await fetchArtifactBytes('r-v4-aaa', { creds, transport });
    expect(bytes).not.toBeNull();
    expect(Buffer.compare(bytes!, zip)).toBe(0);
    // The listing call happens right before the download.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(LOGS_RE);
    expect(calls[1]).toMatch(/^https:\/\/storage\/dl/);
  });

  it('records a no-artifact session as null rather than throwing', async () => {
    const { transport } = recordingTransport(() =>
      jsonResponse({ result: { data: [{ filename: 'bzt.log', dataUrl: 'x' }] } }),
    );
    await expect(fetchArtifactBytes('r-v4-dead', { creds, transport })).resolves.toBeNull();
  });

  it('retries a stale 403 by re-listing and re-fetching a fresh dataUrl', async () => {
    const zip = Buffer.from('PK-fresh');
    let listCount = 0;
    const { transport, calls } = recordingTransport((url) => {
      if (LOGS_RE.test(url)) {
        listCount += 1;
        return jsonResponse({
          result: { data: [{ filename: 'artifacts.zip', dataUrl: `https://storage/dl?sig=${listCount}` }] },
        });
      }
      if (url === 'https://storage/dl?sig=1') return bytesResponse(Buffer.alloc(0), 403); // stale
      if (url === 'https://storage/dl?sig=2') return bytesResponse(zip); // fresh
      throw new Error(`unexpected ${url}`);
    });

    const bytes = await fetchArtifactBytes('r-v4-aaa', { creds, transport });
    expect(bytes).not.toBeNull();
    expect(Buffer.compare(bytes!, zip)).toBe(0);
    expect(listCount).toBe(2); // re-listed on the stale 403
    const logCalls = calls.filter((c) => LOGS_RE.test(c));
    expect(logCalls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ D3 (#32)
//
// The real transport against REAL local HTTP servers (127.0.0.1, ephemeral
// ports — still no test touches the internet). Before D3 a server that
// accepted the connection and never answered hung the CLI forever, and
// BLAZEMETER_API_BASE was ignored, so the dashboard could not even be pointed
// at such a server.

interface FakeServer {
  base: string;
  host: string;
  requests: string[];
  close(): Promise<void>;
}

const servers: FakeServer[] = [];

async function fakeServer(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
): Promise<FakeServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  const fake: FakeServer = {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      (closed ??= new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
  };
  servers.push(fake);
  return fake;
}

const hang = () => {}; // accept, read, never answer

function json(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** A transport with test-sized timeouts and no real backoff sleeps. */
function fastTransport(overrides: Partial<TransportPolicy> = {}) {
  const sleeps: number[] = [];
  const transport = createTransport({
    apiTimeoutMs: 300,
    downloadTimeoutMs: 2_000,
    downloadStallMs: 300,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { transport, sleeps };
}

const SIGNED_QUERY = 'Signature=TOPSECRET-sig&Expires=1752700000&AWSAccessKeyId=AKIA-NOT-REAL';
const LEAK_RE = /TOPSECRET|Signature|AKIA|\?/;

beforeEach(() => {
  vi.stubEnv('BLAZEMETER_API_BASE', ''); // a developer's own setting must not leak in
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('BLAZEMETER_API_BASE', () => {
  it('defaults to https://a.blazemeter.com', () => {
    expect(resolveApiBase({})).toBe('https://a.blazemeter.com');
    expect(resolveApiBase({ BLAZEMETER_API_BASE: '  ' })).toBe('https://a.blazemeter.com');
  });

  it('is trimmed and loses trailing slashes, as the collector reads it', () => {
    expect(resolveApiBase({ BLAZEMETER_API_BASE: ' https://bzm.example.com/ ' })).toBe(
      'https://bzm.example.com',
    );
  });

  it('a value that is not an http(s) URL fails loudly', () => {
    expect(() => resolveApiBase({ BLAZEMETER_API_BASE: 'a.blazemeter.com' })).toThrow(
      /BLAZEMETER_API_BASE must be an http\(s\) URL/,
    );
  });

  it('is honoured by every listing call', async () => {
    vi.stubEnv('BLAZEMETER_API_BASE', 'https://bzm.example.com/');
    const { transport, calls } = recordingTransport((url) => {
      if (STATUS_RE.test(url)) return jsonResponse({ result: { sessions: [{ id: 'r-v4-a' }] } });
      if (LOGS_RE.test(url)) return jsonResponse({ result: { data: [] } });
      return jsonResponse({ result: { name: 'n' } });
    });
    await getMaster('1', { creds, transport });
    await listSessions('1', { creds, transport });
    await findArtifactUrl('r-v4-a', { creds, transport });
    expect(calls).toEqual([
      'https://bzm.example.com/api/v4/masters/1',
      'https://bzm.example.com/api/v4/masters/1/status',
      'https://bzm.example.com/api/v4/sessions/r-v4-a/reports/logs',
    ]);
  });
});

describe('timeouts: a hung server fails the CLI fast, naming the host and nothing signed', () => {
  async function runAgainst(server: FakeServer, transport: Transport) {
    const workDir = await mkdtemp(path.join(tmpdir(), 'bzm-d3-'));
    const started = Date.now();
    const err = await runCli({
      argv: ['--master', '33', '--out', path.join(workDir, 'r.html')],
      // runCli reads BLAZEMETER_API_BASE from its own env (D1), not process.env.
      env: {
        BLAZEMETER_API_BASE: server.base,
        BLAZEMETER_API_KEY_ID: 'stub-id',
        BLAZEMETER_API_KEY_SECRET: 'stub-secret',
      },
      transport,
      cacheRoot: path.join(workDir, 'cache'),
      log: () => {},
    }).then(
      () => {
        throw new Error('expected the run to fail');
      },
      (e: Error) => e,
    );
    const elapsed = Date.now() - started;
    await rm(workDir, { recursive: true, force: true });
    return { err, elapsed };
  }

  /** The API answers; the pre-signed download is served by `download`. */
  function blazemeterWith(download: (res: ServerResponse) => void) {
    return fakeServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/dl/')) return download(res);
      if (url.endsWith('/status')) {
        return json(res, { result: { sessions: [{ id: 'r-v4-d3', status: 'ENDED', locationId: 'l' }] } });
      }
      if (url.endsWith('/reports/logs')) {
        const dataUrl = `http://${req.headers.host}/dl/r-v4-d3/artifacts.zip?${SIGNED_QUERY}`;
        return json(res, { result: { data: [{ filename: 'artifacts.zip', dataUrl }] } });
      }
      return json(res, { result: { name: 'D3' } });
    });
  }

  it('an API call that never answers times out (30 s by default; 300 ms here), once, with the host named', async () => {
    const server = await fakeServer(hang);
    const { transport } = fastTransport();
    const { err, elapsed } = await runAgainst(server, transport);
    expect(err.message).toBe(`GET ${server.host}/api/v4/masters/33 timed out after 0.3 s`);
    expect(elapsed).toBeLessThan(3_000);
    expect(server.requests).toHaveLength(1); // a hung server is not retried
  });

  it('a download that never sends headers times out without leaking the signed query', async () => {
    const server = await blazemeterWith(hang);
    const { transport } = fastTransport({ downloadTimeoutMs: 400, downloadStallMs: 10_000 });
    const { err, elapsed } = await runAgainst(server, transport);
    expect(err.message).toBe(`artifact download from ${server.host} timed out after 0.4 s`);
    expect(elapsed).toBeLessThan(3_000);
    expect(err.message).not.toMatch(LEAK_RE);
  });

  it('a download that stalls mid-body is abandoned after the stall timeout', async () => {
    const server = await blazemeterWith((res) => {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(Buffer.from('PK\u0003\u0004 partial')); // then nothing, forever
    });
    const { transport } = fastTransport({ downloadTimeoutMs: 10_000, downloadStallMs: 300 });
    const { err, elapsed } = await runAgainst(server, transport);
    expect(err.message).toBe(`artifact download from ${server.host} stalled: no data for 0.3 s`);
    expect(elapsed).toBeLessThan(3_000);
    expect(err.message).not.toMatch(LEAK_RE);
  });

  it('a download that keeps trickling is NOT a stall', async () => {
    const zipBytes = Buffer.from('0123456789');
    const server = await fakeServer((_req, res) => {
      res.writeHead(200);
      let i = 0;
      const tick = setInterval(() => {
        if (i < zipBytes.length) {
          res.write(zipBytes.subarray(i, i + 1));
          i += 1;
        } else {
          clearInterval(tick);
          res.end();
        }
      }, 40); // ~440 ms in all: longer than the stall timeout, never silent that long
    });
    const { transport } = fastTransport({ downloadStallMs: 250 });
    const res = await transport(`${server.base}/dl/a.zip?${SIGNED_QUERY}`, { kind: 'download' });
    expect(Buffer.from(await res.arrayBuffer()).equals(zipBytes)).toBe(true);
  });
});

describe('retry: 429, 5xx and network errors, with backoff and Retry-After', () => {
  it('a 503 then a 200 succeeds', async () => {
    const server = await fakeServer((_req, res, n) =>
      n === 1
        ? json(res, { error: 'busy' }, 503)
        : json(res, { result: { sessions: [{ id: 'r-v4-ok' }] } }),
    );
    const { transport, sleeps } = fastTransport();
    const sessions = await listSessions('1', { creds, transport, apiBase: server.base });
    expect(sessions.map((s) => s.id)).toEqual(['r-v4-ok']);
    expect(server.requests).toHaveLength(2);
    expect(sleeps).toEqual([500 + 0.5 * 500]); // base·2⁰ + jitter
  });

  it('backs off exponentially with jitter, gives up after 3 retries, and reports the status', async () => {
    const server = await fakeServer((_req, res) => json(res, {}, 502));
    const { transport, sleeps } = fastTransport({ random: () => 0 });
    await expect(listSessions('1', { creds, transport, apiBase: server.base })).rejects.toThrow(
      'GET /masters/1/status failed: 502',
    );
    expect(server.requests).toHaveLength(4); // 1 + 3 retries
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('honours Retry-After on a 429, in seconds or as an HTTP-date, clamped to 60 s', async () => {
    const server = await fakeServer((_req, res, n) => {
      if (n === 1) return json(res, {}, 429, { 'retry-after': '2' });
      if (n === 2) return json(res, {}, 429, { 'retry-after': '86400' });
      return json(res, { result: { name: 'ok' } });
    });
    const { transport, sleeps } = fastTransport();
    await expect(getMaster('1', { creds, transport, apiBase: server.base })).resolves.toEqual({
      name: 'ok',
    });
    expect(sleeps).toEqual([2_000, 60_000]);
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('does not retry a 4xx such as 404 (only 429 is transient)', async () => {
    const server = await fakeServer((_req, res) => json(res, {}, 404));
    const { transport } = fastTransport();
    await expect(getMaster('1', { creds, transport, apiBase: server.base })).rejects.toThrow(
      'failed: 404',
    );
    expect(server.requests).toHaveLength(1);
  });

  it('retries a refused connection, then fails naming the host — never the signed query', async () => {
    const server = await fakeServer(hang);
    await server.close(); // nothing listens on that port now
    const { transport, sleeps } = fastTransport();
    const err = await transport(`${server.base}/dl/r-v4-x/artifacts.zip?${SIGNED_QUERY}`, {
      kind: 'download',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const { message } = err as Error;
    expect(message.startsWith(`artifact download from ${server.host} failed after 4 attempts: `)).toBe(true);
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toMatch(LEAK_RE);
    expect(sleeps).toHaveLength(3);
  });

  it('a download 5xx is retried against the same pre-signed URL', async () => {
    const zipBytes = Buffer.from('PK-after-retry');
    const server = await fakeServer((_req, res, n) => {
      res.writeHead(n === 1 ? 500 : 200);
      res.end(n === 1 ? undefined : zipBytes);
    });
    const { transport } = fastTransport();
    const res = await transport(`${server.base}/dl/a.zip?${SIGNED_QUERY}`, { kind: 'download' });
    expect(Buffer.from(await res.arrayBuffer()).equals(zipBytes)).toBe(true);
    expect(server.requests).toEqual([`/dl/a.zip?${SIGNED_QUERY}`, `/dl/a.zip?${SIGNED_QUERY}`]);
  });
});
