// Seam 3 — issue #10: the format-drift guard.
//
// ONE cross-package test: the collector's REAL emitted files — produced by actual
// Playwright child runs via the Seam 1 harness, never hand-authored — fed straight into
// the dashboard's parser, asserted to round-trip COMPLETELY. The monorepo's atomicity
// argument only pays off if something actually checks; shared TypeScript types don't run
// at runtime, and the format is plain JSON on disk. This file is the thing that looks
// from both sides at once.
//
// What "round-trip completely" means here, and why each part exists:
//   - deep-equal of the parsed record against JSON.parse of the raw bytes — catches
//     silent REWRITING (the cls:0-vs-null class of bug);
//   - a structural key-path walk asserting every path the collector writes survives
//     parsing — catches silent DROPPING, and turns a future collector field the parser
//     ignores into a red test, not drift;
//   - the parser's TYPED view is asserted field by field against what format v1
//     defines — catches the two packages agreeing on bytes but not on meaning;
//   - Outcomes join to Samples through the dashboard's ACTUAL join (joinOutcomes),
//     on real data;
//   - a schemaVersion the parser doesn't know is rejected LOUDLY on real bytes
//     minimally perturbed — never silently misread.
//
// Cross-package wiring: the dashboard package's public exports ("main": dist/index.js)
// are used — parse/attribute/aggregate are all exported from its index. dist is
// gitignored and the collector's own `tsc --build` only builds format+collector, so
// beforeAll runs `npx tsc --build` at the REPO ROOT (project references build all three
// packages) and then dynamic-imports the package. A static import would fail at module
// collection time on a fresh checkout, before any hook could build dist.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { runPlaywright, walkFiles } from './helpers/run-playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** The dashboard package, loaded AFTER the root build guarantees dist exists. */
type Dashboard = typeof import('@bzm/vitals-dashboard');
let dash: Dashboard;

/** One real emitted file: its path, its raw bytes, and nothing interpreted. */
interface RawRecord {
  path: string;
  raw: string;
}

/** The ORIGINAL files the two-step wrote (exact names; attached copies carry a -sha1
 *  suffix and are byte-identical copies — the originals are the canonical bytes). */
async function rawFiles(outputDir: string, pattern: RegExp): Promise<RawRecord[]> {
  const files = (await walkFiles(outputDir)).filter((f) => pattern.test(f));
  return Promise.all(files.map(async (path) => ({ path, raw: await readFile(path, 'utf8') })));
}

const SAMPLE_FILE = /\/bzm-vitals-sample-\d+\.json$/;
const OUTCOME_FILE = /\/bzm-vitals-outcome\.json$/;

// ---------------------------------------------------------------------------
// The field-coverage walk — the "a field the parser ignores fails the test"
// criterion, implemented structurally so a FUTURE collector field the parser
// drops turns this file red without anyone updating an expected-fields list.
// ---------------------------------------------------------------------------

/** Every leaf key path in a JSON value: 'vitals.cls.value', 'test.repeat', … .
 *  Empty objects/arrays are leaves too — their presence is a fact to preserve. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((v, i) => keyPaths(v, `${prefix}[${i}]`));
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return [`${prefix}{}`];
  return keys.flatMap((k) =>
    keyPaths((value as Record<string, unknown>)[k], prefix === '' ? k : `${prefix}.${k}`),
  );
}

/** The key paths of `original` that `parsed` does not expose — the parser's
 *  silently-dropped fields. Must always be empty against real output. */
function droppedPaths(original: unknown, parsed: unknown): string[] {
  const have = new Set(keyPaths(parsed));
  return keyPaths(original).filter((p) => !have.has(p));
}

// ---------------------------------------------------------------------------
// Real input: three child Playwright runs through the Seam 1 harness.
//   chromium — vitals.spec.ts: a journey with 2 Navigations and a real click
//              (INP ok) plus a navigate-only test (INP no-interaction);
//   firefox  — vitals.spec.ts: no LayoutShift API, so CLS is 'unsupported';
//   routes   — route.spec.ts on chromium: the optional `route` field appears
//              in real bytes, declared and omitted.
// Nothing below is hand-authored; every asserted byte came off a real run.
// ---------------------------------------------------------------------------

let server: FixtureServer;
let chromiumSamples: RawRecord[];
let firefoxSamples: RawRecord[];
let routeSamples: RawRecord[];
let outcomes: RawRecord[]; // all three runs' Outcome records

function allSamples(): RawRecord[] {
  return [...chromiumSamples, ...firefoxSamples, ...routeSamples];
}

/** Parse one real Sample through the dashboard, failing loudly with the reason. */
function parsedSample(r: RawRecord) {
  const result = dash.parseSampleJson(r.raw);
  if (!result.ok) throw new Error(`dashboard rejected real collector output ${r.path}: ${result.reason}`);
  return result.sample;
}

