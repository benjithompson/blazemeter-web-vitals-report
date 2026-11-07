// bzm-playwright-vitals — the tester's one changed import.
//
//   - import { test, expect } from '@playwright/test';
//   + import { test, expect } from 'bzm-playwright-vitals';
//
// Adopting the collector is ONE changed import and nothing else: no per-Navigation
// call, no teardown hook the tester owns. Every Navigation the test drives leaves one
// Sample JSON file on disk (format v1), written to outputPath() then attach({ path }).
//
// Two seams: an in-page trap that flushes on its own listeners, and a Node-side binding
// that assembles and writes the Sample. A Sample carries all five vitals — TTFB, FCP,
// LCP, CLS, INP — each as {value, status}. The rest of the tester-facing surface is one
// Execution Outcome record per test (written in fixture teardown, where testInfo.status
// is final), and vitals.route() — the only knob, and an optional one.
//
// The load-bearing decisions, all measured on real Engines (see SPEC.md):
//   * attach({ body }) writes NOTHING under Taurus and errors nowhere. The write-file-
//     to-outputPath()-then-attach({ path }) two-step is the ONLY transport that survives.
//   * Injection is passive addInitScript; the trap pushes to Node via exposeBinding on
//     flush. Never page.on('load') -> evaluate(), which perturbs the metric measured.
//   * page.close() flushes nothing, so the fixture flushes in teardown BEFORE the context
//     closes, and a test's own page.close() flushes first — via a synthetic event the
//     hand-rolled listener still receives.
//   * Instrumentation is per CONTEXT: every page the test opens in the
//     fixture-provided context is measured — the `page` fixture, popups and
//     context.newPage() alike — and each Sample says which page by its pageIndex.
//   * A binding call from a document's pagehide never reaches Node once its frame is
//     swapped — cross-site always, and on every navigation from Playwright 1.63
//     (Chromium RenderDocument). So test-driven navigations flush BEFORE they navigate,
//     and link-click navigations flush at beforeunload.
//   * Read only NAMED env variables. The Engine env holds a live SESSION_TOKEN; nothing
//     here ever serializes process.env or any subset of it.

import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page, Request, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import {
  SCHEMA_VERSION,
  SAMPLE_ATTACHMENT_PREFIX,
  OUTCOME_ATTACHMENT_PREFIX,
  isCollectorMetricStatus,
  isExecutionStatus,
  type Sample,
  type Metric,
  type TestIdentity,
  type ExecutionOutcome,
} from 'bzm-vitals-format';
import { Pusher, resolveFlushMs, PUSH_STATUS_ATTACHMENT_PREFIX } from './pusher.js';
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

/**
 * Per-Execution collection state: one test, one fixture-provided context, and every page
 * opened in it. navigationIndex and the pending route are per Execution; request counts
 * are per page (see PageState).
 */
interface CollectorState {
  /**
   * navigationIndex is 1-based and increments per Navigation within an Execution — across
   * ALL its pages, so it stays unique per Execution (and so does the Sample's file name).
   * It is claimed when a document first reports, so within one page it follows ts order;
   * across pages it follows the order Navigations began to leave. ts is the time order.
   */
  nextNavigationIndex: number;
  /** pageIndex is 0-based: the context's first page is 0, then one per page, in open order. */
  nextPageIndex: number;
  /** Every measured page, in open order (a Map keeps insertion order). */
  pages: Map<Page, PageState>;
  /** Registers a page with the collector (idempotent). Set once the context is attached. */
  trackPage: ((page: Page) => PageState) | null;
  /** In-flight writes; teardown awaits these so no Sample is lost to a race. */
  pending: Promise<void>[];
  /**
   * The route declared via vitals.route(), waiting for its Sample. Consumed
   * synchronously with the navigationIndex claim (see the binding), so it lands on the
   * Navigation that reports next — with one page, the one the page was on when route()
   * was called. It is per Execution, not per page: with several pages open, whichever
   * page's document reports first takes it.
   */
  pendingRoute: string | null;
  /** Documents whose Sample is claimed but not yet written — teardown writes them. */
  openDocs: Map<string, OpenDoc>;
}

/** Per-page state: the requests of the page's CURRENT document. */
interface PageState {
  /** Which page of the Execution's context this is — the Sample's pageIndex. */
  pageIndex: number;
  /**
   * Requests the CURRENT document has made: its own document request, then everything it
   * fetched (subframes included). Reset when the next document commits — see
   * countRequestsPerDocument.
   */
  requestCount: number;
  /**
   * Main-frame document requests (and their redirects) for a document that has not
   * committed yet. They belong to the NEXT document, so they wait here instead of
   * inflating the leaving one's count.
   */
  incomingDocumentRequests: number;
  failedRequests: number;
}

