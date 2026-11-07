// The report's markup, as strings — ISOMORPHIC (E1). The browser bundle
// (entry.ts) renders the interactive report with these functions from the
// view model it builds in the page; Node uses the same functions for the no-JS
// fallback summary (render.ts) and for the tests, which assert on exactly the
// markup the browser inserts (test/browser-render.test.ts proves the DOM
// matches). No node:* imports, no DOM access: string in, string out.
//
// Everything visible is rendered from the PRECOMPUTED view model
// (view-model.ts): threshold dots (p75 only), groupings, blend caveats,
// histogram bins — all decided there, all unit-tested there. These functions
// decide nothing.
//
// The look (dataviz skill): status colors carry the p75 threshold verdict and
// nothing else — good #0ca30c / needs-improvement #fab219 / poor #d03b3b, the
// same steps in both modes, always paired with a text label (title + visually
// hidden text), never color alone. Histograms are single-series (slot-1 blue),
// thin bars with 2px surface gaps and rounded data-ends, in drill-in only.
// Vocabulary (CONTEXT.md) comes from UI_STRINGS, nowhere else.

import type { OutcomeSummary } from '../aggregate.js';
import type { SessionSummary } from '../report.js';
import type { ThresholdBand } from '../thresholds.js';
import { UI_STRINGS as S } from '../ui-strings.js';
import {
  seriesColumns,
  xFraction,
  type EngineView,
  type HistogramView,
  type MetricCell,
  type NavigationView,
  type ReportView,
  type RouteSummaryView,
  type RouteView,
  type TestGroupView,
  type TimelineAxis,
  type TimelineChart,
  type TimelinePoint,
  type TimelineView,
} from '../view-model.js';

// --------------------------------------------------------------- utilities

/** Escape for text and double-quoted attributes. A NUL becomes U+FFFD here —
 *  exactly what the HTML parser would turn it into — so the markup Node
 *  renders and the DOM the browser builds from it stay identical. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\u0000/g, '\uFFFD');
}

/** A grouping key made safe for a DOM attribute: TestGroupView.key may start
 *  with a NUL (`\0id\0…`, `\0legacy`), which no attribute can carry. Control
 *  characters and '%' are percent-encoded — total (never throws, unlike
 *  encodeURIComponent on a lone surrogate) and reversible. */
export function domKey(key: string): string {
  return key.replace(/[\u0000-\u001f%]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Display formatting: CLS is a true unitless float; everything else is ms. */
function fmtValue(metric: string, value: number): string {
  if (metric === 'cls') {
    return String(Math.round(value * 100000) / 100000);
  }
  return `${Math.round(value).toLocaleString('en-US')} ms`;
}

/** "1 Sample" / "n Samples" — counts read naturally at every level. */
function nSamples(n: number): string {
  return `${n} ${n === 1 ? S.sampleWord : S.samplesWord}`;
}

/** The subordinate p50/p95 line drops the unit — the p75 beside it carries it. */
function fmtBare(metric: string, value: number): string {
  if (metric === 'cls') return fmtValue(metric, value);
  return Math.round(value).toLocaleString('en-US');
}

/** The metric's column heading — the known five read as acronyms. */
const KNOWN_HEADINGS: Record<string, string> = {
  ttfb: 'TTFB',
  fcp: 'FCP',
  lcp: 'LCP',
  cls: 'CLS',
  inp: 'INP',
};
function metricHeading(name: string): string {
  return KNOWN_HEADINGS[name] ?? name;
}

const BAND_LABEL: Record<ThresholdBand, string> = {
  good: S.bandGood,
  'needs-improvement': S.bandNeedsImprovement,
  poor: S.bandPoor,
};

/** "no-interaction" → "no interaction"; "not-carried" → the UI's phrasing.
 *  'unknown' is the legacy adapter's status and is displayed DISTINCTLY from
 *  'unsupported' and 'no interaction' — the incumbent cannot say why. */
function reasonLabel(reason: string): string {
  if (reason === 'not-carried') return S.notCarried;
  if (reason === 'unknown') return S.unknownLegacy;
  return reason.replace(/-/g, ' ');
}

/** The not-ok statuses itemized, for the coverage tooltip: "9 unsupported". */
function breakdownTitle(cell: MetricCell): string {
  return Object.entries(cell.breakdown)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, count]) => `${count} ${reasonLabel(status)}`)
    .join(', ');
}

// ------------------------------------------------------------------- cells

/** The threshold dot — beside p75 ONLY, and never color alone: a title and
 *  visually-hidden text always carry the band name. */
function dotHtml(cell: MetricCell): string {
  if (cell.dot === null) return '';
  const band = BAND_LABEL[cell.dot];
  const title = `${metricHeading(cell.metric)} ${S.p75} — ${band} (web.dev)`;
  return (
    `<span class="dot dot-${cell.dot}" title="${escapeHtml(title)}"></span>` +
    `<span class="sr-only">${escapeHtml(band)} </span>`
  );
}

function metricCellHtml(cell: MetricCell): string {
  const coverage = `${cell.ok} ${S.ofWord} ${cell.total}`;
  const coverageTitle = breakdownTitle(cell);
  const coverageHtml = `<div class="coverage"${
    coverageTitle ? ` title="${escapeHtml(coverageTitle)}"` : ''
  }>${escapeHtml(coverage)}</div>`;

  if (cell.ok === 0 || cell.p75 === null) {
    // Nothing measured: the reason, never a number, never a 0.
    const reason = reasonLabel(cell.reason ?? 'invalid');
    return (
      `<td class="metric">` +
      `<div class="lead reason">${escapeHtml(reason)}</div>` +
      coverageHtml +
      `</td>`
    );
  }

  const shape =
    `${S.p50} ${escapeHtml(fmtBare(cell.metric, cell.p50!))}` +
    ` · ${S.p95} ${escapeHtml(fmtBare(cell.metric, cell.p95!))}`;
  return (
    `<td class="metric">` +
    `<div class="lead">${dotHtml(cell)}<span class="p75">${escapeHtml(
      fmtValue(cell.metric, cell.p75),
    )}</span></div>` +
    `<div class="shape">${shape}</div>` +
    coverageHtml +
    `</td>`
  );
}

// -------------------------------------------------------------- histograms

const HISTO_W = 260;
const HISTO_H = 72;
const HISTO_PLOT_H = 56;
const HISTO_GAP = 2;