function parsedOutcome(r: RawRecord) {
  const result = dash.parseOutcomeJson(r.raw);
  if (!result.ok) throw new Error(`dashboard rejected real collector output ${r.path}: ${result.reason}`);
  return result.outcome;
}

beforeAll(async () => {
  // Build ALL packages from the root so the dashboard's dist exists and is fresh —
  // the collector's own test script only builds format+collector. The variable
  // specifier + @vite-ignore is load-bearing: with a literal, vite resolves the
  // package at TRANSFORM time, when a fresh checkout has no dist yet, and the whole
  // file fails collection before this hook could build it. Made opaque, Node
  // resolves it natively at runtime — after the build above has run. (Verified
  // both ways: dist deleted → this file still goes green and rebuilds it.)
  // --force because tsc --build trusts tsbuildinfo and does NOT notice deleted
  // outputs: a dist removed out from under a stale tsbuildinfo would silently
  // no-op the build and fail the import below. A few seconds per run buys a
  // wiring that works from every state, not just the happy one.
  execSync('npx tsc --build --force', { cwd: REPO_ROOT, stdio: 'pipe' });
  const dashboardPackage = '@bzm/vitals-dashboard';
  dash = (await import(/* @vite-ignore */ dashboardPackage)) as Dashboard;

  server = await startFixtureServer();
  const [chromiumRun, firefoxRun, routeRun] = await Promise.all([
    runPlaywright({ spec: 'vitals.spec.ts', baseURL: server.url }),
    runPlaywright({ spec: 'vitals.spec.ts', baseURL: server.url, project: 'firefox' }),
    runPlaywright({ spec: 'route.spec.ts', baseURL: server.url }),
  ]);

  chromiumSamples = await rawFiles(chromiumRun.outputDir, SAMPLE_FILE);
  firefoxSamples = await rawFiles(firefoxRun.outputDir, SAMPLE_FILE);
  routeSamples = await rawFiles(routeRun.outputDir, SAMPLE_FILE);
  outcomes = [
    ...(await rawFiles(chromiumRun.outputDir, OUTCOME_FILE)),
    ...(await rawFiles(firefoxRun.outputDir, OUTCOME_FILE)),
    ...(await rawFiles(routeRun.outputDir, OUTCOME_FILE)),
  ];
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('the real emitted files reach the parser at all', () => {
  it('the runs emitted the exact expected file counts — a silent loss here would quietly shrink every assertion below', () => {
    // vitals.spec: Click Then Navigate (2 Navigations) + Navigate Only (1) = 3 Samples,
    // 2 Outcomes — per browser. route.spec: 2 + 1 + 1 = 4 Samples, 3 Outcomes.
    expect(chromiumSamples.length).toBe(3);
    expect(firefoxSamples.length).toBe(3);
    expect(routeSamples.length).toBe(4);
    expect(outcomes.length).toBe(7);
  });

  it("the dashboard's discovery predicates match the names the collector emits", () => {
    for (const r of allSamples()) {
      expect(dash.isSampleAttachment(basename(r.path)), r.path).toBe(true);
      expect(dash.isOutcomeAttachment(basename(r.path)), r.path).toBe(false);
    }
    for (const r of outcomes) {
      expect(dash.isOutcomeAttachment(basename(r.path)), r.path).toBe(true);
      // OUTCOME prefix ('bzm-vitals-outcome') vs SAMPLE prefix ('bzm-vitals-sample'):
      // a Sample-prefix match here would double-count every Outcome as a Sample.
      expect(dash.isSampleAttachment(basename(r.path)), r.path).toBe(false);
    }
  });

  it('every real emitted file parses ok — no reason, no rejection', () => {
    for (const r of allSamples()) {
      const result = dash.parseSampleJson(r.raw);
      expect(result.ok, `${r.path}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
    for (const r of outcomes) {
      const result = dash.parseOutcomeJson(r.raw);
      expect(result.ok, `${r.path}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
  });
});

describe('full round-trip: every field the collector writes is read, with the same meaning', () => {
  it('a parsed Sample deep-equals JSON.parse of its raw bytes — nothing dropped, nothing rewritten', () => {
    for (const r of allSamples()) {
      expect(parsedSample(r), r.path).toEqual(JSON.parse(r.raw));
    }
  });

  it('a parsed Outcome deep-equals JSON.parse of its raw bytes', () => {
    for (const r of outcomes) {
      expect(parsedOutcome(r), r.path).toEqual(JSON.parse(r.raw));
    }
  });

  it('field coverage: every key path the collector wrote survives parsing — a field the parser ignores fails HERE', () => {
    for (const r of allSamples()) {
      expect(droppedPaths(JSON.parse(r.raw), parsedSample(r)), r.path).toEqual([]);
    }
    for (const r of outcomes) {
      expect(droppedPaths(JSON.parse(r.raw), parsedOutcome(r)), r.path).toEqual([]);
    }
  });

  it('…and the coverage walk actually bites: a record missing fields the collector wrote is caught (in-memory perturbation, red-green proof)', () => {
    const original = JSON.parse(allSamples()[0]!.raw) as Record<string, unknown>;
    const mutilated = structuredClone(original);
    delete (mutilated.context as Record<string, unknown>).requestCount; // a nested scalar
    delete (mutilated.vitals as Record<string, unknown>).cls; // a whole metric
    const dropped = droppedPaths(original, mutilated);
    expect(dropped).toContain('context.requestCount');
    expect(dropped).toContain('vitals.cls.value');
    expect(dropped).toContain('vitals.cls.status');
    // And a REWRITE (same keys, different value) is the deep-equal's catch:
    const rewritten = structuredClone(original);
    (rewritten.vitals as Record<string, { value: unknown }>).cls!.value = 0;
    expect(droppedPaths(original, rewritten)).toEqual([]); // walk is blind to it, by design…
    expect(rewritten).not.toEqual(original); // …deep-equal is not.
  });
});

describe("the parser's typed view exposes every field format v1 defines", () => {
  it('schemaVersion, ts, url, test.*, navigationIndex, vitals.*.{value,status}, navigation.*, context.* — on every real Sample', () => {
    for (const r of allSamples()) {
      const s = parsedSample(r);
      expect(s.schemaVersion, r.path).toBe(1);
      expect(typeof s.ts, r.path).toBe('number');
      expect(typeof s.url, r.path).toBe('string');
      // DashboardSample widens test/navigationIndex to nullable for the LEGACY
      // adapter's sake — but collector output always carries the full identity.
      expect(s.test, r.path).not.toBeNull();
      expect(typeof s.test!.file, r.path).toBe('string');
      expect(typeof s.test!.title, r.path).toBe('string');
      expect(typeof s.test!.project, r.path).toBe('string');
      expect(typeof s.test!.repeat, r.path).toBe('number');
      expect(typeof s.test!.worker, r.path).toBe('number');
      expect(typeof s.navigationIndex, r.path).toBe('number');
      for (const name of ['ttfb', 'fcp', 'lcp', 'cls', 'inp'] as const) {
        const m = s.vitals[name];
        expect(m, `vitals.${name} on ${r.path}`).toBeDefined();
        expect(m, `vitals.${name} on ${r.path}`).toHaveProperty('value');
        expect(m, `vitals.${name} on ${r.path}`).toHaveProperty('status');
      }
      expect(s.navigation, r.path).toHaveProperty('domContentLoadedMs');
      expect(s.navigation, r.path).toHaveProperty('loadEventMs');
      expect(s.context, r.path).toHaveProperty('workers');
      expect(s.context, r.path).toHaveProperty('resourceCount');
      expect(s.context, r.path).toHaveProperty('requestCount');
      expect(s.context, r.path).toHaveProperty('failedRequests');
    }
  });

  it('the optional route field: verbatim when declared, ABSENT (not null) when not', () => {
    const byTitleAndNav = (title: string, nav: number) =>
      routeSamples
        .map(parsedSample)
        .find((s) => s.test!.title === title && s.navigationIndex === nav);

    // Declared — verbatim, braces and all (the collector never normalizes).
    expect(byTitleAndNav('Declared Routes', 1)!.route).toBe('/home/{id}');
    expect(byTitleAndNav('Declared Routes', 2)!.route).toBe('/second/{orderId}');
    expect(byTitleAndNav('Route Before First Navigation', 1)!.route).toBe('/pre-declared');
    // Omitted — the KEY is absent from the bytes, and the parsed view agrees.
    const undeclared = byTitleAndNav('No Route Declared', 1)!;
    expect('route' in (undeclared as unknown as Record<string, unknown>)).toBe(false);
    // The vitals runs never declare a Route either:
    for (const r of [...chromiumSamples, ...firefoxSamples]) {
      expect('route' in (parsedSample(r) as unknown as Record<string, unknown>), r.path).toBe(false);
    }
  });

  it('Outcome typed view: schemaVersion, full test identity, closed status, retry', () => {
    for (const r of outcomes) {
      const o = parsedOutcome(r);
      expect(o.schemaVersion, r.path).toBe(1);
      expect(typeof o.test.file, r.path).toBe('string');
      expect(typeof o.test.title, r.path).toBe('string');
      expect(typeof o.test.project, r.path).toBe('string');
      expect(typeof o.test.repeat, r.path).toBe('number');
      expect(typeof o.test.worker, r.path).toBe('number');
      expect(['passed', 'failed', 'timedOut', 'skipped'], r.path).toContain(o.status);
      expect(typeof o.retry, r.path).toBe('number');
    }
  });
});

describe('all five metrics round-trip, including the non-ok statuses the real runs produced', () => {
  it("chromium: inp 'ok' (the clicked Navigation) AND 'no-interaction' (navigate-only) both arrive through the parser", () => {
    const statuses = chromiumSamples.map((r) => parsedSample(r).vitals.inp!.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('no-interaction');
    // no-interaction carries value null through the parser — never 0, never absent.
    for (const r of chromiumSamples) {
      const inp = parsedSample(r).vitals.inp!;
      if (inp.status === 'no-interaction') expect(inp.value, r.path).toBeNull();
    }
  });

  it("firefox: cls arrives as {value: null, status: 'unsupported'} — the parser must not turn it into a fake 0", () => {
    expect(firefoxSamples.length).toBeGreaterThan(0);
    for (const r of firefoxSamples) {
      const cls = parsedSample(r).vitals.cls!;
      expect(cls.status, r.path).toBe('unsupported');
      expect(cls.value, r.path).toBeNull();
    }
  });

  it('chromium: cls is ok with a true-float value on the shifting fixture page, and survives parsing as that exact float', () => {
    for (const r of chromiumSamples) {
      const cls = parsedSample(r).vitals.cls!;
      expect(cls.status, r.path).toBe('ok');
      expect(cls.value, r.path).toBe((JSON.parse(r.raw) as { vitals: { cls: { value: number } } }).vitals.cls.value);
      expect(Number.isInteger(cls.value), r.path).toBe(false);
    }
  });

  it("the collector never writes 'unknown' — walked over every metric of every real record", () => {
    for (const r of allSamples()) {
      for (const [name, m] of Object.entries(parsedSample(r).vitals)) {
        expect(m.status, `${name} on ${r.path}`).not.toBe('unknown');
      }
    }
  });
});

describe("Outcomes join to their Samples through the dashboard's actual join logic", () => {
  it('every Sample from a finished Execution gets its executionStatus via joinOutcomes — none crashed, none unavailable', () => {
    // Attribution is the DASHBOARD's stamp (fetch-time identity), not part of the
    // on-disk record — one fake Engine per child run mirrors one zip per Engine.
    // The join is strictly within a session, on the full test identity.
    const engine = (n: number) => ({
      masterId: 'm-roundtrip',
      sessionId: `r-v4-roundtrip-${n}`,
      locationId: 'local',
      engineLabel: `local #${n}`,
    });
    const runs: Array<[RawRecord[], number]> = [
      [chromiumSamples, 1],
      [firefoxSamples, 2],
      [routeSamples, 3],
    ];
    const attributed = runs.flatMap(([records, n]) =>
      records.map((r) => dash.attributeSample(parsedSample(r), 'collector', engine(n))),
    );
    const attributedOutcomes = outcomes.map((r) => {
      const o = parsedOutcome(r);
      // vitals.spec on chromium → session 1; vitals.spec on firefox → session 2;
      // route.spec (always chromium) → session 3. Derived from the record itself,
      // exactly as identity is meant to be (contents, never filename).
      const n = o.test.file === 'route.spec.ts' ? 3 : o.test.project === 'firefox' ? 2 : 1;
      return { sessionId: engine(n).sessionId, outcome: o };
    });

    const joined = dash.joinOutcomes(attributed, attributedOutcomes);
    expect(joined.length).toBe(attributed.length);
    for (const s of joined) {
      // Every fixture test in these three runs finishes and passes; a 'crashed' or
      // 'unavailable' here means the join dropped a real Outcome on real data.
      expect(s.executionStatus, `${s.sample.test!.title} nav ${s.sample.navigationIndex} (${s.sessionId})`).toBe('passed');
    }
  });
});

describe('a schemaVersion the parser does not know fails loudly, never silently', () => {
  it('real Sample bytes with schemaVersion bumped to 2 are REJECTED with a reason naming schemaVersion', () => {
    for (const r of allSamples().slice(0, 1)) {
      const bumped = JSON.parse(r.raw) as Record<string, unknown>;
      bumped.schemaVersion = 2;
      const result = dash.parseSampleJson(JSON.stringify(bumped));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('schemaVersion');
        expect(result.reason).toContain('2');
      }
    }
  });

  it('real Outcome bytes with schemaVersion bumped to 2 are REJECTED the same way', () => {
    const r = outcomes[0]!;
    const bumped = JSON.parse(r.raw) as Record<string, unknown>;
    bumped.schemaVersion = 2;
    const result = dash.parseOutcomeJson(JSON.stringify(bumped));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('schemaVersion');
      expect(result.reason).toContain('2');
    }
  });
});
