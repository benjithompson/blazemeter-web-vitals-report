// Issue #9 — outcome-aware states and the include-failed toggle.
//
// The intuitive default is the harmful one: excluding failed Executions
// deletes exactly the slowest Samples (the real 4 failures were CWV budget
// breaches — they failed BECAUSE the vitals were slow), biasing every
// percentile faster, silently and directionally. So failed Executions are
// INCLUDED by default, the exclude view is a fully server-rendered second
// variant (the inline script only swaps `hidden` — it decides nothing), and
// the outcome breakdown sits next to the numbers the choice changes.
//
// Partial states are the normal case: outcome-awareness unavailable (legacy)
// is said in words and never implies all-passed; a missing Outcome among
// emitted ones is "crashed before finishing"; 'unknown' is displayed
// distinctly from 'unsupported' and 'no-interaction'; and NO code path
// renders a null as 0 — walked and asserted over every status.

import { describe, it, expect } from 'vitest';
import type { Metric } from 'bzm-vitals-format';
import {
  aggregateRoutes,
  joinOutcomes,
  markColdStarts,
  summarizeOutcomes,
} from '../src/aggregate.js';
import type { AttributedOutcome, AttributedSample } from '../src/attribute.js';
import type { ReportData, SessionSummary } from '../src/report.js';
import { buildReportVariants } from '../src/view-model.js';
import { renderHtml } from '../src/render.js';
import { UI_STRINGS as S } from '../src/ui-strings.js';
import { BLOB_RE, parseBlob } from './helpers/blob.js';

// ---------------------------------------------------------------- fixtures

interface TestId {
  file: string;
  title: string;
  project: string;
  repeat: number;
  worker: number;
}

const tid = (repeat: number, worker = 0): TestId => ({
  file: 'shop.spec.ts',
  title: 'checkout',
  project: 'chromium',
  repeat,
  worker,
});

interface MkOpts {
  sessionId?: string;
  engineLabel?: string;
  url?: string;
  ts?: number;
  vitals?: Record<string, Metric>;
  test?: TestId | null;
}

let tsCounter = 1752700000000;

function mk(opts: MkOpts = {}): AttributedSample {
  const test = opts.test === undefined ? tid(0) : opts.test;
  return {
    masterId: '90000001',
    sessionId: opts.sessionId ?? 'r-v4-eng-a',
    locationId: 'us-west-1',
    engineLabel: opts.engineLabel ?? 'us-west-1',
    provenance: test === null ? 'legacy' : 'collector',
    sample: {
      schemaVersion: 1,
      ts: opts.ts ?? tsCounter++,
      url: opts.url ?? 'https://example.com/checkout',
      test,
      navigationIndex: 0,
      vitals: opts.vitals ?? { lcp: { value: 2000, status: 'ok' } },
      navigation: { domContentLoadedMs: null, loadEventMs: null },
      context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
    },
  };
}

function outcome(
  sessionId: string,
  test: TestId,
  status: 'passed' | 'failed' | 'timedOut' | 'skipped',
  retry = 0,
): AttributedOutcome {
  return { sessionId, outcome: { schemaVersion: 1, test, status, retry } };
}

function sessionSummary(
  sessionId: string,
  engineLabel: string,
  artifact: 'present' | 'no-artifact' = 'present',
): SessionSummary {
  return {
    sessionId,
    locationId: 'us-west-1',
    status: 'ENDED',
    engineLabel,
    artifact,
    sampleCount: 0,
    outcomeCount: 0,
    unreadable: [],
  };
}

/** Assemble a ReportData the way report.ts does: mark, join, aggregate. */
function reportData(
  raw: AttributedSample[],
  outcomes: AttributedOutcome[] = [],
  extraSessions: SessionSummary[] = [],
): ReportData {
  const samples = joinOutcomes(markColdStarts(raw), outcomes);
  const seen = new Map<string, string>();
  for (const s of raw) if (!seen.has(s.sessionId)) seen.set(s.sessionId, s.engineLabel);
  return {
    masterId: '90000001',
    reportName: null,
    generatedAt: '2026-07-16T00:00:00.000Z',
    sessions: [
      ...[...seen.entries()].map(([id, label]) => sessionSummary(id, label)),
      ...extraSessions,
    ],
    routes: aggregateRoutes(samples),
    samples,
    outcomes,
  };
}

const lcp = (value: number): Record<string, Metric> => ({ lcp: { value, status: 'ok' } });

