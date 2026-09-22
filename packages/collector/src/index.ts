// bzm-playwright-vitals — the tester's one changed import.
//
//   - import { test, expect } from '@playwright/test';
//   + import { test, expect } from 'bzm-playwright-vitals';
//
// Adopting the collector is ONE changed import and nothing else: no per-Navigation
// call, no teardown hook the tester owns. Every Navigation the test drives leaves one
// Sample JSON file on disk (format v1), written to outputPath() then attach({ path }).
//
// Issue #1 cut the seams (an in-page trap that flushes on its own listeners; a Node-side
// binding that assembles and writes the Sample); issue #3 filled in the metric set: all
// five vitals — TTFB, FCP, LCP, CLS, INP — each as {value, status}, every status true.
// Issue #4 added the rest of the tester-facing surface: one Execution Outcome record per
// test (written in fixture teardown, where testInfo.status is final), and vitals.route()
// — the only knob, and an optional one.
//
// The load-bearing decisions, all measured on real Engines (see SPEC.md):
//   * attach({ body }) writes NOTHING under Taurus and errors nowhere. The write-file-
//     to-outputPath()-then-attach({ path }) two-step is the ONLY transport that survives.
//   * Injection is passive addInitScript; the trap pushes to Node via exposeBinding on
//     flush. Never page.on('load') -> evaluate(), which perturbs the metric measured.
//   * page.close() flushes nothing, so the fixture flushes in teardown BEFORE the page
//     closes — via a synthetic event the hand-rolled listener still receives.
//   * A binding call from a document's pagehide never reaches Node once its frame is
//     swapped — cross-site always, and on every navigation from Playwright 1.63
//     (Chromium RenderDocument). So test-driven navigations flush BEFORE they navigate,
//     and link-click navigations flush at beforeunload.
//   * Read only NAMED env variables. The Engine env holds a live SESSION_TOKEN; nothing
//     here ever serializes process.env or any subset of it.

import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  SCHEMA_VERSION,
  SAMPLE_ATTACHMENT_PREFIX,
  OUTCOME_ATTACHMENT_PREFIX,
  type Sample,
  type Metric,
  type MetricStatus,
  type TestIdentity,
  type ExecutionOutcome,
  type ExecutionStatus,
} from 'bzm-vitals-format';
import { Pusher, resolveFlushMs } from './pusher.js';
import { createDestinationsFromEnv } from './destinations.js';

/** The binding the in-page trap calls to hand a raw reading back to Node. */
const REPORT_BINDING = '__bzmVitalsReport';
/** The in-page flush entry point the fixture drives before each navigation and at teardown. */
const FLUSH_HOOK = '__bzmVitalsFlush';
/**
 * How long Node holds a leaving document's Sample open for a later, more complete
 * reading (pagehide, where the document keeps its frame) before it writes. Short enough
 * that an intermediate Sample is on disk well before a worker could be killed.
 */
const LEAVE_SETTLE_MS = 400;

/**
 * The raw reading the in-page trap produces at flush. Node turns it into a Sample.
 * Values are DOMHighResTimeStamps relative to the document's own time origin; `ts`
 * comes from performance.timeOrigin, which is epoch ms at THIS Navigation's start.
 *
 * Each vital arrives as {value, status} because only the trap knows WHY a value is
 * missing (API absent vs never finalized vs collection threw). Node sanitizes but
 * never invents a status.
 */
interface RawMetric {
  value: number | null;
  status: string;
}

interface RawReading {
  /** Per-document id; every reading one document sends merges into one Sample. */
  docId: string;
  /** Fixture-driven flush (before a navigation, at teardown): write the Sample now. */
  final: boolean;
  timeOrigin: number;
  url: string;
  ttfb: RawMetric;
  fcp: RawMetric;
  lcp: RawMetric;
  cls: RawMetric;
  inp: RawMetric;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  resourceCount: number | null;
}

/** Per-page collection state. One page drives one Execution's Navigations in order. */
interface CollectorState {
  /** navigationIndex is 1-based and increments per Navigation within an Execution. */
  nextNavigationIndex: number;
  /** Requests seen on this page (cumulative — "from the page"). */
  requestCount: number;
  failedRequests: number;
  /** In-flight writes; teardown awaits these so no Sample is lost to a race. */
  pending: Promise<void>[];
  /**
   * The route declared via vitals.route(), waiting for its Sample. Consumed
   * synchronously with the navigationIndex claim (see the binding), so it always lands
   * on the Navigation the page was on when route() was called.
   */
  pendingRoute: string | null;
  /** Documents whose Sample is claimed but not yet written — teardown writes them. */
  openDocs: Map<string, OpenDoc>;
}

