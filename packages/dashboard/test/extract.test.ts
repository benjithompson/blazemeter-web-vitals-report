import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZipEntries, extractNamespaced } from '../src/extract.js';
import { makeZip } from './helpers/zip.js';

let dest: string;
beforeEach(async () => {
  dest = await mkdtemp(path.join(tmpdir(), 'bzm-extract-'));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe('readZipEntries', () => {
  it('reads a flat zip back to its entries byte-for-byte', async () => {
    const zip = makeZip([
      { name: 'bzm-vitals-sample-abc123.json', data: Buffer.from('{"a":1}') },
      { name: 'bzm-vitals-outcome-def456.json', data: Buffer.from('{"b":2}') },
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.name).sort()).toEqual([
      'bzm-vitals-outcome-def456.json',
      'bzm-vitals-sample-abc123.json',
    ]);
    const sample = entries.find((e) => e.name.includes('sample'))!;
    expect(sample.data.toString()).toBe('{"a":1}');
  });
});

describe('extractNamespaced', () => {
  it('writes every flat entry under destRoot/{sessionId}/', async () => {
    const zip = makeZip([
      { name: 'repeat0.json', data: Buffer.from('zero') },
      { name: 'repeat18.json', data: Buffer.from('eighteen') },
    ]);
    const { sessionDir, files } = await extractNamespaced(zip, 'r-v4-aaa', dest);

    expect(sessionDir).toBe(path.join(dest, 'r-v4-aaa'));
    expect(files.sort()).toEqual(['repeat0.json', 'repeat18.json']);

    const onDisk = await readdir(sessionDir);
    expect(onDisk.sort()).toEqual(['repeat0.json', 'repeat18.json']);
    expect(await readFile(path.join(sessionDir, 'repeat18.json'), 'utf8')).toBe('eighteen');
  });

  it('keeps two sessions with identical basenames apart — no overwrite', async () => {
    // Same basename, DIFFERENT bytes — the cross-Engine collision in miniature.
    const zipA = makeZip([{ name: 'repeat18.json', data: Buffer.from('engine-A') }]);
    const zipB = makeZip([{ name: 'repeat18.json', data: Buffer.from('engine-B') }]);

    await extractNamespaced(zipA, 'r-v4-aaa', dest);
    await extractNamespaced(zipB, 'r-v4-bbb', dest);

    expect(await readFile(path.join(dest, 'r-v4-aaa', 'repeat18.json'), 'utf8')).toBe('engine-A');
    expect(await readFile(path.join(dest, 'r-v4-bbb', 'repeat18.json'), 'utf8')).toBe('engine-B');
  });
});
