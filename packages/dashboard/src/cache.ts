// The fetch/cache layer. Point it at a master id; it writes every Engine's
// artifacts.zip into the cache and records a manifest so a second run against
// a finished master does zero network calls.
//
// Layout (cacheRoot: see defaultCacheRoot):
//   {cacheRoot}/{masterId}/manifest.json
//   {cacheRoot}/{masterId}/{sessionId}.zip     <- raw fetched bytes, one per Engine
//
// Nothing is extracted to disk. Each zip is read in memory by the same lazy
// reader local import uses (local.ts readZipRecords): only record entries are
// inflated, and that one read both validates the zip and yields its records,
// namespaced by sessionId because each zip IS one Engine.
//
// Trust rules:
//   - A manifest is trusted (no network) only if the master had ENDED when it
//     was written. Otherwise the sessions are re-listed and only the ones that
//     are missing, unfinished or changed are fetched again.
//   - Every zip and the manifest are written to `<name>.tmp` and renamed into
//     place, so a run killed mid-write never leaves a file under its final
//     name. Leftover `.tmp` files are deleted at startup, and a cached zip that
//     no longer parses is deleted and fetched again, with a warning.
//   - At most MAX_PARALLEL_DOWNLOADS sessions are fetched at once.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchArtifactBytes, getMaster, getMasterStatus, type SessionInfo } from './api.js';
import { readZipRecords, type ZipRecords } from './local.js';
import type { EngineRecords } from './report.js';
import type { Credentials, Transport } from './http.js';

export interface SessionCacheEntry {
  sessionId: string;
  status: string;
  locationId: string;
  /** 'present' — a zip was fetched; 'no-artifact' — the Engine emitted none. */
  artifact: 'present' | 'no-artifact';
  /** Relative to the master dir. Absent when artifact === 'no-artifact'. */
  zipPath?: string;
  /** Count of file entries in the zip, records or not. */
  fileCount?: number;
}

/** A cached master: its manifest plus every Engine's records, read in memory. */
export interface CachedMaster {
  manifest: MasterManifest;
  /** In manifest.sessions order; a no-artifact Engine has no files. */
  engines: EngineRecords[];
}

export interface MasterManifest {
  masterId: string;
  fetchedAt: string;
  /** The master's (Report's) name from GET /masters/{id}; null when the API
   *  carried none. Persisted so the warm cache renders offline, no refetch. */
  reportName: string | null;
  /** The master's status when this manifest was written (ENDED, RUNNING, …).
   *  Absent from manifests written before D1; those are judged by their
   *  sessions' statuses instead (see masterStatusOf). */
  masterStatus?: string | null;
  sessions: SessionCacheEntry[];
}

export interface CacheMasterOptions {
  /** The credentials, or a loader called only if the network is needed — so a
   *  finished, cached master runs with no credentials at all. */
  creds: Credentials | (() => Promise<Credentials>);
  transport?: Transport;
  /** Overrides BLAZEMETER_API_BASE (see api.ts). */
  apiBase?: string;
  /** Defaults to defaultCacheRoot(). */
  cacheRoot?: string;
  /** Ignore the manifest and any cached zips; fetch every session again. */
  refresh?: boolean;
  /** Warnings (a corrupt cached zip). Defaults to stderr. */
  log?: (message: string) => void;
}

/** The most artifact downloads in flight at once. */
export const MAX_PARALLEL_DOWNLOADS = 4;

export interface CacheRootInputs {
  /** Defaults to process.env; only BZM_VITALS_CACHE_DIR is read. */
  env?: NodeJS.ProcessEnv;
  /** The --cache-dir flag. */
  cacheDir?: string;
  /** Defaults to process.cwd(). Relative directories resolve against it. */
  cwd?: string;
}

/**
 * Where the cache lives, for every install mode alike (package, installed bin,
 * or standalone file): --cache-dir, else $BZM_VITALS_CACHE_DIR, else
 * ./.artifact-cache under the cwd — flag over env over default. The module's own location is never
 * consulted, so a path with a space (file:///…/my%20dir) cannot leak into it.
 */