/**
 * A document that has reported but whose Sample is not written yet. It takes its
 * navigationIndex, route and request counts at its FIRST reading — the moment it began
 * to leave — and its vitals from its LAST reading.
 */
interface OpenDoc {
  navigationIndex: number;
  route: string | null;
  requestCount: number;
  failedRequests: number;
  reading: RawReading;
  timer: ReturnType<typeof setTimeout>;
  write: Promise<void> | null;
  commit(): Promise<void>;
}

/**
 * The passive in-page trap. Runs via addInitScript on EVERY document the test drives
 * (every Navigation re-runs it), top frame only. It never touches the page during load;
 * it only reads the performance timeline at flush time and hands the reading to Node.
 *
 * Flush happens on the FLUSH_HOOK the fixture drives before every test-driven
 * navigation (goto/reload/goBack/goForward) and at teardown, and on the events a real
 * navigation-away already fires (beforeunload / pagehide / visibilitychange->hidden) —
 * so link-click and script Navigations flush too. A document may report more than once;
 * Node merges its readings into one Sample (see OpenDoc). The listeners are hand-rolled,
 * so the synthetic flush reaches them (the very gate the popular web-vitals
 * synthetic-event workaround trips over).
 *
 * NOTE: serialized and injected as a string, so it must be self-contained — no closure
 * over anything in this module. Binding/hook names are interpolated in.
 */
