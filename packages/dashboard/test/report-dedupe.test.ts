// The artifacts zip carries each record twice: the sha1-suffixed attachment
// copy, plus a bare fixed-name survivor of Taurus flattening the test-results
// tree in beside the attachments (last writer wins). Observed on the first
// real Engine run of the collector (master 82731327): without deduplication
// the final Execution per Engine is double-counted — the fixed-name collision
// this project has met twice before, resurfacing as duplication instead of
// loss. Two files in one session carrying the identical record are one Sample.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReportData } from '../src/report.js';
import type { MasterManifest } from '../src/cache.js';

const SESSION = 'r-v4-dedupe-test-session';

function sampleRecord(navigationIndex: number, ts: number) {
  return {
    schemaVersion: 1,
    ts,
    url: 'https://en.wikipedia.org/wiki/Web_performance',
    test: { file: 'example.spec.ts', title: 'Search Journey', project: 'chromium', repeat: 3, worker: 6 },
    navigationIndex,
    vitals: { ttfb: { value: 100, status: 'ok' } },
    navigation: { domContentLoadedMs: 500, loadEventMs: 900 },
    context: { workers: 2, resourceCount: 10, requestCount: 12, failedRequests: 0 },
  };
}

const outcomeRecord = {
  schemaVersion: 1,
  test: { file: 'example.spec.ts', title: 'Search Journey', project: 'chromium', repeat: 3, worker: 6 },
  status: 'passed',
  retry: 0,
};

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'bzm-dedupe-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('flattening-survivor deduplication', () => {
  it('counts a record once when the attachment copy and the bare survivor both exist', async () => {
    const sessionDir = path.join(workDir, SESSION);
    await mkdir(sessionDir, { recursive: true });

    // The attachment copies — one per Execution — plus the bare fixed-name
    // survivors, byte-identical to the LAST Execution's copies.
    const nav1 = JSON.stringify(sampleRecord(1, 1784300757338));
    const nav2 = JSON.stringify(sampleRecord(2, 1784300758832));
    const otherExecution = JSON.stringify(
      { ...sampleRecord(1, 1784300700000), test: { ...sampleRecord(1, 0).test, repeat: 2, worker: 4 } },
    );
    await writeFile(path.join(sessionDir, 'bzm-vitals-sample-1-aaaa.json'), otherExecution);
    await writeFile(path.join(sessionDir, 'bzm-vitals-sample-1-bbbb.json'), nav1);
    await writeFile(path.join(sessionDir, 'bzm-vitals-sample-2-cccc.json'), nav2);
    await writeFile(path.join(sessionDir, 'bzm-vitals-sample-1.json'), nav1); // survivor
    await writeFile(path.join(sessionDir, 'bzm-vitals-sample-2.json'), nav2); // survivor
    const outcomeJson = JSON.stringify(outcomeRecord);
    await writeFile(path.join(sessionDir, 'bzm-vitals-outcome-dddd.json'), outcomeJson);
    await writeFile(path.join(sessionDir, 'bzm-vitals-outcome.json'), outcomeJson); // survivor

    const manifest: MasterManifest = {
      masterId: '82731327',
      fetchedAt: '2026-07-17T15:10:00.000Z',
      sessions: [{ sessionId: SESSION, locationId: 'us-west-1', status: 'ENDED', artifact: 'present' }],
    };
    const data = await buildReportData(manifest, workDir);

    // 3 distinct records, not 5; 1 outcome, not 2.
    expect(data.samples).toHaveLength(3);
    expect(data.outcomes).toHaveLength(1);
    expect(data.sessions[0]!.sampleCount).toBe(3);
    expect(data.sessions[0]!.outcomeCount).toBe(1);
    // Nothing lands as unreadable — duplicates are not errors, just not new.
    expect(data.sessions[0]!.unreadable).toHaveLength(0);
    // The distinct Executions both survive.
    const keys = data.samples.map(
      (s) => `${s.sample.test?.repeat}/${s.sample.test?.worker}/${s.sample.navigationIndex}`,
    );
    expect(keys.sort()).toEqual(['2/4/1', '3/6/1', '3/6/2']);
  });
});
