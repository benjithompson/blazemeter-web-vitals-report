// Seam 1 — issue #4: the Execution Outcome record and vitals.route(). Same seam
// discipline as tracer/vitals: real Playwright child runs, assertions on the JSON files
// that survive on disk. Four runs feed the assertions here (the passed/failed happy path
// and its (repeat, worker) join ride the existing journey run in tracer.test.ts):
//
//   outcomes — outcomes.spec.ts: timedOut, and both skip flavors (statically skipped
//              tests never set up fixtures, so they leave NO record — observed and
//              pinned here; in-body test.skip() DOES tear down, so it records 'skipped').
//   retried  — retry.spec.ts under --retries 1: a retry is another Execution with its
//              own Outcome — retry 0 'failed', retry 1 'passed'.
//   killed   — kill.spec.ts, SIGKILLed mid-test: already-flushed Samples survive, and
//              NO Outcome exists anywhere — absence is the crash signal, never faked.
//   routed   — route.spec.ts: vitals.route() lands verbatim on the current Navigation's
//              Sample; omitting it leaves the field absent and the raw url intact.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  runPlaywright,
  findSamples,
  findOutcomes,
  type FoundSample,
  type FoundOutcome,
} from './helpers/run-playwright';

let server: FixtureServer;
let outcomesSamples: FoundSample[];
let outcomesOutcomes: FoundOutcome[];
let retriedSamples: FoundSample[];
let retriedOutcomes: FoundOutcome[];
let killedSamples: FoundSample[];
let killedOutcomes: FoundOutcome[];
let routedSamples: FoundSample[];
let routedOutcomes: FoundOutcome[];

function outcomesFor(outcomes: FoundOutcome[], title: string): FoundOutcome[] {
  return outcomes.filter((o) => o.outcome.test.title === title);
}

