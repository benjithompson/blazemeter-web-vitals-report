// Seam 1 — the collector, asserted on files that exist on disk after a REAL Playwright
// run. Not mocks. Not "attach was called". The bug class this library exists to kill is
// "the run went green and wrote nothing", so the only honest assertion is: is the file
// there, and is it the right shape?
//
// One Playwright child run (slow, ~seconds) feeds most of these assertions. The run drives
// journey.spec.ts under --repeat-each 2 --workers 2 with a fake SESSION_TOKEN in its env.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  SCHEMA_VERSION,
  SAMPLE_ATTACHMENT_PREFIX,
  type MetricStatus,
} from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  runPlaywright,
  findSamples,
  findOutcomes,
  anyFileContains,
  type FoundSample,
  type FoundOutcome,
} from './helpers/run-playwright';

// A distinctive, token-shaped value we plant in the child env. It must appear in NO
// output file: the library reads only NAMED env vars and never serializes process.env.
const FAKE_TOKEN = 'SESSION-TOKEN-a1b2c3d4e5f6-DO-NOT-LEAK';

let server: FixtureServer;
let samples: FoundSample[];
let outcomes: FoundOutcome[];
let wallStart: number;
let wallEnd: number;
let outputDir: string;

beforeAll(async () => {
  server = await startFixtureServer();

  wallStart = Date.now();
  const run = await runPlaywright({
    spec: 'journey.spec.ts',
    baseURL: server.url,
    args: ['--repeat-each', '2', '--workers', '2'],
    env: {
      SESSION_TOKEN: FAKE_TOKEN,
      // The library must not read this either — only named vars it asks for.
      BLAZEMETER_SECRET: FAKE_TOKEN,
    },
  });
  wallEnd = Date.now();

  samples = await findSamples(run.outputDir);
  outcomes = await findOutcomes(run.outputDir);
  // Keep the output dir path around for the token-leak scan.
  outputDir = run.outputDir;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

/** Samples for one test title, sorted by navigationIndex within an Execution. */
function forTitle(title: string): FoundSample[] {
  return samples.filter((s) => s.sample.test.title === title);
}

describe('one changed import emits one Sample per Navigation', () => {
  it('emits at least one Sample and every Sample is format-v1 shaped', () => {
    expect(samples.length).toBeGreaterThan(0);
    for (const { sample } of samples) {
      expect(sample.schemaVersion).toBe(SCHEMA_VERSION);
      expect(typeof sample.ts).toBe('number');
      expect(typeof sample.url).toBe('string');
      expect(typeof sample.navigationIndex).toBe('number');
      // vitals.ttfb and vitals.fcp are each {value, status}
      for (const name of ['ttfb', 'fcp'] as const) {
        const m = sample.vitals[name];
        expect(m, `vitals.${name}`).toBeDefined();
        expect(m).toHaveProperty('value');
        expect(m).toHaveProperty('status');
      }
      expect(sample.navigation).toHaveProperty('domContentLoadedMs');
      expect(sample.navigation).toHaveProperty('loadEventMs');
      expect(sample.context).toHaveProperty('workers');
      expect(sample.context).toHaveProperty('resourceCount');
      expect(sample.context).toHaveProperty('requestCount');
      expect(sample.context).toHaveProperty('failedRequests');
    }
  });

  it('reports ttfb and fcp as measured (status ok, finite value) on a served page', () => {
    const landing = forTitle('Landing Page');
    expect(landing.length).toBeGreaterThan(0);
    for (const { sample } of landing) {
      for (const name of ['ttfb', 'fcp'] as const) {
        expect(sample.vitals[name]!.status).toBe<MetricStatus>('ok');
        expect(typeof sample.vitals[name]!.value).toBe('number');
        expect(Number.isFinite(sample.vitals[name]!.value)).toBe(true);
      }
    }
  });

  it('Landing Page drove exactly one Navigation per Execution', () => {
    const landing = forTitle('Landing Page');
    // --repeat-each 2 -> two Executions (repeat 0 and 1), each one Navigation.
    expect(landing.length).toBe(2);
    for (const { sample } of landing) {
      expect(sample.navigationIndex).toBe(1);
    }
  });
});

describe('two Navigations in one test yield two Samples with distinct navigationIndex', () => {
  it('each Two Navigations Execution has navigationIndex 1 and 2 with ts ordered', () => {
    const two = forTitle('Two Navigations');
    // 2 repeats x 2 Navigations
    expect(two.length).toBe(4);

    // Group by Execution = (repeat, worker), then check the pair.
    const byExecution = new Map<string, FoundSample[]>();
    for (const s of two) {
      const key = `${s.sample.test.repeat}:${s.sample.test.worker}`;
      const list = byExecution.get(key) ?? [];
      list.push(s);
      byExecution.set(key, list);
    }
    expect(byExecution.size).toBe(2);
    for (const list of byExecution.values()) {
      const ordered = list.sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
      expect(ordered.map((s) => s.sample.navigationIndex)).toEqual([1, 2]);
      // First Navigation went to '/', second to '/second'.
      expect(ordered[0]!.sample.url).toMatch(/\/$/);
      expect(ordered[1]!.sample.url).toMatch(/\/second$/);
      // ts is epoch ms at Navigation start, so Sample 1 precedes Sample 2.
      expect(ordered[0]!.sample.ts).toBeLessThan(ordered[1]!.sample.ts);
    }
  });
});

describe('ts is epoch ms at Navigation start', () => {
  it('every ts falls within the run wall-clock window', () => {
    // Small slop to absorb clock granularity at the boundaries.
    const lo = wallStart - 5_000;
    const hi = wallEnd + 5_000;
    for (const { sample } of samples) {
      expect(sample.ts).toBeGreaterThanOrEqual(lo);
      expect(sample.ts).toBeLessThanOrEqual(hi);
    }
  });
});

describe('test identity is captured from testInfo, not guessed', () => {
  it('file, title, project match the run; repeat 0 and 1 both appear', () => {
    for (const { sample } of samples) {
      expect(sample.test.file).toBe('journey.spec.ts');
      expect(sample.test.project).toBe('chromium');
      expect(typeof sample.test.worker).toBe('number');
    }
    const titles = new Set(samples.map((s) => s.sample.test.title));
    expect(titles).toContain('Landing Page');
    expect(titles).toContain('Two Navigations');

    // --repeat-each 2 -> both repeat indices present.
    const repeats = new Set(samples.map((s) => s.sample.test.repeat));
    expect(repeats).toContain(0);
    expect(repeats).toContain(1);
  });

  it('context.workers reflects the actual worker count of the run (2)', () => {
    for (const { sample } of samples) {
      expect(sample.context.workers).toBe(2);
    }
  });
});

describe('a mid-journey crash keeps the Navigations already recorded', () => {
  it('Crasher left Navigation 1 on disk despite throwing', () => {
    const crasher = forTitle('Crasher');
    // 2 repeats, each recorded its one pre-crash Navigation.
    expect(crasher.length).toBe(2);
    for (const { sample } of crasher) {
      expect(sample.navigationIndex).toBe(1);
      expect(sample.url).toMatch(/\/$/);
    }
  });
});

describe('the two-step wrote a real file at the outputPath location', () => {
  it('the Sample file exists on disk under its outputPath name, not only as an attachment', () => {
    // findSamples() matched the ORIGINAL `bzm-vitals-sample-<n>.json` files (attachment
    // copies carry a -<sha1> suffix and are excluded), so their existence proves the
    // write-file step landed a real file independent of any reporter.
    expect(samples.length).toBeGreaterThan(0);
    for (const { path } of samples) {
      expect(path).toMatch(
        new RegExp(`/${SAMPLE_ATTACHMENT_PREFIX}-\\d+\\.json$`),
      );
    }
  });
});

describe('every Execution leaves exactly one Outcome record', () => {
  it('6 Executions (3 tests x 2 repeats) -> 6 Outcomes, no more, no fewer', () => {
    // A throw still runs teardown (try/finally), so Crasher gets a REAL 'failed'
    // outcome — the no-teardown-at-all case (SIGKILL) lives in outcome.test.ts.
    expect(outcomes.length).toBe(6);
    for (const { outcome } of outcomes) {
      expect(outcome.schemaVersion).toBe(SCHEMA_VERSION);
      expect(outcome.retry).toBe(0);
      expect(outcome.test.file).toBe('journey.spec.ts');
      expect(outcome.test.project).toBe('chromium');
    }
  });

  it("passing tests record 'passed'; the throwing test records 'failed'", () => {
    const byTitle = (title: string) =>
      outcomes.filter((o) => o.outcome.test.title === title);
    for (const title of ['Landing Page', 'Two Navigations']) {
      const found = byTitle(title);
      expect(found.length).toBe(2); // repeat 0 and 1
      for (const { outcome } of found) expect(outcome.status).toBe('passed');
    }
    const crasher = byTitle('Crasher');
    expect(crasher.length).toBe(2);
    for (const { outcome } of crasher) expect(outcome.status).toBe('failed');
  });

  it('each Outcome joins its Samples on (repeat, worker) — asserted on the actual files', () => {
    // Both directions: every Outcome finds its Execution's Samples with a byte-equal
    // TestIdentity, and every Sample's Execution has exactly one Outcome.
    const executionKey = (t: { title: string; repeat: number; worker: number }) =>
      `${t.title}#${t.repeat}#${t.worker}`;

    for (const { outcome } of outcomes) {
      const joined = samples.filter(
        (s) =>
          s.sample.test.title === outcome.test.title &&
          s.sample.test.repeat === outcome.test.repeat &&
          s.sample.test.worker === outcome.test.worker,
      );
      expect(joined.length, executionKey(outcome.test)).toBeGreaterThan(0);
      for (const s of joined) expect(s.sample.test).toEqual(outcome.test);
    }

    const outcomeKeys = outcomes.map((o) => executionKey(o.outcome.test));
    expect(new Set(outcomeKeys).size).toBe(outcomeKeys.length); // one per Execution
    for (const s of samples) {
      const matches = outcomeKeys.filter((k) => k === executionKey(s.sample.test));
      expect(matches.length, s.path).toBe(1);
    }
  });
});

describe('no artifact contains a token-shaped value', () => {
  it('the fake SESSION_TOKEN appears in no output file', async () => {
    const leaked = await anyFileContains(outputDir, FAKE_TOKEN);
    expect(leaked).toBe(false);
  });
});
