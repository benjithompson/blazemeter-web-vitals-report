// Seam 1 — a navigation that swaps the document's frame still leaves the departing
// document's Sample. This was a measured loss (cross-site, see upload-kit/README.md)
// and, from Playwright 1.63 (Chromium RenderDocument), the fate of EVERY navigation:
// a binding call made at pagehide never reaches Node.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { runPlaywright, findSamples, type FoundSample } from './helpers/run-playwright';

let server: FixtureServer;
let samples: FoundSample[];

function forTitle(title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

beforeAll(async () => {
  server = await startFixtureServer();
  const run = await runPlaywright({ spec: 'crosssite.spec.ts', baseURL: server.url });
  expect(run.exitCode, run.stdout + run.stderr).toBe(0);
  samples = await findSamples(run.outputDir);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe.each([
  ['Cross Site Goto', '/home/goto', /localhost:\d+\/second$/],
  ['Cross Site Link Click', '/home/click', /localhost:\d+\/third$/],
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
