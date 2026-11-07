// A minimal read-only zip parser over node builtins (zlib) — no npm dependency.
//
// Scope is deliberately the zips this dashboard actually reads: BlazeMeter
// artifacts.zip files — store- or deflate-compressed, no zip64, no encryption,
// no spanning. Anything outside that scope throws loudly rather than decoding
// wrong bytes.
//
// Reading is lazy: the caller's filter picks entries by name from the central
// directory, and only those are inflated and CRC32-verified — so a corrupt
// record fails the run instead of poisoning the report, while the video.webm,
// trace.zip and html-report twins an artifacts.zip also carries are never
// inflated at all. Every entry, wanted or not, is still bounds-checked, so a
// truncated download fails loudly.
//
// This module exists (instead of yauzl) so the whole dashboard resolves from
// node builtins alone — which is what lets scripts/build-standalone.ts emit a
// single .ts file runnable with no npm install at all.

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** The entry name as stored; artifacts.zip entries are flat basenames. */
  name: string;
  data: Buffer;
}

/** Decides, from its name alone, whether an entry is inflated and returned. */
export type ZipEntryFilter = (name: string) => boolean;

/** Every file entry — for the debug --extract and tests; the report pipeline
 *  always passes a narrower filter. */
export const ALL_ENTRIES: ZipEntryFilter = () => true;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Locate the end-of-central-directory record (the comment can push it forward). */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip: no end-of-central-directory record');
}

/**
 * Read the file entries of a zip held entirely in memory. Only entries whose
 * name passes `filter` are inflated and CRC-checked. `filter` sees every file
 * entry's name exactly once, in central-directory order, so a caller that only
 * needs to know an entry EXISTS (bzt.log, for Engine inference) can note it
 * there and return false. Async for call-site compatibility with the streaming
 * reader it replaced; the parse itself is synchronous.
 */
export function readZipEntries(
  zipBytes: Buffer,
  filter: ZipEntryFilter = ALL_ENTRIES,
): Promise<ZipEntry[]> {
  try {
    return Promise.resolve(readZipEntriesSync(zipBytes, filter));
  } catch (err) {
    return Promise.reject(err);
  }
}

function readZipEntriesSync(buf: Buffer, filter: ZipEntryFilter): ZipEntry[] {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('zip64 archive — outside the scope of this reader');
  }

  const entries: ZipEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`corrupt zip: bad central directory signature at ${p}`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a directory entry, not a file
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 entry '${name}' — outside the scope of this reader`);
    }

    // Sizes come from the central directory (authoritative even when the local
    // header deferred them to a data descriptor); the local header is read only
    // to find where the data starts, since its extra field can differ in length.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`corrupt zip: bad local header signature for '${name}'`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`corrupt zip: '${name}' is truncated`);
    }

    if (!filter(name)) continue; // never inflated, never CRC-checked

    if (flags & 0x1) throw new Error(`encrypted zip entry '${name}' — unsupported`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip entry '${name}' uses unsupported compression method ${method}`);

    if (data.length !== uncompSize) {
      throw new Error(`corrupt zip: '${name}' inflated to ${data.length}, expected ${uncompSize}`);
    }
    if (crc32(data) !== crc) throw new Error(`corrupt zip: CRC mismatch on '${name}'`);

    entries.push({ name, data });
  }
  return entries;
}