/** The measured real-Report shape: failed Executions carry the slowest Samples.
 *  8 passed (2000..2070) + 2 failed (3200, 3300) on one session. */
function measuredCase(): ReportData {
  const samples: AttributedSample[] = [];
  const outcomes: AttributedOutcome[] = [];
  const passedValues = [2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070];
  passedValues.forEach((v, i) => {
    samples.push(mk({ test: tid(i, i % 2), ts: 1752700000000 + i * 1000, vitals: lcp(v) }));
    outcomes.push(outcome('r-v4-eng-a', tid(i, i % 2), 'passed'));
  });
  [3200, 3300].forEach((v, i) => {
    const t = tid(8 + i, i % 2);
    samples.push(mk({ test: t, ts: 1752700100000 + i * 1000, vitals: lcp(v) }));
    outcomes.push(outcome('r-v4-eng-a', t, 'failed'));
  });
  return reportData(samples, outcomes);
}

// ------------------------------------------------- summarizeOutcomes (model)

describe('summarizeOutcomes — the outcome breakdown as data', () => {
  it('zero Outcome records anywhere → not aware; never implies all-passed', () => {
    const data = reportData([mk({ test: null }), mk({ test: null })]);
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.aware).toBe(false);
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({});
    expect(summary.excludable).toBe(0);
  });

  it('counts distinct Executions from Outcomes — including a skipped one with zero Samples', () => {
    const outcomes = [
      outcome('r-v4-eng-a', tid(0), 'passed'),
      outcome('r-v4-eng-a', tid(1), 'passed'),
      outcome('r-v4-eng-a', tid(2), 'skipped'), // in-body skip: outcome, no Samples
    ];
    const data = reportData([mk({ test: tid(0) }), mk({ test: tid(1) })], outcomes);
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.aware).toBe(true);
    expect(summary.total).toBe(3);
    expect(summary.counts).toEqual({ passed: 2, skipped: 1 });
    expect(summary.excludable).toBe(0);
  });

  it('a retried Execution counts ONCE, with the final retry\'s verdict', () => {
    const outcomes = [
      outcome('r-v4-eng-a', tid(0), 'failed', 0),
      outcome('r-v4-eng-a', tid(0), 'passed', 1), // fresh worker in reality; same identity here
    ];
    const data = reportData([mk({ test: tid(0) })], outcomes);
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.total).toBe(1);
    expect(summary.counts).toEqual({ passed: 1 });
    expect(summary.excludable).toBe(0);
  });

  it('derives crashed Executions from Samples whose session emitted Outcomes but not for them', () => {
    const outcomes = [outcome('r-v4-eng-a', tid(0), 'passed')];
    const data = reportData(
      [
        mk({ test: tid(0) }),
        mk({ test: tid(1) }), // SIGKILLed: flushed Samples, no Outcome → crashed
        mk({ test: tid(1) }), // second Navigation of the same crashed Execution
      ],
      outcomes,
    );
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.total).toBe(2); // one passed + ONE crashed Execution (not two Samples)
    expect(summary.counts).toEqual({ passed: 1, crashed: 1 });
    expect(summary.excludable).toBe(1);
  });

  it('failed + timedOut + crashed are excludable; skipped and passed are not', () => {
    const outcomes = [
      outcome('r-v4-eng-a', tid(0), 'passed'),
      outcome('r-v4-eng-a', tid(1), 'failed'),
      outcome('r-v4-eng-a', tid(2), 'timedOut'),
      outcome('r-v4-eng-a', tid(3), 'skipped'),
    ];
    const data = reportData(
      [0, 1, 2].map((r) => mk({ test: tid(r) })),
      outcomes,
    );
    const summary = summarizeOutcomes(data.samples, data.outcomes);
    expect(summary.total).toBe(4);
    expect(summary.counts).toEqual({ passed: 1, failed: 1, timedOut: 1, skipped: 1 });
    expect(summary.excludable).toBe(2);
  });
});

// -------------------------------------------------- buildReportVariants

