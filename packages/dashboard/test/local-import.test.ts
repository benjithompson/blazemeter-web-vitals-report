// Local import — `--artifacts <path>` builds the report from artifacts already
// on disk, for when the network is unavailable. Same seam as Seam 2: run the
// CLI in-process, parse the embedded blob back out of the emitted HTML.
//
// Every run uses a transport that fails the test on ANY request, and a
// cacheRoot that must never be created — local import is offline and leaves
// no trace.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OUTCOME_ATTACHMENT_PREFIX, SAMPLE_ATTACHMENT_PREFIX } from 'bzm-vitals-format';
import { runCli } from '../src/cli.js';
import type { Transport } from '../src/http.js';
import { makeZip, type ZipInput } from './helpers/zip.js';
import { parseBlob } from './helpers/blob.js';

const noNetwork: Transport = async (url) => {
  throw new Error(`local import made a network request: ${url}`);
};

function sample(lcp: number, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ts: 1752700745069 + lcp,
      url: 'https://example.com/checkout',
      test: { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat: 0, worker: 0 },
      navigationIndex: 1,
      vitals: { lcp: { value: lcp, status: 'ok' } },
      navigation: { domContentLoadedMs: 900, loadEventMs: 1500 },
      context: { workers: 1, resourceCount: 10, requestCount: 12, failedRequests: 0 },
      ...overrides,
    }),
  );
}

function outcome(repeat: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      test: { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat, worker: 0 },
      status: 'passed',
      retry: 0,
    }),
  );
}

// Collector basenames are sha1-of-a-fixed-path, so they COLLIDE across Engines.
const S1 = `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`;
const S2 = `${SAMPLE_ATTACHMENT_PREFIX}-2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`;

function engineEntries(lcpA: number, lcpB: number): ZipInput[] {
  return [
    { name: S1, data: sample(lcpA) },
    { name: S2, data: sample(lcpB) },
    { name: 'bzt.log', data: Buffer.from('taurus noise') },
  ];
}

async function writeTree(root: string, entries: ZipInput[]): Promise<void> {
  for (const { name, data } of entries) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
  }
}

const lcps = (data: ReturnType<typeof parseBlob>) =>
  data.samples.map((s) => s.sample.vitals.lcp!.value).sort((a, b) => a! - b!);

let workDir: string;
let cacheRoot: string;
let outPath: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'bzm-local-'));
  cacheRoot = path.join(workDir, 'cache');
  outPath = path.join(workDir, 'report.html');
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runLocal(input: string, extra: string[] = []) {
  await runCli({
    argv: ['--artifacts', input, ...extra, '--out', outPath],
    env: {}, // no credentials at all
    transport: noNetwork,
    cacheRoot,
    log: () => {},
  });
  expect(existsSync(cacheRoot)).toBe(false);
  const html = await readFile(outPath, 'utf8');
  return { html, data: parseBlob(html) };
}

describe('local import — one Engine', () => {
  it('reads a downloaded artifacts.zip offline, with no credentials', async () => {
    const zip = path.join(workDir, 'artifacts.zip');
    await writeFile(zip, makeZip(engineEntries(1000, 2000)));

    const { html, data } = await runLocal(zip);

    expect(lcps(data)).toEqual([1000, 2000]);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]!.sessionId).toBe('artifacts');
    expect(data.sessions[0]!.sampleCount).toBe(2);
    // No master id → nothing to name or link; the source is stated instead.
    expect(data.masterId).toBeNull();
    expect(data.localSource).toBe('artifacts.zip');
    expect(html).not.toContain('<p class="report-link">');
    expect(html).toContain('imported from artifacts.zip');
  });

  it('reads the unzipped folder to the same Samples', async () => {
    const dir = path.join(workDir, 'artifacts');
    await writeTree(dir, engineEntries(1000, 2000));

    const { data } = await runLocal(dir);

    expect(lcps(data)).toEqual([1000, 2000]);
    expect(data.sessions.map((s) => s.sessionId)).toEqual(['artifacts']);
  });

  it('takes an optional --master to name and link the Report — still offline', async () => {
    const zip = path.join(workDir, 'artifacts.zip');
    await writeFile(zip, makeZip(engineEntries(1000, 2000)));

    const { html, data } = await runLocal(zip, ['--master', '83407766']);

    expect(data.masterId).toBe('83407766');
    expect(data.samples.every((s) => s.masterId === '83407766')).toBe(true);
    expect(html).toContain('<p class="report-link">');
    expect(html).toContain('/masters/83407766/summary');
  });

  it('ignores macOS __MACOSX and ._ twins in a Finder-made zip', async () => {
    const zip = path.join(workDir, 'archive.zip');
    await writeFile(
      zip,
      makeZip([
        ...engineEntries(1000, 2000).map((e) => ({ ...e, name: `artifacts/${e.name}` })),
        { name: `__MACOSX/artifacts/._${S1}`, data: Buffer.from([0, 5, 22, 7]) },
        { name: `artifacts/._${S2}`, data: Buffer.from([0, 5, 22, 7]) },
      ]),
    );

    const { data } = await runLocal(zip);

    expect(lcps(data)).toEqual([1000, 2000]);
    expect(data.sessions[0]!.unreadable).toEqual([]);
  });
});

