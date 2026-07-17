#!/usr/bin/env tsx
// Fetch/cache script — the ONLY thing that talks to the live BlazeMeter API.
// Run by hand; fails loudly. The test suite reads the cache it populates and
// never touches the network.
//
//   BLAZEMETER_API_KEY=./api-key.json \
//     npx tsx packages/dashboard/scripts/fetch-cache.ts <masterId> [<masterId> ...]
//
// Writes each Report's every Engine artifact into <repo>/.artifact-cache/{masterId}/,
// extracted and namespaced by sessionId. The cache is gitignored and re-fetchable.
// Re-running against a cached master does no network calls.

import { loadCredentials } from '../src/http.js';
import { cacheMaster, defaultCacheRoot } from '../src/cache.js';

async function main() {
  const masterIds = process.argv.slice(2);
  if (masterIds.length === 0) {
    console.error('usage: tsx scripts/fetch-cache.ts <masterId> [<masterId> ...]');
    process.exit(2);
  }

  const creds = await loadCredentials();
  const cacheRoot = defaultCacheRoot();

  for (const masterId of masterIds) {
    console.log(`\n=== master ${masterId} ===`);
    console.log('(archived Reports may take a moment to restore — latency, not failure)');
    const manifest = await cacheMaster(masterId, { creds, cacheRoot });

    console.log(`sessions: ${manifest.sessions.length}`);
    for (const s of manifest.sessions) {
      const detail =
        s.artifact === 'present'
          ? `artifact present — ${s.fileCount} files`
          : 'NO ARTIFACT (Engine emitted none)';
      console.log(`  ${s.sessionId}  [${s.locationId}]  ${s.status}  ${detail}`);
    }
  }
  console.log(`\ncache: ${cacheRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
