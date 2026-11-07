// Seam 1 — C6 (#42): instrumentation lives on the CONTEXT, so every page a test opens in
// its fixture-provided context is measured: popups, context.newPage(), and the `page`
// fixture itself (the context's first page). Each Sample carries the pageIndex of the
// page it was measured on; navigationIndex stays unique across the whole Execution.
// A context the test creates itself with browser.newContext() is NOT measured.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateSample } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  runPlaywright,
  findSamples,
  findOutcomes,
  type FoundSample,
  type FoundOutcome,
} from './helpers/run-playwright';

let server: FixtureServer;
let samples: FoundSample[];
let outcomes: FoundOutcome[];
let runLog = '';
let exitCode: number | null = null;

function forTitle(title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

/** [pageIndex, pathname] per Sample, page by page and in ts order within a page. */
function pagesOf(title: string): Array<[number | undefined, string]> {
  return forTitle(title)
    .map((s) => s.sample)
    .sort((a, b) => (a.pageIndex ?? -1) - (b.pageIndex ?? -1) || a.ts - b.ts)
    .map((s) => [s.pageIndex, new URL(s.url).pathname]);
}

beforeAll(async () => {
  server = await startFixtureServer();
  const run = await runPlaywright({ spec: 'pages.spec.ts', baseURL: server.url });
  runLog = run.stdout + run.stderr;
  exitCode = run.exitCode;
  samples = await findSamples(run.outputDir);
  outcomes = await findOutcomes(run.outputDir);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('every page in the fixture-provided context is measured', () => {
  it('a popup opened via page.waitForEvent("popup") and then navigated gets Samples for both pages', () => {
    expect(pagesOf('Popup')).toEqual([
      [0, '/'],
      [1, '/second'],
      [1, '/third'],
    ]);
  });

  it('a page from context.newPage() gets Samples, alongside the page fixture', () => {
    expect(pagesOf('New Page Alongside Page')).toEqual([
      [0, '/'],
      [1, '/second'],
      [1, '/third'],
    ]);
  });

  it('a test that only uses `context`: its first page is pageIndex 0', () => {
    expect(pagesOf('Context Only')).toEqual([[0, '/']]);
  });

  it('a popup the test closes still leaves its Sample', () => {
    expect(pagesOf('Popup Closed By The Test')).toEqual([
      [0, '/'],
      [1, '/second'],
    ]);
  });

  it("a context the test closes itself still leaves every open page's Sample", () => {
    expect(pagesOf('Context Closed By The Test')).toEqual([
      [0, '/'],
      [1, '/second'],
    ]);
  });

  it('a context the test makes with browser.newContext() is not measured', () => {
    expect(forTitle('Own Browser Context Is Not Measured')).toEqual([]);
  });
});

describe('Sample identity across pages', () => {
  it('navigationIndex is unique within each Execution, 1..n, across all its pages', () => {
    for (const title of ['Popup', 'New Page Alongside Page', 'Popup Closed By The Test', 'Context Closed By The Test']) {
      const idx = forTitle(title).map((s) => s.sample.navigationIndex);
      expect(idx, title).toEqual(idx.map((_, i) => i + 1));
    }
  });

  it('every Sample is valid under the shared format validator', () => {
    expect(samples.length).toBeGreaterThan(0);
    for (const { path, sample } of samples) {
      const result = validateSample(sample);
      expect(result.ok, `${path}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("a popup's Samples are complete readings: ttfb/fcp ok, requestCount its own document's", () => {
    const popup = forTitle('Popup').filter((s) => s.sample.pageIndex === 1);
    expect(popup.length).toBe(2);
    for (const { sample } of popup) {
      expect(sample.vitals['ttfb']!.status, sample.url).toBe('ok');
      expect(sample.vitals['fcp']!.status, sample.url).toBe('ok');
      // The fixture pages fetch nothing: one document request each.
      expect(sample.context.requestCount, sample.url).toBe(1);
    }
  });
});

describe('Outcomes are unchanged: one per Execution, whatever the page count', () => {
  it('every test passed, and wrote exactly one Outcome', () => {
    expect(exitCode, runLog).toBe(0);
    const titles = outcomes.map((o) => o.outcome.test.title).sort();
    expect(titles).toEqual(
      [
        'Context Closed By The Test',
        'Context Only',
        'New Page Alongside Page',
        'Own Browser Context Is Not Measured',
        'Patches Are Per Page Instance',
        'Popup',
        'Popup Closed By The Test',
      ],
    );
    for (const { outcome } of outcomes) expect(outcome.status, outcome.test.title).toBe('passed');
  });

  it('methods are patched per page instance, never on the prototype (Patches Are Per Page Instance)', () => {
    expect(forTitle('Patches Are Per Page Instance').map((s) => s.sample.pageIndex)).toEqual([0]);
  });
});