/**
 * A document that has reported but whose Sample is not written yet. It takes its
 * navigationIndex, route and request counts at its FIRST reading — the moment it began
 * to leave — and its vitals from its LAST reading.
 */
interface OpenDoc {
  navigationIndex: number;
  pageIndex: number;
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
    //
    // An interaction is SEEN when any entry for it arrives: an 'event' entry (only for
    // durations >= the 16ms durationThreshold) or the 'first-input' entry, which the
    // browser emits for the first interaction whatever its duration. Without the
    // latter, a journey whose clicks were all fast read as 'no-interaction' — a claim
    // that nothing was clicked. Later fast interactions still go unobserved, which is
    // correct: INP is the WORST interaction, and one at or over 16ms would be observed.
    var inp = { value: null, status: 'unsupported' };
    var inpObs = null;
    var interactions = {};   // interactionId -> worst duration seen
    var lastEntryStart = -1; // latest startTime among interaction entries seen
    function inpTake(list) {
      var es = list.getEntries ? list.getEntries() : list;
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        // hover/scroll noise has interactionId 0. A first-input entry always counts —
        // under its own key if this engine gave it no interactionId; max() makes a
        // double count of the same interaction harmless.
        var key = e.interactionId || (e.entryType === 'first-input' ? 'first-input' : 0);
        if (!key) continue;
        if (e.startTime > lastEntryStart) lastEntryStart = e.startTime;
        var prev = interactions[key];
        if (prev === undefined || e.duration > prev) interactions[key] = e.duration;
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
      // Same observer, so drain()'s takeRecords() covers both types. Best-effort: an
      // engine without first-input keeps the event-only behaviour.
      if (inpObs !== null && supported.indexOf('first-input') >= 0) {
        try { inpObs.observe({ type: 'first-input', buffered: true }); } catch (e) {}
      }
    }

