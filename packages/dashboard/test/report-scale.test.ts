// Report-scale — the full pipeline through the REAL cached demo bytes.
//
// Master 82723459: two Engines (us-west-1, us-west-2), 377 files each, 50
// incumbent performance-audit records per Engine. The run is cache-only — the
// transport THROWS if touched — so these tests need no network and no account.
//
// Fixture policy (SPEC.md → "Where the fixture bytes come from"): the cache is
// gitignored and re-fetchable. With an empty cache these tests SKIP LOUDLY —
// a green suite that silently tested nothing is this project's signature
// failure and must not be reproduced in its own harness.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { defaultCacheRoot } from '../src/cache.js';
import { parseBlob } from './helpers/blob.js';
import type { ReportData } from '../src/report.js';

const DEMO_MASTER = '82723459';
const cacheRoot = defaultCacheRoot();
const cachePresent = existsSync(path.join(cacheRoot, DEMO_MASTER, 'manifest.json'));

if (!cachePresent) {
  // Loud, and it names the remedy.
  console.warn(
    `\n[report-scale] SKIPPED — no cached Report ${DEMO_MASTER} at ${cacheRoot}.\n` +
      `[report-scale] Populate it with:\n` +
      `[report-scale]   BLAZEMETER_API_KEY=./api-key.json npx tsx packages/dashboard/scripts/fetch-cache.ts ${DEMO_MASTER}\n`,
  );
}

describe.skipIf(!cachePresent)('report-scale: the real demo Report through the CLI, cache-only', () => {
  let workDir: string;
  let html: string;
  let data: ReportData;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'bzm-demo-'));
    const outPath = path.join(workDir, 'demo.html');
    await runCli({
      argv: ['--master', DEMO_MASTER, '--out', outPath],
      env: {}, // cache-only: no credentials needed
      transport: () => {
        throw new Error('network call during a cache-only run');
      },
      cacheRoot,
    });
    html = await readFile(outPath, 'utf8');
    data = parseBlob(html);
  });
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('adapts all 100 legacy Samples — 50 per Engine, html twins never double-counted', () => {
    expect(data.samples).toHaveLength(100);
    expect(data.samples.every((s) => s.provenance === 'legacy')).toBe(true);
    // Legacy Samples carry no fabricated identity.
    expect(data.samples.every((s) => s.sample.test === null)).toBe(true);
    // And nothing was recorded unreadable — the html twins were excluded by
    // name, not parsed and rejected.
    for (const session of data.sessions) expect(session.unreadable).toEqual([]);
  });

  it('attributes both sessions, with single-Engine-per-location labels', () => {
    expect(data.sessions).toHaveLength(2);
    const counts = new Map<string, number>();
    for (const s of data.samples) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([50, 50]);
    // One Engine per location → plain locationId labels, no ordinal chrome.
    expect(new Set(data.samples.map((s) => s.engineLabel))).toEqual(
      new Set(['us-west-1', 'us-west-2']),
    );
    for (const s of data.samples) expect(s.masterId).toBe(DEMO_MASTER);
  });

  it('renders a Route table row with p50/p75/p95 over the expected coverage', () => {
    // Every audit hit https://example.com/ → Route "/".
    const row = data.routes.find((r) => r.route === '/')!;
    expect(row).toBeDefined();
    expect(row.sampleCount).toBe(100);

    // LCP measured on all 100 (both Engines pooled — Samples weighted, not
    // Engines); all three percentiles are real numbers by the pinned method,
    // ordered as percentiles must be.
    expect(row.metrics.lcp.ok).toBe(100);
    expect(row.metrics.lcp.total).toBe(100);
    expect(row.metrics.lcp.breakdown).toEqual({});
    expect(row.metrics.lcp.p50).toBeGreaterThan(0);
    expect(row.metrics.lcp.p75).toBeGreaterThanOrEqual(row.metrics.lcp.p50!);
    expect(row.metrics.lcp.p95).toBeGreaterThanOrEqual(row.metrics.lcp.p75!);

    // INP was null on every incumbent record. Through the legacy adapter that
    // is status "unknown" — the incumbent cannot say WHY (the distilled
    // fixture's "no-interaction 0 of 50" is the collector-provenance phrasing
    // of the same fact; see known-answers.test.ts). The aggregate carries the
    // reason as data, and p50/p75/p95 are null, never 0.
    expect(row.metrics.inp).toEqual({
      p50: null,
      p75: null,
      p95: null,
      ok: 0,
      total: 100,
      breakdown: { unknown: 100 },
      reason: 'unknown',
    });

    // The blob carries no mean, anywhere.
    expect(JSON.stringify(data.routes)).not.toMatch(/"mean"|"avg"/i);
  });

  it('is honest about what legacy data cannot say: Cold Starts unidentifiable, outcomes unavailable', () => {
    const row = data.routes.find((r) => r.route === '/')!;
    // No legacy record carries a workerIndex → first-ts-per-(sessionId,
    // workerIndex) is structurally impossible: null, never a guessed 0.
    expect(row.coldStarts).toBeNull();
    expect(data.samples.every((s) => s.coldStart === null)).toBe(true);

    // Zero Outcome records anywhere → outcome-awareness unavailable; nothing
    // is marked crashed on a session that was never emitting outcomes.
    expect(data.outcomes).toEqual([]);
    for (const session of data.sessions) expect(session.outcomeCount).toBe(0);
    expect(data.samples.every((s) => s.executionStatus === 'unavailable')).toBe(true);
  });

  it('emits no pre-signed URL and no external fetchable reference, even at real scale', () => {
    expect(html).not.toContain('storage.blazemeter.com');
    expect(html).not.toMatch(/<script[^>]+\bsrc\s*=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<img[^>]+\bsrc\s*=\s*["']?https?:/i);
  });
});
