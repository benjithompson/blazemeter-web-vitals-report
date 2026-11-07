// Seam 1 — a navigation that swaps the document's frame still leaves the departing
// document's Sample. This was a measured loss (cross-site, #13) and, from Playwright
// 1.63 (Chromium RenderDocument), the fate of EVERY navigation: a binding call made at
// pagehide never reaches Node.
//
// C7 (#46) re-verified #13 on Playwright 1.63: 127.0.0.1 and localhost are different
// SITES (an IP host is its own site; a port never is part of one), so every navigation
// here between them is cross-site. Every way of leaving — goto(), link click, form
// submit, location assignment, history — keeps the departing Sample, and a pending
// vitals.route() lands on the document it was declared for, never the next one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

function forTitle(title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

/** [host, pathname, route] per Sample, in navigationIndex order. */
function journey(title: string): Array<[string, string, string | undefined]> {
  return forTitle(title).map(({ sample }) => {
    const u = new URL(sample.url);
    return [u.hostname, u.pathname, sample.route];
  });
}

beforeAll(async () => {
  server = await startFixtureServer();
  const run = await runPlaywright({ spec: 'crosssite.spec.ts', baseURL: server.url });
  expect(run.exitCode, run.stdout + run.stderr).toBe(0);
  samples = await findSamples(run.outputDir);
  outcomes = await findOutcomes(run.outputDir);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe.each([
  ['Cross Site Goto', '/home/goto', /localhost:\d+\/second$/],
  ['Cross Site Link Click', '/home/click', /localhost:\d+\/third$/],
  ['Cross Site Form Submit', '/home/form', /localhost:\d+\/second$/],
  ['Cross Site Location Assignment', '/home/location', /localhost:\d+\/third$/],
])('%s', (title, route, secondUrl) => {
  it('writes BOTH Samples — the departing document is not lost', () => {
    const s = forTitle(title);
    expect(s.map((x) => x.sample.navigationIndex)).toEqual([1, 2]);
    expect(s[0]!.sample.url).toMatch(/127\.0\.0\.1:\d+\/$/);
    expect(s[1]!.sample.url).toMatch(secondUrl);
  });

  it('the departing document carries its own route; the next one does not steal it', () => {
    const s = forTitle(title);
    expect(s[0]!.sample.route).toBe(route);
    expect(s[1]!.sample.route).toBeUndefined();
  });

  it('the departing document was read after it painted — ttfb and fcp are ok', () => {
    const first = forTitle(title)[0]!.sample;
    expect(first.vitals['ttfb']!.status).toBe('ok');
    expect(first.vitals['fcp']!.status).toBe('ok');
  });
});

describe('Cross Site Round Trip', () => {
  it('every document of a journey that leaves the site and comes back has its Sample, with only its own route', () => {
    expect(journey('Cross Site Round Trip')).toEqual([
      ['127.0.0.1', '/', '/trip/1'],       // left by location.assign()
      ['localhost', '/second', undefined], // left by a link click
      ['127.0.0.1', '/third', '/trip/3'],  // left by goBack()
      ['localhost', '/second', undefined], // left by goto()
      ['127.0.0.1', '/', '/trip/5'],       // flushed at teardown
    ]);
  });
});

describe('Outcomes', () => {
  it('every Execution passed and wrote one Outcome', () => {
    expect(outcomes.map((o) => o.outcome.test.title).sort()).toEqual([
      'Cross Site Form Submit',
      'Cross Site Goto',
      'Cross Site Link Click',
      'Cross Site Location Assignment',
      'Cross Site Round Trip',
    ]);
    for (const { outcome } of outcomes) expect(outcome.status, outcome.test.title).toBe('passed');
  });
});
