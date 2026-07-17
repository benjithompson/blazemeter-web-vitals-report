// Every human-facing label the renderer emits, in one exported map — so the
// vocabulary contract (CONTEXT.md) is assertable: "Page" is banned outright
// (ambiguous between URL and Route), Worker is never offered as a dimension,
// and the UI speaks Report / Route / Test / Engine / Navigation / Sample /
// Coverage / Cold Start. The renderer takes its words from here, nowhere else.
//
// Data values (URLs, file names, statuses) are not UI strings and are rendered
// verbatim — the ban is on labels, not on data.

export const UI_STRINGS = {
  // Header
  title: 'Web Vitals — Report',
  generated: 'generated',
  labData: 'lab data',

  // Engines list
  enginesHeading: 'Engines',
  engineWord: 'Engine',
  samplesWord: 'Samples',
  sampleWord: 'Sample',
  noArtifact: 'no artifact',
  unreadableWord: 'unreadable',

  // Landing table
  routesHeading: 'Routes',
  routeColumn: 'Route',
  samplesColumn: 'Samples',
  thresholdNote: 'threshold dots: web.dev Core Web Vitals bands, applied to p75 only',
  coverageNote: 'Coverage under every value: measured Samples of the pool',
  noSamples: 'no samples — this Report carried no vitals records',
  coldStartsSuffix: 'Cold Starts',
  coldStartFlag: 'Cold Start',
  blendedFlag: 'blended',
  p50: 'p50',
  p75: 'p75',
  p95: 'p95',
  notCarried: 'not carried',
  ofWord: 'of',

  // Threshold band names (beside the dot for screen readers / tooltips)
  bandGood: 'good',
  bandNeedsImprovement: 'needs improvement',
  bandPoor: 'poor',

  // Drill-down: Report → Route → Test → Engine → Navigation
  expandHint: 'drill into this Route',
  blendCaveat:
    'pooled Route — its Samples come from more than one Test, so this number blends whatever journeys hit it and moves when a Test is added. The split by Test is below.',
  distributionsHeading: 'Distributions',
  testsHeading: 'Tests',
  legacyTestGroup: '(no test identity — legacy collector)',
  engineSpreadHeading: 'Engine spread — p75 by Engine, shown, never adjudicated',
  navigationsHeading: 'Navigations',
  timeColumn: 'time (UTC)',
  urlColumn: 'URL',
  outcomeColumn: 'Execution',
  outcomeUnavailable: 'outcome unavailable',
  outcomeCrashed: 'crashed',
  binTooltipSuffix: 'Samples',
  histogramEmptyNote: 'distribution over measured Samples in this Route',

  // Timeline — vitals over the run's wall-clock (below the Route table)
  timelineHeading: 'Timeline',
  timelineNote:
    'one point per measured Sample, at absolute wall-clock time (UTC) — Samples with nothing measured are not plotted',
  timelineChartAria: 'measured Samples over wall-clock time (UTC)',
  unitlessWord: 'unitless',
} as const;

export type UiStringKey = keyof typeof UI_STRINGS;
