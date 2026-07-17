// The emitter — ONE self-contained static HTML file.
//
// The data is embedded as a parseable JSON blob (<script type="application/json"
// id="bzm-vitals-data">). That blob is a PRODUCT requirement, not a test hook:
// the pre-signed dataUrl expires in 20 minutes, so the data must be baked in at
// build time for the artifact to be permanent. Seam 2 parses the blob back out.
//
// Hard rules, asserted on the emitted bytes by the tests:
//   - ZERO external requests: no <script src>, <link href>, <img src>, no
//     remote fetch/XHR — the file renders offline, in six months, unchanged;
//   - NO credentials and NO pre-signed URLs, ever;
//   - a Report with zero vitals says "no samples", never 0.
//
// Everything visible is rendered server-side from the PRECOMPUTED view model
// (view-model.ts): threshold dots (p75 only), groupings, blend caveats,
// histogram bins — all decided at build time, all unit-tested there. The one
// inline script toggles drill-down rows open and closed; it decides nothing.
//
// The look (dataviz skill): status colors carry the p75 threshold verdict and
// nothing else — good #0ca30c / needs-improvement #fab219 / poor #d03b3b, the
// same steps in both modes, always paired with a text label (title + visually
// hidden text), never color alone. Histograms are single-series (slot-1 blue),
// thin bars with 2px surface gaps and rounded data-ends, in drill-in only.
// Vocabulary (CONTEXT.md) comes from UI_STRINGS, nowhere else.

import type { ReportData } from './report.js';
import { UI_STRINGS as S } from './ui-strings.js';
import {
  buildView,
  xFraction,
  type EngineView,
  type HistogramView,
  type MetricCell,
  type NavigationView,
  type ReportView,
  type RouteView,
  type TestGroupView,
  type TimelineAxis,
  type TimelineChart,
  type TimelineView,
} from './view-model.js';
import type { ThresholdBand } from './thresholds.js';

export const DATA_BLOB_ID = 'bzm-vitals-data';

// --------------------------------------------------------------- utilities

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON for embedding inside a <script> element. Escaping every "<" as \\u003c
 * makes "</script>" (and "<!--") impossible in the payload while remaining
 * plain JSON — JSON.parse reads it back identically.
 */
function embedJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
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