function trapSource(reportBinding: string, flushHook: string): string {
  return `(() => {
    if (window.top !== window) return;            // top frame only — ignore iframes
    // Identifies THIS document to Node, which merges every reading it sends into one
    // Sample. A document may report more than once (see report()); Node keeps the last.
    var docId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var lastSent = null;

    // Feature detection is per metric, via supportedEntryTypes. Missing API -> that
    // metric is 'unsupported' and the Sample STILL emits — the incumbent's silent skip
    // of non-Chromium engines is the defect this exists to kill.
    var supported = [];
    try {
      supported = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
    } catch (e) {}

    // ---- LCP — hand-rolled, and there is NO isTrusted gate anywhere in this path.
    // That gate is web-vitals-the-library's, not the platform's; under a synthetic
    // flush it silently drops LCP. LCP here is simply the last candidate observed at
    // flush time — honest, and stated as such.
    var lcp = { value: null, status: 'unsupported' };
    var lcpObs = null;
    function lcpTake(list) {
      var es = list.getEntries ? list.getEntries() : list;
      if (es.length) { lcp.value = es[es.length - 1].startTime; lcp.status = 'ok'; }
    }
    if (supported.indexOf('largest-contentful-paint') >= 0) {
      // Supported but never fired by flush -> the candidate never finalized.
      lcp.status = 'not-finalized';
      try {
        lcpObs = new PerformanceObserver(lcpTake);
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) { lcp.status = 'error'; lcpObs = null; }
    }

    // ---- CLS — session windows per the web.dev definition: shifts (excluding
    // hadRecentInput) accumulate into a session while gaps stay < 1s and the session
    // stays < 5s long; CLS is the MAX session value. A true float — never rounded.
    var cls = { value: null, status: 'unsupported' };
    var clsObs = null;
    var sessionValue = 0, sessionFirst = 0, sessionPrev = 0;
    function clsTake(list) {
      var es = list.getEntries ? list.getEntries() : list;
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (e.hadRecentInput) continue;
        if (sessionValue > 0 && e.startTime - sessionPrev < 1000 && e.startTime - sessionFirst < 5000) {
          sessionValue += e.value;
        } else {
          sessionValue = e.value;
          sessionFirst = e.startTime;
        }
        sessionPrev = e.startTime;
        if (sessionValue > cls.value) cls.value = sessionValue;
      }
    }
    if (supported.indexOf('layout-shift') >= 0) {
      // Supported with no shifts observed is a GENUINE zero (stable page), not a gap —
      // 'cls: 0, ok' and 'cls: null, unsupported' must coexist, which is why both exist.
      cls.value = 0;
      cls.status = 'ok';
      try {
        clsObs = new PerformanceObserver(clsTake);
        clsObs.observe({ type: 'layout-shift', buffered: true });
      } catch (e) { cls.value = null; cls.status = 'error'; clsObs = null; }
    }

    // ---- INP — worst qualifying interaction (max event-timing duration per
    // interactionId). The standard high-percentile pick estimates p98 as one candidate
    // per 50 interactions, which DEGENERATES to the worst below 50 — and a scripted
    // journey drives a handful at most, so worst-interaction is the honest choice: a
    // within-harness regression signal, never a field-comparable p75.
    var inp = { value: null, status: 'unsupported' };
    var inpObs = null;
    var interactions = {};   // interactionId -> worst duration seen
    var lastEntryStart = -1; // latest startTime among interaction entries seen
    function inpTake(list) {
      var es = list.getEntries ? list.getEntries() : list;
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e.interactionId) continue;    // hover/scroll noise has interactionId 0
        if (e.startTime > lastEntryStart) lastEntryStart = e.startTime;
        var prev = interactions[e.interactionId];
        if (prev === undefined || e.duration > prev) interactions[e.interactionId] = e.duration;
      }
    }
    if (supported.indexOf('event') >= 0 &&
        typeof window.PerformanceEventTiming === 'function' &&
        'interactionId' in PerformanceEventTiming.prototype) {
      // Supported and nothing clicked is 'no-interaction' — never 0, never absent.
      inp.status = 'no-interaction';
      try {
        inpObs = new PerformanceObserver(inpTake);
        // 16 is the lowest durationThreshold the spec allows; buffered picks up
        // interactions from before observer registration completed.
        inpObs.observe({ type: 'event', durationThreshold: 16, buffered: true });
      } catch (e) { inp.status = 'error'; inpObs = null; }
    }

    // An interaction's event-timing entry only exists once its next frame is PRESENTED,
    // which trails the paint by a variable few ms (measured: sometimes after two rAFs).
    // A flush that can wait therefore waits for the latest input's entry — bounded,
    // because an interaction under the 16ms threshold never gets one. The listeners are
    // passive and only read a timestamp.
    var lastInputAt = -1;
    function noteInput(e) { lastInputAt = e.timeStamp; }
    try {
      window.addEventListener('pointerdown', noteInput, { capture: true, passive: true });
      window.addEventListener('keydown', noteInput, { capture: true, passive: true });
    } catch (e) {}
    function inputPending() {
      return inpObs !== null && lastInputAt >= 0 && lastEntryStart < lastInputAt - 1 &&
        performance.now() - lastInputAt < 300;
    }

    // takeRecords() hands over entries the browser has generated but not yet delivered
    // to a callback — the synchronous half of the flush hardening. The beforeunload /
    // pagehide flushes rely on it alone; fixture-driven flushes also wait a paint and
    // the latest input's entry first (below) for durations still being finalized.
    function drain() {
      try { if (lcpObs) lcpTake(lcpObs.takeRecords()); } catch (e) { lcp = { value: null, status: 'error' }; }
      try { if (clsObs) clsTake(clsObs.takeRecords()); } catch (e) { cls = { value: null, status: 'error' }; }
      try { if (inpObs) inpTake(inpObs.takeRecords()); } catch (e) { inp = { value: null, status: 'error' }; }
      // Recomputed on every drain: a later, worse interaction must still win after an
      // earlier report already settled on 'ok'.
      if (inp.status === 'no-interaction' || inp.status === 'ok') {
        var worst = null;
        for (var k in interactions) {
          if (worst === null || interactions[k] > worst) worst = interactions[k];
        }
        if (worst !== null) { inp.value = worst; inp.status = 'ok'; }
      }
    }

    function readFcpRaw() {
      var paints = performance.getEntriesByType('paint');
      for (var i = 0; i < paints.length; i++) {
        if (paints[i].name === 'first-contentful-paint') return paints[i].startTime;
      }
      return null;
    }
    function readFcpSafe() {
      try { return readFcpRaw(); } catch (e) { return null; }
    }

    // Synchronous report — reads the live performance timeline, drains the observers,
    // and pushes to Node. Used directly by beforeunload / pagehide / visibilitychange,
    // where the page is being discarded and there is no time to await. Every timeline
    // read is individually guarded: a throw costs THAT metric ('error'), never the Sample.
    // Sends only when the reading changed since the last send; \`final\` (a fixture-
    // driven flush) always sends and tells Node to write the Sample now.
    function report(final) {
      if (location.href === 'about:blank') return Promise.resolve();  // no real Navigation
      drain();
      var ttfb = { value: null, status: 'not-finalized' };
      var dcl = null, loadEnd = null, resources = null;
      try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          ttfb = { value: nav.responseStart, status: 'ok' };
          dcl = nav.domContentLoadedEventEnd;
          loadEnd = nav.loadEventEnd;
        }
      } catch (e) { ttfb = { value: null, status: 'error' }; }
      var fcp = { value: null, status: 'not-finalized' };
      try {
        var f = readFcpRaw();
        if (f !== null) fcp = { value: f, status: 'ok' };
      } catch (e) { fcp = { value: null, status: 'error' }; }
      try { resources = performance.getEntriesByType('resource').length; } catch (e) {}
      var reading = {
        docId: docId,
        final: final === true,
        timeOrigin: performance.timeOrigin,
        url: location.href,
        ttfb: ttfb,
        fcp: fcp,
        lcp: lcp,
        cls: cls,
        inp: inp,
        domContentLoadedMs: dcl,
        loadEventMs: loadEnd,
        resourceCount: resources
      };
      var key = JSON.stringify([ttfb, fcp, lcp, cls, inp, dcl, loadEnd, resources]);
      if (!reading.final && key === lastSent) return Promise.resolve();
      lastSent = key;
      return window['${reportBinding}'](reading);
    }

    // One paint, then a macrotask: two rAFs force the frame that finalizes in-flight
    // event-timing durations (an interaction's duration only exists after the next
    // paint), and the setTimeout lets observer queues deliver before drain(). Bounded:
    // a hidden or throttled page may never paint again, so a timer backstops it.
    function afterNextPaint(cb) {
      var done = false;
      function fire() { if (done) return; done = true; cb(); }
      try {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setTimeout(fire, 0); });
        });
      } catch (e) {}
      setTimeout(fire, 300);
    }

    // Fixture-driven flush (before a navigation, at teardown) — the page is still alive
    // here, so we can wait. On a fast page a Navigation can end before its FCP paint
    // entry is recorded; without this grace
    // window FCP (and the LCP candidate that rides the same paint) would race to null.
    // Bounded: FCP may legitimately never come, so we report regardless after 1500ms.
    function flushWithGrace() {
      return new Promise(function (resolve) {
        function proceed() {
          afterNextPaint(function () {
            (function settle() {
              drain();
              if (inputPending()) { setTimeout(settle, 10); return; }
              resolve(report(true));
            })();
          });
        }
        if (readFcpSafe() !== null) { proceed(); return; }
        var settled = false;
        var obs;
        function finish() {
          if (settled) return;
          settled = true;
          try { obs && obs.disconnect(); } catch (e) {}
          proceed();
        }
        try {
          obs = new PerformanceObserver(function (list) {
            var es = list.getEntries();
            for (var i = 0; i < es.length; i++) {
              if (es[i].name === 'first-contentful-paint') { finish(); return; }
            }
          });
          obs.observe({ type: 'paint', buffered: true });
        } catch (e) {}
        setTimeout(finish, 1500);
      });
    }
    window['${flushHook}'] = flushWithGrace;
    // beforeunload runs while this document is still the frame's CURRENT one. From
    // Playwright 1.63, Chromium's RenderDocument swaps in the next document's frame at
    // commit, BEFORE pagehide runs, and a binding call from the old frame never reaches
    // Node. (Test-driven goto/reload/back/forward flush earlier still — see
    // flushBeforeNavigating.)
    window.addEventListener('beforeunload', function () { report(false); }, { once: true });
    // pagehide still reaches Node where the document keeps its frame (Firefox, or
    // Chromium without RenderDocument) — the later, more complete reading.
    window.addEventListener('pagehide', function () { report(false); }, { once: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') report(false);
    });
  })()`;
}

