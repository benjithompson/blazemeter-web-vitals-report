// Local import — read Engine artifacts from a path on disk instead of the API,
// for when the network is unavailable or the artifacts were downloaded by hand.
//
// Accepted inputs, any of which may nest inside another:
//   - an Engine's artifacts.zip (or any zip holding one or more Engines);
//   - the unzipped folder of one;
//   - a folder holding several of either — e.g. a whole .artifact-cache master
//     dir, or a local Playwright test-results tree.
//
// There is no API here, so Engine identity is inferred from the layout:
//   1. a directory or zip named `r-v4-…` anywhere on a record's path is its
//      Engine — that name IS the real sessionId, so it wins wherever it sits;
//   2. otherwise the innermost of: a zip (one downloaded artifacts.zip is one
//      Engine), or a directory holding bzt.log (Taurus writes one per Engine);
//   3. otherwise the input itself.
// `foo.zip` and its unzipped `foo/` resolve to the same sessionId, so a zip
// lying beside its own extraction is one Engine whose duplicate records the
// content-identity dedupe collapses — never two Engines double-counting the
// same Samples.
//
// Records are read in memory by path and never flattened onto disk: a local
// test-results tree repeats basenames (bzm-vitals-outcome.json per test dir),
// and flattening would destroy all but one — the collision SPEC.md warns of.
// Zips are read lazily (zip.ts): only record entries and nested zips are
// inflated. The API/cache path reads its cached zips through readZipRecords
// below, so both input modes share one reader.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SAMPLE_ATTACHMENT_PREFIX, OUTCOME_ATTACHMENT_PREFIX } from 'bzm-vitals-format';
import { readZipEntries } from './zip.js';
import { isRecordFileName, type EngineRecords, type RecordFile } from './report.js';

/** Local artifacts carry no location; every Engine gets this one. */
export const LOCAL_LOCATION_ID = 'local';
/** Local artifacts carry no API session status. */
export const LOCAL_SESSION_STATUS = 'local';

const SESSION_ID_RE = /^r-v4-/;
const ZIP_RE = /\.zip$/i;
const TAURUS_LOG = 'bzt.log';

interface FoundRecord {
  /** Path segments relative to the input root. */
  segments: string[];
  read(): Promise<string>;
}

interface Scan {
  records: FoundRecord[];
  /** Joined segment prefixes that are rule-2 Engine boundaries. */
  boundaries: Set<string>;
  /** Every bzt.log's segments — its Engine is real even with zero records. */
  taurusLogs: string[][];
}

const joinSegments = (segments: string[]): string => segments.join('/');

/** macOS zips carry __MACOSX/ resource forks and ._ AppleDouble twins — never records. */
function isMacJunk(segments: string[]): boolean {
  return segments.includes('__MACOSX') || segments[segments.length - 1]!.startsWith('._');
}

function noteFile(scan: Scan, segments: string[], read: () => Promise<string>): void {
  const name = segments[segments.length - 1]!;
  if (name === TAURUS_LOG) {
    scan.boundaries.add(joinSegments(segments.slice(0, -1)));
    scan.taurusLogs.push(segments);
  } else if (isRecordFileName(name)) {
    scan.records.push({ segments, read });
  }
}

const NOT_READ = (): Promise<string> => Promise.reject(new Error('bzt.log is never read'));

/**
 * Scan one zip, lazily: only record entries and nested zips are inflated.
 * bzt.log matters only for being THERE (an Engine boundary), so it is noted
 * from the central directory and never inflated; everything else — video,
 * traces, html reports — is skipped by name. Returns the zip's file-entry count.
 */
async function scanZip(
  scan: Scan,
  bytes: Buffer,
  zipSegments: string[],
  display: string,
): Promise<number> {
  const segmentsOf = (entryName: string) => [
    ...zipSegments,
    ...entryName.split('/').filter((s) => s.length > 0),
  ];
  let entryCount = 0;
  const wanted = (entryName: string): boolean => {
    entryCount += 1;
    const segments = segmentsOf(entryName);
    if (segments.length === zipSegments.length || isMacJunk(segments)) return false;
    const name = segments[segments.length - 1]!;
    if (name === TAURUS_LOG) {
      noteFile(scan, segments, NOT_READ);
      return false;
    }
    return ZIP_RE.test(name) || isRecordFileName(name);
  };

  let entries;
  try {
    entries = await readZipEntries(bytes, wanted);
  } catch (err) {
    throw new Error(`cannot read ${display}: ${(err as Error).message}`, { cause: err });
  }
  scan.boundaries.add(joinSegments(zipSegments));
  for (const entry of entries) {
    const segments = segmentsOf(entry.name);
    if (ZIP_RE.test(segments[segments.length - 1]!)) {
      await scanZip(scan, entry.data, segments, `${display}/${entry.name}`);
    } else {
      const data = entry.data;
      noteFile(scan, segments, async () => data.toString('utf8'));
    }
  }
  return entryCount;
}

