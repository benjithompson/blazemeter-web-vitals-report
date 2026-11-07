// Namespaced extraction — a DEBUG aid only, behind the CLI's --extract <dir>.
// The report pipeline never extracts: it reads records out of each zip in
// memory (local.ts readZipRecords). This writes a cached Engine's whole zip to
// disk so a person can look inside it.
//
// Cross-Engine attachment basenames are IDENTICAL by construction (basename is
// sha1 of the fixed absolute path Taurus passes to every Engine). Extracting two
// Engines' flat zips into one directory silently destroys half the Samples, and
// nothing downstream can notice. So every extraction is
// namespaced by sessionId: destRoot/{sessionId}/{entryName}.
//
// See SPEC.md → "Cross-Engine filename collision".

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_ENTRIES, readZipEntries } from './zip.js';

export interface ExtractResult {
  /** destRoot/{sessionId} */
  sessionDir: string;
  /** Flat entry names written (basenames). */
  files: string[];
}

/**
 * Extract a flat zip into destRoot/{sessionId}/. The sessionId namespace is what
 * keeps two Engines' byte-identical colliding basenames from overwriting each
 * other. Returns the entry names written.
 */
export async function extractNamespaced(
  zipBytes: Buffer,
  sessionId: string,
  destRoot: string,
): Promise<ExtractResult> {
  const sessionDir = path.join(destRoot, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const entries = await readZipEntries(zipBytes, ALL_ENTRIES);
  const files: string[] = [];
  for (const entry of entries) {
    // Flat: basename === entry name. path.basename guards a stray separator.
    const outPath = path.join(sessionDir, path.basename(entry.name));
    await writeFile(outPath, entry.data);
    files.push(entry.name);
  }
  return { sessionDir, files };
}
