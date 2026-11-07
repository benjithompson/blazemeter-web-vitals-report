// A fake InfluxDB 2.x write endpoint — the integration DOUBLE for the Influx sink. It answers
// POST /api/v2/write over real HTTP, PARSES the line-protocol body strictly (a malformed line
// is a 400, as Influx answers), and stores points with Influx's own identity rule: a point is
// (measurement, tag set, timestamp), and a second write with the same identity OVERWRITES the
// first (field values merge, last write wins). So a test can assert what would actually
// survive in a bucket — e.g. that two Samples did not collapse into one point — without
// Docker. The Docker test (influx-integration.test.ts) remains the proof against a real one.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StoredPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, number>;
  /** Timestamp normalized to ns, from the request's `precision`. */
  timestampNs: bigint;
}

export interface InfluxServer {
  url: string;
  /** The points a real bucket would hold, after overwrite-on-identical-identity. */
  points(): StoredPoint[];
  /** Raw bodies received, in order. */
  bodies: string[];
  /** The `precision` query of each write. */
  precisions: string[];
  /** 400 responses sent for malformed lines (the parse errors). */
  rejections: string[];
  close(): Promise<void>;
}

const NS_PER: Record<string, bigint> = { ns: 1n, us: 1_000n, ms: 1_000_000n, s: 1_000_000_000n };

/** Split `s` on unescaped `sep` chars, keeping escapes in the pieces. */
function splitUnescaped(s: string, seps: string): { parts: string[]; rest: string; stop: string | null } {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (seps.includes(c)) {
      if (c === ' ') return { parts: [...parts, cur], rest: s.slice(i + 1), stop: ' ' };
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  return { parts: [...parts, cur], rest: '', stop: null };
}

/** Undo line-protocol escapes (`\,` `\=` `\ ` and `\\`). */
function unescape(s: string): string {
  return s.replace(/\\([,= \\])/g, '$1');
}

/** Split one `k=v` on its first unescaped `=`. */
function splitPair(s: string): [string, string] | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '=') return [s.slice(0, i), s.slice(i + 1)];
  }
  return null;
}

/** Parse one line strictly, or throw with the reason Influx would give. */
export function parseLine(line: string, precision: string): StoredPoint {
  if (/[\r]/.test(line)) throw new Error('carriage return in line');
  const head = splitUnescaped(line, ', ');
  const [measurementRaw, ...tagParts] = head.parts;
  if (!measurementRaw) throw new Error('missing measurement');
  if (head.stop !== ' ') throw new Error('missing fields');
  const tags: Record<string, string> = {};
  for (const t of tagParts) {
    const kv = splitPair(t);
    if (kv === null || kv[0] === '' || kv[1] === '') throw new Error(`invalid tag "${t}"`);
    tags[unescape(kv[0])] = unescape(kv[1]);
  }
  const fieldSeg = splitUnescaped(head.rest, ', ');
  const fields: Record<string, number> = {};
  for (const f of fieldSeg.parts) {
    const kv = splitPair(f);
    if (kv === null || kv[0] === '') throw new Error(`invalid field "${f}"`);
    const v = kv[1].replace(/i$/, '');
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) throw new Error(`invalid field value "${kv[1]}"`);
    fields[unescape(kv[0])] = Number(v);
  }
  if (Object.keys(fields).length === 0) throw new Error('no fields');
  const tsRaw = fieldSeg.rest.trim();
  if (!/^-?\d+$/.test(tsRaw)) throw new Error(`invalid timestamp "${tsRaw}"`);
  const unit = NS_PER[precision];
  if (unit === undefined) throw new Error(`invalid precision ${precision}`);
  return { measurement: unescape(measurementRaw), tags, fields, timestampNs: BigInt(tsRaw) * unit };
}

/** The identity Influx dedupes on: measurement + sorted tag set + timestamp. */
function identity(p: StoredPoint): string {
  const tagSet = Object.keys(p.tags)
    .sort()
    .map((k) => `${k}=${p.tags[k]}`)
    .join(',');
  return `${p.measurement}|${tagSet}|${p.timestampNs}`;
}

export async function startInfluxServer(): Promise<InfluxServer> {
  const store = new Map<string, StoredPoint>();
  const bodies: string[] = [];
  const precisions: string[] = [];
  const rejections: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || url.pathname !== '/api/v2/write') {
        res.writeHead(404).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const precision = url.searchParams.get('precision') ?? 'ns';
      bodies.push(body);
      precisions.push(precision);
      const parsed: StoredPoint[] = [];
      const lines = body.split('\n').filter((l) => l.trim() !== '');
      for (const [i, line] of lines.entries()) {
        try {
          parsed.push(parseLine(line, precision));
        } catch (err) {
          const msg = `line ${i + 1}: ${(err as Error).message}`;
          rejections.push(msg);
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'invalid', message: msg }));
          return; // all-or-nothing, like a rejected batch
        }
      }
      for (const p of parsed) {
        const key = identity(p);
        const prev = store.get(key);
        store.set(key, prev ? { ...p, fields: { ...prev.fields, ...p.fields } } : p);
      }
      res.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    points: () => [...store.values()],
    bodies,
    precisions,
    rejections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
