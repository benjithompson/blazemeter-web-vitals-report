// Seam A — issue #15: the walking skeleton, proven end-to-end. Real `npx playwright test`
// child runs (the tester's exact adoption) push measured vitals to a fake BlazeMeter API
// double, and we assert on the requests that DOUBLE actually captured — the resolution GET
// and the injection POST(s) — plus the on-disk artifacts, exactly as Seam 1 does. Never a
// mock, never "send was called".
//
// Five runs, each against its own API double so captured requests never intermix:
//   push     — chromium vitals.spec + full push env: the happy path (GET + POSTs).
//   override — chromium vitals.spec + BLAZEMETER_MASTER_ID and NO session: the override
//              wins and the resolution GET never happens.
//   firefox  — firefox vitals.spec: CLS/LCP UNSUPPORTED → those metrics produce no interval.
//   hostile  — chromium hostile.spec: TTFB/FCP ERROR + no click (INP no-interaction) →
//              none of the three produce an interval; the observer-backed LCP/CLS still do.
//   nocreds  — chromium vitals.spec with creds blanked: nothing is pushed and the on-disk
//              records are exactly what a local run writes today.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  startBlazeMeterServer,
  decodeBasicAuth,
  type BlazeMeterServer,
  type CapturedRequest,
} from './helpers/blazemeter-server';
import { runPlaywright, findSamples, findOutcomes, anyFileContains, type RunResult } from './helpers/run-playwright';
import type { Interval } from '../src/blazemeter-destination';

const KEY_ID = 'seam-a-key-id';
const KEY_SECRET = 'seam-a-key-secret';

const PUSH_MASTER = 82_731_957;
const FIREFOX_MASTER = 111_111;
const HOSTILE_MASTER = 222_222;
const OVERRIDE_SERVER_MASTER = 333_333; // what the double WOULD resolve — must be ignored
const OVERRIDE_ENV_MASTER = 42_424_242; // the BLAZEMETER_MASTER_ID override — must win

/** The push env shared by every run that SHOULD push. Each run adds its own base + session. */
const PUSH_BASE = {
  BLAZEMETER_API_KEY_ID: KEY_ID,
  BLAZEMETER_API_KEY_SECRET: KEY_SECRET,
  LOCATION: 'us-west-1',
  BZM_VITALS_ENGINE: '#1',
  // Small cadence so the flush timer fires during the short run (teardown drain backstops it).
  BZM_VITALS_FLUSH_MS: '250',
};

/** Every interval across every injection POST a double captured. */
function intervalsOf(server: BlazeMeterServer): Interval[] {
  return server.injectionRequests().flatMap((r) => (r.body as { intervals?: Interval[] }).intervals ?? []);
}

/** The metric leaf (last tier) of a metricPath. */
function leafOf(metricPath: string): string {
  return metricPath.split(' | ').pop()!;
}

let pageServer: FixtureServer;
let bzmPush: BlazeMeterServer;
let bzmFirefox: BlazeMeterServer;
let bzmHostile: BlazeMeterServer;
let bzmOverride: BlazeMeterServer;
let bzmNoCreds: BlazeMeterServer;
let bzmError: BlazeMeterServer;

let pushRun: RunResult;
let firefoxRun: RunResult;
let hostileRun: RunResult;
let overrideRun: RunResult;
let noCredsRun: RunResult;
let errorRun: RunResult;

let pushSamples: Sample[];

beforeAll(async () => {
  pageServer = await startFixtureServer();
  [bzmPush, bzmFirefox, bzmHostile, bzmOverride, bzmNoCreds, bzmError] = await Promise.all([
    startBlazeMeterServer({ masterId: PUSH_MASTER }),
    startBlazeMeterServer({ masterId: FIREFOX_MASTER }),
    startBlazeMeterServer({ masterId: HOSTILE_MASTER }),
    startBlazeMeterServer({ masterId: OVERRIDE_SERVER_MASTER }),
    startBlazeMeterServer({ masterId: 999 }),
    // Every injection POST 500s — the best-effort path under a broken API.
    startBlazeMeterServer({ masterId: 777, injectionStatus: 500 }),
  ]);

  [pushRun, firefoxRun, hostileRun, overrideRun, noCredsRun, errorRun] = await Promise.all([
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-push', BLAZEMETER_API_BASE: bzmPush.url },
    }),
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      project: 'firefox',
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-firefox', BLAZEMETER_API_BASE: bzmFirefox.url },
    }),
    runPlaywright({
      spec: 'hostile.spec.ts',
      baseURL: pageServer.url,
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-hostile', BLAZEMETER_API_BASE: bzmHostile.url },
    }),
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      // Override set, NO SESSION_ID — resolution must be skipped entirely.
      env: { ...PUSH_BASE, BLAZEMETER_MASTER_ID: String(OVERRIDE_ENV_MASTER), BLAZEMETER_API_BASE: bzmOverride.url },
    }),
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      // Creds blanked so ambient shell creds can never turn the push on for the local-path
      // run; pointed at its OWN double so we can assert it received exactly zero requests.
      env: { BLAZEMETER_API_KEY_ID: '', BLAZEMETER_API_KEY_SECRET: '', BLAZEMETER_API_BASE: bzmNoCreds.url },
    }),
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      // Push is ON (override master, no GET needed) but every injection POST 500s.
      env: { ...PUSH_BASE, BLAZEMETER_MASTER_ID: '777', BLAZEMETER_API_BASE: bzmError.url },
    }),
  ]);

  pushSamples = (await findSamples(pushRun.outputDir)).map((f) => f.sample);
}, 300_000);

