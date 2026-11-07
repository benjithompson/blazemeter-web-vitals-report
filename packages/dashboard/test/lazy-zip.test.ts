// Lazy zip reading, and one in-memory pipeline.
//
// A real artifacts.zip carries far more than records: video.webm, trace.zip,
// the html-report twins. Only the record entries are worth inflating; the
// rest must cost a central-directory read, never an inflate. And the API/cache
// path (--master) and local import (--artifacts) read zips through the same
// code, so over the same bytes they embed the same data.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OUTCOME_ATTACHMENT_PREFIX, SAMPLE_ATTACHMENT_PREFIX } from 'bzm-vitals-format';

// Count every inflate the reader performs, by compressed size.
const inflates = vi.hoisted(() => ({ sizes: [] as number[] }));
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    inflateRawSync: (buf: Buffer, opts?: import('node:zlib').ZlibOptions) => {
      inflates.sizes.push(buf.length);
      return actual.inflateRawSync(buf, opts);
    },
  };
});

import { readZipEntries } from '../src/zip.js';
import { readLocalArtifacts } from '../src/local.js';
import { runCli } from '../src/cli.js';
import type { ReportData } from '../src/report.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import { makeZip, type ZipInput } from './helpers/zip.js';
import { parseBlob } from './helpers/blob.js';

const VIDEO_BYTES = 50 * 1024 * 1024;
const STUB_ENV = {
  BLAZEMETER_API_KEY_ID: 'stub-key-id-d5',
  BLAZEMETER_API_KEY_SECRET: 'stub-key-secret-d5',
} as NodeJS.ProcessEnv;

const testId = (repeat: number) => ({
  file: 'shop.spec.ts',
  title: 'checkout',
  project: 'chromium',
  repeat,
  worker: 0,
});

function sample(repeat: number, navigationIndex: number, lcp: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ts: 1752700745069 + repeat * 1000 + navigationIndex,
      url: 'https://example.com/checkout',
      test: testId(repeat),
      navigationIndex,
      vitals: { lcp: { value: lcp, status: 'ok' } },
      navigation: { domContentLoadedMs: 500, loadEventMs: 900 },
      context: { workers: 1, resourceCount: 10, requestCount: 12, failedRequests: 0 },
    }),
  );
}

const outcome = (repeat: number, status: string) =>
  Buffer.from(JSON.stringify({ schemaVersion: 1, test: testId(repeat), status, retry: 0 }));

/** One Engine's artifacts.zip: three deflated records among non-record bulk. */
function engineZip(lcp: number, extra: ZipInput[] = []): Buffer {
  return makeZip([
    { name: `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaa.json`, data: sample(0, 1, lcp), deflate: true },
    { name: `${SAMPLE_ATTACHMENT_PREFIX}-1-bbbb.json`, data: sample(1, 1, lcp + 50), deflate: true },
    { name: `${OUTCOME_ATTACHMENT_PREFIX}-cccc.json`, data: outcome(1, 'failed'), deflate: true },
    { name: 'bzt.log', data: Buffer.from('taurus log line\n'.repeat(1000)), deflate: true },
    { name: 'config.yml', data: Buffer.from('execution: []\n'), deflate: true },
    ...extra,
  ]);
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'bzm-d5-'));
  inflates.sizes.length = 0;
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function stubApi(masterId: string, zips: Record<string, { locationId: string; zip: Buffer }>) {
  return recordingTransport((url) => {
    if (url.endsWith(`/masters/${masterId}/status`)) {
      return jsonResponse({
        result: {
          status: 'ENDED',
          sessions: Object.entries(zips).map(([id, z]) => ({ id, status: 'ENDED', locationId: z.locationId })),
        },
      });
    }
    if (url.endsWith(`/masters/${masterId}`)) return jsonResponse({ result: { name: 'D5 parity run' } });
    const logs = /\/sessions\/([^/]+)\/reports\/logs$/.exec(url);
    if (logs) {
      return jsonResponse({
        result: { data: [{ filename: 'artifacts.zip', dataUrl: `https://storage.example/${logs[1]}/a.zip` }] },
      });
    }
    const dl = /^https:\/\/storage\.example\/([^/]+)\//.exec(url);
    if (dl) return bytesResponse(zips[dl[1]!]!.zip);
    throw new Error(`unexpected ${url}`);
  });
}