/** One zip's record files, read in memory — the cache path's reader. */
export interface ZipRecords {
  /** Record files, display paths relative to the zip root, sorted. */
  files: RecordFile[];
  /** Every file entry in the zip, records or not. */
  entryCount: number;
}

/**
 * Read one Engine's artifacts.zip with the same lazy scan local import uses
 * (nested zips included): only records are inflated and CRC-checked. The
 * caller already knows the Engine, so no identity is inferred. Throws when
 * the zip is truncated or a record in it is corrupt.
 */
export async function readZipRecords(bytes: Buffer, display: string): Promise<ZipRecords> {
  const scan: Scan = { records: [], boundaries: new Set(), taurusLogs: [] };
  const entryCount = await scanZip(scan, bytes, [], display);
  const files = scan.records
    .map((r) => ({ file: joinSegments(r.segments), read: r.read }))
    .sort(byFile);
  return { files, entryCount };
}

const byFile = (a: RecordFile, b: RecordFile) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

async function scanDir(scan: Scan, absDir: string, dirSegments: string[]) {
  const dirents = await readdir(absDir, { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    const segments = [...dirSegments, dirent.name];
    if (isMacJunk(segments)) continue;
    const abs = path.join(absDir, dirent.name);
    if (dirent.isDirectory()) {
      await scanDir(scan, abs, segments);
    } else if (dirent.isFile()) {
      if (ZIP_RE.test(dirent.name)) {
        await scanZip(scan, await readFile(abs), segments, abs);
      } else {
        noteFile(scan, segments, () => readFile(abs, 'utf8'));
      }
    }
  }
}

/** The sessionId of the Engine a file belongs to — rules 1–3 above. */
function sessionIdOf(segments: string[], boundaries: Set<string>, rootName: string): string {
  for (let i = segments.length - 1; i > 0; i--) {
    const name = segments[i - 1]!.replace(ZIP_RE, '');
    if (SESSION_ID_RE.test(name)) return name;
  }
  for (let i = segments.length - 1; i > 0; i--) {
    const prefix = segments.slice(0, i);
    if (boundaries.has(joinSegments(prefix))) {
      return joinSegments([...prefix.slice(0, -1), prefix[i - 1]!.replace(ZIP_RE, '')]);
    }
  }
  return rootName;
}

/**
 * Read every Engine's record files from a local zip or folder. No network, no
 * credentials, and nothing written to disk. Throws when the path holds neither
 * a record nor a Taurus Engine — a wrong path must fail loudly, not render an
 * empty report.
 */
export async function readLocalArtifacts(inputPath: string): Promise<EngineRecords[]> {
  const abs = path.resolve(inputPath);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`--artifacts path not found: ${inputPath}`);
  }

  const scan: Scan = { records: [], boundaries: new Set(), taurusLogs: [] };
  if (info.isDirectory()) await scanDir(scan, abs, []);
  else await scanZip(scan, await readFile(abs), [], abs);

  const rootName = path.basename(abs).replace(ZIP_RE, '');
  const engines = new Map<string, RecordFile[]>();
  const engineFor = (sessionId: string): RecordFile[] => {
    let files = engines.get(sessionId);
    if (!files) engines.set(sessionId, (files = []));
    return files;
  };

  for (const record of scan.records) {
    const sessionId = sessionIdOf(record.segments, scan.boundaries, rootName);
    engineFor(sessionId).push({ file: joinSegments(record.segments), read: record.read });
  }
  // A Taurus Engine with zero records (the collector import was forgotten) is
  // still an Engine — listed with 0 Samples, never silently absent.
  for (const log of scan.taurusLogs) engineFor(sessionIdOf(log, scan.boundaries, rootName));

  if (engines.size === 0) {
    throw new Error(
      `no web-vitals records under ${inputPath} — expected ${SAMPLE_ATTACHMENT_PREFIX}-*.json ` +
        `or ${OUTCOME_ATTACHMENT_PREFIX}-*.json files in a BlazeMeter artifacts.zip, ` +
        `its unzipped folder, or a folder holding several of them`,
    );
  }

  return [...engines.keys()].sort().map((sessionId) => ({
    sessionId,
    locationId: LOCAL_LOCATION_ID,
    status: LOCAL_SESSION_STATUS,
    artifact: 'present' as const,
    files: engines.get(sessionId)!.sort(byFile),
  }));
}