/** A bar with a rounded data-end and a square baseline end. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(3, w / 2, h);
  const x2 = x + w;
  const yb = y + h;
  return `M${x.toFixed(2)},${yb.toFixed(2)} V${(y + r).toFixed(2)} Q${x.toFixed(2)},${y.toFixed(
    2,
  )} ${(x + r).toFixed(2)},${y.toFixed(2)} H${(x2 - r).toFixed(2)} Q${x2.toFixed(2)},${y.toFixed(
    2,
  )} ${x2.toFixed(2)},${(y + r).toFixed(2)} V${yb.toFixed(2)} Z`;
}

function histogramHtml(histo: HistogramView): string {
  const n = histo.bins.length;
  const barW = (HISTO_W - (n - 1) * HISTO_GAP) / n;
  const baselineY = HISTO_PLOT_H + 2;
  const bars = histo.bins
    .map((bin, i) => {
      if (bin.count === 0) return '';
      const h = Math.max(2, (bin.count / histo.maxBinCount) * HISTO_PLOT_H);
      const x = i * (barW + HISTO_GAP);
      const range =
        bin.x0 === bin.x1
          ? fmtValue(histo.metric, bin.x0)
          : `${fmtValue(histo.metric, bin.x0)} – ${fmtValue(histo.metric, bin.x1)}`;
      return (
        `<path class="bar" data-tip="${escapeHtml(`${range} · ${bin.count} ${S.binTooltipSuffix}`)}" ` +
        `d="${barPath(x, baselineY - h, barW, h)}"></path>`
      );
    })
    .join('');
  return (
    `<figure class="histo">` +
    `<figcaption>${escapeHtml(metricHeading(histo.metric))} ` +
    `<span class="muted">${escapeHtml(nSamples(histo.okCount))}</span></figcaption>` +
    `<svg viewBox="0 0 ${HISTO_W} ${HISTO_H}" width="${HISTO_W}" height="${HISTO_H}" role="img" ` +
    `aria-label="${escapeHtml(`${metricHeading(histo.metric)} ${S.histogramEmptyNote}`)}">` +
    bars +
    `<rect class="axis" x="0" y="${baselineY}" width="${HISTO_W}" height="1"></rect>` +
    `</svg>` +
    `<div class="histo-axis"><span>${escapeHtml(
      fmtValue(histo.metric, histo.min),
    )}</span><span>${escapeHtml(fmtValue(histo.metric, histo.max))}</span></div>` +
    `</figure>`
  );
}

// ---------------------------------------------------------------- timeline
//
// The wall-clock timeline (issue #8) — everything here is GEOMETRY over the
// precomputed TimelineView; the model (axis union, ticks, points, p75, y
// domain) is decided and tested in view-model.ts. Scatter, deliberately: each
// point is one Sample event, and connecting lines would invent a continuity
// the data does not have (two Engines interleave; thin runs stay honest).
//
// The chart renderer walks chart.series — N series on the ONE shared axis —
// so a foreign series later is one more loop iteration, not a rework.
//
// Three layers per chart (E3), stacked in one .tl-plot box:
//   1. an SVG BEHIND: gridlines, tick labels, the zone label, the axis line
//      and the p75 reference line;
//   2. a <canvas>: the plain points (Navigations) — drawn by the browser
//      (canvas.ts) from timelineGeometry, at the device pixel ratio. A
//      200k-Sample Report draws a million points with ZERO DOM nodes for them;
//   3. an SVG IN FRONT: the Cold Start diamonds (few: one per Engine per
//      worker process, each with its own data-tip) and the p75 label.
// The plain points' tooltip comes from a hit-test (timelineHit) over the
// same geometry. The box carries the chart's text alternative (aria-label).
//
// Time zone (E3): tick labels, the zone label on the axis and the tooltips
// read in a time zone the caller names — the viewer's local zone by default
// in the browser, or UTC by the toggle. The model's ticks sit on clean UTC
// boundaries; their labels are re-read here in the chosen zone.

// Matches the body's content column (80rem minus padding), so at full width
// the svg renders 1:1 and its 10px labels stay 10px — width:100% below that.
export const TL_W = 1240;
const TL_PL = 56; // left pad: y tick labels
const TL_PR = 14;
const TL_PT = 12; // top pad: p75 label headroom
const TL_PLOT_H = 120;
const TL_AXIS_H = 24;
export const TL_H = TL_PT + TL_PLOT_H + TL_AXIS_H;
/** A plain point's radius, in viewBox units. */
export const TL_POINT_R = 4;

/** The zone the times read in: an IANA name ('America/New_York') or 'UTC'. */
export const UTC = 'UTC';

function tlX(axis: TimelineAxis, ts: number): number {
  return TL_PL + xFraction(axis, ts) * (TL_W - TL_PL - TL_PR);
}

function tlY(chart: TimelineChart, value: number): number {
  return TL_PT + (1 - value / chart.yMax) * TL_PLOT_H;
}

// ------------------------------------------------------- time-zone reading

interface ZoneParts {
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  ms: string;
  zone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      timeZoneName: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock reading of `ts` in `tz`. UTC is read straight off the ISO
 *  string — exactly the model's labels; any other zone through Intl, by parts,
 *  so the shape never depends on a locale's punctuation. */
function zoneParts(ts: number, tz: string): ZoneParts {
  if (tz === UTC) {
    const iso = new Date(ts).toISOString();
    return {
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19),
      ms: iso.slice(20, 23),
      zone: UTC,
    };
  }
  const out: ZoneParts = { month: '', day: '', hour: '', minute: '', second: '', ms: '', zone: '' };
  for (const part of formatterFor(tz).formatToParts(ts)) {
    if (part.type === 'month') out.month = part.value;
    else if (part.type === 'day') out.day = part.value;
    else if (part.type === 'hour') out.hour = part.value;
    else if (part.type === 'minute') out.minute = part.value;
    else if (part.type === 'second') out.second = part.value;
    else if (part.type === 'fractionalSecond') out.ms = part.value;
    else if (part.type === 'timeZoneName') out.zone = part.value;
  }
  return out;
}

/** A tick's label in `tz`: HH:MM:SS, or MM-DD HH:MM on day-scale steps —
 *  the model's resolution (TimelineAxis.stepMs), read in the chosen zone. */
export function tickText(ts: number, stepMs: number, tz: string): string {
  const p = zoneParts(ts, tz);
  return stepMs >= 86_400_000
    ? `${p.month}-${p.day} ${p.hour}:${p.minute}`
    : `${p.hour}:${p.minute}:${p.second}`;
}

