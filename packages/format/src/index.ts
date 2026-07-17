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

export const SCHEMA_VERSION = 1;

/**
 * Attachment-name prefixes. Discovery is by prefix: the artifacts zip is flat
 * (no entry contains a `/`), so a directory can never be the handle — the name
 * is the only discriminator. Keep these distinctive and stable.
 */
export const SAMPLE_ATTACHMENT_PREFIX = 'bzm-vitals-sample';
export const OUTCOME_ATTACHMENT_PREFIX = 'bzm-vitals-outcome';

/** Closed vocabulary. `unknown` is the legacy adapter's alone — the collector never writes it. */
export type MetricStatus =
  | 'ok'
  | 'unsupported'
  | 'no-interaction'
  | 'not-finalized'
  | 'error'
  | 'unknown';

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

export type ExecutionStatus = 'passed' | 'failed' | 'timedOut' | 'skipped';

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
