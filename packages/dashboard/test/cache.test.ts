import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheMaster } from '../src/cache.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import { makeZip } from './helpers/zip.js';
import type { Credentials } from '../src/http.js';

const creds: Credentials = { id: 'k', secret: 's' };
const STATUS_RE = /\/masters\/([^/]+)\/status$/;
const LOGS_RE = /\/sessions\/([^/]+)\/reports\/logs$/;

// Two Engines: aaa has an artifact, bbb died and emitted none.
function twoEngineHandler(zipA: Buffer) {
  return (url: string) => {
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
    if (/\/sessions\/r-v4-aaa\/reports\/logs$/.test(url)) {
      return jsonResponse({
        result: { data: [{ filename: 'artifacts.zip', dataUrl: 'https://storage/aaa?sig=1' }] },
      });
    }
    if (/\/sessions\/r-v4-bbb\/reports\/logs$/.test(url)) {
      return jsonResponse({ result: { data: [{ filename: 'bzt.log', dataUrl: 'x' }] } });
    }
    if (url.startsWith('https://storage/aaa')) return bytesResponse(zipA);
    throw new Error(`unexpected ${url}`);
  };
}

let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(path.join(tmpdir(), 'bzm-cache-'));
});
afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('cacheMaster', () => {
  it('enumerates sessions, extracts namespaced, records the no-artifact Engine', async () => {
    const zipA = makeZip([
      { name: 'repeat0.json', data: Buffer.from('a0') },
      { name: 'repeat18.json', data: Buffer.from('a18') },
    ]);
    const { transport } = recordingTransport(twoEngineHandler(zipA));

    const manifest = await cacheMaster('82724289', { creds, transport, cacheRoot });

    expect(manifest.sessions).toHaveLength(2);
    const aaa = manifest.sessions.find((s) => s.sessionId === 'r-v4-aaa')!;
    const bbb = manifest.sessions.find((s) => s.sessionId === 'r-v4-bbb')!;
    expect(aaa.artifact).toBe('present');
    expect(aaa.fileCount).toBe(2);
    expect(bbb.artifact).toBe('no-artifact');

    // Extracted, namespaced by sessionId.
    const masterDir = path.join(cacheRoot, '82724289');
    expect(await readdir(path.join(masterDir, 'r-v4-aaa'))).toEqual(
      expect.arrayContaining(['repeat0.json', 'repeat18.json']),
    );
    // Raw zip bytes cached too.
    expect(existsSync(path.join(masterDir, 'r-v4-aaa.zip'))).toBe(true);
    // No zip for the dead Engine.
    expect(existsSync(path.join(masterDir, 'r-v4-bbb.zip'))).toBe(false);
  });

  it('does no network calls on a second run against a cached master', async () => {
    const zipA = makeZip([{ name: 'repeat0.json', data: Buffer.from('a0') }]);
    const first = recordingTransport(twoEngineHandler(zipA));
    await cacheMaster('82724289', { creds, transport: first.transport, cacheRoot });
    expect(first.calls.length).toBeGreaterThan(0);

    // Second run: a transport that throws if touched.
    const second = recordingTransport(() => {
      throw new Error('network call on a cached master');
    });
    const manifest = await cacheMaster('82724289', {
      creds,
      transport: second.transport,
      cacheRoot,
    });
    expect(second.calls).toHaveLength(0);
    expect(manifest.sessions).toHaveLength(2);
    // Re-extraction still ran from the cached zip.
    expect(await readFile(path.join(cacheRoot, '82724289', 'r-v4-aaa', 'repeat0.json'), 'utf8')).toBe('a0');
  });
});