/** The zone's short name at `ts` — "UTC", "EST", "GMT+5:30" — for the axis. */
export function zoneLabel(ts: number, tz: string): string {
  return zoneParts(ts, tz).zone;
}

/** HH:MM:SS.mmm ZONE — a point's time in its tooltip. */
function clockText(ts: number, tz: string): string {
  const p = zoneParts(ts, tz);
  return `${p.hour}:${p.minute}:${p.second}.${p.ms} ${p.zone}`;
}

// ---------------------------------------------------------- Engine colors

/** Engine → categorical slot, in the API's session order — fixed, never cycled.
 *  Past the 8 palette slots, later Engines share the de-emphasis ink (and stay
 *  identified by tooltip); a 9th generated hue would break the CVD checks. */
function engineSlots(view: ReportView): Map<string, number> {
  const slots = new Map<string, number>();
  view.sessions.forEach((session, i) => {
    slots.set(session.sessionId, i < 8 ? i : -1);
  });
  return slots;
}

/** A point's color slot: 0–7 an Engine hue, -1 the single-series ink. */
function pointSlot(sessionId: string | undefined, slots: Map<string, number>, multiEngine: boolean): number {
  if (!multiEngine || sessionId === undefined) return -1;
  return slots.get(sessionId) ?? -1;
}

/** The CSS class for a slot — and the custom property the canvas reads it from. */
export function slotClass(slot: number): string {
  return slot === -1 ? 'pt-mono' : `pt-s${slot}`;
}
export function slotColorVar(slot: number): string {
  return slot === -1 ? '--series-1' : `--cat-${slot + 1}`;
}

/** A Cold Start marker: a diamond (a SHAPE, so the flag survives color-
 *  blindness and never depends on hue). Its hover text rides as data-tip —
 *  precomputed here, shown by the inline script's tooltip, which positions
 *  but never composes. (A native <title> alongside would double the tooltip.) */
function coldMarker(x: number, y: number, cls: string, tip: string): string {
  const cx = x.toFixed(1);
  const cy = y.toFixed(1);
  const d = `M${cx},${(y - 6).toFixed(1)} L${(x + 6).toFixed(1)},${cy} L${cx},${(y + 6).toFixed(
    1,
  )} L${(x - 6).toFixed(1)},${cy} Z`;
  return `<path class="pt cold ${cls}" data-tip="${escapeHtml(tip)}" d="${d}"></path>`;
}

/** A point's hover text: wall-clock time (in `tz`), value, Engine, Cold
 *  Start, URL. */
export function pointTip(chart: TimelineChart, p: TimelinePoint, tz: string = UTC): string {
  return (
    `${clockText(p.ts, tz)} · ${fmtValue(chart.metric, p.value)}` +
    (p.meta?.engineLabel ? ` · ${p.meta.engineLabel}` : '') +
    (p.meta?.coldStart === true ? ` · ${S.coldStartFlag}` : '') +
    (p.meta?.url ? `\n${p.meta.url}` : '')
  );
}

function axisOf(view: ReportView): TimelineAxis {
  return view.timeline.axis ?? { minTs: 0, maxTs: 0, stepMs: 1_000, ticks: [] };
}

/** One chart's points in viewBox units, ordered by x — what the canvas draws
 *  and the hit-test searches. Built once per chart (memoized), from the
 *  series' columns: no point objects are materialized. */
export interface TimelineGeometry {
  xs: Float64Array;
  ys: Float64Array;
  /** Color slot per point (pointSlot). */
  slots: Int8Array;
  /** 1 where the point is a Cold Start — drawn as an SVG diamond, not here. */
  cold: Uint8Array;
  /** Which series, and which point in it, each entry is. */
  series: Uint16Array;
  index: Uint32Array;
}

const geometryCache = new WeakMap<TimelineChart, TimelineGeometry>();

export function timelineGeometry(view: ReportView, chartIndex: number): TimelineGeometry | null {
  const chart = view.timeline.charts[chartIndex];
  if (chart === undefined) return null;
  const cached = geometryCache.get(chart);
  if (cached !== undefined) return cached;
  const axis = axisOf(view);
  const slotMap = engineSlots(view);
  const cols = chart.series.map(seriesColumns);
  const n = cols.reduce((sum, c) => sum + c.ts.length, 0);
  // One series is already in ts (so x) order; several are merged by ts.
  let order: Array<[number, number]> | null = null;
  if (cols.length > 1) {
    order = [];
    cols.forEach((c, si) => {
      for (let i = 0; i < c.ts.length; i++) order!.push([si, i]);
    });
    order.sort((a, b) => cols[a[0]]!.ts[a[1]]! - cols[b[0]]!.ts[b[1]]!);
  }
  const geo: TimelineGeometry = {
    xs: new Float64Array(n),
    ys: new Float64Array(n),
    slots: new Int8Array(n),
    cold: new Uint8Array(n),
    series: new Uint16Array(n),
    index: new Uint32Array(n),
  };
  // The x and y maps, inlined: x = a + b·ts, y = c + d·value (tlX, tlY).
  const span = axis.maxTs - axis.minTs;
  const plotW = TL_W - TL_PL - TL_PR;
  const xb = span === 0 ? 0 : plotW / span;
  const xa = span === 0 ? TL_PL + 0.5 * plotW : TL_PL - axis.minTs * xb;
  const yd = -TL_PLOT_H / chart.yMax;
  const yc = TL_PT + TL_PLOT_H;
  let lastSession: string | undefined;
  let lastSlot = -1;
  for (let k = 0; k < n; k++) {
    const si = order === null ? 0 : order[k]![0];
    const i = order === null ? k : order[k]![1];
    const c = cols[si]!;
    geo.xs[k] = xa + c.ts[i]! * xb;
    geo.ys[k] = yc + c.value[i]! * yd;
    const session = c.sessionId(i);
    if (k === 0 || session !== lastSession) {
      lastSession = session;
      lastSlot = pointSlot(session, slotMap, view.multiEngine);
    }
    geo.slots[k] = lastSlot;
    geo.cold[k] = c.coldStart(i) === true ? 1 : 0;
    geo.series[k] = si;
    geo.index[k] = i;
  }
  geometryCache.set(chart, geo);
  return geo;
}

/** The point at geometry entry `k`, as a TimelinePoint (for its tooltip). */
function geometryPoint(chart: TimelineChart, geo: TimelineGeometry, k: number): TimelinePoint {
  const cols = seriesColumns(chart.series[geo.series[k]!]!);
  const i = geo.index[k]!;
  const meta = cols.meta(i);
  return meta === undefined ? { ts: cols.ts[i]!, value: cols.value[i]! } : { ts: cols.ts[i]!, value: cols.value[i]!, meta };
}

