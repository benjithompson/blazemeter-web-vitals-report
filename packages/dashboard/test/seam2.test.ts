// SEAM 2 — the CLI end-to-end, asserting the embedded JSON.
//
// Run the CLI (in-process — the bin entry is a thin wrapper around runCli)
// against a stubbed Transport, out to a temp HTML file, then parse the JSON
// data blob the HTML must embed anyway (the 20-minute dataUrl expiry forces
// embedding) back out of the emitted file and assert on it. One seam, no new
// interface — the blob is a product requirement, not a test hook.
//
// Two fixtures drive it:
//   - the committed probe zips (real fetched bytes, two Engines, zero Samples)
//     prove sessions are enumerated, extraction is namespaced, and a Report
//     with no vitals says "no samples" rather than 0;
//   - a synthesized pair of zips carrying canonical format-v1 Samples with
//     COLLIDING basenames proves both Engines' Samples survive and arrive
//     attributed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_ATTACHMENT_PREFIX } from '@bzm/vitals-format';
import { runCli } from '../src/cli.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import { makeZip } from './helpers/zip.js';
import { parseBlob } from './helpers/blob.js';

const PROBE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe');
const PROBE_A = 'r-v4-6a596ee06d5a9077555455'; // us-west-1
const PROBE_B = 'r-v4-6a596ee06dc10652779841'; // us-west-2

// Stub credentials, provided through the same env the real loader reads.
const STUB_ENV = {
  BLAZEMETER_API_KEY_ID: 'stub-key-id-8f3a51',
  BLAZEMETER_API_KEY_SECRET: 'stub-key-secret-c41d97e2',
} as NodeJS.ProcessEnv;

function stubApi(masterId: string, zips: Record<string, { locationId: string; zip: Buffer }>) {
  return recordingTransport((url) => {
    if (url.endsWith(`/masters/${masterId}/status`)) {
      return jsonResponse({
        result: {
          sessions: Object.entries(zips).map(([id, z]) => ({
            id,
            status: 'ENDED',
            locationId: z.locationId,
          })),
        },
      });
    }
    const logs = /\/sessions\/([^/]+)\/reports\/logs$/.exec(url);
    if (logs) {
      return jsonResponse({
        result: {
          data: [
            {
              filename: 'artifacts.zip',
              // Realistic pre-signed URL — the byte test asserts it NEVER
              // appears in the emitted HTML.
              dataUrl: `https://storage.blazemeter.com/${logs[1]}/artifacts.zip?Signature=abc123`,
            },
          ],
        },
      });
    }
    const dl = /^https:\/\/storage\.blazemeter\.com\/([^/]+)\//.exec(url);
    if (dl) return bytesResponse(zips[dl[1]!]!.zip);
    throw new Error(`unexpected ${url}`);
  });
}

/** A canonical format-v1 Sample as the collector emits it. */
function canonicalSample(overrides: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ts: 1752700745069,
      url: 'https://example.com/checkout?step=1',
      test: { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat: 0, worker: 0 },
      navigationIndex: 1,
      vitals: {
        ttfb: { value: 120, status: 'ok' },
        lcp: { value: 2000, status: 'ok' },
        inp: { value: null, status: 'no-interaction' },
      },
      navigation: { domContentLoadedMs: 900, loadEventMs: 1500 },
      context: { workers: 2, resourceCount: 10, requestCount: 12, failedRequests: 0 },
      ...overrides,
    }),
  );
}

let workDir: string;
let cacheRoot: string;
let outPath: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'bzm-seam2-'));
  cacheRoot = path.join(workDir, 'cache');
  outPath = path.join(workDir, 'report.html');
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('Seam 2 — probe Report (real bytes, two Engines, zero Samples)', () => {
  it('enumerates sessions, extracts namespaced, and says "no samples"', async () => {
    const zipA = await readFile(path.join(PROBE_DIR, `${PROBE_A}.zip`));
    const zipB = await readFile(path.join(PROBE_DIR, `${PROBE_B}.zip`));
    const { transport } = stubApi('82724289', {
      [PROBE_A]: { locationId: 'us-west-1', zip: zipA },
      [PROBE_B]: { locationId: 'us-west-2', zip: zipB },
    });

    await runCli({
      argv: ['--master', '82724289', '--out', outPath],
      env: STUB_ENV,
      transport,
      cacheRoot,
    });

    const html = await readFile(outPath, 'utf8');
    const data = parseBlob(html);

    // Sessions enumerated — never assume exactly one.
    expect(data.masterId).toBe('82724289');
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions.map((s) => s.sessionId).sort()).toEqual([PROBE_A, PROBE_B].sort());
    expect(data.sessions.map((s) => s.locationId).sort()).toEqual(['us-west-1', 'us-west-2']);

    // Extraction namespaced by sessionId — both Engines' colliding files on disk.
    const masterDir = path.join(cacheRoot, '82724289');
    const filesA = await readdir(path.join(masterDir, PROBE_A));
    const filesB = await readdir(path.join(masterDir, PROBE_B));
    expect(filesA.length).toBeGreaterThan(0);
    expect(filesA.sort()).toEqual(filesB.sort()); // the collision is real

    // No vitals anywhere → "no samples", never a 0.
    expect(data.samples).toHaveLength(0);
    expect(html).toMatch(/no samples/i);
  });
});

