// Unit tests for the format package's runtime surface: the closed vocabularies, the
// attachment prefixes, the schema version and the one routeOf. Writer (collector) and
// reader (dashboard) import these, so a change here is a change to both.

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  COLLECTOR_METRIC_STATUSES,
  EXECUTION_STATUSES,
  METRIC_STATUSES,
  OUTCOME_ATTACHMENT_PREFIX,
  SAMPLE_ATTACHMENT_PREFIX,
  SCHEMA_VERSION,
  isCollectorMetricStatus,
  isExecutionStatus,
  isMetricStatus,
  routeOf,
  type CollectorMetricStatus,
  type ExecutionStatus,
  type MetricStatus,
} from '../src/index';
import { ROUTE_TABLE } from './route-table';

describe('SCHEMA_VERSION', () => {
  it('is the literal 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expectTypeOf(SCHEMA_VERSION).toEqualTypeOf<1>();
  });
});

describe('attachment prefixes', () => {
  it('keep their published, stable values', () => {
    expect(SAMPLE_ATTACHMENT_PREFIX).toBe('bzm-vitals-sample');
    expect(OUTCOME_ATTACHMENT_PREFIX).toBe('bzm-vitals-outcome');
  });

  it('are disjoint: neither prefix is a prefix of the other', () => {
    expect(SAMPLE_ATTACHMENT_PREFIX.startsWith(OUTCOME_ATTACHMENT_PREFIX)).toBe(false);
    expect(OUTCOME_ATTACHMENT_PREFIX.startsWith(SAMPLE_ATTACHMENT_PREFIX)).toBe(false);
  });
});

describe('METRIC_STATUSES', () => {
  it('is the closed vocabulary, in order, with no duplicates', () => {
    expect(METRIC_STATUSES).toEqual(['ok', 'unsupported', 'no-interaction', 'not-finalized', 'error', 'unknown']);
    expect(new Set(METRIC_STATUSES).size).toBe(METRIC_STATUSES.length);
  });

  it('derives the MetricStatus union', () => {
    expectTypeOf<MetricStatus>().toEqualTypeOf<
      'ok' | 'unsupported' | 'no-interaction' | 'not-finalized' | 'error' | 'unknown'
    >();
  });

  it('isMetricStatus accepts every member and rejects anything else', () => {
    for (const s of METRIC_STATUSES) expect(isMetricStatus(s)).toBe(true);
    for (const x of ['OK', 'passed', '', 'ok ', null, undefined, 0, {}]) expect(isMetricStatus(x)).toBe(false);
  });
});

describe('COLLECTOR_METRIC_STATUSES', () => {
  it('is METRIC_STATUSES minus the legacy adapter’s unknown', () => {
    expect(COLLECTOR_METRIC_STATUSES).toEqual(METRIC_STATUSES.filter((s) => s !== 'unknown'));
    expectTypeOf<CollectorMetricStatus>().toEqualTypeOf<Exclude<MetricStatus, 'unknown'>>();
  });

  it('isCollectorMetricStatus rejects unknown and non-members', () => {
    for (const s of COLLECTOR_METRIC_STATUSES) expect(isCollectorMetricStatus(s)).toBe(true);
    for (const x of ['unknown', 'passed', undefined]) expect(isCollectorMetricStatus(x)).toBe(false);
  });
});

describe('EXECUTION_STATUSES', () => {
  it('is the closed Outcome vocabulary, without interrupted', () => {
    expect(EXECUTION_STATUSES).toEqual(['passed', 'failed', 'timedOut', 'skipped']);
    expectTypeOf<ExecutionStatus>().toEqualTypeOf<'passed' | 'failed' | 'timedOut' | 'skipped'>();
  });

  it('isExecutionStatus accepts every member and rejects anything else', () => {
    for (const s of EXECUTION_STATUSES) expect(isExecutionStatus(s)).toBe(true);
    for (const x of ['interrupted', 'timedout', 'ok', '', undefined, null, 1]) expect(isExecutionStatus(x)).toBe(false);
  });
});

describe('routeOf', () => {
  it.each(ROUTE_TABLE)('route=%j url=%j -> %j', (route, url, expected) => {
    expect(routeOf(route === undefined ? { url } : { route, url })).toBe(expected);
  });

  it('never alters the record it reads', () => {
    const record = { url: 'https://example.com/order/1?x=1#y' };
    routeOf(record);
    expect(record).toEqual({ url: 'https://example.com/order/1?x=1#y' });
  });
});