/** The hover hit-test for the canvas points: the tooltip text of the point
 *  nearest (svgX, svgY) — viewBox units — within `radius`, else null. The
 *  geometry is in x order, so a binary search bounds the scan to the
 *  radius-wide column. */
export function timelineHit(
  view: ReportView,
  chartIndex: number,
  svgX: number,
  svgY: number,
  tz: string = UTC,
  radius = 6,
): string | null {
  const chart = view.timeline.charts[chartIndex];
  const geo = timelineGeometry(view, chartIndex);
  if (chart === undefined || geo === null) return null;
  const { xs, ys } = geo;
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < svgX - radius) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = radius * radius;
  for (let i = lo; i < xs.length && xs[i]! <= svgX + radius; i++) {
    const dx = xs[i]! - svgX;
    const dy = ys[i]! - svgY;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best === -1 ? null : pointTip(chart, geometryPoint(chart, geo, best), tz);
}

/** The chart's text alternative: what it plots, over which span, its p75 and
 *  its Cold Starts — the canvas itself says nothing to a screen reader. */
function chartSummary(chart: TimelineChart, axis: TimelineAxis, tz: string): string {
  const heading = metricHeading(chart.metric);
  const span =
    axis.ticks.length > 0
      ? ` ${S.fromWord} ${clockText(axis.minTs, tz)} ${S.toWord} ${clockText(axis.maxTs, tz)}`
      : '';
  const p75 = chart.p75 === null ? '' : `; ${S.p75} ${fmtValue(chart.metric, chart.p75)}`;
  const cold = chart.coldStartCount > 0 ? `; ${chart.coldStartCount} ${S.coldStartsSuffix}` : '';
  return `${heading} — ${S.timelineChartAria}: ${chart.okCount} ${S.ofWord} ${chart.total} ${S.samplesWord}${span}${p75}${cold}`;
}

function timelineChartHtml(
  view: ReportView,
  chart: TimelineChart,
  chartIndex: number,
  slots: Map<string, number>,
  tz: string,
): string {
  const axis = axisOf(view);
  const heading = metricHeading(chart.metric);
  const coverage = `${chart.okCount} ${S.ofWord} ${chart.total} ${S.samplesWord}`;

  if (chart.okCount === 0) {
    // Nothing measured: the reason in place of a chart, never an empty plot.
    const reason = reasonLabel(chart.reason ?? 'invalid');
    return `<div class="tl-reason">${escapeHtml(
      `${heading} — ${reason} (${chart.okCount} ${S.ofWord} ${chart.total})`,
    )}</div>`;
  }

  const plotRight = TL_W - TL_PR;
  const baselineY = TL_PT + TL_PLOT_H;

  // Horizontal gridlines + y tick labels (values precomputed in the model).
  const yGrid = chart.yTicks
    .map((v) => {
      const y = tlY(chart, v).toFixed(1);
      const label = v === 0 ? '0' : fmtBare(chart.metric, v);
      return (
        (v === 0 ? '' : `<line class="grid" x1="${TL_PL}" y1="${y}" x2="${plotRight}" y2="${y}"></line>`) +
        `<text class="ylab" x="${TL_PL - 6}" y="${(Number(y) + 3).toFixed(1)}">${escapeHtml(label)}</text>`
      );
    })
    .join('');

  // Vertical gridlines + wall-clock tick labels in the chosen zone; edge
  // labels clamp inward so nothing clips at the svg boundary.
  const xGrid = axis.ticks
    .map((tick) => {
      const x = tlX(axis, tick.ts);
      const anchor = x < TL_PL + 24 ? 'start' : x > plotRight - 24 ? 'end' : 'middle';
      return (
        `<line class="grid" x1="${x.toFixed(1)}" y1="${TL_PT}" x2="${x.toFixed(1)}" y2="${baselineY}"></line>` +
        `<text class="xlab" text-anchor="${anchor}" x="${x.toFixed(1)}" y="${baselineY + 15}">${escapeHtml(
          tickText(tick.ts, axis.stepMs, tz),
        )}</text>`
      );
    })
    .join('');
  // The zone, ON the axis: under the y labels, level with the tick labels.
  const zoneText = `<text class="tzlab" text-anchor="end" x="${TL_PL - 6}" y="${baselineY + 15}">${escapeHtml(
    zoneLabel(axis.minTs, tz),
  )}</text>`;

  // The run-level p75 reference line, labelled. The line sits UNDER the
  // points; the label is drawn in front of them with a surface halo so it
  // stays legible where the data crowds the right edge. Label flips below
  // the line when the line runs too close to the top edge.
  let refLine = '';
  let refLabel = '';
  if (chart.p75 !== null) {
    const y = tlY(chart, chart.p75);
    const labelY = y - 5 < TL_PT + 6 ? y + 13 : y - 5;
    refLine = `<line class="ref" x1="${TL_PL}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}"></line>`;
    refLabel = `<text class="reflab" text-anchor="end" x="${plotRight}" y="${labelY.toFixed(1)}">${escapeHtml(
      `${S.p75} ${fmtValue(chart.metric, chart.p75)}`,
    )}</text>`;
  }

  // Cold Starts: individual diamonds in the front layer, each with its tip.
  const cold: string[] = [];
  if (chart.coldStartCount > 0) {
    for (const series of chart.series) {
      const cols = seriesColumns(series);
      for (let i = 0; i < cols.ts.length; i++) {
        if (cols.coldStart(i) !== true) continue;
        const meta = cols.meta(i);
        const p: TimelinePoint =
          meta === undefined ? { ts: cols.ts[i]!, value: cols.value[i]! } : { ts: cols.ts[i]!, value: cols.value[i]!, meta };
        const cls = slotClass(pointSlot(cols.sessionId(i), slots, view.multiEngine));
        cold.push(coldMarker(tlX(axis, p.ts), tlY(chart, p.value), cls, pointTip(chart, p, tz)));
      }
    }
  }

  const unit = chart.unit === 'unitless' ? S.unitlessWord : chart.unit;
  const viewBox = `0 0 ${TL_W} ${TL_H}`;
  return (
    `<figure class="tl">` +
    `<figcaption>${escapeHtml(heading)} <span class="muted">${escapeHtml(
      `${unit} · ${coverage}`,
    )}</span></figcaption>` +
    `<div class="tl-plot" role="img" aria-label="${escapeHtml(chartSummary(chart, axis, tz))}">` +
    `<svg class="tl-back" viewBox="${viewBox}" aria-hidden="true">` +
    yGrid +
    xGrid +
    zoneText +
    `<line class="axisline" x1="${TL_PL}" y1="${baselineY}" x2="${plotRight}" y2="${baselineY}"></line>` +
    refLine +
    `</svg>` +
    `<canvas class="tl-points" data-chart="${chartIndex}" aria-hidden="true"></canvas>` +
    `<svg class="tl-front" viewBox="${viewBox}" data-chart="${chartIndex}" aria-hidden="true">` +
    cold.join('') +
    refLabel +
    `</svg>` +
    `</div>` +
    `</figure>`
  );
}

