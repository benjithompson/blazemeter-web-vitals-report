// The view model — everything the renderer needs, precomputed as plain data.
//
// ISOMORPHIC: this module runs in Node (the drift guard, the fallback
// summary) AND in the browser — esbuild bundles it, unchanged, into the
// report's one inline <script> (src/browser/entry.ts). So: no node:* imports,
// no I/O, no globals, pure functions only. The browser and Node must build
// deep-equal views from the same ReportData (test/browser-render.test.ts).
//
// Fast at 200k Samples, without changing an answer: the drill-down
// contents (a Route's Tests and histograms, an Engine's Navigations) and the
// timeline's point objects are computed when first READ (lazyField: an
// enumerable, memoizing getter — the view still deep-equals and serializes
// to the eager one); a timeline series is built as typed columns
// (seriesColumns); every Sample's record is read ONCE, into a columnar
// SampleIndex (aggregate.ts: Route, Cold Start flag, per-metric status and
// value), which both variants' aggregates and timelines read instead of the
// records; and a few WeakMap caches of DERIVED data (a Sample's point meta, its
// Route, the Test keys by index position; the timeline tallies the
// exclude-failed variant filters instead of re-tallying every Sample) make the
// second variant cheap. Memoization only: every function still returns the
// same value for the same input (test/timeline-canvas.test.ts pins the
// equivalences).
//
// The rendering layer (src/browser/views.ts) consumes this and decides
// NOTHING: threshold dots (p75 only — the dot is a field that exists once per
// cell, structurally), the Route → Test → Engine → Navigation drill-down
// groupings, the blend caveat, histogram bins, and the per-Engine p75 spread
// are all computed here, where they are unit-testable. Rendering geometry is deliberately not tested;
// it is looked at.
//
// Vocabulary (CONTEXT.md): Test identity is `test.id` when the record carries
// one, else (file, title, project); legacy
// Samples carry none and group as one explicit legacy Test group. Engines are
// keyed by sessionId — the label rides along for humans and is never a key.

import type { Metric } from 'bzm-vitals-format';
import {
  aggregateIndexed,
  CODE_NOT_CARRIED,
  CODE_POOLED,
  keptPositions,
  NOT_CARRIED,
  percentile,
  sampleIndex,
  testKeyResolver,
  summarizeOutcomes,
  type MetricAggregate,
  type OutcomeSummary,
  type RouteRow,
  type SampleIndex,
} from './aggregate.js';
import type { AttributedSample, SampleExecutionStatus } from './attribute.js';
import type { ReportData, SessionSummary } from './report.js';
import { threshold, type ThresholdBand } from './thresholds.js';

export { sampleIndex, type SampleIndex };

/** Canonical metric column order; open-set extras follow, alphabetically. */
const KNOWN_METRIC_ORDER = ['ttfb', 'fcp', 'lcp', 'cls', 'inp'];

export interface MetricCell {
  metric: string;
  p50: number | null;
  /** Leads the cell. The ONLY statistic that carries a threshold dot. */
  p75: number | null;
  p95: number | null;
  ok: number;
  total: number;
  breakdown: Record<string, number>;
  /**
   * The threshold verdict for p75 — and only p75; no other statistic has a dot
   * field at all. null when nothing was measured or the metric has no band.
   */
  dot: ThresholdBand | null;
  /** Present exactly when ok === 0: render the reason, never a number. */
  reason?: string;
  /** false when no Sample in this Route carried the metric at all. */
  carried: boolean;
}

export interface NavigationView {
  ts: number;
  url: string;
  navigationIndex: number | null;
  coldStart: boolean | null;
  executionStatus: SampleExecutionStatus;
  vitals: Record<string, Metric>;
}

export interface EngineView {
  /** The join key. UI logic never keys on the label. */
  sessionId: string;
  engineLabel: string;
  sampleCount: number;
  /** Per-metric p75 over this Engine's ok values in this Test group — the
   *  spread, shown side by side, never adjudicated. null when nothing ok.
   *  Coverage rides along: a 3-of-50 Engine p75 must not read like 50-of-50. */
  p75s: Record<string, { p75: number | null; ok: number; total: number }>;
  navigations: NavigationView[];
}

export interface TestGroupView {
  /** Stable grouping key (test.id, else the identity triple, or the legacy marker). */
  key: string;
  /** Human label: "titlePath › … — path (project)", falling back to
   *  "title — file (project)"; or the legacy group label. */
  label: string;
  legacy: boolean;
  sampleCount: number;
  engines: EngineView[];
}

export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

export interface HistogramView {
  metric: string;
  okCount: number;
  min: number;
  max: number;
  maxBinCount: number;
  bins: HistogramBin[];
}

export interface RouteView {
  route: string;
  sampleCount: number;
  /** null = unidentifiable (legacy pool), which is not zero. */
  coldStarts: number | null;
  /** >1 distinct Test identities feed this Route — the pooled number is a
   *  blend of whatever journeys hit it. Carried visibly by the renderer. */
  blended: boolean;
  testCount: number;
  /** One cell per report-wide metric name, in column order. */
  cells: MetricCell[];
  /** Drill-in only — histograms never appear on the landing view. */
  histograms: HistogramView[];
  tests: TestGroupView[];
}