export function defaultCacheRoot(inputs: CacheRootInputs = {}): string {
  const cwd = inputs.cwd ?? process.cwd();
  if (inputs.cacheDir) return path.resolve(cwd, inputs.cacheDir);
  const fromEnv = (inputs.env ?? process.env).BZM_VITALS_CACHE_DIR?.trim();
  if (fromEnv) return path.resolve(cwd, fromEnv);
  return path.resolve(cwd, '.artifact-cache');
}

const isEnded = (status: string | null | undefined) => status?.toUpperCase() === 'ENDED';

/** A master the API gives no status for has ENDED when every session has. */
function deriveMasterStatus(status: string | null, sessions: Array<{ status: string }>): string | null {
  if (status !== null) return status;
  return sessions.length > 0 && sessions.every((s) => isEnded(s.status)) ? 'ENDED' : null;
}

function masterStatusOf(manifest: MasterManifest): string | null {
  return manifest.masterStatus !== undefined
    ? manifest.masterStatus
    : deriveMasterStatus(null, manifest.sessions);
}

async function loadManifest(masterDir: string): Promise<MasterManifest | null> {
  const manifestPath = path.join(masterDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as MasterManifest;
  } catch {
    return null; // unreadable: not trusted, and rewritten by this run
  }
}

/**
 * The manifest a run may use with no network call: present, and written after
 * the master had ENDED. Null otherwise (absent, unreadable, or written while
 * the master was still running).
 */
export async function loadTrustedManifest(masterDir: string): Promise<MasterManifest | null> {
  const manifest = await loadManifest(masterDir);
  return manifest && isEnded(masterStatusOf(manifest)) ? manifest : null;
}

/** Write via `<file>.tmp` + rename, so `file` is only ever whole or absent. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** A cached zip's records if it reads (bounds-checked; records CRC-checked);
 *  otherwise delete it, warn, and return null so the caller fetches it again.
 *  The one read both validates the zip and yields its records. */
async function readCachedZip(
  zipAbs: string,
  sessionId: string,
  log: (message: string) => void,
): Promise<ZipRecords | null> {
  if (!existsSync(zipAbs)) return null;
  const bytes = await readFile(zipAbs);
  try {
    return await readZipRecords(bytes, zipAbs);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`warning: cached artifacts for ${sessionId} are truncated or corrupt (${why}); deleting and fetching again`);
    await rm(zipAbs, { force: true });
    return null;
  }
}

/** A tiny semaphore: run(fn) waits until fewer than `max` are running. A
 *  finishing task hands its slot straight to the next waiter, so a newcomer
 *  can never slip in between and push the count past `max`. */
function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Ensure a master's every Engine artifact is cached, and read each Engine's
 * records out of its zip in memory — one read per zip, which is also the
 * integrity check. A trusted manifest (the master had ENDED) means no network
 * call; otherwise sessions are re-listed and each missing, unfinished or
 * changed one fetched.
 */
