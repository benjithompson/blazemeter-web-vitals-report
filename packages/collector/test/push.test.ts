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
//   badcreds — the injection POST answers 401 (bad api key): one deduped stderr warning, and
//              the Push Status attachment records the failure (C4).
//   badsession — the masterId resolution GET answers 401: the destination comes up dead,
//              says why once, and every Sample is tallied as failed (C4).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import {
  startBlazeMeterServer,
  decodeBasicAuth,
  type BlazeMeterServer,
  type CapturedRequest,
} from './helpers/blazemeter-server';
import {
  runPlaywright,
  findSamples,
  findOutcomes,
  anyFileContains,
  walkFiles,
  type RunResult,
} from './helpers/run-playwright';
import { readFile } from 'node:fs/promises';
import type { Interval } from '../src/blazemeter-destination';
import type { PushStatus } from '../src/pusher';
import { firefoxRunOrSkip, itFirefox } from './helpers/browsers';

const KEY_ID = 'seam-a-key-id';
const KEY_SECRET = 'seam-a-key-secret';

const PUSH_MASTER = 82_731_957;
const FIREFOX_MASTER = 111_111;
const HOSTILE_MASTER = 222_222;
const OVERRIDE_SERVER_MASTER = 333_333; // what the double WOULD resolve — must be ignored
const OVERRIDE_ENV_MASTER = 42_424_242; // the BLAZEMETER_MASTER_ID override — must win

/** The push env shared by every run that SHOULD push. Each run adds its own base + session.
 *  NOTE: no LOCATION here on purpose — the location tier must come from the master status
 *  (GET /masters/{id}/status), exactly as on a real Engine where LOCATION is absent. */
const PUSH_BASE = {
  BLAZEMETER_API_KEY_ID: KEY_ID,
  BLAZEMETER_API_KEY_SECRET: KEY_SECRET,
  // Small cadence so the flush timer fires during the short run (teardown drain backstops it).
  BZM_VITALS_FLUSH_MS: '250',
};

/** Every interval across every injection POST a double captured. */
function intervalsOf(server: BlazeMeterServer): Interval[] {
  return server.injectionRequests().flatMap((r) => (r.body as { intervals?: Interval[] }).intervals ?? []);
}

interface PushStatusFile {
  path: string;
  raw: string;
  record: { worker: number; destinations: PushStatus[] };
}

/** The Push Status files a run wrote — the originals (`bzm-vitals-push-status-<worker>.json`)
 *  AND their attached copies (`…-<sha1>.json`), so a leak scan covers both. */
async function findPushStatusFiles(outputDir: string): Promise<{ originals: PushStatusFile[]; all: string[] }> {
  const all = (await walkFiles(outputDir)).filter((f) => /\/bzm-vitals-push-status-\d+(-[0-9a-f]+)?\.json$/.test(f));
  const originals: PushStatusFile[] = [];
  for (const path of all.filter((f) => /\/bzm-vitals-push-status-\d+\.json$/.test(f))) {
    const raw = await readFile(path, 'utf8');
    originals.push({ path, raw, record: JSON.parse(raw) });
  }
  return { originals, all };
}

/** One destination's tallies summed across every worker's Push Status in a run. */
function totals(files: PushStatusFile[], destination: string): { sent: number; failed: number; dropped: number; lastErrors: string[] } {
  const recs = files.flatMap((f) => f.record.destinations).filter((d) => d.destination === destination);
  return {
    sent: recs.reduce((n, r) => n + r.sent, 0),
    failed: recs.reduce((n, r) => n + r.failed, 0),
    dropped: recs.reduce((n, r) => n + r.dropped, 0),
    lastErrors: recs.map((r) => r.lastError).filter((e): e is string => e !== null),
  };
}