// ------------------------------------------------------- timeline (N series)
//
// THE SEAM (SPEC.md → "Build the N-series seam now, ship one series through
// it"): the timeline is N series on ONE shared absolute-epoch wall-clock
// axis. v1 ships exactly the vitals series — but the axis domain derives from
// the UNION of every series' ts range, never from "the run", so a foreign
// series (backend KPIs from a different master — note their ts arrives in
// SECONDS and must be ×1000 at construction; Engine health — already ms,
// adaptively downsampled past 500 points, so never assume a fixed grid) joins
// by being appended to the series list. No rework of axis or model.

export interface TimelinePointMeta {
  /** The Engine join key; the label rides along for humans. */
  sessionId?: string;
  engineLabel?: string;
  /** true = first Navigation for its (session, worker); null = unidentifiable
   *  (legacy) — a marker is only ever drawn for true, never faked from null. */
  coldStart?: boolean | null;
  url?: string;
}

export interface TimelinePoint {
  /** Absolute epoch ms. NEVER a test-relative offset. */
  ts: number;
  value: number;
  meta?: TimelinePointMeta;
}

export interface TimelineSeries {
  id: string;
  /** 'vitals-metric' today; 'backend-kpi' / 'engine-health' join later. */
  kind: string;
  label: string;
  /** 'ms' | 'unitless' today; foreign units arrive with their series. */
  unit: string;
  /** Sorted ascending by ts. */
  points: TimelinePoint[];
}

export interface TimelineTick {
  /** Absolute epoch ms, on a clean wall-clock boundary (a whole step into
   *  the day, read in the zone the tick is for: UTC for the model's ticks). */
  ts: number;
  /** The wall-clock reading of ts — HH:MM:SS (date-prefixed past day spans). */
  label: string;
}

export interface TimelineAxis {
  /** The union of all series' ts ranges — absolute epoch ms. */
  minTs: number;
  maxTs: number;
  /** The tick step, ms (TICK_STEPS). The model's ticks sit on UTC
   *  boundaries; the renderer places the same step on the boundaries of the
   *  zone in force (alignedTicks) — 23:00 IST, not 22:30 — and labels them at
   *  this resolution: day-scale steps carry the date, finer ones read HH:MM:SS. */
  stepMs: number;
  ticks: TimelineTick[];
}

/** One small-multiple chart. `series` is N-shaped; v1 puts one series in it. */
export interface TimelineChart {
  metric: string;
  /** Display unit: CLS is a true unitless float; the rest are ms. */
  unit: string;
  series: TimelineSeries[];
  /** Coverage over the whole Sample pool — stated wherever the chart is. */
  okCount: number;
  total: number;
  /** Present exactly when okCount === 0: render the reason, never a chart. */
  reason?: string;
  /** The run-level p75 over pooled ok values — the reference line. */
  p75: number | null;
  /** Points whose meta.coldStart === true (null is never counted). */
  coldStartCount: number;
  /** Precomputed y-domain top (≥ every value and the p75), a clean number. */
  yMax: number;
  /** Clean horizontal-gridline values within [0, yMax]. */
  yTicks: number[];
}

export interface TimelineView {
  /** null when no series carries a single point. */
  axis: TimelineAxis | null;
  charts: TimelineChart[];
}

/** Tick steps, ms: whole seconds → minutes → hours → days. Human boundaries. */
const TICK_STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

function tickLabel(ts: number, step: number): string {
  const iso = new Date(ts).toISOString();
  // Day-scale spans need the date; epoch-aligned steps sit on UTC midnights.
  return step >= 86_400_000 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 19);
}

/**
 * Tick instants over [minTs, maxTs] on round wall-clock boundaries of a zone:
 * every ts whose reading in the zone (ts + offsetAt(ts)) is a whole number of
 * `step`s, ascending. `offsetAt` gives the zone's UTC offset at an instant, in
 * ms — 0 throughout for UTC (the model's ticks). An offset that is not a whole
 * hour (+5:30, -3:30) moves the boundaries with it; across an offset change
 * (DST) the ticks follow the wall clock: a 6-hour step stays on 00/06/12/18
 * local, and a repeated hour is ticked once in each offset. Pure.
 */
export function alignedTicks(
  minTs: number,
  maxTs: number,
  step: number,
  offsetAt: (ts: number) => number = () => 0,
): number[] {
  const onBoundary = (ts: number): boolean => (((ts + offsetAt(ts)) % step) + step) % step === 0;
  // The first boundary after t: under the offset in force at t, or under the
  // one in force a step later (an offset change in between); a candidate
  // counts only where its own instant is in that offset.
  const next = (t: number): number => {
    let best = Infinity;
    const before = offsetAt(t);
    const after = offsetAt(t + step);
    for (const offset of before === after ? [before] : [before, after]) {
      let c = Math.floor((t + offset) / step) * step + step - offset;
      for (let tries = 0; tries < 4 && c < best; tries++, c += step) {
        if (offsetAt(c) === offset) {
          best = c;
          break;
        }
      }
    }
    return best === Infinity ? t + step : best;
  };
  const ticks: number[] = [];
  for (let ts = onBoundary(minTs) ? minTs : next(minTs); ts <= maxTs; ts = next(ts)) ticks.push(ts);
  return ticks;
}

