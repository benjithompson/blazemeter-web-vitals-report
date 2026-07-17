import { describe, it, expect } from 'vitest';
import { listSessions, findArtifactUrl, fetchArtifactBytes } from '../src/api.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import type { Credentials } from '../src/http.js';

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
