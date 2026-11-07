// Join and group on `test.id`, with the (file, title, project) fallback. What
// is pinned here:
//   - two Tests sharing file + title + project (a describe chain, or two spec
//     dirs with the same basename) are TWO Tests when they carry distinct ids,
//     and each Outcome joins to its OWN Samples — on the triple alone they
//     would be one Test, and the later Outcome's verdict would overwrite the
//     other's;
//   - labels read `titlePath.join(' › ')` and `path` when present;
//   - 0.2.x records (no id) key, label and join exactly as before (X3), proven
//     on the real collector-0.2.1 bytes;
//   - mixed data (an old and a new collector in one Report): an id-less record
//     folds into the ONE id its triple carries in scope; a triple seen with
//     two ids is ambiguous, so id-less records on it stay on the triple key.

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionOutcome, ExecutionStatus, Metric, TestIdentity } from 'bzm-vitals-format';
import {
  aggregateRoutes,
  joinOutcomes,
  markColdStarts,
  summarizeOutcomes,
} from '../src/aggregate.js';
import type { AttributedOutcome, AttributedSample } from '../src/attribute.js';
import type { ReportData, RecordFile } from '../src/report.js';
import { assembleReportData } from '../src/report.js';
import { buildReportVariants, buildView } from '../src/view-model.js';

const FIXTURES_021 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'format',
  'test',
  'fixtures',
  'collector-0.2.1',
);

// ---------------------------------------------------------------- fixtures

const ENG_A = 'r-v4-eng-a';
const ENG_B = 'r-v4-eng-b';
let tsCounter = 1794070000000;

/** Same file basename, same title, same project — only the describe chain
 *  (and Playwright's testId) tells them apart: the collector's same-title
 *  shape. Both run on worker 0, one after the other, so without the id their
 *  Execution keys collide too. */
function guest(repeat = 0, worker = 0, withId = true): TestIdentity {
  return {
    file: 'checkout.spec.ts',
    title: 'pays',
    project: 'chromium',
    repeat,
    worker,
    ...(withId
      ? { id: 'aaaa1111-guest', titlePath: ['Guest', 'pays'], path: 'guest/checkout.spec.ts' }
      : {}),
  };
}
function member(repeat = 0, worker = 0, withId = true): TestIdentity {
  return {
    file: 'checkout.spec.ts',
    title: 'pays',
    project: 'chromium',
    repeat,
    worker,
    ...(withId
      ? { id: 'bbbb2222-member', titlePath: ['Member', 'pays'], path: 'member/checkout.spec.ts' }
      : {}),
  };
}

function mk(test: TestIdentity | null, lcp: number, sessionId = ENG_A): AttributedSample {
  return {
    masterId: '90000001',
    sessionId,
    locationId: 'us-west-1',
    engineLabel: sessionId === ENG_A ? 'us-west-1 #1' : 'us-west-1 #2',
    provenance: test === null ? 'legacy' : 'collector',
    sample: {
      schemaVersion: 1,
      ts: tsCounter++,
      url: 'https://example.com/checkout',
      test,
      navigationIndex: 1,
      vitals: { lcp: { value: lcp, status: 'ok' } satisfies Metric },
      navigation: { domContentLoadedMs: null, loadEventMs: null },
      context: { workers: 2, resourceCount: null, requestCount: null, failedRequests: null },
    },
  };
}

function outcomeOf(
  test: TestIdentity,
  status: ExecutionStatus,
  sessionId = ENG_A,
  retry = 0,
): AttributedOutcome {
  return { sessionId, outcome: { schemaVersion: 1, test, status, retry } };
}

/** Assemble a ReportData the way report.ts does: mark, join, aggregate. */
function reportData(raw: AttributedSample[], outcomes: AttributedOutcome[]): ReportData {
  const samples = joinOutcomes(markColdStarts(raw), outcomes);
  const ids = [...new Set(raw.map((s) => s.sessionId))];
  return {
    masterId: '90000001',
    reportName: null,
    generatedAt: '2026-11-07T00:00:00.000Z',
    sessions: ids.map((sessionId, i) => ({
      sessionId,
      locationId: 'us-west-1',
      status: 'ENDED',
      engineLabel: `us-west-1 #${i + 1}`,
      artifact: 'present' as const,
      sampleCount: 0,
      outcomeCount: 0,
      unreadable: [],
    })),
    routes: aggregateRoutes(samples),
    samples,
    outcomes,
  };
}

/** The 0.2.1 fixture records as one Engine's files, named as the zip names them. */
async function fixtureFiles(transform?: (record: { test: TestIdentity }) => void): Promise<RecordFile[]> {
  const names = (await readdir(FIXTURES_021)).filter((n) => n.endsWith('.json')).sort();
  return names.map((name) => ({
    // Strip the "<spec>--<output folder>--" provenance prefix back to the attachment basename.
    file: `${name.slice(0, name.lastIndexOf('--'))}/${name.slice(name.lastIndexOf('--') + 2)}`,
    read: async () => {
      const raw = await readFile(path.join(FIXTURES_021, name), 'utf8');
      if (!transform) return raw;
      const record = JSON.parse(raw) as { test: TestIdentity };
      transform(record);
      return JSON.stringify(record);
    },
  }));
}