/** The legend: Engine hues only when >1 Engine contributed points (a single-
 *  Engine run needs no legend — the note names what is plotted); the Cold
 *  Start diamond appears exactly when a true flag exists somewhere. */
function timelineLegendHtml(
  timeline: TimelineView,
  view: ReportView,
  slots: Map<string, number>,
): string {
  const contributing = new Set<string>();
  for (const chart of timeline.charts) {
    for (const series of chart.series) {
      const cols = seriesColumns(series);
      for (let i = 0; i < cols.ts.length && contributing.size < view.sessions.length; i++) {
        const id = cols.sessionId(i);
        if (id !== undefined) contributing.add(id);
      }
    }
  }
  const entries: string[] = [];
  if (view.multiEngine) {
    for (const session of view.sessions) {
      if (!contributing.has(session.sessionId)) continue;
      const cls = slotClass(pointSlot(session.sessionId, slots, true));
      entries.push(
        `<span class="key" title="${escapeHtml(session.sessionId)}">` +
          `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><circle class="pt ${cls}" cx="6" cy="6" r="4.5"></circle></svg>` +
          ` ${escapeHtml(session.engineLabel)}</span>`,
      );
    }
  }
  if (timeline.charts.some((c) => c.coldStartCount > 0)) {
    const cls = view.multiEngine ? 'pt-legend-cold' : 'pt-mono';
    entries.push(
      `<span class="key">` +
        `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path class="pt ${cls}" d="M7,1.5 L12.5,7 L7,12.5 L1.5,7 Z"></path></svg>` +
        ` ${escapeHtml(S.coldStartFlag)}</span>`,
    );
  }
  if (entries.length === 0) return '';
  return `<div class="tl-legend">${entries.join('')}</div>`;
}

/** The time-zone line: which zone the times read in, and the UTC toggle.
 *  `localTz` is the viewer's zone; `tz` the one in force. One checkbox per
 *  variant's timeline (class, not id); the script keeps them in step. */
function zoneControlHtml(tz: string, localTz: string): string {
  const utc = tz === UTC;
  const shown = utc ? S.tzShownUtc : `${S.tzShownLocal} ${localTz}`;
  return (
    `<div class="tl-zone">` +
    `<span class="tz-shown">${escapeHtml(shown)}</span>` +
    `<label class="toggle"><input type="checkbox" class="bzm-tz-utc"${utc ? ' checked' : ''}> ${escapeHtml(
      S.tzUtcToggle,
    )}</label>` +
    `</div>`
  );
}

/** The timeline section of one variant. `tz`: the zone in force; `localTz`:
 *  the viewer's own (named beside the toggle). */
export function timelineHtml(view: ReportView, tz: string = UTC, localTz: string = tz): string {
  const timeline = view.timeline;
  if (timeline.charts.length === 0) return ''; // zero Samples: the table already said so
  const slots = engineSlots(view);
  const charts = timeline.charts
    .map((chart, i) => timelineChartHtml(view, chart, i, slots, tz))
    .join('');
  return (
    `<section class="timeline">` +
    `<h2>${escapeHtml(S.timelineHeading)}<span class="badge">${escapeHtml(S.labData)}</span></h2>` +
    `<p class="note">${escapeHtml(S.timelineNote)}</p>` +
    zoneControlHtml(tz, localTz) +
    timelineLegendHtml(timeline, view, slots) +
    charts +
    `</section>`
  );
}

// -------------------------------------------------- drill-down (Route → …)

function navigationRowHtml(nav: NavigationView, metricNames: string[]): string {
  const iso = new Date(nav.ts).toISOString();
  const time = iso.slice(11, 23);
  const coldFlag = nav.coldStart === true ? ` <span class="flag cold">${escapeHtml(S.coldStartFlag)}</span>` : '';
  const cells = metricNames
    .map((name) => {
      const metric = nav.vitals[name];
      if (metric === undefined) return `<td class="num muted">—</td>`;
      if (metric.status === 'ok' && typeof metric.value === 'number') {
        return `<td class="num">${escapeHtml(fmtValue(name, metric.value))}</td>`;
      }
      return `<td class="num muted">${escapeHtml(reasonLabel(String(metric.status)))}</td>`;
    })
    .join('');
  const outcome =
    nav.executionStatus === 'unavailable'
      ? `<span class="muted">${escapeHtml(S.outcomeUnavailable)}</span>`
      : nav.executionStatus === 'passed'
        ? `<span class="muted">${escapeHtml(S.passedWord)}</span>`
        : `<span class="flag bad">${escapeHtml(
            nav.executionStatus === 'crashed'
              ? S.outcomeCrashedBeforeFinishing
              : nav.executionStatus === 'failed'
                ? S.failedWord
                : nav.executionStatus === 'timedOut'
                  ? S.timedOutWord
                  : nav.executionStatus === 'skipped'
                    ? S.skippedWord
                    : nav.executionStatus,
          )}</span>`;
  return (
    `<tr>` +
    `<td class="num" title="${escapeHtml(iso)}">${escapeHtml(time)}${coldFlag}</td>` +
    `<td class="url">${escapeHtml(nav.url)}</td>` +
    cells +
    `<td>${outcome}</td>` +
    `</tr>`
  );
}

/** How a variant's drill-downs are emitted. 'lazy' (the browser): every level
 *  — the Route's row, each Test, each Engine — is emitted closed and EMPTY,
 *  and filled on its first expand (drillContentHtml, testGroupBodyHtml,
 *  engineBodyHtml); an Engine's Navigation rows come NAV_CHUNK at a time. A
 *  200k-Sample Report builds none of it until someone asks. A level that
 *  opens by default (the only Test, the only Engine) is filled at once.
 *  'eager': everything filled now (the tests, which assert on the content). */
export type DrillMode = 'lazy' | 'eager';

/** Navigation rows per "show more" step in a lazily built Engine. */
export const NAV_CHUNK = 500;