/** Every `[bzm-vitals]` line a run printed (worker stderr reaches the child's stderr). */
function vitalsLines(r: RunResult): string[] {
  return r.stderr.split('\n').filter((l) => l.startsWith('[bzm-vitals]'));
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
let bzmBadCreds: BlazeMeterServer;
let bzmBadSession: BlazeMeterServer;

let pushRun: RunResult;
let firefoxRun: RunResult | undefined; // undefined when Firefox is not installed
let hostileRun: RunResult;
let overrideRun: RunResult;
let noCredsRun: RunResult;
let errorRun: RunResult;
let badCredsRun: RunResult;
let badSessionRun: RunResult;

let pushSamples: Sample[];

/** Every child run that actually ran (the Firefox run is absent when Firefox is not installed). */
function allRuns(): RunResult[] {
  return [pushRun, firefoxRun, hostileRun, overrideRun, noCredsRun, errorRun, badCredsRun, badSessionRun].filter((r): r is RunResult => r !== undefined);
}

beforeAll(async () => {
  pageServer = await startFixtureServer();
  [bzmPush, bzmFirefox, bzmHostile, bzmOverride, bzmNoCreds, bzmError, bzmBadCreds, bzmBadSession] = await Promise.all([
    // statusSessions carries the location name the collector reads back (LOCATION is unset).
    startBlazeMeterServer({ masterId: PUSH_MASTER, statusSessions: [{ id: 'r-v4-push', locationId: 'us-west-1' }] }),
    startBlazeMeterServer({ masterId: FIREFOX_MASTER, statusSessions: [{ id: 'r-v4-firefox', locationId: 'us-west-2' }] }),
    startBlazeMeterServer({ masterId: HOSTILE_MASTER, statusSessions: [{ id: 'r-v4-hostile', locationId: 'us-east-1' }] }),
    startBlazeMeterServer({ masterId: OVERRIDE_SERVER_MASTER }),
    startBlazeMeterServer({ masterId: 999 }),
    // Every injection POST 500s — the best-effort path under a broken API.
    startBlazeMeterServer({ masterId: 777, injectionStatus: 500 }),
    // Bad api key: every injection POST 401s.
    startBlazeMeterServer({ masterId: 444_444, injectionStatus: 401 }),
    // Bad api key on an Engine: the masterId resolution GET 401s.
    startBlazeMeterServer({ masterId: 555_555, sessionStatus: 401 }),
  ]);

  [pushRun, firefoxRun, hostileRun, overrideRun, noCredsRun, errorRun, badCredsRun, badSessionRun] = await Promise.all([
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-push', BLAZEMETER_API_BASE: bzmPush.url },
    }),
    firefoxRunOrSkip(() =>
      runPlaywright({
        spec: 'vitals.spec.ts',
        baseURL: pageServer.url,
        project: 'firefox',
        env: { ...PUSH_BASE, SESSION_ID: 'r-v4-firefox', BLAZEMETER_API_BASE: bzmFirefox.url },
      }),
    ),
    runPlaywright({
      spec: 'hostile.spec.ts',
      baseURL: pageServer.url,
      // Per-Engine mode here, so the run also exercises the Engine tier live.
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-hostile', BLAZEMETER_API_BASE: bzmHostile.url, BZM_VITALS_PER_ENGINE: '1' },
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
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      env: { ...PUSH_BASE, BLAZEMETER_MASTER_ID: '444444', BLAZEMETER_API_BASE: bzmBadCreds.url },
    }),
    runPlaywright({
      spec: 'vitals.spec.ts',
      baseURL: pageServer.url,
      env: { ...PUSH_BASE, SESSION_ID: 'r-v4-badsession', BLAZEMETER_API_BASE: bzmBadSession.url },
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
    bzmBadCreds?.close(),
    bzmBadSession?.close(),
  ]);
});

describe('the happy path: importing the collector + api-key env + a resolvable master pushes live', () => {
  it('every child run exited 0 — the push never fails the test', () => {
    for (const r of allRuns()) {
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
      // Default is aggregate-per-location: NO Engine tier. 4 tiers, metric as leaf.
      expect(tiers).toHaveLength(4);
      expect(tiers[0]).toBe('Web Vitals');
      expect(tiers[1]).toBe('us-west-1'); // resolved from the master status (see next test)
      expect(['/', '/second']).toContain(tiers[2]);
      expect(['TTFB', 'FCP', 'LCP', 'CLS×1000', 'INP']).toContain(tiers[3]);
    }
  });

  it('the location tier is resolved from GET /masters/{id}/status matched by SESSION_ID (LOCATION unset)', () => {
    const statusGets = bzmPush.statusRequests();
    expect(statusGets.length).toBeGreaterThan(0);
    expect(decodeBasicAuth(statusGets[0]!.authorization)).toBe(`${KEY_ID}:${KEY_SECRET}`);
    for (const iv of intervalsOf(bzmPush)) {
      expect(iv._id.metricPath.split(' | ')[1], iv._id.metricPath).toBe('us-west-1');
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
  itFirefox('firefox: CLS is UNSUPPORTED → no CLS interval; TTFB/FCP still push', () => {
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

  it('per-Engine mode (BZM_VITALS_PER_ENGINE=1) restores the Engine tier: Web Vitals | location | #N | route | metric', () => {
    const intervals = intervalsOf(bzmHostile);
    expect(intervals.length).toBeGreaterThan(0);
    for (const iv of intervals) {
      const tiers = iv._id.metricPath.split(' | ');
      expect(tiers, iv._id.metricPath).toHaveLength(5);
      expect(tiers[0]).toBe('Web Vitals');
      expect(tiers[1]).toBe('us-east-1'); // from status
      expect(tiers[2], iv._id.metricPath).toMatch(/^#\d+$/); // Engine tier present again
    }
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

describe('push failures are visible: one stderr line per reason, and a Push Status attachment (C4)', () => {
  it('bad credentials (POST 401): stderr shows exactly one "[bzm-vitals] blazemeter: 401…" line', () => {
    expect(bzmBadCreds.injectionRequests().length).toBeGreaterThan(0);
    const lines = vitalsLines(badCredsRun);
    expect(lines, badCredsRun.stderr).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[bzm-vitals\] blazemeter: 401 on POST \/api\/v4\/data\/timeseries/);
  });

  it('a 401 is never retried: one POST per flushed batch, never more POSTs than Samples', () => {
    // vitals.spec makes 3 Navigations; a retried 401 would show up as extra identical POSTs.
    const bodies = bzmBadCreds.injectionRequests().map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('bad credentials: the Push Status attachment shows failed > 0 with the reason', async () => {
    const { originals, all } = await findPushStatusFiles(badCredsRun.outputDir);
    expect(originals.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(originals.length); // the attach({path}) copy exists too
    const t = totals(originals, 'blazemeter');
    expect(t.failed).toBeGreaterThan(0);
    expect(t.sent).toBe(0);
    expect(t.failed + t.dropped).toBe(3); // every Navigation accounted for
    expect(t.lastErrors[0]).toMatch(/^401 on POST/);
  });

  it('bad credentials on resolution (GET 401): one line, and every Sample tallied as failed', async () => {
    const lines = vitalsLines(badSessionRun);
    expect(lines, badSessionRun.stderr).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[bzm-vitals\] blazemeter: 401 on GET \/api\/v4\/sessions\/r-v4-badsession/);
    expect(bzmBadSession.injectionRequests()).toEqual([]);
    const t = totals((await findPushStatusFiles(badSessionRun.outputDir)).originals, 'blazemeter');
    expect(t).toMatchObject({ sent: 0, failed: 3, dropped: 0 });
  });

  it('a 500ing endpoint is retried, warned once, and tallied as failed', async () => {
    const lines = vitalsLines(errorRun);
    expect(lines, errorRun.stderr).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[bzm-vitals\] blazemeter: 500 on POST/);
    const bodies = bzmError.injectionRequests().map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBeLessThan(bodies.length); // the same batch was re-sent
    const t = totals((await findPushStatusFiles(errorRun.outputDir)).originals, 'blazemeter');
    expect(t.failed + t.dropped).toBe(3);
    expect(t.sent).toBe(0);
  });

  it('the happy path: the Push Status shows every Sample sent, nothing failed, and stderr is quiet', async () => {
    expect(vitalsLines(pushRun), pushRun.stderr).toEqual([]);
    const t = totals((await findPushStatusFiles(pushRun.outputDir)).originals, 'blazemeter');
    expect(t).toEqual({ sent: 3, failed: 0, dropped: 0, lastErrors: [] });
  });

  it('the local path (no destination enabled) writes no Push Status at all', async () => {
    expect((await findPushStatusFiles(noCredsRun.outputDir)).all).toEqual([]);
    expect(vitalsLines(noCredsRun)).toEqual([]);
  });
});

describe('the credential-leak invariant', () => {
  it('the Push Status attachment (original and attached copy) carries no credential', async () => {
    const authHeader = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
    let scanned = 0;
    for (const r of [pushRun, hostileRun, overrideRun, errorRun, badCredsRun, badSessionRun]) {
      const { all } = await findPushStatusFiles(r.outputDir);
      expect(all.length, `no push status in ${r.outputDir}`).toBeGreaterThan(0); // never vacuous
      for (const f of all) {
        const raw = await readFile(f, 'utf8');
        for (const needle of [KEY_ID, KEY_SECRET, authHeader]) expect(raw, f).not.toContain(needle);
        scanned++;
      }
    }
    expect(scanned).toBeGreaterThan(0);
  });

  it('the api-key id and secret appear in NO on-disk artifact of any run', async () => {
    for (const r of allRuns()) {
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