/**
 * The shared axis over N series: domain = union of every series' ts range
 * (ranges may overlap partially or not at all — a foreign series from a
 * different master is normal), ticks on clean UTC wall-clock boundaries.
 * null when there are no points anywhere.
 */
export function timelineAxis(series: TimelineSeries[]): TimelineAxis | null {
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const s of series) {
    for (const ts of seriesColumns(s).ts) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }
  if (minTs === Infinity) return null;

  const span = maxTs - minTs;
  if (span === 0) {
    // A single instant: one tick, labelled at second resolution.
    return { minTs, maxTs, stepMs: 1_000, ticks: [{ ts: minTs, label: tickLabel(minTs, 1_000) }] };
  }

  // The smallest step yielding at most ~6 intervals; day steps repeat past it.
  let step = TICK_STEPS[TICK_STEPS.length - 1]!;
  for (const candidate of TICK_STEPS) {
    if (span / candidate <= 6) {
      step = candidate;
      break;
    }
  }
  const ticks: TimelineTick[] = alignedTicks(minTs, maxTs, step).map((ts) => ({ ts, label: tickLabel(ts, step) }));
  // A sub-step span may straddle no boundary at all — still state the time once.
  if (ticks.length === 0) ticks.push({ ts: minTs, label: tickLabel(minTs, step) });
  return { minTs, maxTs, stepMs: step, ticks };
}

/** Map an absolute ts into the axis domain as a 0..1 fraction. Pure linear —
 *  the renderer scales it to pixels and decides nothing else. */
export function xFraction(axis: TimelineAxis, ts: number): number {
  if (axis.maxTs === axis.minTs) return 0.5;
  return (ts - axis.minTs) / (axis.maxTs - axis.minTs);
}

/** CLS is a true unitless float; every other vitals metric is ms. */
function metricUnit(metric: string): string {
  return metric === 'cls' ? 'unitless' : 'ms';
}

/** The smallest "nice" number (1/2/2.5/5 × 10^k) at or above v. */
function niceCeil(v: number): number {
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  if (f <= 1) return base;
  if (f <= 2) return 2 * base;
  if (f <= 2.5) return 2.5 * base;
  if (f <= 5) return 5 * base;
  return 10 * base;
}

/** One Sample's point meta — the same object wherever the Sample is plotted
 *  (every chart, both variants). Equal by value either way; nothing mutates it. */
const pointMetaCache = new WeakMap<AttributedSample, TimelinePointMeta>();
function pointMeta(s: AttributedSample): TimelinePointMeta {
  let meta = pointMetaCache.get(s);
  if (meta === undefined) {
    meta = {
      sessionId: s.sessionId,
      engineLabel: s.engineLabel,
      coldStart: s.coldStart ?? null,
      url: s.sample.url,
    };
    pointMetaCache.set(s, meta);
  }
  return meta;
}

/**
 * A series' points as columns — what the canvas renderer and the hover
 * hit-test read: ts and value as typed arrays, in the series' (ts) order, and
 * per point its Engine, its Cold Start flag and its full meta, on demand.
 * At 200k Samples × 5 metrics the points as objects are a million
 * allocations; a vitals series is built AS columns, and its `points` array is
 * materialized only when something reads it (a test, the drift guard).
 */
export interface SeriesColumns {
  ts: Float64Array;
  value: Float64Array;
  sessionId(i: number): string | undefined;
  coldStart(i: number): boolean | null | undefined;
  meta(i: number): TimelinePointMeta | undefined;
}

const columnsCache = new WeakMap<TimelineSeries, SeriesColumns>();

/** The columns of any series: a vitals series carries them from construction;
 *  any other (a foreign series appended later) gets them from its points. */
export function seriesColumns(series: TimelineSeries): SeriesColumns {
  let cols = columnsCache.get(series);
  if (cols === undefined) {
    const points = series.points;
    const ts = new Float64Array(points.length);
    const value = new Float64Array(points.length);
    points.forEach((p, i) => {
      ts[i] = p.ts;
      value[i] = p.value;
    });
    cols = {
      ts,
      value,
      sessionId: (i) => points[i]?.meta?.sessionId,
      coldStart: (i) => points[i]?.meta?.coldStart,
      meta: (i) => points[i]?.meta,
    };
    columnsCache.set(series, cols);
  }
  return cols;
}

/** One chart's running tally while buildTimeline reads the pool. */
interface ChartTally {
  metric: string;
  src: AttributedSample[];
  /** Each point's position in the pool's ts order (byTs). */
  pos: Int32Array;
  ts: Float64Array;
  value: Float64Array;
  n: number;
  /** Samples carrying the metric at all, ok or not. */
  carried: number;
  coldStartCount: number;
  breakdown: Record<string, number>;
}

/** Tally every chart over the pool, from the Sample index's columns: `order`
 *  is the pool as index positions, stably sorted ascending by ts, and
 *  `byTs[at]` is the Sample at order[at] — so each chart's points come out in
 *  ts order, ties in pool order, exactly as filtering, then stably sorting,
 *  would give. No Sample's record is read here. */
