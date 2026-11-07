// validateSample / validateOutcome (B2): the one runtime definition of a valid record.
// conformance.test.ts holds them to agreement with the JSON Schemas; this file pins the
// behaviour a reader relies on: the record comes back untouched, and a rejection's reason
// names the offending field.

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  validateOutcome,
  validateSample,
  type ExecutionOutcome,
  type Sample,
  type TestIdentity,
  type Validation,
} from '../src/index';

const sample = () => ({
  schemaVersion: 1,
  ts: 1752700745069,
  url: 'https://example.com/',
  test: { file: 'example.spec.ts', title: 'Landing', project: 'chromium', repeat: 0, worker: 0 },
  navigationIndex: 1,
  vitals: {
    lcp: { value: 2104, status: 'ok' },
    cls: { value: null, status: 'unsupported' },
    inp: { value: null, status: 'no-interaction' },
  },
  navigation: { domContentLoadedMs: 1889.4, loadEventMs: null },
  context: { workers: 5, resourceCount: 84, requestCount: 87, failedRequests: 0 },
});

const outcome = () => ({
  schemaVersion: 1,
  test: { file: 'example.spec.ts', title: 'Landing', project: 'chromium', repeat: 0, worker: 0 },
  status: 'passed',
  retry: 0,
});

function reasonOf(r: Validation<unknown>): string {
  if (r.ok) throw new Error('expected a rejection, got ok');
  return r.reason;
}

describe('validateSample', () => {
  it('returns the very same object when valid — never a rebuilt copy, so unknown fields ride along', () => {
    const x = { ...sample(), futureField: [1, 2] };
    const r = validateSample(x);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(x);
  });

  it('accepts a 0.2.x identity (no id/titlePath/path) and the additive B2 identity', () => {
    expect(validateSample(sample()).ok).toBe(true);
    const x = sample();
    Object.assign(x.test, { id: 'abc-123', titlePath: ['Suite', 'Landing'], path: 'flows/example.spec.ts' });
    expect(validateSample(x).ok).toBe(true);
  });

  it('rejects vitals.lcp = {value: "12", status: "ok"} naming vitals.lcp.value', () => {
    const x = sample();
    (x.vitals.lcp as { value: unknown }).value = '12';
    expect(reasonOf(validateSample(x))).toMatch(/^vitals\.lcp\.value must be a number or null, got "12"/);
  });

  it('rejects a test identity missing project, naming test.project', () => {
    const x = sample() as { test: Partial<TestIdentity> };
    delete x.test.project;
    expect(reasonOf(validateSample(x))).toMatch(/^test\.project is missing/);
  });

  it('names the metric and the vocabulary for an unknown status', () => {
    const x = sample();
    x.vitals.lcp.status = 'brand-new-status';
    const reason = reasonOf(validateSample(x));
    expect(reason).toMatch(/vitals\.lcp\.status "brand-new-status"/);
    expect(reason).toMatch(/closed Metric status vocabulary/);
  });

  it("enforces value === null unless status === 'ok', and a number when it is", () => {
    const withValue = sample();
    (withValue.vitals.cls as { value: unknown }).value = 0;
    expect(reasonOf(validateSample(withValue))).toMatch(/vitals\.cls\.value must be null when status is 'unsupported'/);
    const okNull = sample();
    (okNull.vitals.lcp as { value: unknown }).value = null;
    expect(reasonOf(validateSample(okNull))).toMatch(/vitals\.lcp\.value must be a number when status is 'ok'/);
  });

  it('keeps the schemaVersion rejection message the dashboard has always reported', () => {
    expect(reasonOf(validateSample({ ...sample(), schemaVersion: 2 }))).toBe(
      'schemaVersion 2 is not the supported version 1 — rejected, not misread',
    );
  });

  it('checks optional fields only when present: route, pageIndex, test.titlePath', () => {
    expect(reasonOf(validateSample({ ...sample(), route: 7 }))).toMatch(/^route must be a string when present/);
    expect(reasonOf(validateSample({ ...sample(), pageIndex: -1 }))).toMatch(/^pageIndex must be a non-negative integer/);
    expect(validateSample({ ...sample(), pageIndex: 2 }).ok).toBe(true);
    const x = sample();
    Object.assign(x.test, { titlePath: 'Suite › Landing' });
    expect(reasonOf(validateSample(x))).toMatch(/^test\.titlePath must be an array of strings/);
  });

  it('rejects non-finite numbers an in-memory writer could produce (JSON would turn them into null)', () => {
    const x = sample();
    x.vitals.lcp.value = Number.NaN;
    expect(validateSample(x).ok).toBe(false);
    expect(validateSample({ ...sample(), ts: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it('bounds a huge bad value in the reason', () => {
    const reason = reasonOf(validateSample({ ...sample(), url: 'x'.repeat(10_000).split('') }));
    expect(reason.length).toBeLessThan(200);
  });

  it('narrows to Sample', () => {
    const r = validateSample(sample() as unknown);
    if (r.ok) expectTypeOf(r.value).toEqualTypeOf<Sample>();
  });
});

describe('validateOutcome', () => {
  it('returns the very same object when valid, with or without the additive fields', () => {
    const x = outcome();
    const r = validateOutcome(x);
    expect(r.ok && r.value).toBe(x);
    expect(validateOutcome({ ...outcome(), lostNavigations: 3 }).ok).toBe(true);
  });

  it('keeps the closed-status rejection naming the bad status', () => {
    expect(reasonOf(validateOutcome({ ...outcome(), status: 'exploded' }))).toMatch(
      /^status "exploded" is not in the closed ExecutionStatus vocabulary/,
    );
  });

  it('rejects a missing identity, a non-integer repeat and a bad lostNavigations', () => {
    const { test: _, ...noTest } = outcome();
    expect(reasonOf(validateOutcome(noTest))).toMatch(/^test is missing/);
    const x = outcome();
    (x.test as { repeat: unknown }).repeat = '0';
    expect(reasonOf(validateOutcome(x))).toMatch(/^test\.repeat must be a non-negative integer, got "0"/);
    expect(reasonOf(validateOutcome({ ...outcome(), lostNavigations: 1.5 }))).toMatch(/^lostNavigations/);
  });

  it('narrows to ExecutionOutcome', () => {
    const r = validateOutcome(outcome() as unknown);
    if (r.ok) expectTypeOf(r.value).toEqualTypeOf<ExecutionOutcome>();
  });
});

describe('the additive fields are optional in the types (no SCHEMA_VERSION bump)', () => {
  it('a 0.2.x-shaped TestIdentity / Sample / Outcome still type-checks', () => {
    expectTypeOf<{ file: string; title: string; project: string; repeat: number; worker: number }>().toMatchTypeOf<TestIdentity>();
    expectTypeOf<TestIdentity['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TestIdentity['titlePath']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<TestIdentity['path']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Sample['pageIndex']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ExecutionOutcome['lostNavigations']>().toEqualTypeOf<number | undefined>();
  });
});
