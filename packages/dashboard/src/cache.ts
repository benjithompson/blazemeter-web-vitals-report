// The fetch/cache layer. Point it at a master id; it writes every Engine's
// extracted artifact into the repo-root cache and records a manifest so a second
// run against a cached master does zero network calls.
//
// Layout (cacheRoot defaults to <repo>/.artifact-cache, which is gitignored):
//   {cacheRoot}/{masterId}/manifest.json
//   {cacheRoot}/{masterId}/{sessionId}.zip     <- raw fetched bytes
//   {cacheRoot}/{masterId}/{sessionId}/...      <- extracted, namespaced by sessionId
//
// Raw zip bytes are cached alongside the extraction so that extraction-logic
// changes never force a refetch — re-extraction runs from the local zip.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchArtifactBytes, getMaster, listSessions, type SessionInfo } from './api.js';
import { extractNamespaced } from './extract.js';
import type { Credentials, Transport } from './http.js';

export interface SessionCacheEntry {
  sessionId: string;
  status: string;
  locationId: string;
  /** 'present' — a zip was fetched; 'no-artifact' — the Engine emitted none. */
  artifact: 'present' | 'no-artifact';
  /** Relative to the master dir. Absent when artifact === 'no-artifact'. */
  zipPath?: string;
  /** Count of files extracted (flat entry count). */
  fileCount?: number;
}

export interface MasterManifest {
  masterId: string;
  fetchedAt: string;
  /** The master's (Report's) name from GET /masters/{id}; null when the API
   *  carried none. Persisted so the warm cache renders offline, no refetch. */
  reportName: string | null;
  sessions: SessionCacheEntry[];
}

export interface CacheMasterOptions {
  creds: Credentials;
  transport?: Transport;
  /** Defaults to <repo-root>/.artifact-cache. */
  cacheRoot?: string;
}

export function defaultCacheRoot(): string {
  // src/ -> package -> packages -> repo root
  return path.resolve(new URL('../../..', import.meta.url).pathname, '.artifact-cache');
}

async function loadManifest(masterDir: string): Promise<MasterManifest | null> {
  const manifestPath = path.join(masterDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(await readFile(manifestPath, 'utf8')) as MasterManifest;
}

/**
 * Ensure a master's every Engine artifact is on disk, extracted and namespaced by
 * sessionId. Idempotent: if a manifest already exists it is trusted and no network
 * call is made; otherwise sessions are enumerated and each missing zip fetched.
 * Re-extraction always runs from the cached zip.
 */
export async function cacheMaster(
  masterId: string,
  opts: CacheMasterOptions,
): Promise<MasterManifest> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const masterDir = path.join(cacheRoot, masterId);
  await mkdir(masterDir, { recursive: true });

  const existing = await loadManifest(masterDir);
  if (existing) {
    // Cached master — re-extract from local zips, no network.
    for (const s of existing.sessions) {
      if (s.artifact === 'present' && s.zipPath) {
        const zipBytes = await readFile(path.join(masterDir, s.zipPath));
        await extractNamespaced(zipBytes, s.sessionId, masterDir);
      }
    }
    return existing;
  }

  // Cold: fetch the Report name and enumerate sessions (there is at least one;
  // never assume exactly one).
  const master = await getMaster(masterId, opts);
  const sessions: SessionInfo[] = await listSessions(masterId, opts);
  const entries: SessionCacheEntry[] = [];

  for (const session of sessions) {
    const zipPath = `${session.id}.zip`;
    const zipAbs = path.join(masterDir, zipPath);

    let zipBytes: Buffer | null;
    if (existsSync(zipAbs)) {
      zipBytes = await readFile(zipAbs); // bytes already cached — do not refetch
    } else {
      zipBytes = await fetchArtifactBytes(session.id, opts);
      if (zipBytes) await writeFile(zipAbs, zipBytes);
    }

    if (!zipBytes) {
      // No artifacts.zip — a normal outcome, recorded as such.
      entries.push({
        sessionId: session.id,
        status: session.status,
        locationId: session.locationId,
        artifact: 'no-artifact',
      });
      continue;
    }

    const { files } = await extractNamespaced(zipBytes, session.id, masterDir);
    entries.push({
      sessionId: session.id,
      status: session.status,
      locationId: session.locationId,
      artifact: 'present',
      zipPath,
      fileCount: files.length,
    });
  }

  const manifest: MasterManifest = {
    masterId,
    fetchedAt: new Date().toISOString(),
    reportName: master.name,
    sessions: entries,
  };
  await writeFile(
    path.join(masterDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

/** Remove a master's cache — used by tests, not the script. */
export async function clearMasterCache(masterId: string, cacheRoot: string): Promise<void> {
  await rm(path.join(cacheRoot, masterId), { recursive: true, force: true });
}