function tallyCharts(
  metricNames: string[],
  index: SampleIndex,
  order: Int32Array,
  byTs: AttributedSample[],
): ChartTally[] {
  const metricIds = new Map(index.metrics.map((m, i) => [m, i]));
  return metricNames.map((metric): ChartTally => {
    const t: ChartTally = {
      metric,
      src: [],
      pos: new Int32Array(order.length),
      ts: new Float64Array(order.length),
      value: new Float64Array(order.length),
      n: 0,
      carried: 0,
      coldStartCount: 0,
      breakdown: {},
    };
    const id = metricIds.get(metric);
    if (id !== undefined) {
      const codes = index.status[id]!;
      const values = index.value[id]!;
      for (let at = 0; at < order.length; at++) {
        const p = order[at]!;
        const code = codes[p]!;
        if (code === CODE_NOT_CARRIED) continue;
        t.carried += 1;
        if (code === CODE_POOLED) {
          // ts stays absolute epoch ms — the axis is wall-clock, never run-relative.
          t.pos[t.n] = at;
          t.ts[t.n] = index.ts[p]!;
          t.value[t.n] = values[p]!;
          t.src.push(byTs[at]!);
          if (index.coldStart[p] === 1) t.coldStartCount += 1;
          t.n += 1;
        } else {
          // Non-ok is ABSENT from the plot — never a 0 — but counted for coverage.
          const status = index.statuses[code]!;
          t.breakdown[status] = (t.breakdown[status] ?? 0) + 1;
        }
      }
    }
    const notCarried = order.length - t.carried;
    if (notCarried > 0) t.breakdown[NOT_CARRIED] = notCarried;
    return t;
  });
}

function buildTimelineChart(tally: ChartTally, total: number): TimelineChart {
  const { metric, src, n, coldStartCount, breakdown } = tally;
  const ts = tally.ts.subarray(0, n);
  const value = tally.value.subarray(0, n);

  const p75 = n > 0 ? percentile(value, 0.75) : null;
  let dataMax = p75 ?? 0;
  for (let i = 0; i < n; i++) dataMax = Math.max(dataMax, value[i]!);
  // Headroom above the tallest of {points, p75 line}; 1 is an honest floor for
  // an all-zero series (the real CLS case) — points sit on the baseline.
  const yMax = dataMax > 0 ? niceCeil(dataMax * 1.05) : 1;

  const series: TimelineSeries = {
    id: `vitals-${metric}`,
    kind: 'vitals-metric',
    label: metric,
    unit: metricUnit(metric),
    points: [],
  };
  lazyField(series, 'points', () => {
    const points: TimelinePoint[] = new Array(n);
    for (let i = 0; i < n; i++) points[i] = { ts: ts[i]!, value: value[i]!, meta: pointMeta(src[i]!) };
    return points;
  });
  columnsCache.set(series, {
    ts,
    value,
    sessionId: (i) => src[i]?.sessionId,
    coldStart: (i) => {
      const s = src[i];
      return s === undefined ? undefined : (s.coldStart ?? null);
    },
    meta: (i) => {
      const s = src[i];
      return s === undefined ? undefined : pointMeta(s);
    },
  });

  const chart: TimelineChart = {
    metric,
    unit: metricUnit(metric),
    series: [series],
    okCount: n,
    total,
    p75,
    coldStartCount,
    yMax,
    yTicks: [0, yMax / 2, yMax],
  };
  if (n === 0 && total > 0) {
    // The dominant not-ok status, same tie-break as the aggregate's reason.
    chart.reason = Object.entries(breakdown).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]![0];
  }
  return chart;
}

/**
 * The timeline view: one chart per report-wide metric (column order), the
 * shared axis unioned over every chart's every series. v1 feeds vitals only;
 * a foreign series joins by appending to the list handed to timelineAxis —
 * the domain math never changes.
 */
export function buildTimeline(samples: AttributedSample[], metricNames: string[]): TimelineView {
  return fullTimeline(sampleIndex(samples), metricNames);
}

/** buildTimeline over every Sample of an index. */
function fullTimeline(index: SampleIndex, metricNames: string[]): TimelineView {
  const samples = index.samples;
  if (samples.length === 0) return { axis: null, charts: [] };
  // One stable sort by ts, shared by every chart: positions into `samples`,
  // ties in pool order (Array.prototype.sort is stable).
  const order = Int32Array.from(
    Array.from({ length: samples.length }, (_, i) => i).sort((a, b) => index.ts[a]! - index.ts[b]!),
  );
  const byTs = Array.from(order, (i) => samples[i]!);
  const tallies = tallyCharts(metricNames, index, order, byTs);
  timelineTallies.set(index, { order, tallies });
  return timelineFrom(tallies, byTs.length);
}

function timelineFrom(tallies: ChartTally[], total: number): TimelineView {
  const charts = tallies.map((t) => buildTimelineChart(t, total));
  return { axis: timelineAxis(charts.flatMap((c) => c.series)), charts };
}

/** The tallies behind an index's full timeline, so a SUBSET's timeline (the
 *  exclude-failed variant) is derived by filtering them instead of tallying
 *  every Sample again. A cache of derived data: the result is the same either
 *  way (test/timeline-canvas.test.ts pins it). */
const timelineTallies = new WeakMap<SampleIndex, { order: Int32Array; tallies: ChartTally[] }>();

