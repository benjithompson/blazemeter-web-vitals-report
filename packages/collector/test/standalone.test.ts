// Seam 1 for the STANDALONE build (dist-standalone/bzm-playwright-vitals.ts) — the one-file variant
// uploaded directly to a BlazeMeter test next to a spec. Same rules as tracer.test.ts:
// a REAL Playwright child run, assertions on the JSON files left on disk, never mocks.
//
// The child spec (fixtures/standalone.spec.ts) imports './bzm-playwright-vitals' — the exact
// relative-TS-import path Playwright's own loader must transpile on an Engine. The file
// it imports is REGENERATED here in beforeAll via the actual build script and copied
// into the fixtures dir, so a stale artifact can never be what gets tested.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@bzm/vitals-format';
import { buildStandalone } from '../scripts/build-standalone';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  FIXTURES_DIR,
  runPlaywright,
  findSamples,
  findOutcomes,
  type FoundSample,
  type FoundOutcome,
} from './helpers/run-playwright';

const VITAL_NAMES = ['ttfb', 'fcp', 'lcp', 'cls', 'inp'] as const;

let server: FixtureServer;
let samples: FoundSample[];
let outcomes: FoundOutcome[];

beforeAll(async () => {
  // Regenerate the artifact from src/index.ts, then place it NEXT TO the spec — the
  // upload-kit layout. Staleness is impossible: what runs is what the script just built.
  const { outFile } = await buildStandalone();
  await copyFile(outFile, join(FIXTURES_DIR, 'bzm-playwright-vitals.ts'));

  server = await startFixtureServer();
  const run = await runPlaywright({
    spec: 'standalone.spec.ts',
    baseURL: server.url,
    args: ['--repeat-each', '2', '--workers', '2'],
  });

  samples = await findSamples(run.outputDir);
  outcomes = await findOutcomes(run.outputDir);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

function forTitle(title: string): FoundSample[] {
  return samples.filter((s) => s.sample.test.title === title);
}

describe('the standalone file behaves as the package does under a relative TS import', () => {
  it('emits one Sample per Navigation: 2 repeats x (1 + 2) Navigations = 6 Samples', () => {
    expect(forTitle('Standalone Landing Page').length).toBe(2);
    expect(forTitle('Standalone Journey').length).toBe(4);
  });

  it('every Sample is format-v1 shaped with all five vitals present', () => {
    expect(samples.length).toBe(6);
    for (const { sample } of samples) {
      expect(sample.schemaVersion).toBe(SCHEMA_VERSION);
      expect(typeof sample.ts).toBe('number');
      expect(typeof sample.url).toBe('string');
      expect(typeof sample.navigationIndex).toBe('number');
      for (const name of VITAL_NAMES) {
        const m = sample.vitals[name];
        expect(m, `vitals.${name}`).toBeDefined();
        expect(m).toHaveProperty('value');
        expect(m).toHaveProperty('status');
      }
    }
  });

  it('ttfb and fcp are measured (status ok, finite value) on the served pages', () => {
    for (const { sample } of samples) {
      for (const name of ['ttfb', 'fcp'] as const) {
        expect(sample.vitals[name]!.status).toBe('ok');
        expect(Number.isFinite(sample.vitals[name]!.value)).toBe(true);
      }
    }
  });

  it('the journey has navigationIndex 1 and 2, and route() rode along', () => {
    const byExecution = new Map<string, FoundSample[]>();
    for (const s of forTitle('Standalone Journey')) {
      const key = `${s.sample.test.repeat}:${s.sample.test.worker}`;
      byExecution.set(key, [...(byExecution.get(key) ?? []), s]);
    }
    expect(byExecution.size).toBe(2); // repeat 0 and 1
    for (const list of byExecution.values()) {
      const ordered = list.sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
      expect(ordered.map((s) => s.sample.navigationIndex)).toEqual([1, 2]);
      // vitals.route() tagged Navigation 1 (declared while the page was on it).
      expect(ordered[0]!.sample.route).toBe('/home/{id}');
      expect(ordered[1]!.sample.route).toBeUndefined();
      // Navigation 1 carried a real click, so its INP was measured.
      expect(ordered[0]!.sample.vitals['inp']!.status).toBe('ok');
    }
  });

  it('every Execution left exactly one Outcome record, schemaVersion 1, status passed', () => {
    // 2 tests x 2 repeats = 4 Executions.
    expect(outcomes.length).toBe(4);
    for (const { outcome } of outcomes) {
      expect(outcome.schemaVersion).toBe(SCHEMA_VERSION);
      expect(outcome.status).toBe('passed');
      expect(outcome.retry).toBe(0);
      expect(outcome.test.file).toBe('standalone.spec.ts');
    }
  });

  it('the generated file declares itself: header, generator, no workspace import', async () => {
    const { source } = await buildStandalone();
    expect(source).toContain('DO NOT HAND-EDIT');
    expect(source).toContain('scripts/build-standalone.ts');
    expect(source).toContain('adopt via npm when published');
    // No resolvable reference to the workspace package (comments may mention it).
    expect(source).not.toMatch(/(?:from\s+|require\()\s*['"]@bzm\/vitals-format['"]/);
    // No .js-extension self-imports and no top-level await — the things Playwright's
    // Engine-side TS loader chokes on.
    expect(source).not.toMatch(/from\s+'\.[^']*\.js'/);
    expect(source).not.toMatch(/^await\s/m);
  });
});
