// The timeline model — N series on ONE shared absolute-epoch wall-clock axis.
//
// The seam is the point (SPEC.md → "Build the N-series seam now, ship one
// series through it"): v1 ships exactly the vitals series, but the axis domain
// derives from the UNION of all series' ts ranges — never from "the run" — so
// a foreign series (backend KPIs from a different master, Engine health) that
// overlaps partially or not at all joins with NO rework of axis or model.
//
// Rendering geometry is deliberately not tested; it is looked at.

import { describe, it, expect } from 'vitest';
import type { Metric } from 'bzm-vitals-format';
import { aggregateRoutes, joinOutcomes, markColdStarts, percentile } from '../src/aggregate.js';
import type { AttributedSample } from '../src/attribute.js';
import type { ReportData, SessionSummary } from '../src/report.js';
import {
  buildView,
  timelineAxis,
  xFraction,
  type TimelineSeries,
} from '../src/view-model.js';

// ---------------------------------------------------------------- fixtures

// A real absolute epoch base — nothing in the model may zero-base it away.
const T0 = Date.parse('2026-07-16T21:19:05.069Z');

interface MkOpts {
  sessionId?: string;
  engineLabel?: string;
  url?: string;
  ts?: number;
  vitals?: Record<string, Metric>;
  test?: { file: string; title: string; project: string; repeat: number; worker: number } | null;
}

function mk(opts: MkOpts = {}): AttributedSample {
  const test =
    opts.test === undefined
      ? { file: 'shop.spec.ts', title: 'checkout', project: 'chromium', repeat: 0, worker: 0 }
      : opts.test;
  return {
    masterId: '90000001',
    sessionId: opts.sessionId ?? 'r-v4-eng-a',
    locationId: 'us-west-1',
    engineLabel: opts.engineLabel ?? 'us-west-1',
    provenance: test === null ? 'legacy' : 'collector',
    sample: {
      schemaVersion: 1,
      ts: opts.ts ?? T0,
      url: opts.url ?? 'https://example.com/checkout',
      test,
      navigationIndex: 0,
      vitals: opts.vitals ?? { lcp: { value: 2000, status: 'ok' } },
      navigation: { domContentLoadedMs: null, loadEventMs: null },
      context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
    },
  };
}

function sessionSummary(sessionId: string, engineLabel: string): SessionSummary {
  return {
    sessionId,
    locationId: 'us-west-1',
    status: 'ENDED',
    engineLabel,
    artifact: 'present',
    sampleCount: 0,
    outcomeCount: 0,
    unreadable: [],
  };
}

function reportData(raw: AttributedSample[]): ReportData {
  const samples = joinOutcomes(markColdStarts(raw), []);
  const seen = new Map<string, string>();
  for (const s of raw) if (!seen.has(s.sessionId)) seen.set(s.sessionId, s.engineLabel);
  return {
    masterId: '90000001',
    reportName: null,
    generatedAt: '2026-07-16T00:00:00.000Z',
    sessions: [...seen.entries()].map(([id, label]) => sessionSummary(id, label)),
    routes: aggregateRoutes(samples),
    samples,
    outcomes: [],
  };
}

const lcp = (value: number): Record<string, Metric> => ({ lcp: { value, status: 'ok' } });

/** A synthetic foreign series — the deferred enrichment shape, joined today. */
function foreignSeries(id: string, kind: string, tss: number[]): TimelineSeries {
  return {
    id,
    kind,
    label: 'Hits/s',
    unit: 'per-second',
    points: tss.map((ts, i) => ({ ts, value: 10 + i })),
  };
}

// ------------------------------------------------------------------- tests