/** The timeline of the Samples at `positions` (ascending index positions;
 *  `kept[k]` is the Sample at positions[k]), from the full timeline's tallies
 *  when they exist. Filtering the full pool's stable ts order gives exactly
 *  the subset's stable ts order. A chart left with no ok point is re-tallied
 *  over the subset for its reason (its not-ok breakdown is not carried by the
 *  full tally's points). */
function subsetTimeline(
  index: SampleIndex,
  positions: Int32Array,
  kept: AttributedSample[],
  metricNames: string[],
): TimelineView {
  if (kept.length === 0) return { axis: null, charts: [] };
  const parent = timelineTallies.get(index);
  if (parent === undefined) {
    // No full timeline to filter: tally the subset itself, in its ts order.
    const order = Int32Array.from(Array.from(positions).sort((a, b) => index.ts[a]! - index.ts[b]!));
    const byTs = Array.from(order, (p) => index.samples[p]!);
    return timelineFrom(tallyCharts(metricNames, index, order, byTs), byTs.length);
  }
  const isKept = new Uint8Array(index.samples.length);
  for (let k = 0; k < positions.length; k++) isKept[positions[k]!] = 1;
  // Which of the full ts-ordered positions survive, and where to.
  const moved = new Int32Array(parent.order.length);
  const survivors: number[] = [];
  for (let i = 0; i < parent.order.length; i++) {
    const p = parent.order[i]!;
    moved[i] = isKept[p] === 1 ? survivors.length : -1;
    if (isKept[p] === 1) survivors.push(p);
  }
  const order = Int32Array.from(survivors);
  const byTs = Array.from(order, (p) => index.samples[p]!);
  const byName = new Map(parent.tallies.map((t) => [t.metric, t]));
  const tallies = metricNames.map((metric): ChartTally => {
    const from = byName.get(metric);
    if (from === undefined) return tallyCharts([metric], index, order, byTs)[0]!;
    const t: ChartTally = {
      metric,
      src: [],
      pos: new Int32Array(from.n),
      ts: new Float64Array(from.n),
      value: new Float64Array(from.n),
      n: 0,
      carried: 0,
      coldStartCount: 0,
      breakdown: {},
    };
    for (let i = 0; i < from.n; i++) {
      const to = moved[from.pos[i]!]!;
      if (to === -1) continue;
      const sample = from.src[i]!;
      t.pos[t.n] = to;
      t.ts[t.n] = from.ts[i]!;
      t.value[t.n] = from.value[i]!;
      t.src.push(sample);
      if (sample.coldStart === true) t.coldStartCount += 1;
      t.n += 1;
    }
    return t.n === 0 ? tallyCharts([metric], index, order, byTs)[0]! : t;
  });
  return timelineFrom(tallies, byTs.length);
}

export interface ReportView {
  masterId: string | null;
  generatedAt: string;
  metricNames: string[];
  sessions: SessionSummary[];
  engineCount: number;
  multiEngine: boolean;
  /** Engines that emitted a zip. When < engineCount the aggregates cover a
   *  subset and the renderer says so visibly — a degraded run is never
   *  silently reported as a clean one. */
  enginesWithArtifact: number;
  totalSamples: number;
  routes: RouteView[];
  timeline: TimelineView;
}

const LEGACY_KEY = '\u0000legacy';

/** A Report-wide Test key function: `test.id` when the Sample carries
 *  one, else the (file, title, project) triple — with an id-less Sample folded
 *  into the one id its triple carries elsewhere in the Report, so an old and a
 *  new collector's Samples of the same Test stay one Test (testKeyResolver). */
export type TestKeyOf = (s: AttributedSample) => string;

/** Build the Report-wide Test key function. Build it ONCE from the FULL
 *  Sample set and hand it to every variant (buildView's `testKey`), so a
 *  Test's group key is the same whether failed Executions are included or
 *  not — an id-less Sample folded into an id seen only on a failed Execution
 *  must not change key when that Execution is excluded. */
export function testKeyFor(samples: AttributedSample[]): TestKeyOf {
  const resolve = testKeyResolver(samples, (s) => s.sample.test);
  // Memoized per test identity record: both variants key the same Samples.
  const keys = new WeakMap<object, string>();
  return (s) => {
    const t = s.sample.test;
    if (t === null || t === undefined) return LEGACY_KEY;
    let key = keys.get(t);
    if (key === undefined) {
      key = resolve(t);
      keys.set(t, key);
    }
    return key;
  };
}

/** The human Test label, composed of data, not vocabulary: "title — file
 *  (project)", with the describe chain (`titlePath`, joined by " › ") in place
 *  of the bare title and the testDir-relative `path` in place of the basename
 *  whenever the group carries them — which is what tells two same-title Tests
 *  apart. Read from the first Sample in the group that carries each field. */
function testLabel(samples: AttributedSample[]): string {
  let t: NonNullable<AttributedSample['sample']['test']> | null = null;
  let titlePath: string[] | undefined;
  let specPath: string | undefined;
  for (const s of samples) {
    const st = s.sample.test;
    if (!st) continue;
    t ??= st;
    if (titlePath === undefined && st.titlePath && st.titlePath.length > 0) titlePath = st.titlePath;
    if (specPath === undefined && st.path) specPath = st.path;
    if (titlePath !== undefined && specPath !== undefined) break;
  }
  if (t === null) return LEGACY_KEY;
  const title = titlePath ? titlePath.join(' \u203a ') : t.title;
  return `${title} — ${specPath ?? t.file} (${t.project})`;
}