/**
 * Sanitize a raw metric from the page into the record. The collector's vocabulary is
 * the closed set MINUS 'unknown' (the legacy adapter's alone — never written here);
 * anything malformed lands as 'error' rather than inventing a status, and a value
 * survives only when the status says it was measured.
 */
const COLLECTOR_STATUSES = new Set<MetricStatus>([
  'ok',
  'unsupported',
  'no-interaction',
  'not-finalized',
  'error',
]);

function metric(raw: RawMetric | undefined): Metric {
  const status = raw?.status as MetricStatus;
  if (!COLLECTOR_STATUSES.has(status)) return { value: null, status: 'error' };
  if (status === 'ok') {
    return typeof raw?.value === 'number' && Number.isFinite(raw.value)
      ? { value: raw.value, status: 'ok' }   // CLS is a true float — never round here
      : { value: null, status: 'error' };
  }
  return { value: null, status };
}

/** The identity every record carries — the same fields on a Sample and its Outcome, so
 *  the (repeat, worker) join is between values read from ONE source at ONE place. */
function testIdentity(testInfo: TestInfo): TestIdentity {
  return {
    file: basename(testInfo.file),
    title: testInfo.title,
    project: testInfo.project.name,
    repeat: testInfo.repeatEachIndex,
    worker: testInfo.workerIndex,
  };
}

