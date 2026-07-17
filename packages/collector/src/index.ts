// @bzm/playwright-vitals — the tester's one changed import.
//
//   - import { test, expect } from '@playwright/test';
//   + import { test, expect } from '@bzm/playwright-vitals';
//
// Adopting the collector is ONE changed import and nothing else: no per-Navigation
// call, no teardown hook the tester owns. Every Navigation the test drives leaves one
// Sample JSON file on disk (format v1), written to outputPath() then attach({ path }).
//
// Issue #1 cut the seams (an in-page trap that flushes on its own listeners; a Node-side
// binding that assembles and writes the Sample); issue #3 filled in the metric set: all
// five vitals — TTFB, FCP, LCP, CLS, INP — each as {value, status}, every status true.
// The Execution Outcome record and the vitals.route() knob are #4.
//
// The load-bearing decisions, all measured on real Engines (see SPEC.md):
//   * attach({ body }) writes NOTHING under Taurus and errors nowhere. The write-file-
//     to-outputPath()-then-attach({ path }) two-step is the ONLY transport that survives.
//   * Injection is passive addInitScript; the trap pushes to Node via exposeBinding on
//     flush. Never page.on('load') -> evaluate(), which perturbs the metric measured.
//   * page.close() flushes nothing, so the fixture flushes in teardown BEFORE the page
//     closes — via a synthetic event the hand-rolled listener still receives.
//   * Read only NAMED env variables. The Engine env holds a live SESSION_TOKEN; nothing
//     here ever serializes process.env or any subset of it.

import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  SCHEMA_VERSION,
  SAMPLE_ATTACHMENT_PREFIX,
  type Sample,
  type Metric,
  type MetricStatus,
  type TestIdentity,
} from '@bzm/vitals-format';

/** The binding the in-page trap calls to hand a raw reading back to Node. */
const REPORT_BINDING = '__bzmVitalsReport';
/** The in-page flush entry point the fixture teardown drives before the page closes. */
const FLUSH_HOOK = '__bzmVitalsFlush';

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
}

/**
 * The passive in-page trap. Runs via addInitScript on EVERY document the test drives
 * (every Navigation re-runs it), top frame only. It never touches the page during load;
 * it only reads the performance timeline at flush time and hands the reading to Node.
 *
 * Flush happens on the events a real navigation-away already fires (pagehide /
 * visibilitychange->hidden) — so intermediate Navigations flush naturally — and on the
 * FLUSH_HOOK the fixture teardown calls for the last document before it closes. The
 * listeners are hand-rolled, so the synthetic teardown event reaches them (the very
 * gate the popular web-vitals synthetic-event workaround trips over).
 *
 * NOTE: serialized and injected as a string, so it must be self-contained — no closure
 * over anything in this module. Binding/hook names are interpolated in.
 */
function trapSource(reportBinding: string, flushHook: string): string {
  return `(() => {
    if (window.top !== window) return;            // top frame only — ignore iframes
    var flushed = false;

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
    function inpTake(list) {
      var es = list.getEntries ? list.getEntries() : list;
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e.interactionId) continue;    // hover/scroll noise has interactionId 0
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

    // takeRecords() hands over entries the browser has generated but not yet delivered
    // to a callback — the synchronous half of the flush hardening. The pagehide flush
    // relies on it alone; the teardown flush also waits a paint first (below) for
    // durations still being finalized.
    function drain() {
      try { if (lcpObs) lcpTake(lcpObs.takeRecords()); } catch (e) { lcp = { value: null, status: 'error' }; }
      try { if (clsObs) clsTake(clsObs.takeRecords()); } catch (e) { cls = { value: null, status: 'error' }; }
      try { if (inpObs) inpTake(inpObs.takeRecords()); } catch (e) { inp = { value: null, status: 'error' }; }
      if (inp.status === 'no-interaction') {
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
    // and pushes to Node once. Used directly by pagehide / visibilitychange, where the
    // page is being discarded and there is no time to await. Every timeline read is
    // individually guarded: a throw costs THAT metric ('error'), never the Sample.
    function report() {
      if (flushed) return Promise.resolve();
      if (location.href === 'about:blank') return Promise.resolve();  // no real Navigation
      flushed = true;
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

    // Teardown flush — the page is still alive here, so we can wait. On a fast page the
    // last Navigation ends before its FCP paint entry is recorded; without this grace
    // window FCP (and the LCP candidate that rides the same paint) would race to null.
    // Bounded: FCP may legitimately never come, so we report regardless after 1500ms.
    function flushWithGrace() {
      if (flushed) return Promise.resolve();
      return new Promise(function (resolve) {
        function proceed() { afterNextPaint(function () { resolve(report()); }); }
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
    window.addEventListener('pagehide', report, { once: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') report();
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

/**
 * Wire the collector onto a page: expose the Node binding, inject the trap, and count
 * requests. Order matters — the binding and init script must exist before the page
 * navigates, so the trap the first document runs can call back.
 */
async function attachCollector(page: Page, testInfo: TestInfo, state: CollectorState): Promise<void> {
  const identity: TestIdentity = {
    file: basename(testInfo.file),
    title: testInfo.title,
    project: testInfo.project.name,
    repeat: testInfo.repeatEachIndex,
    worker: testInfo.workerIndex,
  };
  // The DERIVED per-Engine worker count (Taurus's --workers), never a declared concurrency.
  const workers = testInfo.config.workers ?? null;

  async function writeSample(reading: RawReading, navigationIndex: number): Promise<void> {
    const sample: Sample = {
      schemaVersion: SCHEMA_VERSION,
      ts: Math.round(reading.timeOrigin), // epoch ms at Navigation start — exactly one timestamp
      url: reading.url,
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
        requestCount: state.requestCount,
        failedRequests: state.failedRequests,
      },
    };

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
    // navigationIndex is claimed synchronously at call time, so ordering follows flush
    // order (= ts order) even when writes below run concurrently.
    const navigationIndex = state.nextNavigationIndex++;
    const p = writeSample(reading, navigationIndex);
    state.pending.push(p);
    await p;
  });

  await page.addInitScript(trapSource(REPORT_BINDING, FLUSH_HOOK));

  page.on('request', () => { state.requestCount++; });
  page.on('requestfailed', () => { state.failedRequests++; });
}

/**
 * Flush the last document's Navigation before the page closes. page.close() flushes
 * nothing, so we drive the trap's own flush via a synthetic call and await the binding
 * round-trip (which resolves only once the Sample is written and attached). Then we
 * settle any intermediate flushes still in flight. Best-effort: a page that already
 * crashed or closed simply has nothing left to flush.
 */
async function flushOnTeardown(page: Page, state: CollectorState): Promise<void> {
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
  await Promise.allSettled(state.pending);
}

/**
 * The auto-fixture. Overriding `page` means the collector rides along on the exact page
 * the test drives — journey vitals, not a cold re-navigation — and the tester writes
 * nothing. Teardown runs even when the test body throws (try/finally), so every
 * Navigation recorded before a mid-journey crash survives.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, testInfo) => {
    const state: CollectorState = {
      nextNavigationIndex: 1,
      requestCount: 0,
      failedRequests: 0,
      pending: [],
    };
    await attachCollector(page, testInfo, state);
    try {
      await use(page);
    } finally {
      await flushOnTeardown(page, state);
    }
  },
});

export { expect };