/** Math.min over an array of ANY length. `Math.min(...xs)` puts every
 *  element on the call stack and throws a RangeError at ~10^5 elements.
 *  Folding pairwise through Math.min keeps its exact semantics:
 *  NaN propagates, -0 < +0, and an empty array gives `init` (default
 *  +Infinity, as `Math.min()` does). */
function minOf(values: readonly number[], init = Infinity): number {
  let m = init;
  for (const v of values) m = Math.min(m, v);
  return m;
}

/** Math.max over an array of ANY length; see minOf. An empty array gives
 *  `init` (default -Infinity, as `Math.max()` does). */
function maxOf(values: readonly number[], init = -Infinity): number {
  let m = init;
  for (const v of values) m = Math.max(m, v);
  return m;
}

/** Equal-width bins over [min, max]; a single-valued distribution (the real
 *  CLS case: 41 of 50 share one value) collapses to one full-count bin. */
export function histogramBins(values: number[], binCount?: number): HistogramBin[] {
  if (values.length === 0) return [];
  const min = minOf(values);
  const max = maxOf(values);
  if (min === max) return [{ x0: min, x1: max, count: values.length }];
  const n = binCount ?? Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / n;
  const bins: HistogramBin[] = Array.from({ length: n }, (_, i) => ({
    x0: min + i * width,
    x1: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    bins[Math.min(n - 1, Math.floor((v - min) / width))]!.count += 1;
  }
  return bins;
}

function buildCell(name: string, row: RouteRow): MetricCell {
  const aggregate: MetricAggregate | undefined = row.metrics[name];
  if (aggregate === undefined) {
    // No Sample in this Route carried the metric — absence, not a zero.
    return {
      metric: name,
      p50: null,
      p75: null,
      p95: null,
      ok: 0,
      total: row.sampleCount,
      breakdown: { [NOT_CARRIED]: row.sampleCount },
      dot: null,
      reason: NOT_CARRIED,
      carried: false,
    };
  }
  const cell: MetricCell = {
    metric: name,
    p50: aggregate.p50,
    p75: aggregate.p75,
    p95: aggregate.p95,
    ok: aggregate.ok,
    total: aggregate.total,
    breakdown: aggregate.breakdown,
    // The dot decision, made once, from p75 and nothing else.
    dot: aggregate.p75 === null ? null : threshold(name, aggregate.p75),
    carried: true,
  };
  if (aggregate.reason !== undefined) cell.reason = aggregate.reason;
  return cell;
}

function okValues(pool: AttributedSample[], metric: string): number[] {
  const values: number[] = [];
  for (const s of pool) {
    const m = s.sample.vitals[metric];
    if (m !== undefined && m.status === 'ok' && typeof m.value === 'number') values.push(m.value);
  }
  return values;
}

function buildEngines(
  pool: AttributedSample[],
  metricNames: string[],
  sessionOrder: Map<string, number>,
): EngineView[] {
  const bySession = new Map<string, AttributedSample[]>();
  for (const s of pool) {
    const engine = bySession.get(s.sessionId);
    if (engine) engine.push(s);
    else bySession.set(s.sessionId, [s]);
  }
  const engines: EngineView[] = [];
  for (const [sessionId, samples] of bySession) {
    const p75s: Record<string, { p75: number | null; ok: number; total: number }> = {};
    for (const name of metricNames) {
      const values = okValues(samples, name);
      p75s[name] = {
        p75: values.length > 0 ? percentile(values, 0.75) : null,
        ok: values.length,
        total: samples.length,
      };
    }
    const engine: EngineView = {
      sessionId,
      engineLabel: samples[0]!.engineLabel,
      sampleCount: samples.length,
      p75s,
      navigations: [],
    };
    // The Navigation rows: built when first read, like a Route's drill-down.
    lazyField(engine, 'navigations', () =>
      samples
        .map((s) => ({
          ts: s.sample.ts,
          url: s.sample.url,
          navigationIndex: s.sample.navigationIndex ?? null,
          coldStart: s.coldStart ?? null,
          executionStatus: s.executionStatus ?? ('unavailable' as const),
          vitals: s.sample.vitals,
        }))
        .sort((a, b) => a.ts - b.ts || (a.navigationIndex ?? 0) - (b.navigationIndex ?? 0)),
    );
    engines.push(engine);
  }
  // The API's session order, so labels' ordinals read in sequence.
  engines.sort(
    (a, b) =>
      (sessionOrder.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) -
      (sessionOrder.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER),
  );
  return engines;
}

/** A Route pool grouped by Test key, in first-seen order. Cheap: one key per
 *  Sample, read from the index's Test-key column by the Sample's position
 *  (`at[j]` is pool[j]'s). Its size is the Route's testCount; buildTestGroups
 *  builds from it. */
function groupByTest(pool: AttributedSample[], at: number[], keys: string[]): Map<string, AttributedSample[]> {
  const byTest = new Map<string, AttributedSample[]>();
  for (let j = 0; j < pool.length; j++) {
    const key = keys[at[j]!]!;
    const group = byTest.get(key);
    if (group) group.push(pool[j]!);
    else byTest.set(key, [pool[j]!]);
  }
  return byTest;
}

/** Every indexed Sample's Test key under one key function, by position —
 *  computed once per (index, key function), so the second variant groups by
 *  reading it. A cache of derived data: testKey is pure. */
const testKeyColumns = new WeakMap<SampleIndex, WeakMap<TestKeyOf, string[]>>();
function testKeyColumn(index: SampleIndex, testKey: TestKeyOf): string[] {
  let byFn = testKeyColumns.get(index);
  if (byFn === undefined) {
    byFn = new WeakMap();
    testKeyColumns.set(index, byFn);
  }
  let keys = byFn.get(testKey);
  if (keys === undefined) {
    keys = index.samples.map(testKey);
    byFn.set(testKey, keys);
  }
  return keys;
}

function buildTestGroups(
  byTest: Map<string, AttributedSample[]>,
  metricNames: string[],
  sessionOrder: Map<string, number>,
): TestGroupView[] {
  const groups: TestGroupView[] = [];
  for (const [key, samples] of byTest) {
    const legacy = key === LEGACY_KEY;
    groups.push({
      key,
      // The label is composed of data (file/title/project), not vocabulary —
      // the legacy marker is the one UI string here (render substitutes it).
      label: legacy ? LEGACY_KEY : testLabel(samples),
      legacy,
      sampleCount: samples.length,
      engines: buildEngines(samples, metricNames, sessionOrder),
    });
  }
  groups.sort((a, b) => b.sampleCount - a.sampleCount || a.label.localeCompare(b.label));
  return groups;
}

/** Column order: the known five first, then whatever else the open name set
 *  carried, alphabetically — stable across Reports. */
function metricNamesOf(routes: RouteRow[]): string[] {
  const seen = new Set<string>();
  for (const row of routes) for (const name of Object.keys(row.metrics)) seen.add(name);
  return [
    ...KNOWN_METRIC_ORDER.filter((n) => seen.has(n)),
    ...[...seen].filter((n) => !KNOWN_METRIC_ORDER.includes(n)).sort(),
  ];
}

/** The landing table alone — Route, Samples, one cell per metric — with no
 *  drill-down, histogram or timeline. Cheap at any scale: it reads the
 *  precomputed RouteRows only. The server renders the no-JS fallback from it
 *  (the p75 + coverage summary); its cells are buildView's cells exactly. */
export interface RouteSummaryView {
  metricNames: string[];
  totalSamples: number;
  routes: Array<Pick<RouteView, 'route' | 'sampleCount' | 'coldStarts' | 'cells'>>;
}

export function buildRouteSummary(data: ReportData): RouteSummaryView {
  const metricNames = metricNamesOf(data.routes);
  return {
    metricNames,
    totalSamples: data.samples.length,
    routes: data.routes.map((row) => ({
      route: row.route,
      sampleCount: row.sampleCount,
      coldStarts: row.coldStarts,
      cells: metricNames.map((name) => buildCell(name, row)),
    })),
  };
}

/** Replace `obj[key]` (already present, so its position in key order is
 *  kept) with an enumerable getter that computes the value on first read and
 *  then becomes a plain data property holding it. */
function lazyField<T extends object, K extends keyof T>(obj: T, key: K, compute: () => T[K]): void {
  const settle = (target: T, value: T[K]): void => {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
  };
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: true,
    get(this: T) {
      const value = compute();
      settle(this, value);
      return value;
    },
    set(this: T, value: T[K]) {
      settle(this, value);
    },
  });
}

