// THE COLLISION TEST — never skips, owns its fixture.
//
// The two committed probe zips are real fetched bytes from master 82724289's two
// Engines (us-west-1, us-west-2). By construction their attachment basenames are
// identical (basename = sha1 of the fixed absolute path Taurus passes to every
// Engine) while their contents differ (different vitals). Extract both into ONE
// destination through the namespaced extractor and assert BOTH Engines survive.
//
// This test exists because the failure it prevents — merging Engines into one
// directory and silently destroying half the Samples — has already hit this
// codebase twice. See SPEC.md → "Cross-Engine filename collision".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNamespaced, readZipEntries } from '../src/extract.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe');
const SESSION_A = 'r-v4-6a596ee06d5a9077555455'; // us-west-1
const SESSION_B = 'r-v4-6a596ee06dc10652779841'; // us-west-2

let dest: string;
beforeEach(async () => {
  dest = await mkdtemp(path.join(tmpdir(), 'bzm-collision-'));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe('cross-Engine filename collision', () => {
  it('both Engines survive extraction into one destination', async () => {
    const zipA = await readFile(path.join(FIXTURE_DIR, `${SESSION_A}.zip`));
    const zipB = await readFile(path.join(FIXTURE_DIR, `${SESSION_B}.zip`));

    const entriesA = await readZipEntries(zipA);
    const entriesB = await readZipEntries(zipB);

    // The collision is REAL: the two Engines' basenames overlap...
    const namesA = new Set(entriesA.map((e) => e.name));
    const namesB = new Set(entriesB.map((e) => e.name));
    const overlap = [...namesA].filter((n) => namesB.has(n));
    expect(overlap.length).toBeGreaterThan(0);
    // ...in fact every attachment name collides.
    expect(overlap.length).toBe(namesA.size);

    // Extract BOTH into ONE destination through the namespaced extractor.
    const resA = await extractNamespaced(zipA, SESSION_A, dest);
    const resB = await extractNamespaced(zipB, SESSION_B, dest);

    // Both namespaces are fully populated — nothing was overwritten.
    const filesA = await readdir(resA.sessionDir);
    const filesB = await readdir(resB.sessionDir);
    expect(filesA).toHaveLength(entriesA.length);
    expect(filesB).toHaveLength(entriesB.length);

    // Total on disk equals the sum of both zips' entries — no losses.
    expect(filesA.length + filesB.length).toBe(entriesA.length + entriesB.length);

    // And a colliding name holds DIFFERENT bytes per Engine — the two Samples
    // that a flat extraction would have collapsed to one.
    const collidingName = overlap[0]!;
    const bytesA = await readFile(path.join(resA.sessionDir, collidingName));
    const bytesB = await readFile(path.join(resB.sessionDir, collidingName));
    expect(Buffer.compare(bytesA, bytesB)).not.toBe(0);
  });
});