function navHeadHtml(metricNames: string[]): string {
  return (
    `<tr><th>${escapeHtml(S.timeColumn)}</th><th class="url">${escapeHtml(S.urlColumn)}</th>` +
    metricNames.map((n) => `<th class="num">${escapeHtml(metricHeading(n))}</th>`).join('') +
    `<th>${escapeHtml(S.outcomeColumn)}</th></tr>`
  );
}

/** Navigation rows [from, to) of an Engine, for its table body. */
export function navigationRowsHtml(engine: EngineView, metricNames: string[], from: number, to: number): string {
  const navs = engine.navigations;
  let html = '';
  for (let i = from; i < Math.min(to, navs.length); i++) html += navigationRowHtml(navs[i]!, metricNames);
  return html;
}

/** The "show more" button under a partly shown Navigation table, or ''. */
export function moreNavigationsHtml(engine: EngineView, shown: number): string {
  const total = engine.navigations.length;
  if (shown >= total) return '';
  const next = Math.min(NAV_CHUNK, total - shown);
  return `<button class="more" data-shown="${shown}">${escapeHtml(
    `${S.showWord} ${next} ${S.moreOfWord} ${total} ${S.navigationsHeading}`,
  )}</button>`;
}

/** The inside of an Engine's <details>, after its summary: the Navigation
 *  table — every row ('eager'), or the first NAV_CHUNK and a "show more". */
export function engineBodyHtml(engine: EngineView, metricNames: string[], drills: DrillMode): string {
  const shown = drills === 'eager' ? engine.navigations.length : Math.min(NAV_CHUNK, engine.navigations.length);
  return (
    `<div class="table-scroll"><table class="navs"><thead>${navHeadHtml(metricNames)}</thead><tbody>` +
    navigationRowsHtml(engine, metricNames, 0, shown) +
    `</tbody></table></div>` +
    moreNavigationsHtml(engine, shown)
  );
}

function engineHtml(
  engine: EngineView,
  metricNames: string[],
  soloEngine: boolean,
  drills: DrillMode,
  engineIndex: number,
): string {
  const fill = drills === 'eager' || soloEngine;
  return (
    `<details class="engine" data-session-id="${escapeHtml(engine.sessionId)}" data-ei="${engineIndex}"${
      fill ? '' : ' data-lazy=""'
    }${soloEngine ? ' open' : ''}>` +
    `<summary><span class="engine-label" title="${escapeHtml(engine.sessionId)}">${escapeHtml(
      engine.engineLabel,
    )}</span> — ${escapeHtml(nSamples(engine.sampleCount))} · ${escapeHtml(
      S.navigationsHeading,
    )}</summary>` +
    (fill ? engineBodyHtml(engine, metricNames, drills) : '') +
    `</details>`
  );
}

/** The per-Engine p75 spread — rendered only when a Test ran on >1 Engine.
 *  Shown side by side; never adjudicated. */
function engineSpreadHtml(group: TestGroupView, metricNames: string[]): string {
  if (group.engines.length < 2) return ''; // single-Engine runs read naturally
  const head =
    `<tr><th>${escapeHtml(S.engineWord)}</th>` +
    metricNames
      .map((n) => `<th class="num">${escapeHtml(metricHeading(n))} ${S.p75}</th>`)
      .join('') +
    `</tr>`;
  const rows = group.engines
    .map(
      (engine) =>
        `<tr><td data-session-id="${escapeHtml(engine.sessionId)}" title="${escapeHtml(
          engine.sessionId,
        )}">${escapeHtml(engine.engineLabel)}</td>` +
        metricNames
          .map((n) => {
            const agg = engine.p75s[n];
            const value =
              agg === undefined || agg.p75 === null ? '—' : escapeHtml(fmtValue(n, agg.p75));
            // Coverage accompanies every aggregate — a 3-of-50 Engine p75 must
            // not read like a 50-of-50 one.
            const coverage =
              agg === undefined
                ? ''
                : `<div class="coverage">${escapeHtml(`${agg.ok} ${S.ofWord} ${agg.total}`)}</div>`;
            return `<td class="num">${value}${coverage}</td>`;
          })
          .join('') +
        `</tr>`,
    )
    .join('');
  return (
    `<div class="spread"><h4>${escapeHtml(S.engineSpreadHeading)}</h4>` +
    `<div class="table-scroll"><table class="spread-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`
  );
}

/** The inside of a Test's <details>, after its summary: the Engine spread and
 *  one (closed, lazily filled) <details> per Engine. */
export function testGroupBodyHtml(
  group: TestGroupView,
  metricNames: string[],
  soloTest: boolean,
  drills: DrillMode,
): string {
  const soloEngine = soloTest && group.engines.length === 1;
  return (
    engineSpreadHtml(group, metricNames) +
    group.engines.map((engine, i) => engineHtml(engine, metricNames, soloEngine, drills, i)).join('')
  );
}

function testGroupHtml(
  group: TestGroupView,
  metricNames: string[],
  soloTest: boolean,
  drills: DrillMode,
  testIndex: number,
): string {
  const label = group.legacy ? S.legacyTestGroup : group.label;
  const fill = drills === 'eager' || soloTest;
  return (
    `<details class="test-group" data-test-key="${escapeHtml(domKey(group.key))}" data-ti="${testIndex}"${
      fill ? '' : ' data-lazy=""'
    }${soloTest ? ' open' : ''}>` +
    `<summary>${escapeHtml(label)} — ${escapeHtml(nSamples(group.sampleCount))}</summary>` +
    (fill ? testGroupBodyHtml(group, metricNames, soloTest, drills) : '') +
    `</details>`
  );
}

/** The drill-down row id for Route `index` of the variant `idPrefix`. */
export function drillId(idPrefix: string, index: number): string {
  return `drill-${idPrefix}-${index}`;
}

/** The inside of one Route's drill-down row: blend note, histograms, the
 *  Test → Engine → Navigation groups (each level lazy in 'lazy' mode). */
export function drillContentHtml(route: RouteView, metricNames: string[], drills: DrillMode = 'eager'): string {
  const blendNote = route.blended
    ? `<p class="blend-note">${escapeHtml(`${route.testCount} ${S.testsWord} — ${S.blendCaveat}`)}</p>`
    : '';
  const histos =
    route.histograms.length > 0
      ? `<section><h3>${escapeHtml(S.distributionsHeading)}</h3><div class="histo-grid">` +
        route.histograms.map(histogramHtml).join('') +
        `</div></section>`
      : '';
  const soloTest = route.tests.length === 1;
  const tests =
    `<section><h3>${escapeHtml(S.testsHeading)}</h3>` +
    route.tests.map((group, i) => testGroupHtml(group, metricNames, soloTest, drills, i)).join('') +
    `</section>`;
  return blendNote + histos + tests;
}

