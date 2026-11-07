// The aggregation model — one module owning the model; the renderer
// consumes a plain data shape.
//
// The rules, all load-bearing (SPEC.md → "Aggregation semantics"):
//   - POOL Attributed Samples over sessionId and repeat; everything else is a
//     dimension. Percentiles are computed ONCE over the pooled raw values —
//     never the mean of per-Engine percentiles, never per-Engine-equalized
//     pools. Samples are weighted, not Engines.
//   - the pinned percentile method: sorted[floor((n-1)*q)] — the ONLY common
//     method reproducing the real Report's known answers (p75=2276, p95=3120);
//   - p75 leads; p50/p95 for shape; NO MEAN anywhere in the model. Ever.
//   - percentiles over status === "ok" values only; any other status —
//     including ones this code has never heard of, and even when it carries a
//     number — is not-ok and never pooled. A null is never pooled as 0.
//   - coverage {ok, total} beside every aggregate, with the not-ok statuses
//     itemized in `breakdown`; a metric absent from a record entirely counts
//     as "not-carried" — absence and failure are different facts.
//   - an all-non-ok metric carries its DOMINANT REASON as data, so the UI
//     renders "INP — no interaction (0 of 50)", never a number, never 0.
//   - Cold Starts (first Navigation by ts per (sessionId, workerIndex)) are
//     flagged and counted, NEVER trimmed. Legacy records carry no workerIndex,
//     so their flag is null — unidentifiable, not guessed.
//   - Execution Outcomes join within a session on the full test identity; a
//     missing Outcome among emitted ones means crashed. Failed Executions are
//     INCLUDED by default (excluding them deletes exactly the slowest Samples,
//     silently and directionally); excludeFailedExecutions is the pure opt-out
//     the caller applies before re-aggregating.
//   - no minimum sample count: an n=2 aggregate computes normally and its
//     coverage makes it visible rather than misleading.
//
// Route derivation is the format's routeOf: a declared Route wins verbatim;
// otherwise the URL's pathname, with query and fragment stripped. The raw URL is
// always kept, so a Route can be re-derived from it.

import { routeOf } from 'bzm-vitals-format';
import type { AttributedOutcome, AttributedSample, SampleExecutionStatus } from './attribute.js';

/**
 * The pinned percentile method: sorted ascending, take sorted[floor((n-1)*q)] —
 * NumPy's method='lower'. It always returns an observed value, and it reads low
 * at small n (n=10 → "p95" is the second-highest value); coverage beside every
 * aggregate makes small n visible. Nearest-rank and linear interpolation both
 * fail to reproduce the known-answer fixture's values. Decision: SPEC-HARDENING.md D7.
 */
export function percentile(values: ArrayLike<number>, q: number): number {
  return percentiles(values, [q])[0]!;
}

/**
 * Several percentiles of one value set, by the pinned method — the SAME
 * values sorting would give (sorted[floor((n-1)*q)]), found by selection
 * instead: an in-place quickselect on one Float64Array copy, O(n) per
 * percentile rather than a comparator sort per call. `qs` in any order; the
 * input is never reordered. A NaN in the input (never in parsed data) falls
 * back to a full typed sort, which orders NaN last.
 */
export function percentiles(values: ArrayLike<number>, qs: readonly number[]): number[] {
  if (values.length === 0) {
    throw new Error('percentile of zero values — callers must render coverage, not a number');
  }
  return percentilesInPlace(Float64Array.from(values), qs);
}