    // An interaction's event-timing entry only exists once its next frame is PRESENTED,
    // which trails the paint by a variable few ms (measured: sometimes after two rAFs).
    // A flush that can wait therefore waits for the latest input's entry — bounded,
    // because an interaction under the 16ms threshold (other than the first input) never
    // gets one. The listeners are
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
      // A fresh page's (or popup's) initial about:blank is no Navigation and reports
      // nothing, so there is no paint to wait for before it is left.
      if (location.href === 'about:blank') return Promise.resolve();
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
 * format's COLLECTOR_METRIC_STATUSES — the closed set MINUS 'unknown' (the legacy
 * adapter's alone — never written here); anything malformed lands as 'error' rather than
 * inventing a status, and a value survives only when the status says it was measured.
 */
function metric(raw: RawMetric | undefined): Metric {
  const status = raw?.status;
  if (!isCollectorMetricStatus(status)) return { value: null, status: 'error' };
  if (status === 'ok') {
    return typeof raw?.value === 'number' && Number.isFinite(raw.value)
      ? { value: raw.value, status: 'ok' }   // CLS is a true float — never round here
      : { value: null, status: 'error' };
  }
  return { value: null, status };
}

/** The identity every record carries — the same fields on a Sample and its Outcome, so
 *  the (repeat, worker) join is between values read from ONE source at ONE place.
 *
 *  (file, title, project) is kept exactly as 0.2.x wrote it, but it collides: two
 *  describe blocks may hold the same title, and two folders the same spec basename.
 *  `id`, `titlePath` and `path` disambiguate:
 *  - `id` is Playwright's testId, which hashes the spec path, the title path and the
 *    project, so it is unique per Test and stable across runs and Engines.
 *  - `titlePath` drops element 0, which in Playwright 1.63 is the spec path relative to
 *    testDir (already in `path`). The project name is NOT in testInfo.titlePath (it is
 *    in `project`), so nothing else is dropped: what remains is the describe chain plus
 *    the title.
 *  - `path` is relative to the project's testDir, with POSIX separators so a Windows
 *    and a Linux Engine write the same key. */
function testIdentity(testInfo: TestInfo): TestIdentity {
  return {
    file: basename(testInfo.file),
    title: testInfo.title,
    project: testInfo.project.name,
    repeat: testInfo.repeatEachIndex,
    worker: testInfo.workerIndex,
    id: testInfo.testId,
    titlePath: testInfo.titlePath.slice(1),
    path: relative(testInfo.project.testDir, testInfo.file).split(sep).join('/'),
  };
}

/**
 * Wire the collector onto the test's context: expose the Node binding and inject the trap
 * for every page in it, and track each page as it opens (request counts, flush patching).
 * Order matters — the binding and init script must exist before any page navigates, so
 * the trap the first document runs can call back. Returns the page registrar.
 */
async function attachCollector(
  context: BrowserContext,
  testInfo: TestInfo,
  state: CollectorState,
  pusher: Pusher,
): Promise<(page: Page) => PageState> {
  const identity = testIdentity(testInfo);
  // The DERIVED per-Engine worker count (Taurus's --workers), never a declared concurrency.
  const workers = testInfo.config.workers ?? null;

  async function writeSample(doc: OpenDoc): Promise<void> {
    const { reading, navigationIndex, pageIndex, route } = doc;
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
      pageIndex,
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

  /** Orphan document requests of pages not yet reported, by URL (see noteEarlyDocumentRequest). */
  const earlyDocumentRequests = new Map<string, number>();

  /**
   * Register a page: its pageIndex is claimed here, in the order pages open (the context's
   * 'page' event fires before newPage() resolves and before the opener's 'popup'), and its
   * navigation methods are patched on THIS instance before the test can call them.
   * Idempotent.
   */
  function trackPage(page: Page): PageState {
    const known = state.pages.get(page);
    if (known !== undefined) return known;
    const created: PageState = {
      pageIndex: state.nextPageIndex++,
      requestCount: 0,
      incomingDocumentRequests: 0,
      failedRequests: 0,
    };
    state.pages.set(page, created);
    flushBeforeNavigating(page);
    adoptEarlyDocumentRequest(page, created, earlyDocumentRequests);
    countRequestsPerDocument(page, created);
    page.on('requestfailed', () => { created.failedRequests++; });
    return created;
  }

  await context.exposeBinding(REPORT_BINDING, async (source, reading: RawReading) => {
    const pageState = trackPage(source.page);
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
        pageIndex: pageState.pageIndex,
        route: state.pendingRoute,
        requestCount: pageState.requestCount,
        failedRequests: pageState.failedRequests,
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

  await context.addInitScript(trapSource(REPORT_BINDING, FLUSH_HOOK));

  // Pages already open (a reused context) first, in their order; then each new one —
  // the `page` fixture's own, context.newPage(), a popup — as the context reports it.
  for (const page of context.pages()) trackPage(page);
  context.on('page', (page) => { trackPage(page); });
  flushBeforeClosingContext(context);
  context.on('request', (request) => noteEarlyDocumentRequest(request, earlyDocumentRequests));
  return trackPage;
}

/**
 * A popup is reported (context 'page', opener 'popup') only once its first document has
 * COMMITTED (measured on Chromium, Playwright 1.63). Its document request reaches the
 * context before that, with no frame or page Node can attribute it to, and never reaches
 * a page listener. So such orphan document requests are held here by URL (a redirect
 * chain folds into its last hop), and the page adopts the one its committed URL matches
 * when it is reported: its first Sample's requestCount is then its own document's, as
 * for every other Navigation. A request with a page is that page's own listener's.
 */
function noteEarlyDocumentRequest(request: Request, early: Map<string, number>): void {
  let orphan: boolean;
  try {
    orphan = request.frame().page() === null;
  } catch {
    orphan = true; // no frame (yet)
  }
  if (!orphan || !request.isNavigationRequest()) return;
  let hops = 1;
  const from = request.redirectedFrom();
  if (from !== null) {
    hops += early.get(withoutHash(from.url())) ?? 0;
    early.delete(withoutHash(from.url()));
  }
  early.set(withoutHash(request.url()), hops);
}

/** A newly reported page whose first document already committed takes its document request. */
function adoptEarlyDocumentRequest(page: Page, state: PageState, early: Map<string, number>): void {
  const url = withoutHash(page.mainFrame().url());
  const hops = early.get(url);
  if (hops === undefined || url === 'about:blank') return;
  early.delete(url);
  state.requestCount = hops;
}

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/**
 * requestCount is per document, not per page. Each request belongs to the document that
 * was current when it was made — except a main-frame document request, which belongs to
 * the document it fetches. The count resets when that document COMMITS (main-frame
 * framenavigated), not when its request starts: a leaving document's first reading
 * (beforeunload, or the flush before a test-driven goto) always reaches Node before the
 * next document can commit, so its count is snapshotted from its own requests only. A
 * same-document navigation (pushState, #hash) commits with no document request in
 * flight and resets nothing.
 */
function countRequestsPerDocument(page: Page, state: PageState): void {
  page.on('request', (request) => {
    let isDocumentRequest = false;
    try {
      isDocumentRequest = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // A service-worker request has no frame — it is the current document's.
    }
    if (isDocumentRequest) state.incomingDocumentRequests++;
    else state.requestCount++;
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || state.incomingDocumentRequests === 0) return;
    state.requestCount = state.incomingDocumentRequests;
    state.incomingDocumentRequests = 0;
  });
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
 * The Page methods that leave the current document, patched to flush it first.
 * test/page-methods.test.ts fails if Playwright ever renames one (a renamed method would
 * stop flushing), and keeps its copy of this list in step. `close` is here because
 * page.close() itself flushes nothing: a popup the test closes would otherwise lose its
 * last Sample.
 */
const NAVIGATING_PAGE_METHODS = ['goto', 'reload', 'goBack', 'goForward', 'close'] as const;

/** Pages whose methods are already patched, so a page is never wrapped twice. */
const patchedPages = new WeakSet<Page>();

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
  // Patched on THIS page instance as own properties, never on Page.prototype: pages the
  // collector does not measure (a browser.newContext() of the test's own) keep
  // Playwright's methods untouched.
  if (patchedPages.has(page)) return;
  patchedPages.add(page);
  for (const method of NAVIGATING_PAGE_METHODS) {
    const navigate = page[method].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      await flushCurrentDocument(page);
      return navigate(...args);
    };
  }
}

/** Per context: whether its wrapped close() still has to flush its pages first. */
const contextCloseGates = new WeakMap<BrowserContext, { armed: boolean }>();

/**
 * A test that closes its context itself (context.close() in the body) would otherwise
 * lose every open page's last Navigation: closing flushes nothing, and teardown then finds
 * the pages gone. So close() is wrapped, on this instance, to flush the open pages first.
 * It reads the pages from the context, not from per-test state, so a context Playwright
 * reuses across tests stays correct; arming again on reuse never wraps twice.
 */
function flushBeforeClosingContext(context: BrowserContext): void {
  const known = contextCloseGates.get(context);
  if (known !== undefined) {
    known.armed = true;
    return;
  }
  const gate = { armed: true };
  contextCloseGates.set(context, gate);
  const close = context.close.bind(context) as (...args: unknown[]) => Promise<void>;
  (context as unknown as Record<string, unknown>)['close'] = async (...args: unknown[]) => {
    if (gate.armed) {
      gate.armed = false;
      for (const page of context.pages()) {
        if (!page.isClosed()) await flushCurrentDocument(page);
      }
    }
    return close(...args);
  };
}

/**
 * Flush every open page's last document before the context closes. Closing flushes
 * nothing, so we drive the trap's own flush on each page — one at a time, in open order,
 * so their navigationIndex claims are deterministic — then settle any intermediate
 * flushes still in flight.
 */
async function flushOnTeardown(context: BrowserContext, state: CollectorState): Promise<void> {
  // Playwright closes the context right after this; that close need not flush again.
  const gate = contextCloseGates.get(context);
  if (gate !== undefined) gate.armed = false;
  for (const page of state.pages.keys()) {
    if (!page.isClosed()) await flushCurrentDocument(page);
  }
  // Documents still settling (left moments ago, or teardown could not reach them) are
  // written now with the last reading they sent.
  for (const doc of state.openDocs.values()) void doc.commit();
  await Promise.allSettled(state.pending);
}

/**
 * Write-then-attach the one Execution Outcome record. Runs in fixture teardown, where
 * testInfo.status IS final: teardown runs after the test body and all afterEach hooks,
 * and a timed-out test still reaches it (Playwright grants teardown its own budget).
 * A worker killed before teardown writes nothing — that ABSENCE is the crash signal;
 * no catch-all may fabricate a record for an Execution that never finished.
 */
async function writeOutcome(testInfo: TestInfo): Promise<void> {
  const status = testInfo.status;
  // The closed vocabulary is format's EXECUTION_STATUSES. testInfo.status can also be
  // 'interrupted' (ctrl-c) or undefined — Executions that never finished, which leave
  // NO record by design.
  if (!isExecutionStatus(status)) return;
  const outcome: ExecutionOutcome = {
    schemaVersion: SCHEMA_VERSION,
    test: testIdentity(testInfo),
    status,
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
 * The last test each worker's pusher served — the worker-scoped fixture has no TestInfo of
 * its own, so the Push Status is attached through this one after the drain. Set by
 * `context`, the fixture every measured page comes from.
 */
const pushStatusTarget = new WeakMap<Pusher, TestInfo>();

/**
 * Write-then-attach the worker's Push Status (per destination: sent / failed / dropped /
 * lastError) after the teardown drain, through the same mandatory two-step as Samples. Only
 * when a destination was enabled — the local path writes nothing. It is attached via the
 * worker's last test, after that test has been reported, so it lands on disk (which is what
 * the Engine collects) rather than in a reporter's listing. Best-effort: never throws.
 */
async function writePushStatus(pusher: Pusher, workerIndex: number): Promise<void> {
  const status = pusher.status();
  const testInfo = pushStatusTarget.get(pusher);
  if (status.length === 0 || testInfo === undefined) return;
  try {
    const name = `${PUSH_STATUS_ATTACHMENT_PREFIX}-${workerIndex}`;
    const outPath = testInfo.outputPath(`${name}.json`);
    await writeFile(outPath, JSON.stringify({ worker: workerIndex, destinations: status }), 'utf8');
    await testInfo.attach(name, { path: outPath, contentType: 'application/json' });
  } catch (err) {
    process.stderr.write(`[bzm-vitals] push status not written: ${err instanceof Error ? err.message : String(err)}\n`);
  }
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
  context: BrowserContext;
  page: Page;
  vitals: VitalsControls;
  /** Internal — the per-test state `context`, `page` and `vitals` share. Not for testers. */
  _collectorState: CollectorState;
};

type CollectorWorkerFixtures = {
  /** Internal — the worker-scoped best-effort pusher. Not for testers. */
  _vitalsPusher: Pusher;
};

/**
 * The auto-fixture graph. Overriding `context` means the collector rides along on the
 * exact pages the test drives — journey vitals, not a cold re-navigation — and the
 * tester writes nothing. Every page opened in that context is measured: `page` (the
 * context's first page), popups, context.newPage(). A context the test creates itself
 * with browser.newContext() is outside the fixture graph and is NOT measured. Teardown
 * runs even when the test body throws (try/finally), so every Navigation recorded before
 * a mid-journey crash survives.
 *
 * _collectorState is a dependency of context, page and vitals, so it sets up first and
 * tears down LAST — after context's teardown flush (which runs before Playwright closes
 * the context). That is why the Outcome write lives in ITS teardown: every Sample is
 * already on disk, and testInfo.status is final there.
 *
 * _vitalsPusher is WORKER-scoped: it sets up once when the worker starts and drains once
 * when the worker finishes all its tests (Phase 2). It is the ONLY place on the Engine
 * our code reliably runs — a Playwright custom reporter is not viable there (Taurus
 * launches with `--reporter`, overriding config reporters). When no destination is
 * enabled (local run, no creds) it is inert: `enqueue` is a no-op and no timer is set.
 */
export const test = base.extend<CollectorFixtures, CollectorWorkerFixtures>({
  _vitalsPusher: [
    async ({}, use, workerInfo) => {
      const pusher = new Pusher({
        destinations: createDestinationsFromEnv(),
        flushMs: resolveFlushMs(process.env),
        // Failures are loud but never flood: the pusher emits each distinct reason once
        // per destination.
        onWarn: (message) => process.stderr.write(`[bzm-vitals] ${message}\n`),
      });
      pusher.start();
      await use(pusher);
      // Worker teardown: stop the timer and drain the tail within a bounded budget, then
      // record what happened to every Sample this worker pushed.
      await pusher.close();
      await writePushStatus(pusher, workerInfo.workerIndex);
    },
    { scope: 'worker', auto: true },
  ],

  _collectorState: async ({}, use, testInfo) => {
    const state: CollectorState = {
      nextNavigationIndex: 1,
      nextPageIndex: 0,
      pages: new Map(),
      trackPage: null,
      pending: [],
      pendingRoute: null,
      openDocs: new Map(),
    };
    await use(state);
    await writeOutcome(testInfo);
  },

  // auto: the Outcome must exist for EVERY Execution, including tests that never touch
  // `page` or `context` — and `vitals` existing whether or not a spec destructures it
  // keeps the surface at one changed import. (A statically-skipped test never sets up fixtures at
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

  context: async ({ context, _collectorState, _vitalsPusher }, use, testInfo) => {
    pushStatusTarget.set(_vitalsPusher, testInfo);
    _collectorState.trackPage = await attachCollector(context, testInfo, _collectorState, _vitalsPusher);
    try {
      await use(context);
    } finally {
      await flushOnTeardown(context, _collectorState);
    }
  },

  // The context's first page. The context's 'page' event (or, for a page Playwright
  // reuses, attachCollector's sweep of context.pages()) has already registered it as
  // pageIndex 0; registering again is idempotent, and only a safety net.
  page: async ({ page, _collectorState }, use) => {
    _collectorState.trackPage?.(page);
    await use(page);
  },
});

export { expect };