async function fixtureReport(transform?: (record: { test: TestIdentity }) => void): Promise<ReportData> {
  return assembleReportData({
    masterId: '90000001',
    reportName: null,
    engines: [
      {
        sessionId: ENG_A,
        locationId: 'us-west-1',
        status: 'ENDED',
        artifact: 'present',
        files: await fixtureFiles(transform),
      },
    ],
  });
}

// ------------------------------------------------------------------- tests

describe('D6 — two Tests with the same file + title + project but distinct test.id', () => {
  const raw = () => [
    mk(guest(), 1000),
    mk(guest(), 1100),
    mk(member(), 4000),
    mk(member(), 4100),
    mk(member(), 4200),
  ];
  const outcomes = [outcomeOf(guest(), 'passed'), outcomeOf(member(), 'failed')];

  it('the report shows TWO Tests, each with only its own Samples', () => {
    const view = buildView(reportData(raw(), outcomes));
    const route = view.routes[0]!;
    expect(route.testCount).toBe(2);
    expect(route.blended).toBe(true);
    const bySize = route.tests.map((t) => t.sampleCount);
    expect(bySize).toEqual([3, 2]);
    const lcps = route.tests.map((t) =>
      t.engines.flatMap((e) => e.navigations.map((n) => n.vitals['lcp']!.value)),
    );
    expect(lcps).toEqual([
      [4000, 4100, 4200],
      [1000, 1100],
    ]);
  });

  it('each Outcome joins to its own Samples — the member failure never stamps the guest Samples', () => {
    const joined = joinOutcomes(raw(), outcomes);
    expect(joined.map((s) => s.executionStatus)).toEqual([
      'passed',
      'passed',
      'failed',
      'failed',
      'failed',
    ]);
  });

  it('counts two Executions, one failed — and the exclude variant drops only the member Samples', () => {
    const data = reportData(raw(), outcomes);
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.total).toBe(2);
    expect(summary.counts).toEqual({ passed: 1, failed: 1 });
    const variants = buildReportVariants(data);
    expect(variants.excluded).not.toBeNull();
    expect(variants.excluded!.totalSamples).toBe(2);
    expect(variants.excluded!.routes[0]!.tests.map((t) => t.label)).toEqual([
      'Guest › pays — guest/checkout.spec.ts (chromium)',
    ]);
  });

  it('labels use titlePath joined by " › " and the testDir-relative path', () => {
    const view = buildView(reportData(raw(), outcomes));
    expect(view.routes[0]!.tests.map((t) => t.label)).toEqual([
      'Member › pays — member/checkout.spec.ts (chromium)',
      'Guest › pays — guest/checkout.spec.ts (chromium)',
    ]);
  });

  it('an id-only record (no titlePath/path) still groups on id and labels with title and file', () => {
    const a: TestIdentity = { file: 'x.spec.ts', title: 't', project: 'p', repeat: 0, worker: 0, id: 'id-1' };
    const b: TestIdentity = { ...a, id: 'id-2', worker: 1 };
    const view = buildView(reportData([mk(a, 1), mk(b, 2)], []));
    expect(view.routes[0]!.tests.map((t) => t.label)).toEqual(['t — x.spec.ts (p)', 't — x.spec.ts (p)']);
    expect(new Set(view.routes[0]!.tests.map((t) => t.key)).size).toBe(2);
  });

  it('an empty-string id is treated as absent: the record falls back to the triple', () => {
    const blank: TestIdentity = { ...guest(0, 0, false), id: '' };
    const data = reportData([mk(blank, 1), mk(guest(0, 0, false), 2)], [outcomeOf(guest(0, 0, false), 'passed')]);
    expect(data.samples.map((s) => s.executionStatus)).toEqual(['passed', 'passed']);
    const tests = buildView(data).routes[0]!.tests;
    expect(tests).toHaveLength(1);
    expect(tests[0]!.key).toBe(['checkout.spec.ts', 'pays', 'chromium'].join('\u0000'));
  });

  it('retries still join per attempt on the id path — worker stays in the Execution key', () => {
    // Playwright retries in a fresh worker: attempt 0 on worker 0 failed, attempt 1 on worker 3 passed.
    const samples = [mk(guest(0, 0), 5000), mk(guest(0, 3), 1000)];
    const os = [outcomeOf(guest(0, 0), 'failed', ENG_A, 0), outcomeOf(guest(0, 3), 'passed', ENG_A, 1)];
    const withId = joinOutcomes(samples, os).map((s) => s.executionStatus);
    const noIdSamples = [mk(guest(0, 0, false), 5000), mk(guest(0, 3, false), 1000)];
    const noIdOs = [
      outcomeOf(guest(0, 0, false), 'failed', ENG_A, 0),
      outcomeOf(guest(0, 3, false), 'passed', ENG_A, 1),
    ];
    const withoutId = joinOutcomes(noIdSamples, noIdOs).map((s) => s.executionStatus);
    expect(withId).toEqual(['failed', 'passed']);
    expect(withId).toEqual(withoutId); // the collector's version never changes the verdict
  });
});

