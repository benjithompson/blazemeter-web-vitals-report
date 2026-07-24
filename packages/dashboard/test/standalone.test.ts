// Seam test for the STANDALONE dashboard build (dist-standalone/bzm-vitals-dashboard.ts) —
// the one-file variant a no-npm user downloads from a release. Same philosophy as the
// collector's standalone.test.ts: the artifact is REGENERATED here from the real sources
// via the actual build script (staleness impossible), copied to a temp dir the way a
// download lands, and run as a CHILD PROCESS — the exact invocation a user makes.
//
// The cold fetch is done in-process through the package code path with a stubbed
// Transport (no test touches the network); the child then runs against that warm cache
// OFFLINE. Package and standalone reading the same cache into the same embedded blob is
// the equivalence this seam asserts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_ATTACHMENT_PREFIX } from 'bzm-vitals-format';
import { buildStandalone } from '../scripts/build-standalone';
import { runCli } from '../src/cli.js';
import { jsonResponse, bytesResponse, recordingTransport } from './helpers/transport.js';
import { makeZip } from './helpers/zip.js';
import { parseBlob } from './helpers/blob.js';

const execFileP = promisify(execFile);

// Run the child through the repo's tsx so the test doesn't depend on the local
// node's --experimental-strip-types support (validated manually on node >= 23.6).
const TSX_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules/tsx/dist/cli.mjs',
);

const MASTER_ID = '91000001';
const SESSION = 'r-v4-standalone-aaa';

const STUB_ENV = {
  BLAZEMETER_API_KEY_ID: 'stub-key-id-8f3a51',
  BLAZEMETER_API_KEY_SECRET: 'stub-key-secret-c41d97e2',
} as NodeJS.ProcessEnv;

function canonicalSample(overrides: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ts: 1752700745069,
      url: 'https://example.com/checkout?step=1',
      test: { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat: 0, worker: 0 },
      navigationIndex: 1,
      vitals: {
        ttfb: { value: 120, status: 'ok' },
        lcp: { value: 2000, status: 'ok' },
        inp: { value: null, status: 'no-interaction' },
      },
      navigation: { domContentLoadedMs: 900, loadEventMs: 1500 },
      context: { workers: 2, resourceCount: 10, requestCount: 12, failedRequests: 0 },
      ...overrides,
    }),
  );
}

let workDir: string;
let standalonePath: string;
let source: string;
let referenceHtml: string;

beforeAll(async () => {
  const build = await buildStandalone();
  source = build.source;

  // The temp dir plays the download directory: the artifact is copied there and the
  // child runs with it as cwd, so the standalone's cwd-based .artifact-cache default
  // (its path contains neither packages/ nor node_modules/) resolves inside it.
  workDir = await mkdtemp(path.join(tmpdir(), 'bzm-standalone-'));
  standalonePath = path.join(workDir, 'bzm-vitals-dashboard.ts');
  await copyFile(build.outFile, standalonePath);

  // Cold fetch through the PACKAGE code path, stubbed transport, into the exact
  // cacheRoot the standalone child will resolve.
  const zip = makeZip([
    {
      name: `${SAMPLE_ATTACHMENT_PREFIX}-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`,
      data: canonicalSample({ vitals: { lcp: { value: 1000, status: 'ok' } } }),
    },
    {
      name: `${SAMPLE_ATTACHMENT_PREFIX}-2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`,
      data: canonicalSample({ vitals: { lcp: { value: 2000, status: 'ok' } } }),
    },
    { name: 'bzt.log', data: Buffer.from('noise') },
  ]);
  const { transport } = recordingTransport((url) => {
    if (url.endsWith(`/masters/${MASTER_ID}/status`)) {
      return jsonResponse({
        result: { sessions: [{ id: SESSION, status: 'ENDED', locationId: 'us-east-1' }] },
      });
    }
    if (url.endsWith(`/masters/${MASTER_ID}`)) {
      return jsonResponse({ result: { name: 'Standalone seam' } });
    }
    if (/\/reports\/logs$/.test(url)) {
      return jsonResponse({
        result: {
          data: [
            {
              filename: 'artifacts.zip',
              dataUrl: `https://storage.blazemeter.com/${SESSION}/artifacts.zip?Signature=abc`,
            },
          ],
        },
      });
    }
    if (url.startsWith('https://storage.blazemeter.com/')) return bytesResponse(zip);
    throw new Error(`unexpected ${url}`);
  });

  const referencePath = path.join(workDir, 'reference.html');
  await runCli({
    argv: ['--master', MASTER_ID, '--out', referencePath],
    env: STUB_ENV,
    transport,
    cacheRoot: path.join(workDir, '.artifact-cache'),
    log: () => {},
  });
  referenceHtml = await readFile(referencePath, 'utf8');
}, 60_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('the standalone file behaves as the package does', () => {
  it('resolves from node builtins alone — no npm-installable import survives', () => {
    const importRe = /^import\s[^;]*?from\s+'([^']+)';/gm;
    const specifiers = [...source.matchAll(importRe)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(spec).toMatch(/^node:/);
    // No .js-extension self-imports, no top-level await, no surviving re-export.
    expect(source).not.toMatch(/from\s+'\.[^']*'/);
    expect(source).not.toMatch(/^await\s/m);
    expect(source).not.toMatch(/^export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from/m);
  });

  it('declares itself a generated artifact with usage in the header', () => {
    expect(source).toContain('DO NOT HAND-EDIT');
    expect(source).toContain('scripts/build-standalone.ts');
    expect(source).toContain('--master <masterId> --out report.html');
  });

  it('run as a child process against the warm cache, offline, it emits the package-identical blob', async () => {
    await execFileP(
      process.execPath,
      [TSX_CLI, standalonePath, '--master', MASTER_ID, '--out', 'report.html'],
      { cwd: workDir },
    );

    const html = await readFile(path.join(workDir, 'report.html'), 'utf8');
    const data = parseBlob(html);
    expect(data.masterId).toBe(MASTER_ID);
    expect(data.reportName).toBe('Standalone seam');
    expect(data.samples).toHaveLength(2);

    // The equivalence this seam exists for: same cache in, same blob out —
    // byte-for-byte except the generation timestamp.
    const reference = parseBlob(referenceHtml);
    expect({ ...data, generatedAt: null }).toEqual({ ...reference, generatedAt: null });
  }, 60_000);

  it('with no arguments it exits 1 and prints usage, like the installed bin', async () => {
    const result = await execFileP(process.execPath, [TSX_CLI, standalonePath], {
      cwd: workDir,
    }).then(
      () => {
        throw new Error('expected a non-zero exit');
      },
      (err: { code?: number; stderr?: string }) => err,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('usage: bzm-vitals-dashboard');
  }, 60_000);
});