function drillHtml(
  route: RouteView,
  metricNames: string[],
  idPrefix: string,
  index: number,
  colSpan: number,
  drills: DrillMode,
): string {
  const lazy = drills === 'lazy';
  return (
    `<tr id="${drillId(idPrefix, index)}" class="drill"${lazy ? ' data-lazy=""' : ''} hidden>` +
    `<td colspan="${colSpan}">${lazy ? '' : drillContentHtml(route, metricNames, drills)}</td></tr>`
  );
}

// ----------------------------------------------------------- landing table

function routeRowHtml(route: RouteView, idPrefix: string, index: number): string {
  const coldFlag =
    route.coldStarts !== null && route.coldStarts > 0
      ? `<span class="flag cold">${route.coldStarts} ${escapeHtml(S.coldStartsSuffix)}</span>`
      : ''; // null renders as NOTHING — unidentifiable is not zero
  const blendFlag = route.blended
    ? `<span class="flag blend" title="${escapeHtml(S.blendCaveat)}">${escapeHtml(
        S.blendedFlag,
      )} · ${route.testCount} ${escapeHtml(S.testsHeading)}</span>`
    : '';
  // Flags sit on their own line under the Route so they never widen the column.
  const flags = coldFlag || blendFlag ? `<div class="flags">${coldFlag}${blendFlag}</div>` : '';
  return (
    `<tr class="route-row">` +
    `<td class="route-col">` +
    `<button class="expand" aria-expanded="false" aria-controls="drill-${idPrefix}-${index}" title="${escapeHtml(
      S.expandHint,
    )}">▸</button>` +
    `<code>${escapeHtml(route.route)}</code>${flags}` +
    `</td>` +
    `<td class="num samples">${route.sampleCount}</td>` +
    route.cells.map(metricCellHtml).join('') +
    `</tr>`
  );
}

function routeTableHtml(view: ReportView, idPrefix: string, drills: DrillMode): string {
  if (view.totalSamples === 0) {
    return `<p class="no-samples">${escapeHtml(S.noSamples)}</p>`;
  }
  const colSpan = 2 + view.metricNames.length;
  const head =
    `<tr><th class="route-col">${escapeHtml(S.routeColumn)}</th>` +
    `<th class="num">${escapeHtml(S.samplesColumn)}</th>` +
    view.metricNames.map((n) => `<th class="num">${escapeHtml(metricHeading(n))}</th>`).join('') +
    `</tr>`;
  const body = view.routes
    .map(
      (route, i) =>
        routeRowHtml(route, idPrefix, i) +
        drillHtml(route, view.metricNames, idPrefix, i, colSpan, drills),
    )
    .join('');
  return (
    `<div class="table-scroll"><table class="routes"><thead>${head}</thead>` +
    `<tbody>${body}</tbody></table></div>` +
    `<p class="note">${escapeHtml(S.thresholdNote)} · ${escapeHtml(S.coverageNote)} · ${escapeHtml(S.percentileNote)}</p>`
  );
}

// -------------------------------------- outcome breakdown + the toggle (#9)

/** The breakdown line — "4 of 50 Executions failed" — next to the numbers the
 *  include/exclude choice changes. When outcome-awareness is unavailable it
 *  SAYS SO in words; it never implies all-passed. */
function outcomeLineText(summary: OutcomeSummary): string {
  if (!summary.aware) return S.outcomesUnavailable;
  const c = summary.counts;
  // The itemization of the FAILED head-count only; skipped is not a failure
  // and is appended separately so it never reads as part of the head-count.
  const parts: string[] = [];
  if (c['failed']) parts.push(`${c['failed']} ${S.failedWord}`);
  if (c['timedOut']) parts.push(`${c['timedOut']} ${S.timedOutWord}`);
  if (c['crashed']) parts.push(`${c['crashed']} ${S.outcomeCrashedBeforeFinishing}`);
  const skippedSuffix = c['skipped'] ? ` (${S.andWord} ${c['skipped']} ${S.skippedWord})` : '';
  if (summary.excludable > 0) {
    const head = `${summary.excludable} ${S.ofWord} ${summary.total} ${S.executionsWord} ${S.failedWord}`;
    const onlyPlainFailed = parts.length === 1 && (c['failed'] ?? 0) === summary.excludable;
    return (onlyPlainFailed ? head : `${head} — ${parts.join(' · ')}`) + skippedSuffix;
  }
  if (c['skipped']) {
    return `${c['passed'] ?? 0} ${S.ofWord} ${summary.total} ${S.executionsWord} ${S.passedWord} — ${c['skipped']} ${S.skippedWord}`;
  }
  return `all ${summary.total} ${S.executionsWord} ${S.passedWord}`;
}

/** The visible control. Include is the DEFAULT (checked). When there is
 *  nothing to exclude the toggle is disabled WITH the reason stated — never
 *  silently missing. */
function toggleHtml(outcomes: OutcomeSummary, enabled: boolean): string {
  const reason = enabled
    ? null
    : outcomes.aware
      ? S.toggleDisabledNothingExcludable
      : S.toggleDisabledNoOutcomes;
  return (
    `<label class="toggle${enabled ? '' : ' disabled'}">` +
    `<input type="checkbox" id="bzm-include-failed" checked${enabled ? '' : ' disabled'}> ` +
    `${escapeHtml(S.includeFailedToggle)}</label>` +
    (reason === null ? '' : `<span class="toggle-reason">${escapeHtml(reason)}</span>`)
  );
}

/** "aggregates cover 3 of 4 Engines — 1 no artifact": stated whenever an
 *  Engine emitted no zip, so a degraded run never reads as a clean one. */
function subsetNoteHtml(view: ReportView): string {
  if (view.enginesWithArtifact >= view.engineCount) return '';
  const missing = view.engineCount - view.enginesWithArtifact;
  return `<span class="subset-note">${escapeHtml(
    `${S.subsetCovers} ${view.enginesWithArtifact} ${S.ofWord} ${view.engineCount} ${S.enginesHeading} — ${missing} ${S.noArtifact}`,
  )}</span>`;
}

/** The strip under the Routes heading: breakdown line, toggle, subset note —
 *  the choice sits visibly next to the numbers it changes. */