function buildHistograms(pool: AttributedSample[], metricNames: string[]): HistogramView[] {
  const histograms: HistogramView[] = [];
  for (const name of metricNames) {
    const values = okValues(pool, name);
    if (values.length === 0) continue; // nothing measured → no histogram, not an empty one
    const bins = histogramBins(values);
    histograms.push({
      metric: name,
      okCount: values.length,
      min: minOf(values),
      max: maxOf(values),
      maxBinCount: maxOf(bins.map((b) => b.count)),
      bins,
    });
  }
  return histograms;
}

/** Build the whole precomputed view from a ReportData. Pure.
 *  `testKey` defaults to a key function over `data.samples`; a variant over a
 *  subset passes the full Report's (testKeyFor) so group keys stay stable.
 *  `index` is the columnar index of `data.samples` (sampleIndex), when the
 *  caller already built it — the browser builds it once, at load, for both
 *  variants; one over any other Sample set is not used. */
export function buildView(
  data: ReportData,
  testKey: TestKeyOf = testKeyFor(data.samples),
  index?: SampleIndex,
): ReportView {
  return viewOf(data, testKey, indexOf(data.samples, index), null);
}

/** `index` when it indexes exactly `samples`, else a new one. */
function indexOf(samples: AttributedSample[], index: SampleIndex | undefined): SampleIndex {
  return index !== undefined && index.samples === samples ? index : sampleIndex(samples);
}

/** buildView, from the index. `positions`, when given, are the index
 *  positions data.samples was selected from (data.samples[k] is
 *  index.samples[positions[k]]); null when data.samples is the whole index. */
