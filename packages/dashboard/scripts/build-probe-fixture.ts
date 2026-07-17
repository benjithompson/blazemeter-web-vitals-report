#!/usr/bin/env tsx
// One-off: build the committed collision fixture from the probe master's two
// cached zips. Strips each real fetched zip down to ONLY its attachment entries
// (the probe-*.json files — plumbing-only, zero customer data) using the REAL
// fetched bytes, then re-packs them (STORE method preserves content byte-for-byte).
//
// The bytes are NOT synthesized — they are the fetched attachment entries,
// filtered. Verifies the two stripped zips still carry the colliding basenames
// before writing; refuses to write otherwise.
//
//   npx tsx packages/dashboard/scripts/build-probe-fixture.ts
//
// Prereq: `fetch-cache.ts 82724289` has populated the cache.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../src/extract.js';
import { makeZip } from '../test/helpers/zip.js';

const MASTER = '82724289';
const SESSIONS = ['r-v4-6a596ee06d5a9077555455', 'r-v4-6a596ee06dc10652779841'];
const ATTACHMENT_PREFIX = 'probe-';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const cacheDir = path.join(repoRoot, '.artifact-cache', MASTER);
const fixtureDir = path.join(here, '..', 'test', 'fixtures', 'probe');

async function main() {
  await mkdir(fixtureDir, { recursive: true });
  const basenamesPerSession: string[][] = [];

  for (const sessionId of SESSIONS) {
    const raw = await readFile(path.join(cacheDir, `${sessionId}.zip`));
    const entries = await readZipEntries(raw);
    const attachments = entries.filter((e) => e.name.startsWith(ATTACHMENT_PREFIX));
    if (attachments.length === 0) {
      throw new Error(`no attachment entries in ${sessionId} — did fetch-cache run?`);
    }
    const stripped = makeZip(attachments);
    await writeFile(path.join(fixtureDir, `${sessionId}.zip`), stripped);
    basenamesPerSession.push(attachments.map((e) => e.name).sort());
    console.log(`${sessionId}.zip: ${attachments.length} attachment entries`);
  }

  // Verify the colliding basenames survived — refuse to ship if they didn't.
  const [a, b] = basenamesPerSession;
  const overlap = a!.filter((n) => b!.includes(n));
  if (overlap.length === 0) {
    throw new Error('STOP: stripped zips share no basenames — collision not preserved.');
  }
  console.log(`\ncolliding basenames across the two sessions: ${overlap.length}`);
  for (const n of overlap) console.log(`  ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