/** percentiles() over a scratch copy it may reorder. */
function percentilesInPlace(a: Float64Array, qs: readonly number[]): number[] {
  const n = a.length;
  let hasNaN = false;
  for (let i = 0; i < n; i++) {
    if (a[i] !== a[i]) {
      hasNaN = true;
      break;
    }
  }
  const ks = qs.map((q) => Math.floor((n - 1) * q));
  if (hasNaN) {
    a.sort();
    return ks.map((k) => a[k]!);
  }
  // Select in ascending k: after selecting k, everything right of it is >= a[k],
  // so the next (larger) k is searched in [k, n) only.
  const order = ks.map((k, i) => [k, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(ks.length);
  let lo = 0;
  for (const [k, i] of order) {
    out[i] = selectKth(a, k, lo, n - 1);
    lo = k;
  }
  return out;
}

/** The k-th smallest of a[lo..hi] (inclusive), partitioning `a` in place:
 *  Hoare partitioning around a median-of-three pivot. Falls back to sorting
 *  the remaining range if partitioning stops converging (adversarial input),
 *  so the worst case stays O(n log n). */
function selectKth(a: Float64Array, k: number, lo: number, hi: number): number {
  let budget = 2 * Math.ceil(Math.log2(hi - lo + 2)) + 8;
  while (hi > lo) {
    if (budget-- === 0 || hi - lo < 16) {
      const sorted = a.subarray(lo, hi + 1).sort();
      return sorted[k - lo]!;
    }
    const mid = (lo + hi) >>> 1;
    // Median of three, as the pivot value.
    let x = a[lo]!;
    let y = a[mid]!;
    let z = a[hi]!;
    if (x > y) [x, y] = [y, x];
    if (y > z) [y, z] = [z, y];
    if (x > y) [x, y] = [y, x];
    const pivot = y;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    // Now a[lo..j] <= pivot <= a[i..hi], and a[j+1..i-1] === pivot.
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k]!;
  }
  return a[k]!;
}

// Derive the Route for a Sample: format's routeOf, the ONE copy shared with the collector's
// live sinks. Re-exported so this module stays the aggregation model's single entry point.
export { routeOf };

/** The breakdown key for a Sample that does not carry the metric at all. */
export const NOT_CARRIED = 'not-carried';

export interface MetricAggregate {
  /** All three null when nothing was measured — never 0. Render `reason`. */
  p50: number | null;
  /** p75 leads: web.dev's thresholds are defined at p75. */
  p75: number | null;
  p95: number | null;
  /** Coverage: n_ok of n_total, stated wherever the aggregate is stated. */
  ok: number;
  total: number;
  /**
   * The not-ok Samples itemized by status — e.g. {unsupported: 9, unknown: 3}
   * — plus 'not-carried' for Samples missing the metric entirely.
   * ok + sum(breakdown) === total, always. Empty when everything was ok.
   */
  breakdown: Record<string, number>;
  /** The dominant not-ok status. Present exactly when ok === 0 — the UI shows
   *  the reason, not a number: "INP — no interaction (0 of 50)". */
  reason?: string;
}

export interface RouteRow {
  route: string;
  sampleCount: number;
  /**
   * Cold Starts in this pool — flagged, counted, never trimmed. null when no
   * Sample in the pool is identifiable (no workerIndex anywhere — legacy data):
   * "unidentifiable" and "zero" are different facts.
   */
  coldStarts: number | null;
  /** Metric names are open — whatever the Samples carried. */
  metrics: Record<string, MetricAggregate>;
}

/** The (sessionId, workerIndex) key a Cold Start is defined over. */
function workerKey(s: AttributedSample): string | null {
  const worker = s.sample.test?.worker;
  if (typeof worker !== 'number') return null;
  return `${s.sessionId}\u0000${worker}`;
}

/**
 * Stamp every Sample's Cold Start flag: true for the first Navigation by ts
 * per (sessionId, workerIndex), false for every later one, null when the
 * Sample carries no workerIndex (legacy) — structurally unidentifiable, never
 * guessed. Pure: returns new objects, marks nothing in place.
 */
export function markColdStarts(samples: AttributedSample[]): AttributedSample[] {
  const firstTs = new Map<string, number>();
  for (const s of samples) {
    const key = workerKey(s);
    if (key === null) continue;
    const current = firstTs.get(key);
    if (current === undefined || s.sample.ts < current) firstTs.set(key, s.sample.ts);
  }
  return samples.map((s) => {
    const key = workerKey(s);
    if (key === null) return { ...s, coldStart: null };
    return { ...s, coldStart: s.sample.ts === firstTs.get(key) };
  });
}

/** The Test identity fields the keys read — structural, so a format
 *  TestIdentity and a dashboard Sample's test both satisfy it. */
export interface TestIdentityKeyFields {
  file: string;
  title: string;
  project: string;
  id?: string;
}

/** The record's Playwright testId, or undefined when it carries none — a
 *  0.2.x record, or an empty string (treated as absent, never as an id). */
export function testIdOf(test: { id?: string }): string | undefined {
  return typeof test.id === 'string' && test.id !== '' ? test.id : undefined;
}

/** The pre-id Test key: the (file, title, project) triple. Two Tests sharing a
 *  file basename and title (a describe chain, or two dirs) collide here. */
export function tripleKeyOf(test: TestIdentityKeyFields): string {
  return [test.file, test.title, test.project].join('\u0000');
}

/** Namespace for id keys: a leading NUL that no triple key starts with
 *  (a real spec file basename is never empty). */
const ID_KEY_PREFIX = '\u0000id\u0000';

/**
 * Build a Test-key function over one scope of records. A record carrying
 * a testId keys on it. A record without one (an older collector) keys on its
 * triple — UNLESS, within the same scope, that triple was seen carrying
 * exactly ONE id, in which case it folds into that Test: the same Test written
 * by an old and a new collector stays one Test. A triple seen with two or more
 * ids is ambiguous (that is the collision ids exist to resolve), so id-less
 * records on it stay on the triple key, never guessed into either Test. With
 * no ids anywhere in scope, every key is the triple key — exactly the 0.2.x
 * behaviour.
 *
 * `scopeOf` partitions the fold: the join folds within one session, the view
 * folds across the whole Report.
 */
export function testKeyResolver<R>(
  records: Iterable<R>,
  testOf: (r: R) => TestIdentityKeyFields | null | undefined,
  scopeOf: (r: R) => string = () => '',
): (test: TestIdentityKeyFields, scope?: string) => string {
  const idsByTriple = new Map<string, Set<string>>();
  for (const r of records) {
    const t = testOf(r);
    if (!t) continue;
    const id = testIdOf(t);
    if (id === undefined) continue;
    const k = scopeOf(r) + '\u0000' + tripleKeyOf(t);
    const ids = idsByTriple.get(k);
    if (ids) ids.add(id);
    else idsByTriple.set(k, new Set([id]));
  }
  return (test, scope = '') => {
    const id = testIdOf(test);
    if (id !== undefined) return ID_KEY_PREFIX + id;
    const ids = idsByTriple.get(scope + '\u0000' + tripleKeyOf(test));
    if (ids && ids.size === 1) return ID_KEY_PREFIX + [...ids][0]!;
    return tripleKeyOf(test);
  };
}

type ExecutionIdentity = TestIdentityKeyFields & { repeat: number; worker: number };

/**
 * The within-session Execution key an Outcome joins on: (sessionId, Test,
 * repeat, worker), where Test is the record's testId when it carries one and
 * the (file, title, project) triple otherwise (see testKeyResolver). worker
 * stays in the key on both paths: Playwright retries in a fresh worker, so it
 * is what keeps each attempt's Samples on that attempt's Outcome — dropping it
 * only on the id path would make a retried Execution read differently
 * depending on the collector's version.
 */
function executionKeyer(
  samples: AttributedSample[],
  outcomes: AttributedOutcome[],
): (sessionId: string, test: ExecutionIdentity) => string {
  const records: Array<{ sessionId: string; test: ExecutionIdentity | null }> = [
    ...outcomes.map((o) => ({ sessionId: o.sessionId, test: o.outcome.test })),
    ...samples.map((s) => ({ sessionId: s.sessionId, test: s.sample.test })),
  ];
  const testKey = testKeyResolver(
    records,
    (r) => r.test,
    (r) => r.sessionId,
  );
  return (sessionId, test) =>
    [sessionId, testKey(test, sessionId), test.repeat, test.worker].join('\u0000');
}

/**
 * Stamp every Sample's per-Execution status from the Outcome records:
 *   - joined: the Outcome's status — for a retried Execution, the final
 *     retry's verdict;
 *   - 'crashed': the Sample's session emitted Outcomes but none matches this
 *     Execution — it died before afterEach could attach one;
 *   - 'unavailable': the session emitted zero Outcomes anywhere (older
 *     collector, or legacy), or the Sample has no test identity to join on.
 * Pure: returns new objects.
 */
export function joinOutcomes(
  samples: AttributedSample[],
  outcomes: AttributedOutcome[],
): AttributedSample[] {
  const executionKey = executionKeyer(samples, outcomes);
  const sessionsEmitting = new Set<string>();
  const byExecution = new Map<string, { status: SampleExecutionStatus; retry: number }>();
  for (const { sessionId, outcome } of outcomes) {
    sessionsEmitting.add(sessionId);
    const key = executionKey(sessionId, outcome.test);
    const current = byExecution.get(key);
    if (current === undefined || outcome.retry > current.retry) {
      byExecution.set(key, { status: outcome.status, retry: outcome.retry });
    }
  }
  return samples.map((s) => {
    if (s.sample.test === null || !sessionsEmitting.has(s.sessionId)) {
      return { ...s, executionStatus: 'unavailable' as const };
    }
    const joined = byExecution.get(executionKey(s.sessionId, s.sample.test));
    return { ...s, executionStatus: joined ? joined.status : ('crashed' as const) };
  });
}

/** The statuses the excludeFailed variant removes. 'unavailable' is kept — no
 *  outcome-awareness is not evidence of failure. */
const EXCLUDED_AS_FAILED: ReadonlySet<SampleExecutionStatus> = new Set([
  'failed',
  'timedOut',
  'crashed',
]);

/**
 * The outcome breakdown as data — what "4 of 50 Executions failed" is made of.
 * Executions are counted, never Samples: one Outcome record per Execution
 * (final retry's verdict), plus crashed Executions derived from Samples whose
 * session emitted Outcomes but has none for them.
 */
export interface OutcomeSummary {
  /** false = zero Outcome records anywhere (legacy / older collector). The UI
   *  must say so in words — "not aware" NEVER implies all-passed. */
  aware: boolean;
  /** Distinct Executions: Outcome records ∪ crashed derived from Samples. */
  total: number;
  /** status → Execution count; includes 'crashed'. Empty when not aware. */
  counts: Record<string, number>;
  /** failed + timedOut + crashed — exactly what excludeFailedExecutions drops.
   *  0 means the exclude toggle has nothing to do. */
  excludable: number;
}

/** Summarize Execution Outcomes for the breakdown line and the toggle state. */
export function summarizeOutcomes(
  samples: AttributedSample[],
  outcomes: AttributedOutcome[],
): OutcomeSummary {
  // One entry per Execution; a retry is another attempt at the same identity
  // here, and the FINAL retry's verdict is the Execution's — same rule as
  // joinOutcomes, so the line and the join can never disagree.
  const executionKey = executionKeyer(samples, outcomes);
  const byExecution = new Map<string, { status: string; retry: number }>();
  for (const { sessionId, outcome } of outcomes) {
    const key = executionKey(sessionId, outcome.test);
    const current = byExecution.get(key);
    if (current === undefined || outcome.retry > current.retry) {
      byExecution.set(key, { status: outcome.status, retry: outcome.retry });
    }
  }
  const counts: Record<string, number> = {};
  for (const { status } of byExecution.values()) counts[status] = (counts[status] ?? 0) + 1;

  // Crashed Executions exist only as Samples (the Execution died before
  // afterEach) — count distinct Executions, not Samples.
  const crashed = new Set<string>();
  for (const s of samples) {
    if (s.executionStatus === 'crashed' && s.sample.test) {
      crashed.add(executionKey(s.sessionId, s.sample.test));
    }
  }
  if (crashed.size > 0) counts['crashed'] = crashed.size;

  const excludable =
    (counts['failed'] ?? 0) + (counts['timedOut'] ?? 0) + (counts['crashed'] ?? 0);
  return {
    aware: outcomes.length > 0,
    total: byExecution.size + crashed.size,
    counts,
    excludable,
  };
}

/**
 * The opt-out for suites where failure means the page genuinely broke: a pure
 * filter the caller applies before re-aggregating. NOT the default — on real
 * data the failures were budget breaches, i.e. exactly the slowest Samples,
 * and excluding them biases every percentile faster, silently.
 */
export function excludeFailedExecutions(samples: AttributedSample[]): AttributedSample[] {
  return samples.filter(keptWhenExcludingFailed);
}

/** Positions (into `samples`, ascending) of exactly the Samples
 *  excludeFailedExecutions keeps — the same subset, as an index selection. */
export function keptPositions(samples: readonly AttributedSample[]): Int32Array {
  const out = new Int32Array(samples.length);
  let n = 0;
  for (let i = 0; i < samples.length; i++) if (keptWhenExcludingFailed(samples[i]!)) out[n++] = i;
  return out.slice(0, n);
}

function keptWhenExcludingFailed(s: AttributedSample): boolean {
  return s.executionStatus === undefined || !EXCLUDED_AS_FAILED.has(s.executionStatus);
}

/** routeOf, memoized per Sample record: the Route is a pure function of the
 *  record, and a 200k-Sample Report derives it for every Sample in every
 *  variant (aggregateRoutes, and the view model's Route pools). */
const routeCache = new WeakMap<object, string>();
export function routeOfSample(s: AttributedSample): string {
  let route = routeCache.get(s.sample);
  if (route === undefined) {
    route = routeOf(s.sample);
    routeCache.set(s.sample, route);
  }
  return route;
}

/**
 * The model: pool ALL Attributed Samples per Route (over sessionId and repeat —
 * everything else is a dimension to slice by) and compute p50/p75/p95 ONCE over
 * each metric's pooled ok values. Cold Starts are (re)identified over the FULL
 * input — a (sessionId, workerIndex)'s first Navigation is a global fact, not a
 * per-Route one — then counted per node. Every denominator is the Route's whole
 * pool, so "p75 over 41 of 50 — 9 unsupported" reads directly off
 * {ok, total, breakdown}.
 *
 * coldStartsPreMarked: pass true when the samples ALREADY carry their flags
 * from the full Report and this call sees only a subset (the exclude-failed
 * variant). Re-marking a subset would PROMOTE a later Navigation to Cold Start
 * when the real one was filtered out — a worker's first Navigation is a global
 * fact about the run, not a fact about whichever subset is being aggregated.
 */
export function aggregateRoutes(
  samples: AttributedSample[],
  opts: { coldStartsPreMarked?: boolean } = {},
): RouteRow[] {
  const marked = opts.coldStartsPreMarked ? samples : markColdStarts(samples);
  return aggregateIndexed(sampleIndex(marked));
}

// ------------------------------------------------- the columnar Sample index
//
// Every aggregate is a pure function of a few per-Sample facts: its Route, its
// Cold Start flag, and per metric whether it was carried, ok (pooled, with a
// value) or not-ok (with which status). The index holds exactly those, as
// typed columns, read off each Sample's record ONCE. Aggregating any subset
// of the Samples (the exclude-failed variant) then reads the columns, never
// the records again. The answers are the per-record walk's, exactly:
// test/timeline-canvas.test.ts pins them against a reference walk.

/** A column's status codes: 0 = not carried, 1 = ok and pooled; any larger
 *  code k is the not-ok status `statuses[k]`. */
export const CODE_NOT_CARRIED = 0;
export const CODE_POOLED = 1;

export interface SampleIndex {
  /** The indexed Samples: position i of every column is samples[i]. */
  readonly samples: readonly AttributedSample[];
  /** Each Sample's ts, absolute epoch ms. */
  readonly ts: Float64Array;
  /** Each Sample's Route, as a position in `routes`. */
  readonly routeId: Int32Array;
  readonly routes: readonly string[];
  /** Each Sample's Cold Start flag: 1 true, 0 false (or not stamped), -1 null
   *  (unidentifiable). */
  readonly coldStart: Int8Array;
  /** Every metric name any Sample carries, in first-seen order. */
  readonly metrics: readonly string[];
  /** Per metric (as in `metrics`), per Sample: its status code. */
  readonly status: readonly Uint16Array[];
  /** Per metric, per Sample: the value, where the code is 1 (pooled). */
  readonly value: readonly Float64Array[];
  /** The not-ok status names, by code (codes 0 and 1 are not names). */
  readonly statuses: readonly string[];
  /** Each Sample's metric-name order (the order its record lists its
   *  vitals), as a position in `shapes` — so a pool's metrics keep the
   *  first-seen order a walk of the records gives. */
  readonly shapeId: Int32Array;
  /** The distinct metric-name orders, as positions in `metrics`. */
  readonly shapes: readonly Int32Array[];
}

/** Read every Sample's record once, into a SampleIndex. Pure. */
export function sampleIndex(samples: readonly AttributedSample[]): SampleIndex {
  const n = samples.length;
  const ts = new Float64Array(n);
  const routeId = new Int32Array(n);
  const coldStart = new Int8Array(n);
  const shapeId = new Int32Array(n);
  const routes: string[] = [];
  const routeIds = new Map<string, number>();
  const metrics: string[] = [];
  const metricIds = new Map<string, number>();
  const status: Uint16Array[] = [];
  const value: Float64Array[] = [];
  const statuses: string[] = [NOT_CARRIED, 'ok'];
  const statusCodes = new Map<string, number>();
  const shapes: Int32Array[] = [];
  const shapeIds = new Map<string, number>();

  // Records nearly always list the same metrics in the same order: the k-th
  // name is checked against the last record's k-th name before the map, and
  // a record whose whole order matches the last one reuses its shape.
  const lastNames: string[] = [];
  const lastIds: number[] = [];
  let lastLength = -1;
  let lastShape = -1;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    ts[i] = s.sample.ts;
    const route = routeOfSample(s);
    let r = routeIds.get(route);
    if (r === undefined) {
      r = routes.length;
      routes.push(route);
      routeIds.set(route, r);
    }
    routeId[i] = r;
    coldStart[i] = s.coldStart === true ? 1 : s.coldStart === null ? -1 : 0;

    const vitals = s.sample.vitals;
    let k = 0;
    let sameShape = true;
    for (const name in vitals) {
      let id: number;
      if (lastNames[k] === name) id = lastIds[k]!;
      else {
        sameShape = false;
        let known = metricIds.get(name);
        if (known === undefined) {
          known = metrics.length;
          metrics.push(name);
          metricIds.set(name, known);
          status.push(new Uint16Array(n));
          value.push(new Float64Array(n));
        }
        id = known;
        lastNames[k] = name;
        lastIds[k] = id;
      }
      ids[k] = id;
      k += 1;
      const metric = vitals[name];
      if (metric === undefined) continue; // present but undefined: not carried
      // Closed status vocabulary: only exactly "ok" (with a real number) pools.
      // A not-ok status is never pooled EVEN IF it carries a number, and an
      // unrecognized status is not-ok (the parser rejects one; kept as a backstop).
      if (metric.status === 'ok' && typeof metric.value === 'number') {
        status[id]![i] = CODE_POOLED;
        value[id]![i] = metric.value;
      } else {
        // The status is typed closed but arrives from the open parse path — it
        // can be any runtime string (or worse). Bucket the unusable ones.
        const raw: unknown = metric.status;
        const label = typeof raw === 'string' && raw !== '' ? raw : 'invalid';
        let code = statusCodes.get(label);
        if (code === undefined) {
          code = statuses.length;
          statuses.push(label);
          statusCodes.set(label, code);
        }
        status[id]![i] = code;
      }
    }
    if (!sameShape || k !== lastLength) {
      const key = ids.slice(0, k).join(',');
      let shape = shapeIds.get(key);
      if (shape === undefined) {
        shape = shapes.length;
        shapes.push(Int32Array.from(ids.slice(0, k)));
        shapeIds.set(key, shape);
      }
      lastShape = shape;
      lastLength = k;
    }
    shapeId[i] = lastShape;
  }
  return { samples, ts, routeId, routes, coldStart, metrics, status, value, statuses, shapeId, shapes };
}