function viewOf(
  data: ReportData,
  testKey: TestKeyOf,
  index: SampleIndex,
  positions: Int32Array | null,
): ReportView {
  const metricNames = metricNamesOf(data.routes);
  const sessionOrder = new Map<string, number>(data.sessions.map((s, i) => [s.sessionId, i]));

  // The Route pools, matching aggregateRoutes' grouping exactly — by the
  // index's Route column, in pool order.
  const byRouteId: AttributedSample[][] = index.routes.map(() => []);
  const atByRouteId: number[][] = index.routes.map(() => []);
  for (let k = 0; k < data.samples.length; k++) {
    const p = positions === null ? k : positions[k]!;
    const r = index.routeId[p]!;
    byRouteId[r]!.push(data.samples[k]!);
    atByRouteId[r]!.push(p);
  }
  const routeIds = new Map(index.routes.map((route, r) => [route, r]));
  const keys = testKeyColumn(index, testKey);

  const routes: RouteView[] = data.routes.map((row) => {
    const r = routeIds.get(row.route);
    const pool = r === undefined ? [] : byRouteId[r]!;
    const byTest = groupByTest(pool, r === undefined ? [] : atByRouteId[r]!, keys);
    const route: RouteView = {
      route: row.route,
      sampleCount: row.sampleCount,
      coldStarts: row.coldStarts,
      blended: byTest.size > 1,
      testCount: byTest.size,
      cells: metricNames.map((name) => buildCell(name, row)),
      histograms: [],
      tests: [],
    };
    // The drill-down's contents are built when first READ — the browser
    // reads them when the Route's drill-down is first expanded. Lazy, not
    // different: an enumerable getter that memoizes, so the view still
    // deep-equals (and JSON-serializes to) the eager one.
    lazyField(route, 'histograms', () => buildHistograms(pool, metricNames));
    lazyField(route, 'tests', () => buildTestGroups(byTest, metricNames, sessionOrder));
    return route;
  });

  return {
    masterId: data.masterId,
    generatedAt: data.generatedAt,
    metricNames,
    sessions: data.sessions,
    engineCount: data.sessions.length,
    multiEngine: data.sessions.length > 1,
    enginesWithArtifact: data.sessions.filter((s) => s.artifact === 'present').length,
    totalSamples: data.samples.length,
    routes,
    timeline:
      positions === null
        ? fullTimeline(index, metricNames)
        : subsetTimeline(index, positions, data.samples, metricNames),
  };
}

// ------------------------------------------- the include-failed toggle (#9)

/**
 * Both variants of the report. The browser builds them (src/browser/entry.ts):
 * `included` at load, `excluded` on the first flip of the toggle — through
 * buildExcludedView, the same function buildReportVariants calls here.
 */
export interface ReportVariants {
  /** The breakdown behind "4 of 50 Executions failed" — and the toggle state. */
  outcomes: OutcomeSummary;
  /** Failed Executions INCLUDED — the default. The intuitive default (exclude)
   *  is the harmful one: the real failures were budget breaches, so excluding
   *  them deletes exactly the slowest Samples and flatters every percentile. */
  included: ReportView;
  /** The opt-out view, fully recomputed over excludeFailedExecutions(samples).
   *  null exactly when the toggle has nothing to do: outcome-awareness is
   *  unavailable (legacy — zero Outcome records anywhere) or no Execution
   *  failed. The renderer then disables the toggle WITH the reason stated. */
  excluded: ReportView | null;
}

/** Is there anything for the toggle to do? false = no excluded variant. */
export function hasExcludedVariant(outcomes: OutcomeSummary): boolean {
  return outcomes.aware && outcomes.excludable > 0;
}

/** The opt-out view, recomputed over excludeFailedExecutions(samples); null
 *  exactly when hasExcludedVariant is false. Pure. `index`: as buildView's —
 *  the columnar index of the FULL `data.samples`, which the subset is
 *  aggregated from without reading a Sample's record again. */
export function buildExcludedView(
  data: ReportData,
  outcomes: OutcomeSummary,
  testKey: TestKeyOf = testKeyFor(data.samples),
  index?: SampleIndex,
): ReportView | null {
  if (!hasExcludedVariant(outcomes)) return null;
  const full = indexOf(data.samples, index);
  const positions = keptPositions(data.samples);
  const kept = Array.from(positions, (p) => data.samples[p]!);
  return viewOf(
    {
      ...data,
      samples: kept,
      // The kept Samples carry their flags from the FULL run (the index holds
      // them) — never re-marked over the subset, so a filtered-out Cold Start
      // is a gap, not a promotion.
      routes: aggregateIndexed(full, positions),
    },
    testKey,
    full,
    positions,
  );
}

/** Build both views from one ReportData. Pure — the blob's raw data is never
 *  touched; each variant recomputes aggregates and timeline from its pool.
 *  One Test-key function and one Sample index, over the FULL Sample set,
 *  serve both variants. */
export function buildReportVariants(data: ReportData): ReportVariants {
  const outcomes = summarizeOutcomes(data.samples, data.outcomes);
  const testKey = testKeyFor(data.samples);
  const index = sampleIndex(data.samples);
  const included = buildView(data, testKey, index);
  const excluded = buildExcludedView(data, outcomes, testKey, index);
  return { outcomes, included, excluded };
}