/**
 * Wire the collector onto a page: expose the Node binding, inject the trap, and count
 * requests. Order matters — the binding and init script must exist before the page
 * navigates, so the trap the first document runs can call back.
 */
async function attachCollector(
  page: Page,
  testInfo: TestInfo,
  state: CollectorState,
  pusher: Pusher,
): Promise<void> {
  const identity = testIdentity(testInfo);
  // The DERIVED per-Engine worker count (Taurus's --workers), never a declared concurrency.
  const workers = testInfo.config.workers ?? null;

  async function writeSample(doc: OpenDoc): Promise<void> {
    const { reading, navigationIndex, route } = doc;
    const sample: Sample = {
      schemaVersion: SCHEMA_VERSION,
      ts: Math.round(reading.timeOrigin), // epoch ms at Navigation start — exactly one timestamp
      url: reading.url,
      // A declared Route is verbatim — never normalized. No declaration means NO field
      // (JSON.stringify drops undefined), never null: absent is the supported state the
      // dashboard derives from, and the raw url above is always kept either way.
      ...(route !== null ? { route } : {}),
      test: identity,
      navigationIndex,
      vitals: {
        ttfb: metric(reading.ttfb),
        fcp: metric(reading.fcp),
        lcp: metric(reading.lcp),
        cls: metric(reading.cls),
        inp: metric(reading.inp),
      },
      navigation: {
        domContentLoadedMs: reading.domContentLoadedMs,
        loadEventMs: reading.loadEventMs,
      },
      context: {
        workers,
        resourceCount: reading.resourceCount,
        requestCount: doc.requestCount,
        failedRequests: doc.failedRequests,
      },
    };

    // Best-effort push: hand the SAME neutral Sample to the worker pusher. Synchronous,
    // cheap, and a no-op when the push subsystem is off (no creds / local run) — so the
    // on-disk two-step below is never gated on, nor slowed by, the network path.
    pusher.enqueue(sample);

    // The mandatory two-step. outputPath() is per-test, so its sha1-basenamed
    // attachment copy is unique across workers/repeats/Engines; the navigationIndex
    // makes it unique within the Execution. Discovery downstream is by name prefix.
    const filename = `${SAMPLE_ATTACHMENT_PREFIX}-${navigationIndex}.json`;
    const outPath = testInfo.outputPath(filename);
    await writeFile(outPath, JSON.stringify(sample), 'utf8');
    await testInfo.attach(`${SAMPLE_ATTACHMENT_PREFIX}-${navigationIndex}`, {
      path: outPath,
      contentType: 'application/json',
    });
  }

  await page.exposeBinding(REPORT_BINDING, async (_source, reading: RawReading) => {
    let doc = state.openDocs.get(reading.docId);
    if (doc === undefined) {
      // navigationIndex is claimed synchronously at a document's FIRST reading, so
      // ordering follows flush order (= ts order) even when writes run concurrently. The
      // pending route is consumed in the same synchronous step: beforeunload fires
      // before the next document's load, and binding messages arrive in order, so a
      // route() the test calls after a goto() resolves can never be stolen by the
      // Navigation that goto left behind.
      const opened: OpenDoc = {
        navigationIndex: state.nextNavigationIndex++,
        route: state.pendingRoute,
        requestCount: state.requestCount,
        failedRequests: state.failedRequests,
        reading,
        // A failed write surfaces through state.pending at teardown, never as unhandled.
        timer: setTimeout(() => opened.commit().catch(() => {}), LEAVE_SETTLE_MS),
        write: null,
        commit: () => {
          if (opened.write === null) {
            clearTimeout(opened.timer);
            opened.write = writeSample(opened);
            state.pending.push(opened.write);
          }
          return opened.write;
        },
      };
      state.pendingRoute = null;
      state.openDocs.set(reading.docId, opened);
      doc = opened;
    } else if (doc.write === null) {
      doc.reading = reading;   // a later, more complete reading from the same document
    }
    // A fixture-driven flush awaits the write; a leaving document never waits on Node.
    if (reading.final) await doc.commit();
  });

  await page.addInitScript(trapSource(REPORT_BINDING, FLUSH_HOOK));
  flushBeforeNavigating(page);

  page.on('request', () => { state.requestCount++; });
  page.on('requestfailed', () => { state.failedRequests++; });
}

