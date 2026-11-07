// Seam 1 — C3: context.requestCount counts only the requests made during THAT
// document's lifetime: its own document request, plus everything it fetched (subframes
// included). The defect: the counter was never reset per document, so three sequential
// Navigations read 6 -> 8 -> 9 while resourceCount read 6 -> 2 -> 1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { runPlaywright, findSamples, type FoundSample } from './helpers/run-playwright';

/** What each /rc page fetches: its document request + its images (fixture-server.ts). */
const EXPECTED = [
  { path: '/rc/one', requests: 4, resources: 3 },
  { path: '/rc/two', requests: 2, resources: 1 },
  { path: '/rc/three', requests: 1, resources: 0 },
];

let server: FixtureServer;
let samples: FoundSample[];

function forTitle(title: string): FoundSample[] {
  return samples
    .filter((s) => s.sample.test.title === title)
    .sort((a, b) => a.sample.navigationIndex - b.sample.navigationIndex);
}

beforeAll(async () => {
  server = await startFixtureServer();
  const run = await runPlaywright({ spec: 'request-count.spec.ts', baseURL: server.url });
  samples = await findSamples(run.outputDir);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('context.requestCount is per Navigation', () => {
  for (const title of ['Three Gotos', 'Link Clicks']) {
    it(`${title}: each of three sequential Navigations counts only its own document's requests`, () => {
      const navs = forTitle(title);
      expect(navs.map((s) => new URL(s.sample.url).pathname)).toEqual(EXPECTED.map((e) => e.path));
      expect(navs.map((s) => s.sample.context.requestCount)).toEqual(EXPECTED.map((e) => e.requests));
    });

    it(`${title}: resourceCount is unchanged — the document's own resource entries`, () => {
      const navs = forTitle(title);
      expect(navs.map((s) => s.sample.context.resourceCount)).toEqual(EXPECTED.map((e) => e.resources));
    });
  }
});
