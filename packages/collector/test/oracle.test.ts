// Seam 1 — C0: the web-vitals reference oracle (test-only, Chromium only).
//
// oracle.spec.ts injects the web-vitals attribution build next to the collector and
// drives five Navigations: a layout shift with a slow click, a slow LCP image, and three
// fast clicks. This file pairs each collector Sample with web-vitals' reading of the SAME
// document and checks they agree. web-vitals is the reference implementation; where the
// two read the same performance entries, they must give the same numbers.
//
// Tolerances (each one is the tightest the two implementations can honestly share):
//   CLS            identical to 4 decimal places. Both run the same session-window
//                  algorithm over the same layout-shift entries; only float summation
//                  order could differ.
//   LCP, FCP, TTFB within 1 ms. Both take startTime / responseStart from the same entry
//                  (web-vitals subtracts activationStart, which is 0 without prerender);
//                  1 ms absorbs any rounding either side may apply.
//   INP            within 1 ms. Both take the worst interaction's duration (below 50
//                  interactions, web-vitals' p98 estimate IS the worst), and the oracle
//                  runs with the collector's durationThreshold of 16; durations are
//                  already 8ms-granular, so in practice they are equal.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metric } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { runPlaywright, findSamples, walkFiles, type FoundSample } from './helpers/run-playwright';
import type { OracleReading } from './fixtures/oracle.spec';

const MS_TOLERANCE = 1;
const CLS_DIGITS = 4;

let server: FixtureServer;
let samples: FoundSample[];
let oracle: OracleReading[];

/** [collector Sample, web-vitals reading] for the Navigations at these 0-based indexes. */
function pairs(indexes: number[]): Array<[FoundSample, OracleReading]> {
  return indexes.map((i) => [samples[i]!, oracle[i]!]);
}

function ok(s: FoundSample, name: string): number {
  const m: Metric | undefined = s.sample.vitals[name];
  expect(m, `${name} on ${s.path}`).toEqual({ value: expect.any(Number), status: 'ok' });
  return m!.value!;
}

const ALL = [0, 1, 2, 3, 4];
const SLOW_CLICK = [0];
const NO_INTERACTION = [1];
const FAST_CLICKS = [2, 3, 4];

beforeAll(async () => {
  server = await startFixtureServer();
  const run = await runPlaywright({ spec: 'oracle.spec.ts', baseURL: server.url });
  expect(run.exitCode, run.stdout + run.stderr).toBe(0);
  samples = (await findSamples(run.outputDir)).sort(
    (a, b) => a.sample.navigationIndex - b.sample.navigationIndex,
  );
  const oracleFile = (await walkFiles(run.outputDir)).find((f) => f.endsWith('/bzm-oracle.json'));
  expect(oracleFile, 'the oracle spec wrote its readings').toBeDefined();
  oracle = JSON.parse(await readFile(oracleFile!, 'utf8')) as OracleReading[];
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('the collector agrees with web-vitals on the same documents', () => {
  it('both saw the same five Navigations, in the same order', () => {
    expect(samples.length).toBe(5);
    expect(oracle.length).toBe(5);
    expect(samples.map((s) => s.sample.url)).toEqual(oracle.map((o) => o.url));
  });

  it(`CLS is identical to ${CLS_DIGITS} decimal places`, () => {
    for (const [s, o] of pairs(ALL)) {
      expect(ok(s, 'cls'), s.sample.url).toBeCloseTo(o.cls!, CLS_DIGITS);
    }
  });

  for (const name of ['lcp', 'fcp', 'ttfb'] as const) {
    it(`${name.toUpperCase()} is within ${MS_TOLERANCE} ms`, () => {
      for (const [s, o] of pairs(ALL)) {
        expect(Math.abs(ok(s, name) - o[name]!), `${name} on ${s.sample.url}`).toBeLessThanOrEqual(MS_TOLERANCE);
      }
    });
  }

  it('LCP on the slow-image page is the image, not the text — both say so', () => {
    // The 400ms-delayed image lands well after FCP; an LCP equal to FCP would mean the
    // fixture failed to produce the slow candidate this comparison exists to check.
    const [[s, o]] = pairs(NO_INTERACTION);
    expect(o.lcp!).toBeGreaterThan(o.fcp! + 200);
    expect(ok(s!, 'lcp')).toBeGreaterThan(ok(s!, 'fcp') + 200);
  });

  it(`INP for a slow click is within ${MS_TOLERANCE} ms`, () => {
    for (const [s, o] of pairs(SLOW_CLICK)) {
      expect(o.inp, 'web-vitals saw the click').not.toBeNull();
      expect(Math.abs(ok(s, 'inp') - o.inp!), s.sample.url).toBeLessThanOrEqual(MS_TOLERANCE);
    }
  });

  it("with no interaction, web-vitals reports no INP and the collector says 'no-interaction'", () => {
    for (const [s, o] of pairs(NO_INTERACTION)) {
      expect(o.inp).toBeNull();
      expect(s.sample.vitals.inp).toEqual({ value: null, status: 'no-interaction' });
    }
  });

  // Expected to fail until C2 (fast clicks reported as interactions) lands: the collector
  // records a fast click as 'no-interaction', while web-vitals' first-input observer
  // sees it. Flip to `it` when C2 merges.
  it.fails(`INP for a fast click is within ${MS_TOLERANCE} ms`, () => {
    for (const [s, o] of pairs(FAST_CLICKS)) {
      expect(o.inp, 'web-vitals saw the click').not.toBeNull();
      expect(Math.abs(ok(s, 'inp') - o.inp!), s.sample.url).toBeLessThanOrEqual(MS_TOLERANCE);
    }
  });
});

describe('web-vitals stays a test-only reference', () => {
  const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
  // An import or require of the package — prose mentioning the library is fine.
  const IMPORTS_WEB_VITALS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]web-vitals/;

  it('is a devDependency only — never a runtime dependency', async () => {
    const pkg = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect(pkg.devDependencies?.['web-vitals']).toBeDefined();
    expect(pkg.dependencies?.['web-vitals']).toBeUndefined();
    expect(pkg.peerDependencies?.['web-vitals']).toBeUndefined();
  });

  it('nothing in src/ or the built dist/ imports it', async () => {
    // dist/ is what `npm publish` ships (tsc --build runs before this suite); src/ is
    // what the standalone bundle is built from.
    const files = [...(await walkFiles(join(PKG, 'src'))), ...(await walkFiles(join(PKG, 'dist')))];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files.filter((f) => /\.(ts|js)$/.test(f))) {
      expect(IMPORTS_WEB_VITALS.test(await readFile(f, 'utf8')), f).toBe(false);
    }
  });
});