/**
 * Drive the trap's own flush for the CURRENT document via a synthetic call and await
 * the binding round-trip (which resolves only once the Sample is written and attached).
 * Best-effort: a page that already crashed, closed or navigated has nothing to flush.
 */
async function flushCurrentDocument(page: Page): Promise<void> {
  try {
    await page.evaluate(
      async (hook) => {
        const f = (window as unknown as Record<string, () => Promise<unknown>>)[hook];
        if (typeof f === 'function') await f();
      },
      FLUSH_HOOK,
    );
  } catch {
    // page gone / navigated / crashed — intermediate Samples already on disk survive.
  }
}

/**
 * Flush the current document before a test-driven navigation leaves it. From Playwright
 * 1.63 (Chromium RenderDocument) the leaving document can no longer reach Node once the
 * next one commits — a few ms after beforeunload, often before a just-made
 * interaction's event-timing entry exists (it needs the next paint). Flushing here,
 * with the same bounded paint wait as teardown, records the document as the test left
 * it. It runs between test steps, after the test is done with this document, so it
 * perturbs nothing measured. Link-click and script navigations still flush at
 * beforeunload.
 */
function flushBeforeNavigating(page: Page): void {
  for (const method of ['goto', 'reload', 'goBack', 'goForward'] as const) {
    const navigate = page[method].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      await flushCurrentDocument(page);
      return navigate(...args);
    };
  }
}

/**
 * Flush the last document's Navigation before the page closes. page.close() flushes
 * nothing, so we drive the trap's own flush, then settle any intermediate flushes still
 * in flight.
 */
async function flushOnTeardown(page: Page, state: CollectorState): Promise<void> {
  await flushCurrentDocument(page);
  // Documents still settling (left moments ago, or teardown could not reach them) are
  // written now with the last reading they sent.
  for (const doc of state.openDocs.values()) void doc.commit();
  await Promise.allSettled(state.pending);
}

/** The Outcome record's closed status vocabulary. testInfo.status can also be
 *  'interrupted' (ctrl-c) or undefined — Executions that never finished, which leave
 *  NO record by design. */
const OUTCOME_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  'passed',
  'failed',
  'timedOut',
  'skipped',
]);

/**
 * Write-then-attach the one Execution Outcome record. Runs in fixture teardown, where
 * testInfo.status IS final: teardown runs after the test body and all afterEach hooks,
 * and a timed-out test still reaches it (Playwright grants teardown its own budget).
 * A worker killed before teardown writes nothing — that ABSENCE is the crash signal;
 * no catch-all may fabricate a record for an Execution that never finished.
 */
