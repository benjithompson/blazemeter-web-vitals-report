// Synthetic Engines at scale, for the size and speed budgets (E1). Shaped like
// a real collector run, not like one repeated template: every Execution has a
// testId and an Outcome (1 in 10 failed, so the include-failed toggle is
// live), performs NAV_PER_EXECUTION Navigations over a handful of Routes, and
// each Navigation carries all five vitals with pseudo-random values (a fixed
// LCG, so the output is deterministic but compresses like measured data, not
// like a constant).
import type { EngineRecords, RecordFile } from '../../src/report.js';

const NAV_PER_EXECUTION = 4;
const ROUTES = ['/', '/search', '/product', '/cart', '/checkout'];
const T0 = 1752700000000;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** `samples` Samples spread over `engines` Engines (sessions r-v4-syn-0…). */
export function syntheticEngines(samples: number, engines = 2): EngineRecords[] {
  const rand = lcg(42);
  const out: EngineRecords[] = [];
  const perEngine = Math.ceil(samples / engines);
  let made = 0;
  for (let e = 0; e < engines; e++) {
    const sessionId = `r-v4-syn-${e}`;
    const files: RecordFile[] = [];
    const count = Math.min(perEngine, samples - made);
    for (let i = 0; i < count; i += NAV_PER_EXECUTION) {
      const execution = (made + i) / NAV_PER_EXECUTION;
      const flow = execution % 3;
      const test = {
        file: 'journeys.spec.ts',
        title: `journey ${flow}`,
        project: 'chromium',
        repeat: execution,
        worker: execution % 8,
        id: `syn-${flow}-chromium`,
        titlePath: ['journeys', `journey ${flow}`],
        path: `e2e/journeys.spec.ts`,
      };
      const failed = execution % 10 === 9;
      files.push({
        file: `${sessionId}/bzm-vitals-outcome-${execution}.json`,
        read: async () =>
          JSON.stringify({ schemaVersion: 1, test, status: failed ? 'failed' : 'passed', retry: 0 }),
      });
      for (let k = 0; k < NAV_PER_EXECUTION && i + k < count; k++) {
        const n = made + i + k;
        const route = ROUTES[(flow + k) % ROUTES.length]!;
        const lcp = Math.round(900 + rand() * 3500 + (failed ? 1500 : 0));
        const record = {
          schemaVersion: 1,
          ts: T0 + n * 37 + Math.round(rand() * 30),
          url: `https://shop.example.com${route}?q=${Math.floor(rand() * 500)}`,
          test,
          navigationIndex: k,
          vitals: {
            ttfb: { value: Math.round(80 + rand() * 600), status: 'ok' },
            fcp: { value: Math.round(500 + rand() * 1500), status: 'ok' },
            lcp: { value: lcp, status: 'ok' },
            cls: { value: Math.round(rand() * 300) / 1000, status: 'ok' },
            inp:
              k === 0
                ? { value: null, status: 'no-interaction' }
                : { value: Math.round(40 + rand() * 400), status: 'ok' },
          },
          navigation: {
            domContentLoadedMs: Math.round(600 + rand() * 1200),
            loadEventMs: Math.round(1200 + rand() * 2000),
          },
          context: {
            workers: 8,
            resourceCount: 20 + Math.floor(rand() * 40),
            requestCount: 25 + Math.floor(rand() * 40),
            failedRequests: rand() < 0.05 ? 1 : 0,
          },
        };
        files.push({ file: `${sessionId}/bzm-vitals-sample-${n}.json`, read: async () => JSON.stringify(record) });
      }
    }
    made += count;
    out.push({ sessionId, locationId: 'us-west-1', status: 'ENDED', artifact: 'present', files });
  }
  return out;
}
