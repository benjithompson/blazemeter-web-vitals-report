// The legacy adapter — the incumbent's performance-audit-*.json into the
// canonical shape. The fixture is one REAL record lifted from the cached demo
// Report (plumbing numbers and a public URL — fine to commit).
//
// Mapping under test (SPEC.md → "the legacy adapter"):
//   url → url; generatedAt → ts (epoch ms — stamps the audit, not Navigation start);
//   coreWebVitals.{fcp,lcp,cls,inp,ttfb} → vitals.*.value, status ok-if-non-null
//   else unknown; fullpageloadtime and firstByteMs DROPPED (byte-identical
//   duplicates); navigation.* → navigation.*; counts → context.*;
//   test identity UNAVAILABLE — the incumbent carries none.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptLegacyAuditRecord, isLegacyAuditJsonName } from '../src/legacy-adapter.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'legacy',
  'performance-audit-01-example-com-home-json-026dd038dd2def1dbf45ec47ad19bd3046866d4b.json',
);

async function fixtureRecord(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE, 'utf8'));
}

describe('isLegacyAuditJsonName', () => {
  it('selects only the JSON audit records, never the paired html copies', () => {
    expect(isLegacyAuditJsonName(path.basename(FIXTURE))).toBe(true);
    expect(
      isLegacyAuditJsonName('performance-audit-01-example-com-home-html-0b9a5494a21f29e56cf0db9c7ae628c1090c033b.html'),
    ).toBe(false);
    // The other json attachments in the same zip are NOT audit records.
    expect(isLegacyAuditJsonName('performance-01-example-com-home-json-abc.json')).toBe(false);
    expect(isLegacyAuditJsonName('network-01-example-com-home-json-abc.json')).toBe(false);
    expect(isLegacyAuditJsonName('resource-contribution-01-example-com-home-json-abc.json')).toBe(false);
  });
});

describe('adaptLegacyAuditRecord', () => {
  it('maps a real incumbent record to the canonical shape', async () => {
    const result = adaptLegacyAuditRecord(await fixtureRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.sample;

    expect(s.schemaVersion).toBe(1);
    expect(s.url).toBe('https://example.com/');
    // generatedAt parsed to epoch ms. It stamps the AUDIT, not Navigation start.
    expect(s.ts).toBe(Date.parse('2026-07-16T21:19:05.069Z'));

    expect(s.vitals.fcp).toEqual({ value: 2104, status: 'ok' });
    expect(s.vitals.lcp).toEqual({ value: 2104, status: 'ok' });
    // cls 0 is non-null — a measured zero, hence ok, never "unknown".
    expect(s.vitals.cls).toEqual({ value: 0, status: 'ok' });
    expect(s.vitals.ttfb).toEqual({ value: 167.79999999998836, status: 'ok' });
    // null → unknown: the incumbent cannot say why.
    expect(s.vitals.inp).toEqual({ value: null, status: 'unknown' });

    // The two byte-identical duplicates are dropped, not carried.
    expect(s.vitals).not.toHaveProperty('fullpageloadtime');
    expect(Object.keys(s.vitals)).toEqual(
      expect.arrayContaining(['fcp', 'lcp', 'cls', 'inp', 'ttfb']),
    );
    expect(Object.keys(s.vitals)).toHaveLength(5);

    expect(s.navigation).toEqual({
      domContentLoadedMs: 1889.399999999965,
      loadEventMs: 2445.5,
    });
    expect(s.context).toEqual({
      workers: null, // unavailable — the incumbent does not record it
      resourceCount: 84,
      requestCount: 87,
      failedRequests: 0,
    });

    // The incumbent carries no test identity at all — represented honestly as
    // null, never a fabricated TestIdentity.
    expect(s.test).toBeNull();
    expect(s.navigationIndex).toBeNull();
  });

  it('maps a missing metric to {value: null, status: unknown}', async () => {
    const rec = (await fixtureRecord()) as { coreWebVitals: Record<string, unknown> };
    delete rec.coreWebVitals.fcp;
    const result = adaptLegacyAuditRecord(rec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.vitals.fcp).toEqual({ value: null, status: 'unknown' });
  });

  it('rejects a record that is not an audit record, with a reason', () => {
    const result = adaptLegacyAuditRecord([{ startedAt: 1, url: 'x' }]); // a network log
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('rejects an unparseable generatedAt, with a reason', async () => {
    const rec = (await fixtureRecord()) as { generatedAt: string };
    rec.generatedAt = 'not a date';
    const result = adaptLegacyAuditRecord(rec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/generatedAt/);
  });
});