async function writeOutcome(testInfo: TestInfo): Promise<void> {
  const status = testInfo.status;
  if (status === undefined || !OUTCOME_STATUSES.has(status as ExecutionStatus)) return;
  const outcome: ExecutionOutcome = {
    schemaVersion: SCHEMA_VERSION,
    test: testIdentity(testInfo),
    status: status as ExecutionStatus,
    // A retry is ANOTHER Execution: it re-runs this whole fixture graph and records its
    // own outcome (in a fresh worker, so the (repeat, worker) join stays unambiguous).
    retry: testInfo.retry,
  };
  // Same mandatory two-step as Samples. No index in the name: outputPath() is per-test
  // (a retry gets its own dir), so one Outcome per Execution never collides.
  const outPath = testInfo.outputPath(`${OUTCOME_ATTACHMENT_PREFIX}.json`);
  await writeFile(outPath, JSON.stringify(outcome), 'utf8');
  await testInfo.attach(OUTCOME_ATTACHMENT_PREFIX, {
    path: outPath,
    contentType: 'application/json',
  });
}

/**
 * The one knob on the whole surface, and it is optional. route() declares the Route for
 * the Navigation the page is CURRENTLY on — the most recent one — or, when called before
 * any navigation, for the next one. So `await page.goto('/order/12345');
 * vitals.route('/order/{id}')` reads naturally, and tagging an intermediate Navigation
 * works as long as the page is still on it. What route() cannot do is retro-tag a
 * Navigation the page has already left: its Sample flushed as the page left it and may
 * be on disk. Declaring nothing is a supported, correct state — the dashboard derives a
 * Route from the raw url, which is always kept regardless, and a declared Route wins
 * over a derived one.
 */
export interface VitalsControls {
  route(route: string): void;
}

type CollectorFixtures = {
  page: Page;
  vitals: VitalsControls;
  /** Internal — the per-test state `page` and `vitals` share. Not for testers. */
  _collectorState: CollectorState;
};

type CollectorWorkerFixtures = {
  /** Internal — the worker-scoped best-effort pusher. Not for testers. */
  _vitalsPusher: Pusher;
};

/**
 * The auto-fixture graph. Overriding `page` means the collector rides along on the exact
 * page the test drives — journey vitals, not a cold re-navigation — and the tester
 * writes nothing. Teardown runs even when the test body throws (try/finally), so every
 * Navigation recorded before a mid-journey crash survives.
 *
 * _collectorState is a dependency of BOTH page and vitals, so it sets up first and tears
 * down LAST — after page's teardown flush. That is why the Outcome write lives in ITS
 * teardown: every Sample is already on disk, and testInfo.status is final there.
 *
 * _vitalsPusher is WORKER-scoped: it sets up once when the worker starts and drains once
 * when the worker finishes all its tests (Phase 2). It is the ONLY place on the Engine
 * our code reliably runs — a Playwright custom reporter is not viable there (Taurus
 * launches with `--reporter`, overriding config reporters). When no destination is
 * enabled (local run, no creds) it is inert: `enqueue` is a no-op and no timer is set.
 */
export const test = base.extend<CollectorFixtures, CollectorWorkerFixtures>({
  _vitalsPusher: [
    async ({}, use) => {
      const pusher = new Pusher({
        destinations: createDestinationsFromEnv(),
        flushMs: resolveFlushMs(process.env),
      });
      pusher.start();
      await use(pusher);
      // Worker teardown: stop the timer and drain the tail within a bounded budget.
      await pusher.close();
    },
    { scope: 'worker', auto: true },
  ],

  _collectorState: async ({}, use, testInfo) => {
    const state: CollectorState = {
      nextNavigationIndex: 1,
      requestCount: 0,
      failedRequests: 0,
      pending: [],
      pendingRoute: null,
      openDocs: new Map(),
    };
    await use(state);
    await writeOutcome(testInfo);
  },

  // auto: the Outcome must exist for EVERY Execution, including tests that never touch
  // `page` — and `vitals` existing whether or not a spec destructures it keeps the
  // surface at one changed import. (A statically-skipped test never sets up fixtures at
  // all, so it leaves no record — observed behavior, pinned in the Seam 1 harness.)
  vitals: [
    async ({ _collectorState }, use) => {
      await use({
        route: (route: string) => {
          _collectorState.pendingRoute = route;
        },
      });
    },
    { auto: true },
  ],

  page: async ({ page, _collectorState, _vitalsPusher }, use, testInfo) => {
    await attachCollector(page, testInfo, _collectorState, _vitalsPusher);
    try {
      await use(page);
    } finally {
      await flushOnTeardown(page, _collectorState);
    }
  },
});

export { expect };
