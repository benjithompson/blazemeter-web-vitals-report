/**
 * Format v1 — the on-disk record contract. See SPEC.md → "The record format — the spine".
 *
 * Two record types: the per-Navigation Sample and the per-Execution Outcome.
 * The record carries only what the Test knows; masterId/sessionId/locationId are
 * stamped by the dashboard at fetch time (an Attributed Sample is the dashboard's
 * own type, not part of this contract).
 *
 * Metric NAMES are open — the dashboard renders what it knows and ignores what it
 * doesn't. Metric STATUS is closed — validateSample rejects a status outside
 * METRIC_STATUSES (a new status is a schemaVersion change), and aggregation treats
 * every status but 'ok' as not-ok.
 *
 * Every field below that is marked optional is ADDITIVE: a record without it is still a
 * valid format-v1 record (collector 0.2.x wrote none of them), so none of them bumps
 * SCHEMA_VERSION. validateSample / validateOutcome are the one runtime definition of a
 * valid record; schema/sample.v1.json and schema/outcome.v1.json mirror them for other
 * tools and are tested to agree with them.
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
  /** The spec file's basename. Kept exactly as 0.2.x wrote it; `path` disambiguates. */
  file: string;
  /** The test's own title (not its describe chain). Kept as 0.2.x wrote it; `titlePath` disambiguates. */
  title: string;
  project: string;
  /** Sample discriminator, not a correlation key — Engine A's repeat1 vs Engine B's repeat1 is meaningless. */
  repeat: number;
  /** Never an aggregation dimension, but not discardable: it identifies Cold Starts. */
  worker: number;
  /**
   * Optional (additive): Playwright's `testInfo.testId` — stable across file, title path
   * and project, and unique per Test. Absent on records from collector 0.2.x; a reader
   * falls back to (file, title, project) when it is.
   */
  id?: string;
  /** Optional (additive): `testInfo.titlePath` without its leading file element — the describe chain plus the title. */
  titlePath?: string[];
  /** Optional (additive): the spec path relative to the project's testDir, with POSIX separators. */
  path?: string;
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
  /**
   * Optional (additive): which page of the browser context the Navigation happened on —
   * 0 for the test's own `page`, then popups and `context.newPage()` pages in the order
   * they opened. Absent means the test's own page (all a 0.2.x collector measured).
   */
  pageIndex?: number;
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
 * One per Execution, written in fixture teardown, where testInfo.status is final. A
 * reader joins it to its Samples within one Engine (sessionId) on the Test, `repeat` and
 * `worker`, where the Test is `test.id` when the record carries one and the
 * (file, title, project) triple otherwise. A MISSING outcome record means the Execution
 * crashed before finishing — that absence is a signal, never papered over.
 */
export interface ExecutionOutcome {
  schemaVersion: typeof SCHEMA_VERSION;
  test: TestIdentity;
  status: ExecutionStatus;
  retry: number;
  /**
   * Optional (additive): main-frame Navigations the collector saw commit but could not
   * write a Sample for. Absent means none were detected (or the collector predates the
   * check) — never read absence as a guarantee of zero loss on old records.
   */
  lostNavigations?: number;
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

// ---------------------------------------------------------------------------
// Validation — the ONE runtime definition of a valid format-v1 record, shared by
// every reader (the dashboard's parser) and available to every writer. Hand-rolled
// and dependency-free on purpose. schema/sample.v1.json and schema/outcome.v1.json
// say the same thing in JSON Schema 2020-12; test/conformance.test.ts holds the two
// to agreement on every fixture and every hand-written invalid case, so a rule
// changed here without the schema (or the reverse) is a red test.
//
// The rules:
//   - Unknown FIELDS are allowed everywhere (additive, forward-compatible), and the
//     record is returned as-is — never rebuilt, so they ride along untouched.
//   - Metric NAMES are open; every `vitals` entry is {value: number|null, status},
//     status ∈ METRIC_STATUSES, and value is a number when status is 'ok' and null
//     otherwise (a value survives only when it was measured).
//   - `navigation` entries are number|null; `context` entries and every counter
//     (repeat, worker, navigationIndex, retry, pageIndex, lostNavigations) are
//     non-negative integers (context ones may be null).
//   - An optional field that is present must have its documented type.
// ---------------------------------------------------------------------------

/** The result of validating one record: the record itself, or the first reason it is invalid. */
export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

type Rec = Record<string, unknown>;
type Rule = (v: unknown) => boolean;

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function has(rec: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key) && rec[key] !== undefined;
}