/**
 * aggregateRoutes over an index: the Samples at `positions` (ascending
 * positions into index.samples; all of them when omitted), with the Cold
 * Start flags the index holds — never re-marked over the subset (see
 * coldStartsPreMarked). The same RouteRows aggregateRoutes gives for those
 * Samples, read from the columns instead of the records.
 */
export function aggregateIndexed(index: SampleIndex, positions?: Int32Array): RouteRow[] {
  const count = positions === undefined ? index.samples.length : positions.length;
  const at = (k: number): number => (positions === undefined ? k : positions[k]!);
  const routeCount = index.routes.length;
  // Bucket the positions by Route, keeping their order (a counting sort).
  const sizes = new Int32Array(routeCount);
  for (let k = 0; k < count; k++) sizes[index.routeId[at(k)]!]! += 1;
  const starts = new Int32Array(routeCount);
  let largest = 0;
  for (let r = 0, next = 0; r < routeCount; r++) {
    starts[r] = next;
    next += sizes[r]!;
    if (sizes[r]! > largest) largest = sizes[r]!;
  }
  const members = new Int32Array(count);
  const fill = starts.slice();
  for (let k = 0; k < count; k++) {
    const p = at(k);
    members[fill[index.routeId[p]!]!++] = p;
  }

  const scratch = new Float64Array(largest);
  const shapeSeen = new Int32Array(index.shapes.length);
  const metricSeen = new Int32Array(index.metrics.length);
  const rows: RouteRow[] = [];
  for (let r = 0; r < routeCount; r++) {
    const size = sizes[r]!;
    if (size === 0) continue;
    const pool = members.subarray(starts[r]!, starts[r]! + size);
    // The pool's metric names, in the order a walk of its records meets them.
    const stamp = r + 1;
    const order: number[] = [];
    for (let j = 0; j < size; j++) {
      const shape = index.shapeId[pool[j]!]!;
      if (shapeSeen[shape] === stamp) continue;
      shapeSeen[shape] = stamp;
      for (const m of index.shapes[shape]!) {
        if (metricSeen[m] === stamp) continue;
        metricSeen[m] = stamp;
        order.push(m);
      }
    }

    const metrics: Record<string, MetricAggregate> = {};
    for (const m of order) {
      const codes = index.status[m]!;
      const values = index.value[m]!;
      const breakdown: Record<string, number> = {};
      let ok = 0;
      let carried = 0;
      for (let j = 0; j < size; j++) {
        const p = pool[j]!;
        const code = codes[p]!;
        if (code === CODE_NOT_CARRIED) continue;
        carried += 1;
        if (code === CODE_POOLED) scratch[ok++] = values[p]!;
        else {
          const label = index.statuses[code]!;
          breakdown[label] = (breakdown[label] ?? 0) + 1;
        }
      }
      const notCarried = size - carried;
      if (notCarried > 0) breakdown[NOT_CARRIED] = notCarried;
      // One scratch copy, three selections.
      const [p50, p75, p95] =
        ok > 0 ? percentilesInPlace(scratch.subarray(0, ok), [0.5, 0.75, 0.95]) : [null, null, null];
      const aggregate: MetricAggregate = {
        p50: p50 ?? null,
        p75: p75 ?? null,
        p95: p95 ?? null,
        ok,
        total: size,
        breakdown,
      };
      if (ok === 0) {
        // The dominant reason, as data: highest count wins; ties break
        // deterministically by name so the same input always says the same thing.
        aggregate.reason = Object.entries(breakdown).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]![0];
      }
      metrics[index.metrics[m]!] = aggregate;
    }

    // null when nothing in the pool is identifiable — never a misleading 0.
    let identifiable = false;
    let coldStarts = 0;
    for (let j = 0; j < size; j++) {
      const flag = index.coldStart[pool[j]!]!;
      if (flag !== -1) identifiable = true;
      if (flag === 1) coldStarts += 1;
    }
    rows.push({ route: index.routes[r]!, sampleCount: size, coldStarts: identifiable ? coldStarts : null, metrics });
  }

  // Busiest Route first, ties by Route name, so the ordering is stable run to run.
  rows.sort((a, b) => b.sampleCount - a.sampleCount || a.route.localeCompare(b.route));
  return rows;
}
