// The canonical parser — format-v1 Samples in, DashboardSamples out.
//
// schemaVersion mismatch is REJECTED LOUDLY (recorded per-file with a reason,
// never silently misread). Metric NAMES are open — unknown names pass through.
// Every field is preserved: issue #10 feeds the collector's real output through
// this parser and asserts a full round-trip.

import { describe, it, expect } from 'vitest';
import { OUTCOME_ATTACHMENT_PREFIX, SAMPLE_ATTACHMENT_PREFIX } from '@bzm/vitals-format';
import {
  isOutcomeAttachment,
  isSampleAttachment,
  parseOutcomeJson,
  parseSampleJson,
} from '../src/parse.js';

const validSample = {
  schemaVersion: 1,
  ts: 1752700745069,
  url: 'https://example.com/',
  test: { file: 'example.spec.ts', title: 'demo Landing Page', project: 'chromium', repeat: 18, worker: 3 },
  navigationIndex: 1,
  vitals: {
    ttfb: { value: 167.8, status: 'ok' },
    fcp: { value: 2104, status: 'ok' },
    lcp: { value: 2104, status: 'ok' },
    cls: { value: 0.00059, status: 'ok' },
    inp: { value: null, status: 'no-interaction' },
  },
  navigation: { domContentLoadedMs: 1889.4, loadEventMs: 2445.5 },
  context: { workers: 5, resourceCount: 84, requestCount: 87, failedRequests: 0 },
};

describe('isSampleAttachment', () => {
  it('matches the collector\'s attachment basenames by prefix', () => {
    // Playwright's attach() mangles the basename to {name}-{sha1(path)}{ext}.
    expect(
      isSampleAttachment(`${SAMPLE_ATTACHMENT_PREFIX}-1-026dd038dd2def1dbf45ec47ad19bd3046866d4b.json`),
    ).toBe(true);
    expect(isSampleAttachment(`${SAMPLE_ATTACHMENT_PREFIX}-2.json`)).toBe(true);
  });

  it('rejects everything else, including the probe and legacy names', () => {
    expect(isSampleAttachment('probe-path-16816e1cb2abcc3ebbf681f0574171254cf8ea71.json')).toBe(false);
    expect(isSampleAttachment('performance-audit-01-example-com-home-json-abc.json')).toBe(false);
    expect(isSampleAttachment('bzt.log')).toBe(false);
  });
});

describe('parseSampleJson', () => {
  it('parses a valid format-v1 Sample and preserves every field', () => {
    const raw = JSON.stringify(validSample);
    const result = parseSampleJson(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Full round-trip: nothing dropped, nothing rewritten.
    expect(result.sample).toEqual(JSON.parse(raw));
  });

  it('rejects schemaVersion !== 1 loudly, with a reason', () => {
    const raw = JSON.stringify({ ...validSample, schemaVersion: 2 });
    const result = parseSampleJson(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/schemaVersion/);
    expect(result.reason).toMatch(/2/);
  });

  it('rejects a record with no schemaVersion at all', () => {
    const { schemaVersion: _, ...rest } = validSample;
    const result = parseSampleJson(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/schemaVersion/);
  });

  it('rejects unparseable bytes with a reason', () => {
    const result = parseSampleJson('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('passes unknown metric names through — the name set is open', () => {
    const raw = JSON.stringify({
      ...validSample,
      vitals: { ...validSample.vitals, myCustomTiming: { value: 42, status: 'ok' } },
    });
    const result = parseSampleJson(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.vitals.myCustomTiming).toEqual({ value: 42, status: 'ok' });
  });

  it('preserves an unknown metric status verbatim (aggregation treats it as not-ok)', () => {
    const raw = JSON.stringify({
      ...validSample,
      vitals: { ...validSample.vitals, lcp: { value: 999, status: 'brand-new-status' } },
    });
    const result = parseSampleJson(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.vitals.lcp.status).toBe('brand-new-status');
  });
});

const validOutcome = {
  schemaVersion: 1,
  test: { file: 'example.spec.ts', title: 'demo Landing Page', project: 'chromium', repeat: 18, worker: 3 },
  status: 'passed',
  retry: 0,
};

describe('isOutcomeAttachment', () => {
  it('matches the collector\'s Outcome basenames by prefix, and nothing else', () => {
    expect(
      isOutcomeAttachment(`${OUTCOME_ATTACHMENT_PREFIX}-1-026dd038dd2def1dbf45ec47ad19bd3046866d4b.json`),
    ).toBe(true);
    expect(isOutcomeAttachment(`${OUTCOME_ATTACHMENT_PREFIX}-2.json`)).toBe(true);
    // Sample and Outcome prefixes never cross-match.
    expect(isOutcomeAttachment(`${SAMPLE_ATTACHMENT_PREFIX}-1.json`)).toBe(false);
    expect(isSampleAttachment(`${OUTCOME_ATTACHMENT_PREFIX}-1.json`)).toBe(false);
    expect(isOutcomeAttachment('bzt.log')).toBe(false);
  });
});

describe('parseOutcomeJson', () => {
  it('parses a valid format-v1 Outcome', () => {
    const result = parseOutcomeJson(JSON.stringify(validOutcome));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toEqual(validOutcome);
  });

  it('rejects schemaVersion !== 1 loudly — same discipline as Samples', () => {
    const result = parseOutcomeJson(JSON.stringify({ ...validOutcome, schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/schemaVersion/);
  });

  it('rejects an unknown status — the ExecutionStatus vocabulary is closed', () => {
    const result = parseOutcomeJson(JSON.stringify({ ...validOutcome, status: 'exploded' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/status/);
    expect(result.reason).toMatch(/exploded/);
  });

  it('rejects an Outcome missing the test identity it joins on', () => {
    const { test: _, ...rest } = validOutcome;
    const result = parseOutcomeJson(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/test/);
  });

  it('rejects unparseable bytes with a reason', () => {
    const result = parseOutcomeJson('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