/** A bad value, rendered for a reason string — bounded so a huge blob cannot flood a report. */
function show(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

const isNumber: Rule = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumberOrNull: Rule = (v) => v === null || isNumber(v);
const isCount: Rule = (v) => Number.isInteger(v) && (v as number) >= 0;
const isCountOrNull: Rule = (v) => v === null || isCount(v);
const isString: Rule = (v) => typeof v === 'string';
const isStringArray: Rule = (v) => Array.isArray(v) && v.every((e) => typeof e === 'string');

/** A required field: missing, or present with the wrong type, is a reason. */
function required(rec: Rec, key: string, at: string, rule: Rule, what: string): string | null {
  const path = `${at}${key}`;
  if (!has(rec, key)) return `${path} is missing (expected ${what})`;
  return rule(rec[key]) ? null : `${path} must be ${what}, got ${show(rec[key])}`;
}

/** An optional (additive) field: absent is fine; present with the wrong type is a reason. */
function optional(rec: Rec, key: string, at: string, rule: Rule, what: string): string | null {
  if (!has(rec, key)) return null;
  return rule(rec[key]) ? null : `${at}${key} must be ${what} when present, got ${show(rec[key])}`;
}

function first(...reasons: Array<() => string | null>): string | null {
  for (const r of reasons) {
    const reason = r();
    if (reason !== null) return reason;
  }
  return null;
}

function schemaVersionReason(rec: Rec): string | null {
  return rec.schemaVersion === SCHEMA_VERSION
    ? null
    : `schemaVersion ${show(rec.schemaVersion)} is not the supported version ${SCHEMA_VERSION} — rejected, not misread`;
}

const COUNT = 'a non-negative integer';

function testIdentityReason(rec: Rec): string | null {
  if (!has(rec, 'test')) return 'test is missing — a record cannot be attributed to a Test without its identity';
  const test = rec.test;
  if (!isRecord(test)) return `test must be an object (the test identity), got ${show(test)}`;
  const at = 'test.';
  return first(
    () => required(test, 'file', at, isString, 'a string'),
    () => required(test, 'title', at, isString, 'a string'),
    () => required(test, 'project', at, isString, 'a string'),
    () => required(test, 'repeat', at, isCount, COUNT),
    () => required(test, 'worker', at, isCount, COUNT),
    () => optional(test, 'id', at, isString, 'a string'),
    () => optional(test, 'titlePath', at, isStringArray, 'an array of strings'),
    () => optional(test, 'path', at, isString, 'a string'),
  );
}

function metricReason(m: unknown, at: string): string | null {
  if (!isRecord(m)) return `${at} must be an object {value, status}, got ${show(m)}`;
  const shape = first(
    () => required(m, 'value', `${at}.`, isNumberOrNull, 'a number or null'),
    () =>
      isMetricStatus(m.status)
        ? null
        : `${at}.status ${show(m.status)} is not in the closed Metric status vocabulary (${METRIC_STATUSES.join(', ')}) — rejected, not misread`,
  );
  if (shape !== null) return shape;
  if (m.status === 'ok') {
    return m.value === null ? `${at}.value must be a number when status is 'ok', got null` : null;
  }
  return m.value === null
    ? null
    : `${at}.value must be null when status is '${String(m.status)}' (a value survives only when measured), got ${show(m.value)}`;
}

function sectionReason(rec: Rec, key: string, fields: readonly string[], rule: Rule, what: string): string | null {
  if (!has(rec, key)) return `${key} is missing`;
  const section = rec[key];
  if (!isRecord(section)) return `${key} must be an object, got ${show(section)}`;
  return first(...fields.map((f) => () => required(section, f, `${key}.`, rule, what)));
}

/**
 * Validate one Sample. Returns the SAME object (never a rebuilt copy) when valid, so
 * unknown fields and unknown metric names survive; otherwise the first reason it is not
 * a valid format-v1 Sample, naming the offending field path.
 */
export function validateSample(x: unknown): Validation<Sample> {
  if (!isRecord(x)) return { ok: false, reason: 'not a JSON object' };
  const reason = first(
    () => schemaVersionReason(x),
    () => required(x, 'ts', '', isNumber, 'a number (epoch ms at Navigation start)'),
    () => required(x, 'url', '', isString, 'a string'),
    () => optional(x, 'route', '', isString, 'a string'),
    () => testIdentityReason(x),
    () => required(x, 'navigationIndex', '', isCount, COUNT),
    () => optional(x, 'pageIndex', '', isCount, COUNT),
    () => {
      if (!has(x, 'vitals')) return 'vitals is missing (expected a map of name → {value, status})';
      const vitals = x.vitals;
      if (!isRecord(vitals)) return `vitals must be an object (a map of name → {value, status}), got ${show(vitals)}`;
      for (const [name, m] of Object.entries(vitals)) {
        const r = metricReason(m, `vitals.${name}`);
        if (r !== null) return r;
      }
      return null;
    },
    () => sectionReason(x, 'navigation', ['domContentLoadedMs', 'loadEventMs'], isNumberOrNull, 'a number or null'),
    () =>
      sectionReason(
        x,
        'context',
        ['workers', 'resourceCount', 'requestCount', 'failedRequests'],
        isCountOrNull,
        'a non-negative integer or null',
      ),
  );
  return reason === null ? { ok: true, value: x as unknown as Sample } : { ok: false, reason };
}

/**
 * Validate one Execution Outcome. Same discipline as validateSample: the same object
 * back when valid, otherwise the first reason. The test identity is the join key and the
 * status drives crashed-detection, so neither is ever accepted half-formed.
 */
export function validateOutcome(x: unknown): Validation<ExecutionOutcome> {
  if (!isRecord(x)) return { ok: false, reason: 'not a JSON object' };
  const reason = first(
    () => schemaVersionReason(x),
    () => testIdentityReason(x),
    () =>
      isExecutionStatus(x.status)
        ? null
        : `status ${show(x.status)} is not in the closed ExecutionStatus vocabulary (${EXECUTION_STATUSES.join(', ')}) — rejected, not misread`,
    () => required(x, 'retry', '', isCount, COUNT),
    () => optional(x, 'lostNavigations', '', isCount, COUNT),
  );
  return reason === null ? { ok: true, value: x as unknown as ExecutionOutcome } : { ok: false, reason };
}
