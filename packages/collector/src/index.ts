// @bzm/playwright-vitals — the tester's one changed import.
//
//   - import { test, expect } from '@playwright/test';
//   + import { test, expect } from '@bzm/playwright-vitals';
//
// Adopting the collector is ONE changed import and nothing else: no per-Navigation
// call, no teardown hook the tester owns. Every Navigation the test drives leaves one
// Sample JSON file on disk (format v1), written to outputPath() then attach({ path }).
//
// This file is issue #1 — the tracer: TTFB and FCP only. LCP/CLS/INP are #3; the
// Execution Outcome record and the vitals.route() knob are #4. The seams those need
// are already cut here (an in-page trap that flushes on its own listeners; a Node-side
// binding that assembles and writes the Sample) so they slot in without reshaping this.
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
 */
interface RawReading {
  timeOrigin: number;
  url: string;
  ttfb: number | null;
  fcp: number | null;
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
    function readFcp() {
      var paints = performance.getEntriesByType('paint');
      for (var i = 0; i < paints.length; i++) {
        if (paints[i].name === 'first-contentful-paint') return paints[i].startTime;
      }
      return null;
    }
    // Synchronous report — reads the live performance timeline and pushes to Node once.
    // Used by pagehide / visibilitychange, where the page is being discarded and there is
    // no time to await: by navigation-away the FCP paint entry is already in the buffer.
    function report() {
      if (flushed) return Promise.resolve();
      if (location.href === 'about:blank') return Promise.resolve();  // no real Navigation
      flushed = true;
      var nav = performance.getEntriesByType('navigation')[0];
      var reading = {
        timeOrigin: performance.timeOrigin,
        url: location.href,
        ttfb: nav ? nav.responseStart : null,
        fcp: readFcp(),
        domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
        loadEventMs: nav ? nav.loadEventEnd : null,
        resourceCount: performance.getEntriesByType('resource').length
      };
      return window['${reportBinding}'](reading);
    }
    // Teardown flush — the page is still alive here, so we can wait for FCP. On a fast page
    // the last Navigation ends before its FCP paint entry is recorded; without this grace
    // window FCP would race to null. Bounded: FCP may legitimately never come, so we report
    // regardless after the timeout.
    function flushWithGrace() {
      if (flushed) return Promise.resolve();
      if (readFcp() !== null) return report();
      return new Promise(function (resolve) {
        var settled = false;
        var obs;
        function finish() {
          if (settled) return;
          settled = true;
          try { obs && obs.disconnect(); } catch (e) {}
          resolve(report());
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

/** value present -> measured; absent -> collection did not finalize it. */
function metric(value: number | null): Metric {
  return typeof value === 'number' && Number.isFinite(value)
    ? { value, status: 'ok' }
    : { value: null, status: 'not-finalized' };
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