describe('timeline — THE seam: the axis domain is the union of all series, never "the run"', () => {
  it('a partially-overlapping foreign series extends the domain; every point of both maps into it', () => {
    // Vitals span [T0, T0+60s]. The foreign series starts mid-run and outlives
    // it by 90s — a concurrent master that ended later.
    const view = buildView(
      reportData([0, 20_000, 40_000, 60_000].map((dt) => mk({ ts: T0 + dt, vitals: lcp(2000 + dt / 100) }))),
    );
    const vitalsSeries = view.timeline.charts.flatMap((c) => c.series);
    expect(vitalsSeries.length).toBeGreaterThan(0);

    const foreign = foreignSeries('kpi-hits', 'backend-kpi', [T0 + 30_000, T0 + 150_000]);
    const axis = timelineAxis([...vitalsSeries, foreign]);
    expect(axis).not.toBeNull();

    // Union: min from vitals, max from the foreign series — NOT the run's end.
    expect(axis!.minTs).toBe(T0);
    expect(axis!.maxTs).toBe(T0 + 150_000);

    // Both series' every point maps into the shared domain.
    for (const p of [...vitalsSeries.flatMap((s) => s.points), ...foreign.points]) {
      const f = xFraction(axis!, p.ts);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // And the vitals run's end sits strictly inside the domain, not at its edge.
    expect(xFraction(axis!, T0 + 60_000)).toBeLessThan(1);
  });

  it('a DISJOINT foreign series still shares the axis: the domain covers both ranges', () => {
    const vitals = buildView(
      reportData([0, 30_000].map((dt) => mk({ ts: T0 + dt }))),
    ).timeline.charts.flatMap((c) => c.series);
    // Engine health fetched from a different master, an hour later.
    const foreign = foreignSeries('engine-health-cpu', 'engine-health', [
      T0 + 3_600_000,
      T0 + 3_660_000,
    ]);
    const axis = timelineAxis([...vitals, foreign])!;
    expect(axis.minTs).toBe(T0);
    expect(axis.maxTs).toBe(T0 + 3_660_000);
    // The two clusters land in their own halves — no range is squeezed out.
    expect(xFraction(axis, T0 + 30_000)).toBeLessThan(0.5);
    expect(xFraction(axis, T0 + 3_600_000)).toBeGreaterThan(0.5);
  });

  it('the axis over zero points is null — an empty timeline is a fact, not a fake domain', () => {
    expect(timelineAxis([])).toBeNull();
    expect(timelineAxis([foreignSeries('empty', 'backend-kpi', [])])).toBeNull();
  });
});

describe('timeline — epoch ms in, epoch ms out: no test-relative offsets anywhere', () => {
  it('series points carry the exact absolute epoch ts of their Samples', () => {
    const tss = [T0, T0 + 1_234, T0 + 77_000];
    const view = buildView(reportData(tss.map((ts) => mk({ ts }))));
    const series = view.timeline.charts.find((c) => c.metric === 'lcp')!.series[0]!;
    expect(series.points.map((p) => p.ts)).toEqual(tss); // identical, never re-based
    // Epoch-scale, not run-relative: every ts is a real 2026 timestamp.
    for (const p of series.points) expect(p.ts).toBeGreaterThan(1_000_000_000_000);
    expect(view.timeline.axis!.minTs).toBe(T0);
  });

  it('points are sorted by ts regardless of input order', () => {
    const view = buildView(
      reportData([mk({ ts: T0 + 50_000 }), mk({ ts: T0 }), mk({ ts: T0 + 20_000 })]),
    );
    const series = view.timeline.charts.find((c) => c.metric === 'lcp')!.series[0]!;
    expect(series.points.map((p) => p.ts)).toEqual([T0, T0 + 20_000, T0 + 50_000]);
  });
});

describe('timeline — tick generation reads sanely across spans', () => {
  function axisOver(spanMs: number) {
    return timelineAxis([foreignSeries('s', 'vitals-metric', [T0, T0 + spanMs])])!;
  }

  it('a ~77s run gets second-scale ticks at aligned intervals, labelled HH:MM:SS UTC', () => {
    const axis = axisOver(77_000);
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3);
    expect(axis.ticks.length).toBeLessThanOrEqual(9);
    for (const tick of axis.ticks) {
      expect(tick.ts).toBeGreaterThanOrEqual(axis.minTs);
      expect(tick.ts).toBeLessThanOrEqual(axis.maxTs);
      expect(tick.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      // The label IS the UTC wall-clock reading of the tick's epoch ts.
      expect(tick.label).toBe(new Date(tick.ts).toISOString().slice(11, 19));
      expect(tick.ts % 1000).toBe(0); // human ticks sit on whole seconds
    }
    // Aligned to a clean step: all ticks share the step's modulus.
    const steps = axis.ticks.slice(1).map((t, i) => t.ts - axis.ticks[i]!.ts);
    expect(new Set(steps).size).toBe(1);
  });

  it('a 30-minute span steps in minutes; a 6-hour span steps in hours', () => {
    const minutes = axisOver(30 * 60_000);
    const minuteSteps = minutes.ticks.slice(1).map((t, i) => t.ts - minutes.ticks[i]!.ts);
    expect(minuteSteps.every((s) => s % 60_000 === 0)).toBe(true);
    expect(minutes.ticks.length).toBeGreaterThanOrEqual(3);
    expect(minutes.ticks.length).toBeLessThanOrEqual(9);

    const hours = axisOver(6 * 3_600_000);
    const hourSteps = hours.ticks.slice(1).map((t, i) => t.ts - hours.ticks[i]!.ts);
    expect(hourSteps.every((s) => s % 3_600_000 === 0)).toBe(true);
    expect(hours.ticks.length).toBeGreaterThanOrEqual(3);
    expect(hours.ticks.length).toBeLessThanOrEqual(9);
  });

  it('a single-instant domain degenerates honestly: one tick, points at midline', () => {
    const axis = timelineAxis([foreignSeries('s', 'vitals-metric', [T0])])!;
    expect(axis.minTs).toBe(T0);
    expect(axis.maxTs).toBe(T0);
    expect(axis.ticks).toHaveLength(1);
    expect(xFraction(axis, T0)).toBe(0.5);
  });
});

describe('timeline — vitals series carry only ok Samples, with Cold Start flags in meta', () => {
  it('non-ok Samples are absent from the points — never plotted as 0', () => {
    const view = buildView(
      reportData([
        mk({ ts: T0, vitals: lcp(1000) }),
        mk({ ts: T0 + 1000, vitals: { lcp: { value: 99999, status: 'error' } } }),
        mk({ ts: T0 + 2000, vitals: lcp(2000) }),
      ]),
    );
    const chart = view.timeline.charts.find((c) => c.metric === 'lcp')!;
    expect(chart.series[0]!.points.map((p) => p.value)).toEqual([1000, 2000]);
    expect(chart.okCount).toBe(2);
    expect(chart.total).toBe(3); // coverage over the whole pool, stated honestly
  });

  it('meta carries coldStart true/false/null and the Engine identity per point', () => {
    const worker = { file: 'a.spec.ts', title: 't', project: 'chromium', repeat: 0, worker: 0 };
    const view = buildView(
      reportData([
        mk({ ts: T0, test: worker, sessionId: 'r-v4-a', engineLabel: 'us-west-1 #1' }),
        mk({ ts: T0 + 1000, test: worker, sessionId: 'r-v4-a', engineLabel: 'us-west-1 #1' }),
        mk({ ts: T0 + 2000, test: null, sessionId: 'r-v4-b', engineLabel: 'us-west-1 #2' }),
      ]),
    );
    const points = view.timeline.charts.find((c) => c.metric === 'lcp')!.series[0]!.points;
    expect(points.map((p) => p.meta?.coldStart)).toEqual([true, false, null]); // null ≠ false
    expect(points.map((p) => p.meta?.sessionId)).toEqual(['r-v4-a', 'r-v4-a', 'r-v4-b']);
    expect(points.map((p) => p.meta?.engineLabel)).toEqual([
      'us-west-1 #1',
      'us-west-1 #1',
      'us-west-1 #2',
    ]);
    expect(view.timeline.charts.find((c) => c.metric === 'lcp')!.coldStartCount).toBe(1);
  });
});

describe('timeline — the p75 reference line is the run-level aggregate', () => {
  it('on a single-Route run it equals the Route cell p75 exactly', () => {
    const view = buildView(
      reportData([1000, 1500, 2000, 2500].map((v, i) => mk({ ts: T0 + i * 1000, vitals: lcp(v) }))),
    );
    const chart = view.timeline.charts.find((c) => c.metric === 'lcp')!;
    const cell = view.routes[0]!.cells.find((c) => c.metric === 'lcp')!;
    expect(chart.p75).toBe(cell.p75);
  });

  it('across Routes it is the percentile over the POOLED ok values (pinned method)', () => {
    const view = buildView(
      reportData([
        mk({ ts: T0, url: 'https://example.com/a', vitals: lcp(1000) }),
        mk({ ts: T0 + 1000, url: 'https://example.com/a', vitals: lcp(2000) }),
        mk({ ts: T0 + 2000, url: 'https://example.com/b', vitals: lcp(3000) }),
        mk({ ts: T0 + 3000, url: 'https://example.com/b', vitals: lcp(4000) }),
      ]),
    );
    const chart = view.timeline.charts.find((c) => c.metric === 'lcp')!;
    expect(chart.p75).toBe(percentile([1000, 2000, 3000, 4000], 0.75)); // 3000
  });
});

describe('timeline — all-non-ok metrics carry their reason in place of a chart', () => {
  it('INP with zero ok values has no points, a null p75, and the dominant reason', () => {
    const view = buildView(
      reportData([
        mk({ ts: T0, vitals: { lcp: { value: 2000, status: 'ok' }, inp: { value: null, status: 'no-interaction' } } }),
        mk({ ts: T0 + 1000, vitals: { lcp: { value: 2100, status: 'ok' }, inp: { value: null, status: 'no-interaction' } } }),
      ]),
    );
    const inp = view.timeline.charts.find((c) => c.metric === 'inp')!;
    expect(inp.okCount).toBe(0);
    expect(inp.total).toBe(2);
    expect(inp.series[0]!.points).toHaveLength(0);
    expect(inp.p75).toBeNull();
    expect(inp.reason).toBe('no-interaction');
    // The measured metric beside it has no reason.
    expect(view.timeline.charts.find((c) => c.metric === 'lcp')!.reason).toBeUndefined();
  });
});

describe('timeline — shape and units', () => {
  it('charts follow the report metric column order; CLS is unitless, the rest ms', () => {
    const view = buildView(
      reportData([
        mk({
          ts: T0,
          vitals: {
            lcp: { value: 2000, status: 'ok' },
            cls: { value: 0.01, status: 'ok' },
            ttfb: { value: 120, status: 'ok' },
          },
        }),
      ]),
    );
    expect(view.timeline.charts.map((c) => c.metric)).toEqual(view.metricNames);
    expect(view.timeline.charts.find((c) => c.metric === 'cls')!.unit).toBe('unitless');
    expect(view.timeline.charts.find((c) => c.metric === 'lcp')!.unit).toBe('ms');
    // v1 ships exactly one series per chart — through the N-series shape.
    for (const chart of view.timeline.charts) {
      expect(chart.series).toHaveLength(1);
      expect(chart.series[0]!.kind).toBe('vitals-metric');
    }
  });

  it('a thin (n=2) series still builds a full structure — points, axis, y-domain', () => {
    const view = buildView(
      reportData([mk({ ts: T0, vitals: lcp(1000) }), mk({ ts: T0 + 5000, vitals: lcp(3000) })]),
    );
    const chart = view.timeline.charts.find((c) => c.metric === 'lcp')!;
    expect(chart.series[0]!.points).toHaveLength(2);
    expect(chart.yMax).toBeGreaterThanOrEqual(3000);
    expect(view.timeline.axis).not.toBeNull();
    expect(view.timeline.axis!.ticks.length).toBeGreaterThanOrEqual(1);
  });

  it('a report with zero Samples has a null axis and no charts', () => {
    const view = buildView(reportData([]));
    expect(view.timeline.axis).toBeNull();
    expect(view.timeline.charts).toEqual([]);
  });
});