/** "no-interaction" → "no interaction"; "not-carried" → the UI's phrasing. */
function reasonLabel(reason: string): string {
  if (reason === 'not-carried') return S.notCarried;
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
        `<path class="bar" d="${barPath(x, baselineY - h, barW, h)}">` +
        `<title>${escapeHtml(`${range} · ${bin.count} ${S.binTooltipSuffix}`)}</title></path>`
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

const TL_W = 860;
const TL_PL = 56; // left pad: y tick labels
const TL_PR = 14;
const TL_PT = 12; // top pad: p75 label headroom
const TL_PLOT_H = 120;
const TL_AXIS_H = 24;
const TL_H = TL_PT + TL_PLOT_H + TL_AXIS_H;

function tlX(axis: TimelineAxis, ts: number): number {
  return TL_PL + xFraction(axis, ts) * (TL_W - TL_PL - TL_PR);
}

function tlY(chart: TimelineChart, value: number): number {
  return TL_PT + (1 - value / chart.yMax) * TL_PLOT_H;
}

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

function slotClass(slot: number | undefined, multiEngine: boolean): string {
  if (!multiEngine || slot === undefined || slot === -1) return 'pt-mono';
  return `pt-s${slot}`;
}

/** A point marker: circle for a Sample, diamond for a Cold Start (a SHAPE, so
 *  the flag survives color-blindness and never depends on hue). null coldStart
 *  (legacy) draws a plain circle — the marker is never faked. */
function tlMarker(x: number, y: number, cls: string, coldStart: boolean, title: string): string {
  const t = `<title>${escapeHtml(title)}</title>`;
  const cx = x.toFixed(1);
  const cy = y.toFixed(1);
  if (coldStart) {
    const d = `M${cx},${(y - 6).toFixed(1)} L${(x + 6).toFixed(1)},${cy} L${cx},${(y + 6).toFixed(
      1,
    )} L${(x - 6).toFixed(1)},${cy} Z`;
    return `<path class="pt cold ${cls}" d="${d}">${t}</path>`;
  }
  return `<circle class="pt ${cls}" cx="${cx}" cy="${cy}" r="4">${t}</circle>`;
}

function timelineChartHtml(
  chart: TimelineChart,
  axis: TimelineAxis,
  slots: Map<string, number>,
  multiEngine: boolean,
): string {
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

  // Vertical gridlines + wall-clock tick labels; edge labels clamp inward so
  // nothing clips at the svg boundary.
  const xGrid = axis.ticks
    .map((tick) => {
      const x = tlX(axis, tick.ts);
      const anchor = x < TL_PL + 24 ? 'start' : x > plotRight - 24 ? 'end' : 'middle';
      return (
        `<line class="grid" x1="${x.toFixed(1)}" y1="${TL_PT}" x2="${x.toFixed(1)}" y2="${baselineY}"></line>` +
        `<text class="xlab" text-anchor="${anchor}" x="${x.toFixed(1)}" y="${baselineY + 15}">${escapeHtml(
          tick.label,
        )}</text>`
      );
    })
    .join('');

  // The run-level p75 reference line, labelled. The line sits UNDER the
  // points; the label is drawn last (over them) with a surface halo so it
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

  // N series through one loop; Cold Starts drawn last so the diamonds sit on
  // top of any overlapping circles.
  const plain: string[] = [];
  const cold: string[] = [];
  for (const series of chart.series) {
    for (const p of series.points) {
      const isCold = p.meta?.coldStart === true;
      const time = new Date(p.ts).toISOString().slice(11, 23);
      const title =
        `${time} UTC · ${fmtValue(chart.metric, p.value)}` +
        (p.meta?.engineLabel ? ` · ${p.meta.engineLabel}` : '') +
        (isCold ? ` · ${S.coldStartFlag}` : '') +
        (p.meta?.url ? `\n${p.meta.url}` : '');
      const marker = tlMarker(
        tlX(axis, p.ts),
        tlY(chart, p.value),
        slotClass(p.meta?.sessionId !== undefined ? slots.get(p.meta.sessionId) : undefined, multiEngine),
        isCold,
        title,
      );
      (isCold ? cold : plain).push(marker);
    }
  }

  const unit = chart.unit === 'unitless' ? S.unitlessWord : chart.unit;
  return (
    `<figure class="tl">` +
    `<figcaption>${escapeHtml(heading)} <span class="muted">${escapeHtml(
      `${unit} · ${coverage}`,
    )}</span></figcaption>` +
    `<svg viewBox="0 0 ${TL_W} ${TL_H}" role="img" aria-label="${escapeHtml(
      `${heading} — ${S.timelineChartAria}`,
    )}">` +
    yGrid +
    xGrid +
    `<line class="axisline" x1="${TL_PL}" y1="${baselineY}" x2="${plotRight}" y2="${baselineY}"></line>` +
    refLine +
    plain.join('') +
    cold.join('') +
    refLabel +
    `</svg>` +
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
      for (const p of series.points) if (p.meta?.sessionId !== undefined) contributing.add(p.meta.sessionId);
    }
  }
  const entries: string[] = [];
  if (view.multiEngine) {
    for (const session of view.sessions) {
      if (!contributing.has(session.sessionId)) continue;
      const cls = slotClass(slots.get(session.sessionId), true);
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

function timelineHtml(view: ReportView): string {
  const timeline = view.timeline;
  if (timeline.charts.length === 0) return ''; // zero Samples: the table already said so
  const slots = engineSlots(view);
  const charts = timeline.charts
    .map((chart) =>
      timeline.axis === null
        ? timelineChartHtml(chart, { minTs: 0, maxTs: 0, ticks: [] }, slots, view.multiEngine)
        : timelineChartHtml(chart, timeline.axis, slots, view.multiEngine),
    )
    .join('');
  return (
    `<section class="timeline">` +
    `<h2>${escapeHtml(S.timelineHeading)}<span class="badge">${escapeHtml(S.labData)}</span></h2>` +
    `<p class="note">${escapeHtml(S.timelineNote)}</p>` +
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
        ? `<span class="muted">passed</span>`
        : `<span class="flag bad">${escapeHtml(
            nav.executionStatus === 'crashed' ? S.outcomeCrashed : nav.executionStatus,
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

function engineHtml(engine: EngineView, metricNames: string[], soloEngine: boolean): string {
  const navHead =
    `<tr><th>${escapeHtml(S.timeColumn)}</th><th class="url">${escapeHtml(S.urlColumn)}</th>` +
    metricNames.map((n) => `<th class="num">${escapeHtml(metricHeading(n))}</th>`).join('') +
    `<th>${escapeHtml(S.outcomeColumn)}</th></tr>`;
  return (
    `<details class="engine" data-session-id="${escapeHtml(engine.sessionId)}"${
      soloEngine ? ' open' : ''
    }>` +
    `<summary><span class="engine-label" title="${escapeHtml(engine.sessionId)}">${escapeHtml(
      engine.engineLabel,
    )}</span> — ${escapeHtml(nSamples(engine.sampleCount))} · ${escapeHtml(
      S.navigationsHeading,
    )}</summary>` +
    `<div class="table-scroll"><table class="navs"><thead>${navHead}</thead><tbody>` +
    engine.navigations.map((nav) => navigationRowHtml(nav, metricNames)).join('') +
    `</tbody></table></div>` +
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
            const p75 = engine.p75s[n];
            return `<td class="num">${
              p75 === null || p75 === undefined ? '—' : escapeHtml(fmtValue(n, p75))
            }</td>`;
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

function testGroupHtml(group: TestGroupView, metricNames: string[], soloTest: boolean): string {
  const label = group.legacy ? S.legacyTestGroup : group.label;
  const soloEngine = soloTest && group.engines.length === 1;
  return (
    `<details class="test-group"${soloTest ? ' open' : ''}>` +
    `<summary>${escapeHtml(label)} — ${escapeHtml(nSamples(group.sampleCount))}</summary>` +
    engineSpreadHtml(group, metricNames) +
    group.engines.map((engine) => engineHtml(engine, metricNames, soloEngine)).join('') +
    `</details>`
  );
}

function drillHtml(route: RouteView, metricNames: string[], index: number, colSpan: number): string {
  const blendNote = route.blended
    ? `<p class="blend-note">${escapeHtml(`${route.testCount} Tests — ${S.blendCaveat}`)}</p>`
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
    route.tests.map((group) => testGroupHtml(group, metricNames, soloTest)).join('') +
    `</section>`;
  return (
    `<tr id="drill-${index}" class="drill" hidden><td colspan="${colSpan}">` +
    blendNote +
    histos +
    tests +
    `</td></tr>`
  );
}

// ----------------------------------------------------------- landing table

function routeRowHtml(route: RouteView, index: number): string {
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
    `<button class="expand" aria-expanded="false" aria-controls="drill-${index}" title="${escapeHtml(
      S.expandHint,
    )}">▸</button>` +
    `<code>${escapeHtml(route.route)}</code>${flags}` +
    `</td>` +
    `<td class="num samples">${route.sampleCount}</td>` +
    route.cells.map(metricCellHtml).join('') +
    `</tr>`
  );
}

function routeTableHtml(view: ReportView): string {
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
    .map((route, i) => routeRowHtml(route, i) + drillHtml(route, view.metricNames, i, colSpan))
    .join('');
  return (
    `<div class="table-scroll"><table class="routes"><thead>${head}</thead>` +
    `<tbody>${body}</tbody></table></div>` +
    `<p class="note">${escapeHtml(S.thresholdNote)} · ${escapeHtml(S.coverageNote)}</p>`
  );
}

function enginesHtml(view: ReportView): string {
  const items = view.sessions
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

// ------------------------------------------------------------ page chrome

// The one inline script: it toggles precomputed drill-down rows. It renders
// nothing and decides nothing — every dot, grouping, and bin was computed at
// build time and unit-tested in the view model.
const INLINE_SCRIPT = `
  document.querySelectorAll('button.expand').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = document.getElementById(btn.getAttribute('aria-controls'));
      if (!row) return;
      var opening = row.hasAttribute('hidden');
      if (opening) row.removeAttribute('hidden');
      else row.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', String(opening));
      btn.textContent = opening ? '\\u25BE' : '\\u25B8';
    });
  });
`;

// Palette: the dataviz reference instance — chart chrome/ink in both modes;
// status steps (good/warning/critical) are mode-invariant by design and are
// never used for anything but the p75 threshold verdict.
const STYLE = `
  :root {
    color-scheme: light dark;
    --page: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --band-good: #0ca30c; --band-ni: #fab219; --band-poor: #d03b3b;
    --cat-1: #2a78d6; --cat-2: #008300; --cat-3: #e87ba4; --cat-4: #eda100;
    --cat-5: #1baf7a; --cat-6: #eb6834; --cat-7: #4a3aa7; --cat-8: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --cat-1: #3987e5; --cat-2: #008300; --cat-3: #d55181; --cat-4: #c98500;
      --cat-5: #199e70; --cat-6: #d95926; --cat-7: #9085e9; --cat-8: #e66767;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0 auto; max-width: 76rem; padding: 1.5rem 1.25rem 3rem;
    background: var(--page); color: var(--ink); line-height: 1.45;
  }
  h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
  h3 { font-size: 0.95rem; margin: 1.1rem 0 0.5rem; }
  h4 { font-size: 0.85rem; margin: 0.9rem 0 0.35rem; color: var(--ink-2); font-weight: 600; }
  .meta { color: var(--ink-2); font-size: 0.85rem; margin: 0; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 600; color: var(--ink-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.55rem;
    vertical-align: 0.15rem; margin-left: 0.5rem; background: var(--surface);
  }
  .note { color: var(--muted); font-size: 0.75rem; }
  .muted { color: var(--muted); font-weight: normal; }

  ul.engines { list-style: none; padding: 0; margin: 0.25rem 0; font-size: 0.9rem; }
  ul.engines li { padding: 0.1rem 0; }
  ul.engines li.no-artifact { color: var(--band-poor); }

  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.9rem; }
  table.routes { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  th, td { padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { text-align: left; font-weight: 600; color: var(--ink-2); font-size: 0.78rem; }
  th.num, td.num, td.metric { text-align: right; }
  th.num { text-align: right; }
  td.num, td.metric, td.samples { font-variant-numeric: tabular-nums; }
  tbody tr:last-child > td { border-bottom: none; }
  td.route-col { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  td.route-col code { font-size: 0.9rem; }

  button.expand {
    font: inherit; color: var(--ink-2); background: none; border: none; cursor: pointer;
    padding: 0 0.4rem 0 0; margin: 0;
  }
  .flag {
    display: inline-block; font-family: system-ui, sans-serif; font-size: 0.68rem;
    color: var(--ink-2); border: 1px solid var(--border); border-radius: 999px;
    padding: 0 0.45rem; margin-left: 0.45rem; vertical-align: 0.1rem; white-space: nowrap;
  }
  .flag.bad { color: var(--band-poor); border-color: var(--band-poor); }
  td.route-col .flags { margin: 0.2rem 0 0 1.05rem; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  td.route-col .flags .flag { margin-left: 0; }

  td.metric .lead { font-size: 1.02rem; font-weight: 650; white-space: nowrap; }
  td.metric .lead.reason { font-weight: normal; font-size: 0.85rem; color: var(--muted); }
  td.metric .shape { font-size: 0.72rem; color: var(--ink-2); white-space: nowrap; }
  td.metric .coverage, td .coverage { font-size: 0.72rem; color: var(--muted); }
  .dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    margin-right: 0.4rem; vertical-align: 0.05rem;
  }
  .dot-good { background: var(--band-good); }
  .dot-needs-improvement { background: var(--band-ni); }
  .dot-poor { background: var(--band-poor); }

  tr.drill > td { background: var(--page); padding: 0.75rem 1rem 1.25rem; }
  .blend-note {
    font-size: 0.8rem; color: var(--ink-2); background: var(--surface);
    border: 1px solid var(--border); border-left: 3px solid var(--band-ni);
    border-radius: 4px; padding: 0.45rem 0.7rem; margin: 0.25rem 0 0.5rem;
  }
  .histo-grid { display: flex; flex-wrap: wrap; gap: 1.25rem; }
  figure.histo { margin: 0; }
  figure.histo figcaption { font-size: 0.78rem; font-weight: 600; color: var(--ink-2); margin-bottom: 0.2rem; }
  figure.histo svg { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px; }
  figure.histo .bar { fill: var(--series-1); }
  figure.histo .axis { fill: var(--baseline); }
  .histo-axis { display: flex; justify-content: space-between; font-size: 0.68rem; color: var(--muted); font-variant-numeric: tabular-nums; }

  details { margin: 0.4rem 0; }
  details > summary { cursor: pointer; font-size: 0.88rem; }
  details.test-group { border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.7rem; background: var(--surface); }
  details.engine { margin-left: 1rem; }
  details.engine > summary .engine-label { font-weight: 600; }
  table.navs, table.spread-table { background: var(--surface); font-size: 0.8rem; margin-top: 0.35rem; }
  table.navs td, table.navs th, table.spread-table td, table.spread-table th { padding: 0.3rem 0.6rem; }
  table.navs td.url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; max-width: 26rem; overflow-wrap: anywhere; }
  .spread { margin: 0.4rem 0 0.6rem; }

  .no-samples { font-size: 1.05rem; color: var(--band-poor); }

  section.timeline figure.tl { margin: 0 0 1.1rem; }
  .tl figcaption { font-size: 0.78rem; font-weight: 600; color: var(--ink-2); margin-bottom: 0.25rem; }
  .tl svg {
    display: block; width: 100%; max-width: ${TL_W}px; height: auto;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  .tl .grid { stroke: var(--grid); stroke-width: 1; }
  .tl .axisline { stroke: var(--baseline); stroke-width: 1; }
  .tl .ylab, .tl .xlab { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .tl .ylab { text-anchor: end; }
  .tl .ref { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 4 3; }
  .tl .reflab {
    fill: var(--ink-2); font-size: 10px; font-variant-numeric: tabular-nums;
    paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round;
  }
  .pt { stroke: var(--surface); stroke-width: 2; }
  .pt-mono { fill: var(--series-1); }
  .pt-s0 { fill: var(--cat-1); } .pt-s1 { fill: var(--cat-2); }
  .pt-s2 { fill: var(--cat-3); } .pt-s3 { fill: var(--cat-4); }
  .pt-s4 { fill: var(--cat-5); } .pt-s5 { fill: var(--cat-6); }
  .pt-s6 { fill: var(--cat-7); } .pt-s7 { fill: var(--cat-8); }
  .pt-legend-cold { fill: var(--ink-2); }
  .tl-legend {
    display: flex; flex-wrap: wrap; align-items: center; gap: 1rem;
    font-size: 0.75rem; color: var(--ink-2); margin: 0.35rem 0 0.85rem;
  }
  .tl-legend .key svg { vertical-align: -2px; }
  .tl-reason { font-size: 0.85rem; color: var(--muted); margin: 0.4rem 0 1rem; }
`;

/** Render the whole report as one self-contained HTML document. */
export function renderHtml(data: ReportData): string {
  const view = buildView(data);
  const engineCountLine =
    `${nSamples(view.totalSamples)}` +
    ` · ${view.engineCount} ${view.engineCount === 1 ? S.engineWord : S.enginesHeading}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${S.title} ${data.masterId}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(`${S.title} ${data.masterId}`)}</h1>
<p class="meta">${escapeHtml(`${S.generated} ${data.generatedAt} · ${engineCountLine}`)}</p>
</header>
${enginesHtml(view)}
<section>
<h2>${escapeHtml(S.routesHeading)}<span class="badge">${escapeHtml(S.labData)}</span></h2>
${routeTableHtml(view)}
</section>
${timelineHtml(view)}
<script type="application/json" id="${DATA_BLOB_ID}">${embedJson(data)}</script>
<script>${INLINE_SCRIPT}</script>
</body>
</html>
`;
}
