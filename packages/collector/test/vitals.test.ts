// Seam 1 — issue #3: all five vitals as {value, status}, every status TRUE. Same seam
// discipline as tracer.test.ts: real Playwright child runs, assertions on the JSON files
// that survive on disk. Three runs feed every assertion here:
//
//   normal   — vitals.spec.ts on chromium: the happy path, the flush hardening, INP,
//              CLS session windows, and the no-isTrusted-gate proof (the flush is a
//              synthetic evaluate/pagehide, and LCP is still 'ok').
//   firefox  — vitals.spec.ts on firefox: no LayoutShift API. The Sample must STILL be
//              emitted with cls 'unsupported' — the incumbent's silent non-Chromium skip
//              is the named defect this issue exists to kill.
//   hostile  — hostile.spec.ts on chromium: the page shadows a flush-time read with a
//              thrower. A throw costs that metric ('error'), never the Sample.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Metric } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { runPlaywright, findSamples, type FoundSample } from './helpers/run-playwright';

/** The collector's closed vocabulary: format v1's MetricStatus MINUS 'unknown', which
 *  is the legacy adapter's alone. The collector never writes it. */
const COLLECTOR_VOCAB = new Set(['ok', 'unsupported', 'no-interaction', 'not-finalized', 'error']);
const FIVE_VITALS = ['ttfb', 'fcp', 'lcp', 'cls', 'inp'] as const;

let server: FixtureServer;
let normal: FoundSample[];
let firefox: FoundSample[];
let hostile: FoundSample[];

/** Every Sample from every run — for the vocabulary-wide assertions. */
function allSamples(): FoundSample[] {
  return [...normal, ...firefox, ...hostile];
}

function vital(s: FoundSample, name: string): Metric {
  const m = s.sample.vitals[name];
  expect(m, `vitals.${name} on ${s.path}`).toBeDefined();
  return m!;
}