describe('buildReportVariants — both views built server-side, include is the default', () => {
  it('the measured case: p75(excluded) < p75(included) — exclusion flatters, which is why include is default', () => {
    const variants = buildReportVariants(measuredCase());
    expect(variants.excluded).not.toBeNull();
    const inc = variants.included.routes[0]!.cells.find((c) => c.metric === 'lcp')!;
    const exc = variants.excluded!.routes[0]!.cells.find((c) => c.metric === 'lcp')!;
    expect(inc.p75).toBe(2060); // pinned method over the 10 pooled values
    expect(exc.p75).toBe(2050);
    expect(exc.p75!).toBeLessThan(inc.p75!);
  });

  it('every coverage line restates its denominator: cell and timeline totals shrink to the kept pool', () => {
    const variants = buildReportVariants(measuredCase());
    const inc = variants.included;
    const exc = variants.excluded!;
    expect(inc.totalSamples).toBe(10);
    expect(exc.totalSamples).toBe(8);
    expect(inc.routes[0]!.cells.find((c) => c.metric === 'lcp')!.total).toBe(10);
    expect(exc.routes[0]!.cells.find((c) => c.metric === 'lcp')!.total).toBe(8);
    const incChart = inc.timeline.charts.find((c) => c.metric === 'lcp')!;
    const excChart = exc.timeline.charts.find((c) => c.metric === 'lcp')!;
    expect(incChart.total).toBe(10); // TimelineChart.total is the honest denominator
    expect(excChart.total).toBe(8);
    expect(excChart.p75).toBeLessThan(incChart.p75!);
  });

  it('no Execution failed → excluded is null (the toggle has nothing to do)', () => {
    const data = reportData(
      [mk({ test: tid(0) }), mk({ test: tid(1) })],
      [outcome('r-v4-eng-a', tid(0), 'passed'), outcome('r-v4-eng-a', tid(1), 'passed')],
    );
    const variants = buildReportVariants(data);
    expect(variants.outcomes.aware).toBe(true);
    expect(variants.outcomes.excludable).toBe(0);
    expect(variants.excluded).toBeNull();
  });

  it('outcome-awareness unavailable (legacy) → excluded is null', () => {
    const variants = buildReportVariants(reportData([mk({ test: null }), mk({ test: null })]));
    expect(variants.outcomes.aware).toBe(false);
    expect(variants.excluded).toBeNull();
  });

  it('excluding NEVER re-assigns Cold Starts: a deleted Cold Start is a gap, not a promotion', () => {
    // Worker 0: repeat0 (FAILED, the Cold Start at ts=1000) then repeat1 at 2000.
    // Worker 1: repeat0 passed (Cold Start at ts=1500) then repeat1 at 2500.
    const samples = [
      mk({ test: tid(0, 0), ts: 1752700001000, vitals: lcp(3300) }),
      mk({ test: tid(1, 0), ts: 1752700002000, vitals: lcp(2000) }),
      mk({ test: tid(0, 1), ts: 1752700001500, vitals: lcp(2500) }),
      mk({ test: tid(1, 1), ts: 1752700002500, vitals: lcp(2100) }),
    ];
    const outcomes = [
      outcome('r-v4-eng-a', tid(0, 0), 'failed'),
      outcome('r-v4-eng-a', tid(1, 0), 'passed'),
      outcome('r-v4-eng-a', tid(0, 1), 'passed'),
      outcome('r-v4-eng-a', tid(1, 1), 'passed'),
    ];
    const variants = buildReportVariants(reportData(samples, outcomes));
    expect(variants.included.routes[0]!.coldStarts).toBe(2);
    // The excluded pool lost worker 0's Cold Start — and worker 0's ts=2000
    // Sample must NOT be promoted to Cold Start in its place.
    const excluded = variants.excluded!;
    expect(excluded.routes[0]!.coldStarts).toBe(1);
    const flagged = excluded.routes[0]!.tests.flatMap((t) =>
      t.engines.flatMap((e) => e.navigations.filter((n) => n.coldStart === true)),
    );
    expect(flagged.map((n) => n.ts)).toEqual([1752700001500]); // worker 1's, only
  });

  it('the raw blob data is untouched: variants never mutate ReportData', () => {
    const data = measuredCase();
    const before = JSON.stringify(data);
    buildReportVariants(data);
    expect(JSON.stringify(data)).toBe(before);
  });
});

// ------------------------------------------------------- rendered strings