describe('local import — several Engines', () => {
  it('keeps each zip in a folder a separate Engine despite colliding basenames', async () => {
    const dir = path.join(workDir, 'downloads');
    await mkdir(dir);
    await writeFile(path.join(dir, 'artifacts.zip'), makeZip(engineEntries(1000, 2000)));
    await writeFile(path.join(dir, 'artifacts (1).zip'), makeZip(engineEntries(3000, 4000)));

    const { data } = await runLocal(dir);

    expect(lcps(data)).toEqual([1000, 2000, 3000, 4000]);
    expect(data.sessions.map((s) => [s.sessionId, s.sampleCount])).toEqual([
      ['artifacts', 2],
      ['artifacts (1)', 2],
    ]);
    expect(data.sessions.map((s) => s.engineLabel)).toEqual(['local #1', 'local #2']);
  });

  it('splits an archive.zip of Engine zips by their r-v4 sessionIds', async () => {
    const zip = path.join(workDir, 'archive.zip');
    await writeFile(
      zip,
      makeZip([
        { name: 'r-v4-eng-a/artifacts.zip', data: makeZip(engineEntries(1000, 2000)) },
        { name: 'r-v4-eng-b.zip', data: makeZip(engineEntries(3000, 4000)) },
      ]),
    );

    const { data } = await runLocal(zip);

    expect(data.sessions.map((s) => [s.sessionId, s.sampleCount])).toEqual([
      ['r-v4-eng-a', 2],
      ['r-v4-eng-b', 2],
    ]);
  });

  it('splits unzipped Engine folders by their bzt.log', async () => {
    const dir = path.join(workDir, 'run');
    await writeTree(path.join(dir, 'engine-a'), engineEntries(1000, 2000));
    await writeTree(path.join(dir, 'engine-b'), engineEntries(3000, 4000));

    const { data } = await runLocal(dir);

    expect(data.sessions.map((s) => [s.sessionId, s.sampleCount])).toEqual([
      ['engine-a', 2],
      ['engine-b', 2],
    ]);
  });

  it('treats a zip beside its own extraction as ONE Engine — no double count', async () => {
    // Exactly the .artifact-cache/{masterId}/ layout.
    const dir = path.join(workDir, '83407766');
    await mkdir(dir);
    await writeFile(path.join(dir, 'r-v4-eng-a.zip'), makeZip(engineEntries(1000, 2000)));
    await writeTree(path.join(dir, 'r-v4-eng-a'), engineEntries(1000, 2000));
    await writeFile(path.join(dir, 'manifest.json'), '{}');

    const { data } = await runLocal(dir);

    expect(data.sessions.map((s) => [s.sessionId, s.sampleCount])).toEqual([['r-v4-eng-a', 2]]);
    expect(data.samples).toHaveLength(2);
  });
});

describe('local import — a local Playwright test-results tree', () => {
  it('reads nested per-test folders without flattening their repeated basenames', async () => {
    // outputPath() is per test, so every test dir holds its own
    // bzm-vitals-outcome.json. Flattening would keep one of three.
    const dir = path.join(workDir, 'test-results');
    await writeTree(dir, [
      { name: 'shop-checkout-chromium/bzm-vitals-sample-1-x.json', data: sample(1000) },
      { name: `shop-checkout-chromium/${OUTCOME_ATTACHMENT_PREFIX}.json`, data: outcome(0) },
      { name: 'shop-checkout-chromium-repeat1/bzm-vitals-sample-1-x.json', data: sample(2000) },
      { name: `shop-checkout-chromium-repeat1/${OUTCOME_ATTACHMENT_PREFIX}.json`, data: outcome(1) },
      { name: 'shop-checkout-chromium-repeat2/bzm-vitals-sample-1-x.json', data: sample(3000) },
      { name: `shop-checkout-chromium-repeat2/${OUTCOME_ATTACHMENT_PREFIX}.json`, data: outcome(2) },
    ]);

    const { data } = await runLocal(dir);

    expect(data.sessions.map((s) => s.sessionId)).toEqual(['test-results']);
    expect(lcps(data)).toEqual([1000, 2000, 3000]);
    expect(data.outcomes).toHaveLength(3);
  });
});

describe('local import — loud failures', () => {
  it('names a missing path', async () => {
    await expect(runLocal(path.join(workDir, 'nope.zip'))).rejects.toThrow(
      /--artifacts path not found/,
    );
  });

  it('refuses a folder with no records and no Engine rather than render an empty report', async () => {
    const dir = path.join(workDir, 'wrong');
    await writeTree(dir, [{ name: 'notes.txt', data: Buffer.from('hello') }]);

    await expect(runLocal(dir)).rejects.toThrow(/no web-vitals records under/);
    expect(existsSync(outPath)).toBe(false);
  });

  it('names the file when a zip cannot be read', async () => {
    const zip = path.join(workDir, 'artifacts.zip');
    await writeFile(zip, 'not a zip');

    await expect(runLocal(zip)).rejects.toThrow(/cannot read .*artifacts\.zip: not a zip/);
  });

  it('lists a Taurus Engine that carried no records — "no samples", not an error', async () => {
    // The collector import was forgotten: the Engine ran, recorded nothing.
    const zip = path.join(workDir, 'artifacts.zip');
    await writeFile(zip, makeZip([{ name: 'bzt.log', data: Buffer.from('ran') }]));

    const { html, data } = await runLocal(zip);

    expect(data.sessions.map((s) => [s.sessionId, s.sampleCount])).toEqual([['artifacts', 0]]);
    expect(html).toContain('<p class="no-samples">');
  });
});