describe('D6 — 0.2.x records (no test.id) aggregate exactly as before (X3)', () => {
  it('real collector-0.2.1 bytes: Test keys are the (file, title, project) triple and labels are unchanged', async () => {
    const data = await fixtureReport();
    expect(data.sessions[0]!.unreadable).toEqual([]);
    const view = buildView(data);
    const tests = view.routes.flatMap((r) => r.tests);
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests) {
      const s = data.samples.find(
        (x) => x.sample.test && [x.sample.test.file, x.sample.test.title, x.sample.test.project].join('\u0000') === t.key,
      );
      expect(s, `group key ${JSON.stringify(t.key)} is a triple`).toBeDefined();
      const id = s!.sample.test!;
      expect(t.label).toBe(`${id.title} — ${id.file} (${id.project})`);
    }
  });

  it('real collector-0.2.1 bytes: every Sample joins its Outcome by the triple (crashed only for the Crasher)', async () => {
    const data = await fixtureReport();
    const byTitle = new Map(data.samples.map((s) => [s.sample.test!.title, s.executionStatus]));
    const outcomeByTitle = new Map(data.outcomes.map((o) => [o.outcome.test.title, o.outcome.status]));
    for (const [title, status] of byTitle) {
      expect(status).toBe(outcomeByTitle.get(title) ?? 'crashed');
    }
  });

  it('giving each 0.2.1 Test its own id changes nothing but the group keys', async () => {
    const before = buildReportVariants(await fixtureReport());
    const after = buildReportVariants(
      await fixtureReport((r) => {
        r.test.id = `id:${r.test.file}:${r.test.title}:${r.test.project}`;
      }),
    );
    const stripKeys = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v, (k, val: unknown) => (k === 'key' || k === 'generatedAt' ? undefined : val)));
    expect(stripKeys(after)).toEqual(stripKeys(before));
  });
});

describe('D6 — mixed data: an old and a new collector in one Report', () => {
  it('an id-less Engine folds into the id Test its triple carries elsewhere: one Test, both Engines', () => {
    // Engine A ran the new collector (ids); Engine B the 0.2.x one. One spec, no collision.
    const solo: TestIdentity = {
      file: 'home.spec.ts',
      title: 'loads',
      project: 'chromium',
      repeat: 0,
      worker: 0,
    };
    const raw = [
      mk({ ...solo, id: 'cccc-home', titlePath: ['loads'], path: 'home.spec.ts' }, 1000, ENG_A),
      mk(solo, 2000, ENG_B),
    ];
    const outcomes = [
      outcomeOf({ ...solo, id: 'cccc-home', titlePath: ['loads'], path: 'home.spec.ts' }, 'passed', ENG_A),
      outcomeOf(solo, 'failed', ENG_B),
    ];
    const data = reportData(raw, outcomes);
    expect(data.samples.map((s) => s.executionStatus)).toEqual(['passed', 'failed']);
    const tests = buildView(data).routes[0]!.tests;
    expect(tests).toHaveLength(1);
    expect(tests[0]!.engines.map((e) => e.sessionId)).toEqual([ENG_A, ENG_B]);
    expect(tests[0]!.label).toBe('loads — home.spec.ts (chromium)');
  });

  it('a triple that carries TWO ids is ambiguous: its id-less records stay on the triple key, never guessed', () => {
    const raw = [
      mk(guest(), 1000, ENG_A),
      mk(member(), 4000, ENG_A),
      mk(guest(0, 0, false), 1500, ENG_B), // which one? unknowable from the triple
      mk(member(0, 1, false), 4500, ENG_B),
    ];
    const tests = buildView(reportData(raw, [])).routes[0]!.tests;
    expect(tests).toHaveLength(3);
    const legacyTriple = tests.find((t) => t.key === ['checkout.spec.ts', 'pays', 'chromium'].join('\u0000'));
    expect(legacyTriple?.sampleCount).toBe(2);
    expect(legacyTriple?.label).toBe('pays — checkout.spec.ts (chromium)');
  });

  it('the join folds within one session: an id-less Outcome still joins id-carrying Samples of its only Test', () => {
    const outcome: ExecutionOutcome = {
      schemaVersion: 1,
      test: guest(0, 0, false),
      status: 'failed',
      retry: 0,
    };
    const joined = joinOutcomes([mk(guest(), 1000)], [{ sessionId: ENG_A, outcome }]);
    expect(joined[0]!.executionStatus).toBe('failed');
  });
});