function forTitle(samples: FoundSample[], title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

beforeAll(async () => {
  server = await startFixtureServer();
  const [normalRun, firefoxRun, hostileRun] = await Promise.all([
    runPlaywright({ spec: 'vitals.spec.ts', baseURL: server.url }),
    runPlaywright({ spec: 'vitals.spec.ts', baseURL: server.url, project: 'firefox' }),
    runPlaywright({ spec: 'hostile.spec.ts', baseURL: server.url }),
  ]);
  normal = await findSamples(normalRun.outputDir);
  firefox = await findSamples(firefoxRun.outputDir);
  hostile = await findSamples(hostileRun.outputDir);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('all five vitals, as {value, status}, on every Sample', () => {
  it('every Sample from every run carries ttfb/fcp/lcp/cls/inp as {value, status}', () => {
    expect(allSamples().length).toBeGreaterThan(0);
    for (const s of allSamples()) {
      for (const name of FIVE_VITALS) {
        const m = vital(s, name);
        expect(m, `${name} on ${s.path}`).toHaveProperty('value');
        expect(m, `${name} on ${s.path}`).toHaveProperty('status');
      }
    }
  });

  it('every status is within the closed vocabulary, and value is a finite number iff ok', () => {
    for (const s of allSamples()) {
      for (const [name, m] of Object.entries(s.sample.vitals)) {
        expect(COLLECTOR_VOCAB.has(m.status), `${name}=${m.status} on ${s.path}`).toBe(true);
        if (m.status === 'ok') {
          expect(typeof m.value, `${name} ok value on ${s.path}`).toBe('number');
          expect(Number.isFinite(m.value), `${name} ok value on ${s.path}`).toBe(true);
        } else {
          expect(m.value, `${name} non-ok value on ${s.path}`).toBeNull();
        }
      }
    }
  });

  it("the collector never writes 'unknown' — that status is the legacy adapter's alone", () => {
    for (const s of allSamples()) {
      for (const [name, m] of Object.entries(s.sample.vitals)) {
        expect(m.status, `${name} on ${s.path}`).not.toBe('unknown');
      }
    }
  });

  it('supporting timings ride along; fullpageloadtime is NOT reintroduced', () => {
    for (const s of allSamples()) {
      expect(s.sample.navigation).toHaveProperty('domContentLoadedMs');
      expect(s.sample.navigation).toHaveProperty('loadEventMs');
      // fullpageloadtime duplicated loadEventMs in the incumbent; it must not come back.
      expect(Object.keys(s.sample.vitals)).not.toContain('fullpageloadtime');
    }
  });
});

describe('the normal journey on chromium', () => {
  it('ttfb, fcp and lcp are ok on every Navigation — and the flush was synthetic, so an '
    + 'isTrusted gate anywhere in the LCP path would have dropped it', () => {
    expect(normal.length).toBeGreaterThan(0);
    for (const s of normal) {
      for (const name of ['ttfb', 'fcp', 'lcp'] as const) {
        expect(vital(s, name).status, `${name} on ${s.path}`).toBe('ok');
      }
    }
  });

  it('cls is ok with value > 0 — the session windows saw the 50ms layout shift', () => {
    for (const s of normal) {
      const cls = vital(s, 'cls');
      expect(cls.status, s.path).toBe('ok');
      expect(cls.value, s.path).toBeGreaterThan(0);
    }
  });

  it('cls is a true float, never rounded to an integer', () => {
    // A 120px shift on a desktop viewport yields a small fraction; a rounded/int CLS
    // here would read 0 — the exact lie the true-float rule exists to prevent.
    for (const s of normal) {
      const cls = vital(s, 'cls');
      expect(Number.isInteger(cls.value), `cls=${cls.value} on ${s.path}`).toBe(false);
      expect(cls.value).toBeLessThan(1);
    }
  });

  it('the clicked Navigation reports inp ok (>= the 16ms durationThreshold floor)', () => {
    const clicked = forTitle(normal, 'Click Then Navigate')
      .filter((s) => s.sample.navigationIndex === 1);
    expect(clicked.length).toBe(1);
    const inp = vital(clicked[0]!, 'inp');
    expect(inp.status).toBe('ok');
    expect(inp.value).toBeGreaterThanOrEqual(16);
  });

  it("a Navigation without a click reports inp {value: null, status: 'no-interaction'} — never 0, never absent", () => {
    const noClick = [
      ...forTitle(normal, 'Navigate Only'),
      ...forTitle(normal, 'Click Then Navigate').filter((s) => s.sample.navigationIndex === 2),
    ];
    expect(noClick.length).toBe(2);
    for (const s of noClick) {
      const inp = vital(s, 'inp');
      expect(inp.status, s.path).toBe('no-interaction');
      expect(inp.value, s.path).toBeNull();
    }
  });

  it('CLS survives page close — the teardown flush ran BEFORE the close that flushes nothing', () => {
    // 'Navigate Only' never navigates away, so its only flush is the teardown one.
    const s = forTitle(normal, 'Navigate Only')[0]!;
    expect(vital(s, 'cls').status).toBe('ok');
    expect(vital(s, 'cls').value).toBeGreaterThan(0);
  });

  it("an intermediate Navigation's LCP/CLS/INP survive the pagehide flush", () => {
    // Navigation 1 of 'Click Then Navigate' was flushed by navigating away, not by
    // teardown — its late-finalizing metrics must already have been captured.
    const nav1 = forTitle(normal, 'Click Then Navigate')
      .filter((s) => s.sample.navigationIndex === 1)[0]!;
    expect(vital(nav1, 'lcp').status).toBe('ok');
    expect(vital(nav1, 'cls').status).toBe('ok');
    expect(vital(nav1, 'cls').value).toBeGreaterThan(0);
    expect(vital(nav1, 'inp').status).toBe('ok');
  });
});

describe('a non-Chromium project still emits Samples', () => {
  it('firefox emitted a Sample per Navigation — the incumbent skipped these entirely', () => {
    // 2 tests, 3 Navigations total, single repeat.
    expect(firefox.length).toBe(3);
    for (const s of firefox) {
      expect(s.sample.test.project).toBe('firefox');
    }
  });

  it("cls is {value: null, status: 'unsupported'} — never a fake 0", () => {
    for (const s of firefox) {
      const cls = vital(s, 'cls');
      expect(cls.status, s.path).toBe('unsupported');
      expect(cls.value, s.path).toBeNull();
    }
  });

  it('ttfb and fcp are still ok on firefox', () => {
    for (const s of firefox) {
      expect(vital(s, 'ttfb').status, s.path).toBe('ok');
      expect(vital(s, 'fcp').status, s.path).toBe('ok');
    }
  });
});

describe("a metric whose collection throws lands as status 'error' — the Sample still emits", () => {
  it('the hostile page cost ttfb and fcp (flush-time reads), not the file', () => {
    expect(hostile.length).toBe(1);
    const s = hostile[0]!;
    for (const name of ['ttfb', 'fcp'] as const) {
      const m = vital(s, name);
      expect(m.status, `${name} on ${s.path}`).toBe('error');
      expect(m.value, `${name} on ${s.path}`).toBeNull();
    }
  });

  it('observer-backed metrics on the same page survive the sabotage', () => {
    const s = hostile[0]!;
    expect(vital(s, 'lcp').status).toBe('ok');
    expect(vital(s, 'cls').status).toBe('ok');
    expect(vital(s, 'cls').value).toBeGreaterThan(0);
  });
});