describe('Seam 2 — canonical Samples across two Engines with colliding basenames', () => {
  // The collector's real files arrive as {prefix}-{n}-{sha1(path)}.json, and the
  // sha1 is of a FIXED path — so the basenames collide across Engines.
  const name1 = `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`;
  const name2 = `${SAMPLE_ATTACHMENT_PREFIX}-2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`;

  async function runSynthesized() {
    const zipA = makeZip([
      { name: name1, data: canonicalSample({ vitals: { lcp: { value: 1000, status: 'ok' } } }) },
      { name: name2, data: canonicalSample({ vitals: { lcp: { value: 2000, status: 'ok' } } }) },
      // A record from the future: rejected loudly, never silently misread.
      {
        name: `${SAMPLE_ATTACHMENT_PREFIX}-3-cccccccccccccccccccccccccccccccccccccccc.json`,
        data: canonicalSample({ schemaVersion: 2 }),
      },
      { name: 'bzt.log', data: Buffer.from('noise') },
    ]);
    const zipB = makeZip([
      { name: name1, data: canonicalSample({ vitals: { lcp: { value: 3000, status: 'ok' } } }) },
      { name: name2, data: canonicalSample({ vitals: { lcp: { value: 4000, status: 'ok' } } }) },
    ]);
    const { transport } = stubApi('90000001', {
      'r-v4-eng-a': { locationId: 'us-west-1', zip: zipA },
      'r-v4-eng-b': { locationId: 'us-west-1', zip: zipB },
    });
    await runCli({
      argv: ['--master', '90000001', '--out', outPath],
      env: STUB_ENV,
      transport,
      cacheRoot,
    });
    return readFile(outPath, 'utf8');
  }

  it('both Engines\' Samples survive and arrive attributed', async () => {
    const data = parseBlob(await runSynthesized());

    // 2 + 2 despite byte-identical basenames — nothing overwritten.
    expect(data.samples).toHaveLength(4);

    // Attributed Samples carry masterId / sessionId / locationId / engineLabel.
    for (const s of data.samples) {
      expect(s.masterId).toBe('90000001');
      expect(['r-v4-eng-a', 'r-v4-eng-b']).toContain(s.sessionId);
      expect(s.locationId).toBe('us-west-1');
      expect(s.provenance).toBe('collector');
    }
    const bySession = new Map<string, number>();
    for (const s of data.samples) bySession.set(s.sessionId, (bySession.get(s.sessionId) ?? 0) + 1);
    expect(bySession.get('r-v4-eng-a')).toBe(2);
    expect(bySession.get('r-v4-eng-b')).toBe(2);

    // Two Engines on ONE location → ordinal labels.
    expect(new Set(data.samples.map((s) => s.engineLabel))).toEqual(
      new Set(['us-west-1 #1', 'us-west-1 #2']),
    );

    // The Route table pools all four; percentiles by the pinned method over
    // [1000..4000], with full coverage and an empty breakdown.
    const row = data.routes.find((r) => r.route === '/checkout')!;
    expect(row).toBeDefined();
    expect(row.sampleCount).toBe(4);
    expect(row.metrics.lcp).toEqual({
      p50: 2000, // floor(3*.5)=1
      p75: 3000, // floor(3*.75)=2
      p95: 3000, // floor(3*.95)=2
      ok: 4,
      total: 4,
      breakdown: {},
    });
    // No Outcome records in these zips → outcome-awareness unavailable, and
    // that is never conflated with crashed.
    expect(data.samples.every((s) => s.executionStatus === 'unavailable')).toBe(true);
  });

  it('records the schemaVersion-mismatch file as rejected, with a reason', async () => {
    const data = parseBlob(await runSynthesized());
    const sessionA = data.sessions.find((s) => s.sessionId === 'r-v4-eng-a')!;
    expect(sessionA.unreadable).toHaveLength(1);
    expect(sessionA.unreadable[0]!.file).toMatch(new RegExp(`^${SAMPLE_ATTACHMENT_PREFIX}-3`));
    expect(sessionA.unreadable[0]!.reason).toMatch(/schemaVersion/);
  });

  it('emits a self-contained file: no external fetchable references, no credentials, no pre-signed URLs — asserted on bytes', async () => {
    const html = await runSynthesized();

    // The blob itself parses as JSON (already exercised above, but this is the
    // byte-level contract of the emitted file).
    expect(() => parseBlob(html)).not.toThrow();

    // Zero external requests. Sample URLs legitimately live INSIDE the JSON
    // blob; what must not exist is anything the browser would FETCH:
    expect(html).not.toMatch(/<script[^>]+\bsrc\s*=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<img[^>]+\bsrc\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/@import\s/i);
    // No remote fetch/XHR from the inline script.
    expect(html).not.toMatch(/fetch\(\s*["']https?:/i);
    expect(html).not.toMatch(/XMLHttpRequest/);

    // No pre-signed URL ever lands in the output.
    expect(html).not.toContain('storage.blazemeter.com');
    expect(html).not.toContain('Signature=');

    // No api-key material — the same strings the credentials loader read.
    // (Compared, never printed.)
    expect(html.includes(STUB_ENV.BLAZEMETER_API_KEY_ID!)).toBe(false);
    expect(html.includes(STUB_ENV.BLAZEMETER_API_KEY_SECRET!)).toBe(false);
  });

  it('is cache-through: a second run does zero network calls', async () => {
    await runSynthesized();
    const throwing = recordingTransport(() => {
      throw new Error('network call on a cached master');
    });
    const outPath2 = path.join(workDir, 'report2.html');
    await runCli({
      argv: ['--master', '90000001', '--out', outPath2],
      env: {}, // no credentials needed on a warm cache either
      transport: throwing.transport,
      cacheRoot,
    });
    expect(throwing.calls).toHaveLength(0);
    expect(existsSync(outPath2)).toBe(true);
    expect(parseBlob(await readFile(outPath2, 'utf8')).samples).toHaveLength(4);
  });
});