describe('render — the toggle and both variants, server-side', () => {
  it('with failures: checkbox checked (include is default), excluded variant embedded hidden', () => {
    const html = renderHtml(measuredCase());
    expect(html).toContain('id="bzm-include-failed" checked');
    expect(html).not.toContain('id="bzm-include-failed" checked disabled');
    expect(html).toMatch(/id="bzm-variant-included"/);
    expect(html).toMatch(/id="bzm-variant-excluded" hidden/);
    // Both variants' drill rows exist server-side under distinct ids.
    expect(html).toContain('id="drill-inc-0"');
    expect(html).toContain('id="drill-exc-0"');
    expect(html).toContain('aria-controls="drill-inc-0"');
    expect(html).toContain('aria-controls="drill-exc-0"');
    // The excluded variant restates what it dropped, with the denominator.
    expect(html).toContain(`${S.excludedNote} — 8 ${S.ofWord} 10 ${S.samplesWord}`);
    // The blob still carries the RAW data — Seam 2 contract untouched.
    expect(parseBlob(html).samples).toHaveLength(10);
  });

  it('breakdown line: "2 of 10 Executions failed" next to the toggle', () => {
    const html = renderHtml(measuredCase());
    expect(html).toContain(`2 ${S.ofWord} 10 ${S.executionsWord} failed`);
  });

  it('breakdown line itemizes mixed outcomes, crashed said as "crashed before finishing"', () => {
    const outcomes = [
      outcome('r-v4-eng-a', tid(0), 'passed'),
      outcome('r-v4-eng-a', tid(1), 'failed'),
      outcome('r-v4-eng-a', tid(2), 'timedOut'),
    ];
    const data = reportData(
      [
        mk({ test: tid(0) }),
        mk({ test: tid(1) }),
        mk({ test: tid(2) }),
        mk({ test: tid(3) }), // no Outcome among emitted ones → crashed
      ],
      outcomes,
    );
    const html = renderHtml(data);
    expect(html).toContain(`3 ${S.ofWord} 4 ${S.executionsWord} failed`);
    expect(html).toContain('1 failed · 1 timed out · 1 crashed before finishing');
  });

  it('all passed: says so, toggle disabled WITH the reason stated, no excluded variant', () => {
    const data = reportData(
      [mk({ test: tid(0) }), mk({ test: tid(1) })],
      [outcome('r-v4-eng-a', tid(0), 'passed'), outcome('r-v4-eng-a', tid(1), 'passed')],
    );
    const html = renderHtml(data);
    expect(html).toContain(`all 2 ${S.executionsWord} passed`);
    expect(html).toContain('id="bzm-include-failed" checked disabled');
    expect(html).toContain(S.toggleDisabledNothingExcludable);
    expect(html).not.toContain('id="bzm-variant-excluded"'); // the element, not the script literal
  });

  it('skipped Executions are stated, and never make the toggle live', () => {
    const data = reportData(
      [mk({ test: tid(0) })],
      [outcome('r-v4-eng-a', tid(0), 'passed'), outcome('r-v4-eng-a', tid(1), 'skipped')],
    );
    const html = renderHtml(data);
    expect(html).toContain(`1 ${S.ofWord} 2 ${S.executionsWord} passed — 1 skipped`);
    expect(html).toContain('id="bzm-include-failed" checked disabled');
  });

  it('legacy (zero Outcome records): breakdown says outcomes unavailable in words — never all-passed — and the toggle is disabled with the reason', () => {
    const html = renderHtml(reportData([mk({ test: null }), mk({ test: null })]));
    expect(html).toContain(S.outcomesUnavailable);
    expect(html).toContain('id="bzm-include-failed" checked disabled');
    expect(html).toContain(S.toggleDisabledNoOutcomes);
    expect(html).not.toContain('id="bzm-variant-excluded"');
    expect(html).not.toMatch(/all \d+ Executions passed/);
  });

  it('zero Samples: static "no samples", and no toggle at all', () => {
    const data = reportData([]);
    data.sessions.push(sessionSummary('r-v4-eng-a', 'us-west-1'));
    const html = renderHtml(data);
    expect(html).toContain('<p class="no-samples">');
    expect(html).not.toContain('id="bzm-include-failed"'); // no toggle element at all
  });
});