describe('D5: lazy zip reading', () => {
  // The video's CRC is deliberately wrong: an entry that is never inflated is
  // never CRC-checked either, so it cannot fail the run.
  const video: ZipInput = { name: 'video.webm', data: Buffer.alloc(VIDEO_BYTES, 7), deflate: true, crc: 0xdeadbeef };

  it('readZipEntries inflates and CRC-checks only the entries the filter selects', async () => {
    const zip = engineZip(1200, [video]);
    const seen: string[] = [];
    const entries = await readZipEntries(zip, (name) => {
      seen.push(name);
      return name.startsWith(SAMPLE_ATTACHMENT_PREFIX);
    });
    expect(entries.map((e) => e.name)).toEqual([
      `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaa.json`,
      `${SAMPLE_ATTACHMENT_PREFIX}-1-bbbb.json`,
    ]);
    // The filter saw every entry once — enough to notice bzt.log without inflating it.
    expect(seen).toContain('bzt.log');
    expect(seen).toContain('video.webm');
    expect(inflates.sizes).toHaveLength(2);
  });

  it('--artifacts over a zip with a 50 MB video.webm inflates only the three records', async () => {
    const zipPath = path.join(work, 'r-v4-lazy.zip');
    await writeFile(zipPath, engineZip(1200, [video]));

    const engines = await readLocalArtifacts(zipPath);
    expect(engines.map((e) => e.sessionId)).toEqual(['r-v4-lazy']);
    expect(engines[0]!.files).toHaveLength(3);
    // 2 Samples + 1 Outcome; never bzt.log, config.yml or the video.
    expect(inflates.sizes).toHaveLength(3);
  });

  it('--master over the same zip inflates only the three records, once each, and extracts nothing to disk', async () => {
    const cacheRoot = path.join(work, 'cache');
    const { transport } = stubApi('9001', { 'r-v4-lazy': { locationId: 'us-east-1', zip: engineZip(1200, [video]) } });
    await runCli({
      argv: ['--master', '9001', '--out', path.join(work, 'r.html')],
      env: STUB_ENV,
      transport,
      cacheRoot,
      log: () => {},
    });
    const data = parseBlob(await readFile(path.join(work, 'r.html'), 'utf8'));
    expect(data.samples).toHaveLength(2);
    expect(data.outcomes).toHaveLength(1);
    // One parse per zip: validating the download IS reading its records.
    expect(inflates.sizes).toHaveLength(3);
    // The cache holds the raw zip and the manifest — no extracted session dir.
    expect((await readdir(path.join(cacheRoot, '9001'))).sort()).toEqual(['manifest.json', 'r-v4-lazy.zip']);

    // A warm, offline rerun reads the cached zip once more — still 3 inflates.
    inflates.sizes.length = 0;
    await runCli({
      argv: ['--master', '9001', '--out', path.join(work, 'r2.html')],
      env: {},
      transport: async (url) => {
        throw new Error(`network call on a cached master: ${url}`);
      },
      cacheRoot,
      log: () => {},
    });
    expect(inflates.sizes).toHaveLength(3);
  });
});

/** Strip what legitimately differs by source: identity the API knows and a
 *  local import cannot (locationId, status, Engine Label, Report name), the
 *  local source's name, and the generation time. Everything else must match. */
function withoutSourceMetadata(data: ReportData): unknown {
  return {
    ...data,
    reportName: null,
    localSource: undefined,
    generatedAt: null,
    sessions: data.sessions.map((s) => ({ ...s, locationId: null, status: null, engineLabel: null })),
    samples: data.samples.map((s) => ({ ...s, locationId: null, engineLabel: null })),
  };
}

describe('D5: one pipeline', () => {
  it('--master and --artifacts over the same data embed an identical blob, apart from source metadata', async () => {
    const cacheRoot = path.join(work, 'cache');
    // Two Engines with colliding basenames and different vitals.
    const zips = {
      'r-v4-par-a': { locationId: 'us-east-1', zip: engineZip(1100) },
      'r-v4-par-b': { locationId: 'eu-west-1', zip: engineZip(2300) },
    };
    const { transport } = stubApi('9002', zips);
    const apiOut = path.join(work, 'api.html');
    await runCli({ argv: ['--master', '9002', '--out', apiOut], env: STUB_ENV, transport, cacheRoot, log: () => {} });

    // The very cache the API run wrote is the local import's input.
    const localOut = path.join(work, 'local.html');
    await runCli({
      argv: ['--artifacts', path.join(cacheRoot, '9002'), '--master', '9002', '--out', localOut],
      env: {},
      transport: async (url) => {
        throw new Error(`local import made a network request: ${url}`);
      },
      cacheRoot: path.join(work, 'unused-cache'),
      log: () => {},
    });

    const api = parseBlob(await readFile(apiOut, 'utf8'));
    const local = parseBlob(await readFile(localOut, 'utf8'));
    expect(api.samples).toHaveLength(4);
    expect(api.outcomes).toHaveLength(2);
    expect(api.localSource).toBeUndefined();
    expect(local.localSource).toBe('9002');
    expect(withoutSourceMetadata(local)).toEqual(withoutSourceMetadata(api));
  });
});

describe('D5: --extract, the debugging escape hatch', () => {
  it('--master --extract <dir> also unzips each Engine into <dir>/{sessionId}/, without changing the report', async () => {
    const cacheRoot = path.join(work, 'cache');
    const zips = {
      'r-v4-ext-a': { locationId: 'us-east-1', zip: engineZip(1100) },
      'r-v4-ext-b': { locationId: 'eu-west-1', zip: engineZip(2300) },
    };
    const extractDir = path.join(work, 'inspect');
    const out = path.join(work, 'r.html');
    await runCli({
      argv: ['--master', '9003', '--out', out, '--extract', extractDir],
      env: STUB_ENV,
      transport: stubApi('9003', zips).transport,
      cacheRoot,
      log: () => {},
    });
    expect((await readdir(extractDir)).sort()).toEqual(['r-v4-ext-a', 'r-v4-ext-b']);
    // Every entry, records or not; colliding basenames kept apart per Engine.
    expect(await readdir(path.join(extractDir, 'r-v4-ext-a'))).toContain('bzt.log');
    const name = `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaa.json`;
    expect(await readFile(path.join(extractDir, 'r-v4-ext-a', name), 'utf8')).not.toBe(
      await readFile(path.join(extractDir, 'r-v4-ext-b', name), 'utf8'),
    );
    expect(parseBlob(await readFile(out, 'utf8')).samples).toHaveLength(4);
  });

  it('is refused with --artifacts, whose input is already on disk', async () => {
    await expect(
      runCli({ argv: ['--artifacts', work, '--extract', path.join(work, 'x'), '--out', path.join(work, 'r.html')] }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/--extract/) });
  });
});