function outcomeStripHtml(outcomes: OutcomeSummary, included: ReportView, enabled: boolean): string {
  return (
    `<div class="outcomes">` +
    `<span class="outcome-line">${escapeHtml(outcomeLineText(outcomes))}</span>` +
    toggleHtml(outcomes, enabled) +
    subsetNoteHtml(included) +
    `</div>`
  );
}

/** The time zone the timeline reads in (`tz`: the viewer's local zone, or
 *  UTC by the toggle) and the viewer's own zone (`localTz`, named beside the
 *  toggle). Node renders UTC unless told otherwise. */
export interface ZoneChoice {
  tz: string;
  localTz: string;
}
const UTC_ZONE: ZoneChoice = { tz: UTC, localTz: UTC };

/** One variant: Route table + timeline. The excluded one opens by restating
 *  what it dropped, with the honest denominator. */
export function variantHtml(
  view: ReportView,
  idPrefix: string,
  note: string | null,
  drills: DrillMode,
  zone: ZoneChoice = UTC_ZONE,
): string {
  return (
    (note === null ? '' : `<p class="excluded-note">${escapeHtml(note)}</p>`) +
    routeTableHtml(view, idPrefix, drills) +
    timelineHtml(view, zone.tz, zone.localTz)
  );
}

/** The excluded variant's contents, for #bzm-variant-excluded. */
export function excludedVariantHtml(
  excluded: ReportView,
  included: ReportView,
  drills: DrillMode,
  zone: ZoneChoice = UTC_ZONE,
): string {
  const note = `${S.excludedNote} — ${excluded.totalSamples} ${S.ofWord} ${included.totalSamples} ${S.samplesWord}`;
  return variantHtml(excluded, 'exc', note, drills, zone);
}

export interface AppMarkupInput {
  outcomes: OutcomeSummary;
  included: ReportView;
  /** hasExcludedVariant(outcomes): the toggle is live. */
  toggleEnabled: boolean;
  /** The excluded view when already built; its container is emitted (hidden)
   *  whenever the toggle is live, and filled now only when this is given. */
  excluded?: ReportView | null;
  drills: DrillMode;
  /** The timeline's time zone; UTC when absent. */
  zone?: ZoneChoice;
}

/** The interactive report — what the browser puts in #bzm-app: the outcome
 *  strip with the toggle, the included variant, and the excluded variant's
 *  (hidden) container. With zero Samples there is no strip and no toggle: the
 *  "no samples" paragraph carries the section. */
export function appHtml(input: AppMarkupInput): string {
  const { outcomes, included, drills } = input;
  const zone = input.zone ?? UTC_ZONE;
  const withStrip = included.totalSamples > 0;
  const live = withStrip && input.toggleEnabled;
  const excluded = input.excluded ?? null;
  return (
    (withStrip ? outcomeStripHtml(outcomes, included, input.toggleEnabled) : '') +
    `<div id="bzm-variant-included">${variantHtml(included, 'inc', null, drills, zone)}</div>` +
    (live
      ? `<div id="bzm-variant-excluded" hidden>${
          excluded === null ? '' : excludedVariantHtml(excluded, included, drills, zone)
        }</div>`
      : '')
  );
}

// ------------------------------------------- the no-JS fallback (server only)

/** p75 (with its dot) and coverage — the summary cell, no p50/p95 line. */
function summaryCellHtml(cell: MetricCell): string {
  const coverage = `<div class="coverage">${escapeHtml(`${cell.ok} ${S.ofWord} ${cell.total}`)}</div>`;
  if (cell.ok === 0 || cell.p75 === null) {
    const reason = reasonLabel(cell.reason ?? 'invalid');
    return `<td class="metric"><div class="lead reason">${escapeHtml(reason)}</div>${coverage}</td>`;
  }
  return (
    `<td class="metric"><div class="lead">${dotHtml(cell)}<span class="p75">${escapeHtml(
      fmtValue(cell.metric, cell.p75),
    )}</span></div>${coverage}</td>`
  );
}

/** The fallback summary the server renders into the page, so the Report still
 *  says something when JavaScript is off or fails: the Route table at p75,
 *  with coverage under every value. The browser replaces it on load. */
export function routeSummaryHtml(summary: RouteSummaryView): string {
  if (summary.totalSamples === 0) {
    return `<p class="no-samples">${escapeHtml(S.noSamples)}</p>`;
  }
  const head =
    `<tr><th class="route-col">${escapeHtml(S.routeColumn)}</th>` +
    `<th class="num">${escapeHtml(S.samplesColumn)}</th>` +
    summary.metricNames
      .map((n) => `<th class="num">${escapeHtml(`${metricHeading(n)} ${S.p75}`)}</th>`)
      .join('') +
    `</tr>`;
  const body = summary.routes
    .map(
      (route) =>
        `<tr class="route-row"><td class="route-col"><code>${escapeHtml(route.route)}</code></td>` +
        `<td class="num samples">${route.sampleCount}</td>` +
        route.cells.map(summaryCellHtml).join('') +
        `</tr>`,
    )
    .join('');
  return (
    `<div class="table-scroll"><table class="routes summary"><thead>${head}</thead>` +
    `<tbody>${body}</tbody></table></div>` +
    `<p class="note">${escapeHtml(S.thresholdNote)} · ${escapeHtml(S.coverageNote)} · ${escapeHtml(S.percentileNote)}</p>`
  );
}

/** The Engines list — static, server-rendered: it reads the sessions only. */
export function enginesHtml(sessions: SessionSummary[]): string {
  const items = sessions
    .map((session) => {
      const line =
        session.artifact === 'present'
          ? `${session.engineLabel} — ${nSamples(session.sampleCount)}`
          : `${session.engineLabel} — ${S.noArtifact}`;
      const unreadable =
        session.unreadable.length > 0
          ? ` (${session.unreadable.length} ${S.unreadableWord})`
          : '';
      return `<li${session.artifact === 'present' ? '' : ' class="no-artifact"'} title="${escapeHtml(
        session.sessionId,
      )}" data-session-id="${escapeHtml(session.sessionId)}">${escapeHtml(line + unreadable)}</li>`;
    })
    .join('');
  return `<section><h2>${escapeHtml(S.enginesHeading)}</h2><ul class="engines">${items}</ul></section>`;
}

/** "n Samples · k Engines" for the header line. */
export function sampleEngineCountText(totalSamples: number, engineCount: number): string {
  return `${nSamples(totalSamples)} · ${engineCount} ${engineCount === 1 ? S.engineWord : S.enginesHeading}`;
}