describe('render — partial states in words', () => {
  it('a missing Outcome among emitted ones renders "crashed before finishing" in drill-down', () => {
    const data = reportData(
      [mk({ test: tid(0) }), mk({ test: tid(1) })],
      [outcome('r-v4-eng-a', tid(0), 'passed')],
    );
    expect(data.samples.find((s) => s.sample.test?.repeat === 1)!.executionStatus).toBe('crashed');
    const html = renderHtml(data);
    expect(html).toContain(`<span class="flag bad">${S.outcomeCrashedBeforeFinishing}</span>`);
  });

  it("'unknown' is displayed distinctly from 'unsupported' and 'no-interaction'", () => {
    const data = reportData([
      mk({
        vitals: {
          lcp: { value: null, status: 'unknown' },
          cls: { value: null, status: 'unsupported' },
          inp: { value: null, status: 'no-interaction' },
        },
      }),
    ]);
    const html = renderHtml(data);
    expect(html).toContain(S.unknownLegacy); // 'unknown — legacy collector cannot say why'
    expect(html).toContain('unsupported');
    expect(html).toContain('no interaction');
    // The three phrasings are pairwise distinct strings.
    expect(S.unknownLegacy).not.toBe('unsupported');
    expect(S.unknownLegacy).not.toBe('no interaction');
  });

  it('when ≥1 session lacks an artifact, aggregates carry a visible covers-subset note', () => {
    const data = reportData(
      [mk()],
      [],
      [sessionSummary('r-v4-eng-dead', 'us-west-2', 'no-artifact')],
    );
    const html = renderHtml(data);
    expect(html).toContain(`${S.subsetCovers} 1 ${S.ofWord} 2 ${S.enginesHeading}`);
    expect(html).toContain(S.noArtifact);
  });

  it('all artifacts present → no subset note', () => {
    const html = renderHtml(reportData([mk()]));
    expect(html).not.toContain(S.subsetCovers);
  });
});

// --------------------------------------------- null is NEVER rendered as 0

describe('no code path renders a null as 0 — walked over every status', () => {
  // Every non-ok status the closed vocabulary knows, plus an unrecognized one
  // and a not-ok metric that (wrongly but plausibly) carries a number.
  function everyStatusData(): ReportData {
    return reportData([
      mk({
        test: tid(0, 0),
        vitals: {
          lcp: { value: null, status: 'unsupported' },
          inp: { value: null, status: 'no-interaction' },
          fcp: { value: null, status: 'not-finalized' },
          cls: { value: null, status: 'error' },
          ttfb: { value: null, status: 'unknown' },
        },
      }),
      mk({
        test: tid(1, 0),
        vitals: {
          lcp: { value: null, status: 'unsupported' },
          inp: { value: 98765, status: 'error' }, // a number on a non-ok status: never pooled, never shown
          fcp: { value: null, status: 'mystery-future-status' },
          cls: { value: null, status: 'unknown' },
          // ttfb not carried at all on this Sample
        },
      }),
    ]);
  }

  it('model walk: every cell and chart derived from non-ok metrics is reasons and nulls, never 0', () => {
    const variants = buildReportVariants(everyStatusData());
    const view = variants.included;
    for (const route of view.routes) {
      for (const cell of route.cells) {
        expect(cell.ok).toBe(0);
        expect(cell.p50).toBeNull();
        expect(cell.p75).toBeNull();
        expect(cell.p95).toBeNull();
        expect(typeof cell.reason).toBe('string');
        expect(cell.reason).not.toBe('0');
      }
      expect(route.histograms).toEqual([]); // nothing measured → no histogram at all
    }
    for (const chart of view.timeline.charts) {
      expect(chart.okCount).toBe(0);
      expect(chart.p75).toBeNull();
      expect(chart.series.flatMap((s) => s.points)).toEqual([]); // never plotted as 0
      expect(typeof chart.reason).toBe('string');
    }
    // The Navigation drill-down carries the statuses through untouched.
    for (const route of view.routes) {
      for (const nav of route.tests.flatMap((t) => t.engines.flatMap((e) => e.navigations))) {
        for (const metric of Object.values(nav.vitals)) {
          expect(metric.status).not.toBe('ok');
        }
      }
    }
  });

  it('rendered strings: with zero ok values anywhere, no cell or point renders a value — no "0 ms", no lead numbers', () => {
    const html = renderHtml(everyStatusData());
    // Assert on the STATIC markup only — the blob legitimately carries raw data.
    const staticHtml = html.replace(BLOB_RE, '');
    expect(staticHtml).not.toContain('0 ms'); // the canonical lie this project exists to stop
    // Every metric-cell lead is a reason, never a number.
    const leads = [...staticHtml.matchAll(/<div class="lead([^"]*)">/g)];
    expect(leads.length).toBeGreaterThan(0);
    for (const m of leads) expect(m[1]).toContain('reason');
    // No timeline point markers exist at all.
    expect(staticHtml).not.toMatch(/<circle class="pt/);
    expect(staticHtml).not.toMatch(/<path class="pt /);
    // The number riding on the non-ok INP is never rendered as a value.
    expect(staticHtml).not.toContain('98,765');
  });
});