export async function cacheMasterRecords(
  masterId: string,
  opts: CacheMasterOptions,
): Promise<CachedMaster> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const log = opts.log ?? ((message: string) => console.error(message));
  const masterDir = path.join(cacheRoot, masterId);
  await mkdir(masterDir, { recursive: true });

  // Debris of a killed run: never trusted, never reused.
  for (const f of await readdir(masterDir)) {
    if (f.endsWith('.tmp')) await rm(path.join(masterDir, f), { force: true });
  }

  const previous = opts.refresh ? null : await loadManifest(masterDir);

  if (previous && isEnded(masterStatusOf(previous))) {
    // Finished master — read the local zips, no network, provided every zip
    // is still whole.
    const read = new Map<string, ZipRecords>();
    let whole = true;
    for (const s of previous.sessions) {
      if (s.artifact !== 'present' || !s.zipPath) continue;
      const records = await readCachedZip(path.join(masterDir, s.zipPath), s.sessionId, log);
      if (records) read.set(s.sessionId, records);
      else whole = false;
    }
    if (whole) {
      for (const s of previous.sessions) await dropLegacyExtraction(masterDir, s.sessionId);
      return {
        manifest: previous,
        engines: previous.sessions.map((s) => engineOf(s, read.get(s.sessionId))),
      };
    }
  }

  // Fetch the Report name and enumerate sessions (there is at least one;
  // never assume exactly one).
  const creds = typeof opts.creds === 'function' ? await opts.creds() : opts.creds;
  const api = { creds, transport: opts.transport, apiBase: opts.apiBase };
  const master = await getMaster(masterId, api);
  const listing = await getMasterStatus(masterId, api);
  const sessions: SessionInfo[] = listing.sessions;

  const download = limiter(MAX_PARALLEL_DOWNLOADS);
  const settled = await Promise.allSettled(
    sessions.map(async (session): Promise<[SessionCacheEntry, ZipRecords | undefined]> => {
      const zipPath = `${session.id}.zip`;
      const zipAbs = path.join(masterDir, zipPath);
      const before = previous?.sessions.find((s) => s.sessionId === session.id);
      // A finished session whose status has not changed since it was cached
      // is reused; anything else (new, unfinished, changed) is fetched again.
      const reusable =
        !opts.refresh && isEnded(session.status) && (!before || before.status === session.status);
      const base = { sessionId: session.id, status: session.status, locationId: session.locationId };
      await dropLegacyExtraction(masterDir, session.id);

      if (reusable && before?.artifact === 'no-artifact') {
        return [{ ...base, artifact: 'no-artifact' }, undefined];
      }
      const cached = reusable ? await readCachedZip(zipAbs, session.id, log) : null;
      if (cached) {
        return [{ ...base, artifact: 'present', zipPath, fileCount: cached.entryCount }, cached];
      }

      const fetched = await download(() => fetchArtifactBytes(session.id, api));
      if (!fetched) {
        // No artifacts.zip — a normal outcome (or not yet produced), recorded as such.
        await rm(zipAbs, { force: true });
        return [{ ...base, artifact: 'no-artifact' }, undefined];
      }
      // Reading the records checks the bytes before they are kept.
      const records = await readZipRecords(fetched, `the artifacts.zip of ${session.id}`);
      await writeAtomic(zipAbs, fetched);
      return [{ ...base, artifact: 'present', zipPath, fileCount: records.entryCount }, records];
    }),
  );
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  const results = settled.map(
    (r) => (r as PromiseFulfilledResult<[SessionCacheEntry, ZipRecords | undefined]>).value,
  );

  const manifest: MasterManifest = {
    masterId,
    fetchedAt: new Date().toISOString(),
    reportName: master.name,
    masterStatus: deriveMasterStatus(listing.status, sessions),
    sessions: results.map(([entry]) => entry),
  };
  await writeAtomic(path.join(masterDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, engines: results.map(([entry, records]) => engineOf(entry, records)) };
}

/** Like cacheMasterRecords, for callers that want only the manifest. */
export async function cacheMaster(
  masterId: string,
  opts: CacheMasterOptions,
): Promise<MasterManifest> {
  return (await cacheMasterRecords(masterId, opts)).manifest;
}

function engineOf(entry: SessionCacheEntry, records: ZipRecords | undefined): EngineRecords {
  return {
    sessionId: entry.sessionId,
    locationId: entry.locationId,
    status: entry.status,
    artifact: entry.artifact,
    files: records?.files ?? [],
  };
}

/** Caches written before D5 also held each zip extracted to {sessionId}/;
 *  nothing reads that copy any more, so it is removed. */
async function dropLegacyExtraction(masterDir: string, sessionId: string): Promise<void> {
  // Only ever a plain child of the master dir — never the dir itself, or above it.
  if (!sessionId || sessionId !== path.basename(sessionId) || sessionId.startsWith('.')) return;
  await rm(path.join(masterDir, sessionId), { recursive: true, force: true });
}


/** Remove a master's cache — used by tests, not the script. */
export async function clearMasterCache(masterId: string, cacheRoot: string): Promise<void> {
  await rm(path.join(cacheRoot, masterId), { recursive: true, force: true });
}
