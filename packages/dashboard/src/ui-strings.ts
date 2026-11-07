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
  reportLink: 'open Report in BlazeMeter',
  reportWord: 'Report',
  generated: 'generated',
  importedFrom: 'imported from',
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
  percentileNote: 'percentiles: lower method (NumPy method="lower"), always an observed value',
  noSamples: 'no samples — this Report carried no vitals records',
  coldStartsSuffix: 'Cold Starts',
  coldStartFlag: 'Cold Start',
  blendedFlag: 'blended',
  p50: 'p50',
  p75: 'p75',
  p95: 'p95',
  notCarried: 'not carried',
  ofWord: 'of',
  testsWord: 'Tests',

  // Outcome words (the breakdown line and per-Navigation flags)
  passedWord: 'passed',
  failedWord: 'failed',
  timedOutWord: 'timed out',
  skippedWord: 'skipped',
  andWord: 'and',

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
  unknownLegacy: 'unknown — legacy collector cannot say why',
  binTooltipSuffix: 'Samples',
  histogramEmptyNote: 'distribution over measured Samples in this Route',

  // Outcome breakdown + the include-failed toggle. Include is the
  // DEFAULT: excluding failed Executions deletes exactly the slowest Samples
  // (the real failures were CWV budget breaches), flattering every percentile.
  executionsWord: 'Executions',
  outcomesUnavailable: 'outcome records unavailable — legacy collector',
  outcomeCrashedBeforeFinishing: 'crashed before finishing',
  includeFailedToggle: 'include failed Executions',
  toggleDisabledNoOutcomes: 'cannot exclude — outcome records unavailable',
  toggleDisabledNothingExcludable: 'nothing to exclude — no Execution failed',
  excludedNote: 'failed Executions excluded',
  subsetCovers: 'aggregates cover',

  // Timeline — vitals over the run's wall-clock (below the Route table). The
  // times read in the viewer's local time zone by default, or in UTC by the
  // toggle; the zone in force is named beside the toggle and on the axis.
  timelineHeading: 'Timeline',
  timelineNote:
    'one point per measured Sample, at absolute wall-clock time — Samples with nothing measured are not plotted',
  timelineChartAria: 'measured Samples over wall-clock time',
  unitlessWord: 'unitless',
  fromWord: 'from',
  toWord: 'to',
  tzShownLocal: 'times in your local time zone:',
  tzShownUtc: 'times in UTC',
  tzUtcToggle: 'show times in UTC',
  // An Engine's Navigation rows arrive in steps: "show 500 more of 12000 Navigations".
  showWord: 'show',
  moreOfWord: 'more of',

  // The in-browser render and its fallback — the Route table at p75 with
  // coverage, server-rendered, shown whenever the interactive report is not.
  loadingNote: 'building the interactive report from the embedded data…',
  noscriptNote:
    'JavaScript is off: this is the p75 summary only. The include-failed toggle, the drill-downs and the timeline need JavaScript.',
  noDecompressionNote:
    'this browser cannot unpack the embedded data (it has no DecompressionStream) — showing the p75 summary only. Any current Chrome, Edge, Firefox or Safari can.',
  renderFailedNote: 'the interactive report failed to load — showing the p75 summary only:',
} as const;

export type UiStringKey = keyof typeof UI_STRINGS;