afterAll(async () => {
  await Promise.all([
    pageServer?.close(),
    bzmPush?.close(),
    bzmFirefox?.close(),
    bzmHostile?.close(),
    bzmOverride?.close(),
    bzmNoCreds?.close(),
    bzmError?.close(),
  ]);
});

describe('the happy path: importing the collector + api-key env + a resolvable master pushes live', () => {
  it('every child run exited 0 — the push never fails the test', () => {
    for (const r of [pushRun, firefoxRun, hostileRun, overrideRun, noCredsRun, errorRun]) {
      expect(r.exitCode, r.stderr).toBe(0);
    }
  });

  it('masterId resolves from SESSION_ID via GET /api/v4/sessions/{id}, with Basic api-key auth', () => {
    const gets = bzmPush.sessionRequests();
    expect(gets.length).toBeGreaterThan(0);
    expect(gets[0]!.path).toBe('/api/v4/sessions/r-v4-push');
    expect(decodeBasicAuth(gets[0]!.authorization)).toBe(`${KEY_ID}:${KEY_SECRET}`);
  });

  it('measured vitals are POSTed to /api/v4/data/timeseries during the run', () => {
    const posts = bzmPush.injectionRequests();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.path).toBe('/api/v4/data/timeseries');
      expect(decodeBasicAuth(p.authorization)).toBe(`${KEY_ID}:${KEY_SECRET}`);
    }
    expect(intervalsOf(bzmPush).length).toBeGreaterThan(0);
  });

  it('injection bodies carry the locked metricPath tier order (metric as leaf) and the resolved masterId', () => {
    const intervals = intervalsOf(bzmPush);
    for (const iv of intervals) {
      expect(iv._id.masterId).toBe(PUSH_MASTER);
      expect(iv.profileName).toBe('Web Vitals');
      const tiers = iv._id.metricPath.split(' | ');
      expect(tiers).toHaveLength(5);
      expect(tiers[0]).toBe('Web Vitals');
      expect(tiers[1]).toBe('us-west-1');
      expect(tiers[2]).toBe('#1');
      // tier 3 is the route (/ or /second on this spec); tier 4 is the metric leaf.
      expect(['/', '/second']).toContain(tiers[3]);
      expect(['TTFB', 'FCP', 'LCP', 'CLS×1000', 'INP']).toContain(tiers[4]);
    }
  });

  it('all pushed values are integers, and ts is epoch SECONDS (floor of an on-disk Sample ts)', () => {
    const sampleSeconds = new Set(pushSamples.map((s) => Math.floor(s.ts / 1000)));
    for (const iv of intervalsOf(bzmPush)) {
      expect(Number.isInteger(iv.kpis[0]!.value), iv._id.metricPath).toBe(true);
      expect(iv._id.ts).toBe(iv.kpis[0]!.ts);
      expect(sampleSeconds.has(iv._id.ts), `ts ${iv._id.ts} not a floored sample ts`).toBe(true);
    }
  });

  it('CLS is pushed scaled ×1000 under the CLS×1000 leaf, matching round(cls×1000) on disk', () => {
    const clsIntervals = intervalsOf(bzmPush).filter((iv) => leafOf(iv._id.metricPath) === 'CLS×1000');
    expect(clsIntervals.length).toBeGreaterThan(0);
    const onDiskScaled = new Set(
      pushSamples
        .map((s) => s.vitals.cls)
        .filter((m) => m?.status === 'ok' && typeof m.value === 'number')
        .map((m) => Math.round((m!.value as number) * 1000)),
    );
    for (const iv of clsIntervals) {
      expect(onDiskScaled.has(iv.kpis[0]!.value), `cls ${iv.kpis[0]!.value}`).toBe(true);
    }
  });
});

