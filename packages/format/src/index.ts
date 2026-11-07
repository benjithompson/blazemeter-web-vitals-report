/**
 * Format v1 — the on-disk record contract. See SPEC.md → "The record format — the spine".
 *
 * Two record types: the per-Navigation Sample and the per-Execution Outcome.
 * The record carries only what the Test knows; masterId/sessionId/locationId are
 * stamped by the dashboard at fetch time (an Attributed Sample is the dashboard's
 * own type, not part of this contract).
 *
 * Metric NAMES are open — the dashboard renders what it knows and ignores what it
 * doesn't. Metric STATUS is closed — anything unrecognized is treated as not-ok.
 */

export const SCHEMA_VERSION = 1 as const;

/**
 * Attachment-name prefixes. Discovery is by prefix: the artifacts zip is flat
 * (no entry contains a `/`), so a directory can never be the handle — the name
 * is the only discriminator. Keep these distinctive and stable.
 */
export const SAMPLE_ATTACHMENT_PREFIX = 'bzm-vitals-sample';
export const OUTCOME_ATTACHMENT_PREFIX = 'bzm-vitals-outcome';

/**
 * The closed Metric status vocabulary — the ONE runtime definition; the type derives from it.
 * `unknown` is the legacy adapter's alone — the collector never writes it.
 */
export const METRIC_STATUSES = [
  'ok',
  'unsupported',
  'no-interaction',
  'not-finalized',
  'error',
  'unknown',
] as const;

export type MetricStatus = (typeof METRIC_STATUSES)[number];

/**
 * The subset of METRIC_STATUSES the collector may write: everything except the legacy
 * adapter's `unknown`. Anything the page reports outside this set is recorded as `error`.
 */
export const COLLECTOR_METRIC_STATUSES = [
  'ok',
  'unsupported',
  'no-interaction',
  'not-finalized',
  'error',
] as const satisfies readonly MetricStatus[];

export type CollectorMetricStatus = (typeof COLLECTOR_METRIC_STATUSES)[number];

/** Is `x` a member of the closed Metric status vocabulary? */
export function isMetricStatus(x: unknown): x is MetricStatus {
  return (METRIC_STATUSES as readonly unknown[]).includes(x);
}

/** Is `x` a status the collector may write (the closed vocabulary minus `unknown`)? */
export function isCollectorMetricStatus(x: unknown): x is CollectorMetricStatus {
  return (COLLECTOR_METRIC_STATUSES as readonly unknown[]).includes(x);
}

export interface Metric {
  /** CLS is a true float; any integer-valued consumer converts at its own boundary. */
  value: number | null;
  status: MetricStatus;
}

/** The unit of authorship: file + title + project, plus the per-Execution discriminators. */
export interface TestIdentity {
  file: string;
  title: string;
  project: string;
  /** Sample discriminator, not a correlation key — Engine A's repeat1 vs Engine B's repeat1 is meaningless. */
  repeat: number;
  /** Never an aggregation dimension, but not discardable: it identifies Cold Starts. */
  worker: number;
}

/** One per Navigation, ~450 B, written to outputPath() then attach({ path }). */
export interface Sample {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Epoch ms at Navigation start — not ISO, not write time, exactly one timestamp. */
  ts: number;
  /** The raw address exactly as navigated. Always recorded, never discarded. */
  url: string;
  /** Declared via vitals.route(). Optional; a declared Route always wins over a derived one. */
  route?: string;
  test: TestIdentity;
  navigationIndex: number;
  /** Names open, status closed. */
  vitals: Record<string, Metric>;
  navigation: {
    domContentLoadedMs: number | null;
    loadEventMs: number | null;
  };
  context: {
    /** The DERIVED per-Engine worker count, never config.yml's declared concurrency. */
    workers: number | null;
    resourceCount: number | null;
    requestCount: number | null;
    failedRequests: number | null;
  };
}

/**
 * The Outcome record's closed status vocabulary — the ONE runtime definition. Playwright's
 * testInfo.status can also be 'interrupted' or undefined: Executions that never finished,
 * which leave NO Outcome by design.
 */
export const EXECUTION_STATUSES = ['passed', 'failed', 'timedOut', 'skipped'] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Is `x` a member of the closed ExecutionStatus vocabulary? */
export function isExecutionStatus(x: unknown): x is ExecutionStatus {
  return (EXECUTION_STATUSES as readonly unknown[]).includes(x);
}

/**
 * One per Execution, attached in afterEach. Joins to Samples on (repeat, worker).
 * A MISSING outcome record means the Execution crashed before finishing — that
 * absence is a signal, never papered over.
 */
export interface ExecutionOutcome {
  schemaVersion: typeof SCHEMA_VERSION;
  test: TestIdentity;
  status: ExecutionStatus;
  retry: number;
}

/**
 * Derive the Route for a record — the ONE routing rule, shared by the collector's live
 * sinks and the dashboard's file report so a Route is computed identically wherever it
 * lands. A declared Route always wins, verbatim; otherwise the URL's pathname, with a
 * hand-rolled query/fragment strip for addresses the URL parser rejects. The raw URL is
 * never altered — this only computes the grouping key.
 *
 * Structural on purpose: it reads only `route` and `url`, so the format Sample and the
 * dashboard's widened DashboardSample both satisfy it.
 */
export function routeOf(record: { readonly route?: string; readonly url: string }): string {
  if (record.route !== undefined) return record.route;
  try {
    return new URL(record.url).pathname;
  } catch {
    // Not URL-parseable — strip query/fragment by hand and keep the rest.
    return record.url.split(/[?#]/, 1)[0]!;
  }
}