function samplesFor(samples: FoundSample[], title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

beforeAll(async () => {
  server = await startFixtureServer();

  // The kill sentinel: the spec creates it when its Samples are safely down, and the
  // harness SIGKILLs the child's process group the moment it appears.
  const sentinelDir = await mkdtemp(join(tmpdir(), 'bzm-vitals-kill-'));
  const sentinel = join(sentinelDir, 'ready');

  const [outcomesRun, retriedRun, killedRun, routedRun] = await Promise.all([
    runPlaywright({ spec: 'outcomes.spec.ts', baseURL: server.url }),
    runPlaywright({ spec: 'retry.spec.ts', baseURL: server.url, args: ['--retries', '1'] }),
    runPlaywright({
      spec: 'kill.spec.ts',
      baseURL: server.url,
      env: { PW_KILL_SENTINEL: sentinel },
      killWhenFileExists: sentinel,
    }),
    runPlaywright({ spec: 'route.spec.ts', baseURL: server.url }),
  ]);

  [outcomesSamples, retriedSamples, killedSamples, routedSamples] = await Promise.all([
    findSamples(outcomesRun.outputDir),
    findSamples(retriedRun.outputDir),
    findSamples(killedRun.outputDir),
    findSamples(routedRun.outputDir),
  ]);
  [outcomesOutcomes, retriedOutcomes, killedOutcomes, routedOutcomes] = await Promise.all([
    findOutcomes(outcomesRun.outputDir),
    findOutcomes(retriedRun.outputDir),
    findOutcomes(killedRun.outputDir),
    findOutcomes(routedRun.outputDir),
  ]);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('status covers the non-happy paths', () => {
  it("a timing-out test records 'timedOut' — and keeps its Samples", () => {
    const timedOut = outcomesFor(outcomesOutcomes, 'Times Out');
    expect(timedOut.length).toBe(1);
    expect(timedOut[0]!.outcome.status).toBe('timedOut');
    expect(timedOut[0]!.outcome.retry).toBe(0);
    expect(timedOut[0]!.outcome.schemaVersion).toBe(SCHEMA_VERSION);

    // The Execution timed out but its Navigation 1 Sample is on disk, joined on
    // (repeat, worker).
    const samples = samplesFor(outcomesSamples, 'Times Out');
    expect(samples.length).toBe(1);
    expect(samples[0]!.sample.test.repeat).toBe(timedOut[0]!.outcome.test.repeat);
    expect(samples[0]!.sample.test.worker).toBe(timedOut[0]!.outcome.test.worker);
  });

  it('a STATICALLY skipped test leaves no record at all — fixtures never set up', () => {
    // Observed Playwright behavior, pinned: `test.skip('title', fn)` never runs any
    // fixture, so neither an Outcome nor a Sample can exist. The dashboard must NOT
    // read this absence as a crash — it treats missing-outcome as crashed only for
    // Executions that produced Samples (nuance for #9).
    expect(outcomesFor(outcomesOutcomes, 'Skipped Statically').length).toBe(0);
    expect(samplesFor(outcomesSamples, 'Skipped Statically').length).toBe(0);
  });

  it("an IN-BODY test.skip() records 'skipped' — fixtures were up, teardown ran", () => {
    const skipped = outcomesFor(outcomesOutcomes, 'Skipped In Body');
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.outcome.status).toBe('skipped');
    // Skipped before any navigation: an Outcome with zero Samples is a valid pairing.
    expect(samplesFor(outcomesSamples, 'Skipped In Body').length).toBe(0);
  });
});

describe('a retry is another Execution with its own Outcome', () => {
  it("records TWO outcomes: retry 0 'failed', retry 1 'passed'", () => {
    const flaky = outcomesFor(retriedOutcomes, 'Flaky')
      .sort((a, b) => a.outcome.retry - b.outcome.retry);
    expect(flaky.length).toBe(2);
    expect(flaky[0]!.outcome.retry).toBe(0);
    expect(flaky[0]!.outcome.status).toBe('failed');
    expect(flaky[1]!.outcome.retry).toBe(1);
    expect(flaky[1]!.outcome.status).toBe('passed');
  });

  it('each attempt joins to its own Samples on (repeat, worker)', () => {
    // Playwright retries in a fresh worker, so the two Executions differ on `worker` —
    // which is what keeps the (repeat, worker) join unambiguous across attempts.
    const flaky = outcomesFor(retriedOutcomes, 'Flaky');
    const workers = new Set(flaky.map((o) => o.outcome.test.worker));
    expect(workers.size).toBe(2);

    for (const { outcome } of flaky) {
      const joined = samplesFor(retriedSamples, 'Flaky').filter(
        (s) =>
          s.sample.test.repeat === outcome.test.repeat &&
          s.sample.test.worker === outcome.test.worker,
      );
      // Both attempts drove exactly one Navigation.
      expect(joined.length).toBe(1);
      expect(joined[0]!.sample.test).toEqual(outcome.test);
    }
  });
});

describe('a killed Execution leaves Samples and NO Outcome — absence is the signal', () => {
  it('the pagehide-flushed Sample survived the SIGKILL', () => {
    const samples = samplesFor(killedSamples, 'Killed Mid Flight');
    // Navigation 1 flushed at pagehide before the kill; Navigation 2 died with the
    // worker (its only flush would have been teardown, which never ran).
    expect(samples.length).toBe(1);
    expect(samples[0]!.sample.navigationIndex).toBe(1);
    expect(samples[0]!.sample.url).toMatch(/\/$/);
  });

  it('no Outcome record exists anywhere in the run — nothing fabricated one', () => {
    expect(killedOutcomes.length).toBe(0);
  });
});

describe('vitals.route() — the only knob', () => {
  it('route() after goto lands verbatim on the CURRENT Navigation, intermediate included', () => {
    const samples = samplesFor(routedSamples, 'Declared Routes');
    expect(samples.length).toBe(2);
    // Navigation 1 was tagged before the second goto flushed it at pagehide.
    expect(samples[0]!.sample.route).toBe('/home/{id}');
    expect(samples[0]!.sample.url).toMatch(/\/$/);
    // Navigation 2 was tagged after the last goto and flushed at teardown. Braces
    // intact — verbatim, never normalized.
    expect(samples[1]!.sample.route).toBe('/second/{orderId}');
    expect(samples[1]!.sample.url).toMatch(/\/second$/);
  });

  it('route() before any navigation applies to the next one', () => {
    const samples = samplesFor(routedSamples, 'Route Before First Navigation');
    expect(samples.length).toBe(1);
    expect(samples[0]!.sample.route).toBe('/pre-declared');
  });

  it('omitting route() leaves the field ABSENT (not null) and the raw url intact', () => {
    const samples = samplesFor(routedSamples, 'No Route Declared');
    expect(samples.length).toBe(1);
    expect('route' in samples[0]!.sample).toBe(false);
    expect(samples[0]!.sample.url).toMatch(/\/$/);
  });

  it('destructuring { page, vitals } changes nothing else: all three tests passed with Outcomes', () => {
    // journey.spec.ts (plain { page }) is asserted green in tracer.test.ts; this pins
    // the { page, vitals } shape working alongside it.
    expect(routedOutcomes.length).toBe(3);
    for (const { outcome } of routedOutcomes) {
      expect(outcome.status).toBe('passed');
      expect(outcome.retry).toBe(0);
    }
  });
});