describe('BLAZEMETER_MASTER_ID overrides resolution', () => {
  it('the override is used and the sessions endpoint is never called', () => {
    expect(bzmOverride.sessionRequests()).toEqual([]);
    const intervals = intervalsOf(bzmOverride);
    expect(intervals.length).toBeGreaterThan(0);
    for (const iv of intervals) expect(iv._id.masterId).toBe(OVERRIDE_ENV_MASTER);
  });
});

describe('only status:ok metrics produce an interval — verified on the real non-ok fixtures', () => {
  it('firefox: CLS is UNSUPPORTED → no CLS interval; TTFB/FCP still push', () => {
    const leaves = new Set(intervalsOf(bzmFirefox).map((iv) => leafOf(iv._id.metricPath)));
    // No LayoutShift API on Firefox → cls 'unsupported' → never an interval, never a fake 0.
    expect(leaves.has('CLS×1000')).toBe(false);
    // The engine still measures TTFB and FCP, so the push is not empty — proving the
    // exclusion is per-metric, not a blanket "non-Chromium pushes nothing".
    expect(leaves.has('TTFB')).toBe(true);
    expect(leaves.has('FCP')).toBe(true);
  });

  it('hostile: TTFB/FCP ERROR and INP no-interaction → none push; observer-backed LCP/CLS do', () => {
    const leaves = new Set(intervalsOf(bzmHostile).map((iv) => leafOf(iv._id.metricPath)));
    expect(leaves.has('TTFB')).toBe(false); // read threw at flush → error → excluded
    expect(leaves.has('FCP')).toBe(false); // read threw at flush → error → excluded
    expect(leaves.has('INP')).toBe(false); // never clicked → no-interaction → excluded
    expect(leaves.has('LCP')).toBe(true); // observer survived the sabotage
    expect(leaves.has('CLS×1000')).toBe(true);
  });
});

describe('no credentials / no master: the local path is untouched', () => {
  it('nothing is resolved or POSTed when credentials are absent — the double saw zero requests', () => {
    expect(bzmNoCreds.requests).toEqual([]);
  });

  it('the no-creds run writes the same on-disk Samples/Outcomes as a push run (files unchanged)', async () => {
    const noCredsSamples = await findSamples(noCredsRun.outputDir);
    const noCredsOutcomes = await findOutcomes(noCredsRun.outputDir);
    const pushOutcomes = await findOutcomes(pushRun.outputDir);
    // vitals.spec on chromium: 2 tests, 3 Navigations, 2 Outcomes — with or without push.
    expect(noCredsSamples.length).toBe(3);
    expect(noCredsSamples.length).toBe(pushSamples.length);
    expect(noCredsOutcomes.length).toBe(2);
    expect(noCredsOutcomes.length).toBe(pushOutcomes.length);
  });
});

describe('best-effort: a broken injection endpoint never fails the run or drops a Sample', () => {
  it('the endpoint 500s every POST, yet the run still exits 0 and writes all its Samples/Outcomes', async () => {
    expect(errorRun.exitCode, errorRun.stderr).toBe(0);
    // The push actually TRIED (and failed) — the isolation is real, not vacuous.
    expect(bzmError.injectionRequests().length).toBeGreaterThan(0);
    // On-disk records are exactly the local-run set, untouched by the failing push.
    expect((await findSamples(errorRun.outputDir)).length).toBe(3);
    expect((await findOutcomes(errorRun.outputDir)).length).toBe(2);
  });
});

describe('the credential-leak invariant', () => {
  it('the api-key id and secret appear in NO on-disk artifact of any run', async () => {
    for (const r of [pushRun, firefoxRun, hostileRun, overrideRun, noCredsRun, errorRun]) {
      expect(await anyFileContains(r.outputDir, KEY_ID), `${KEY_ID} on disk in ${r.outputDir}`).toBe(false);
      expect(await anyFileContains(r.outputDir, KEY_SECRET), `${KEY_SECRET} on disk in ${r.outputDir}`).toBe(false);
    }
  });

  it('the credential IS present, decoded, in the captured Authorization header — proving it travels only there', () => {
    const authed: CapturedRequest[] = [...bzmPush.sessionRequests(), ...bzmPush.injectionRequests()];
    expect(authed.length).toBeGreaterThan(0);
    for (const r of authed) {
      expect(decodeBasicAuth(r.authorization)).toBe(`${KEY_ID}:${KEY_SECRET}`);
    }
  });
});
