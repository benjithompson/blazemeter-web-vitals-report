// Attribution — Sample + {masterId, sessionId, locationId, engineLabel}.
// Two distinct types: the on-disk Sample and the dashboard's AttributedSample.
// Engine Label: "{locationId} #{ordinal}" when a location has >1 Engine,
// plain "{locationId}" when it has exactly one. Label for humans, sessionId
// for joining — never key on the label.

import { describe, it, expect } from 'vitest';
import { attributeSample, engineLabels } from '../src/attribute.js';
import type { DashboardSample } from '../src/parse.js';

function sample(url: string): DashboardSample {
  return {
    schemaVersion: 1,
    ts: 1752700745069,
    url,
    test: null,
    navigationIndex: null,
    vitals: { lcp: { value: 100, status: 'ok' } },
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: null, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

describe('engineLabels', () => {
  it('labels a single Engine per location with the bare locationId', () => {
    const labels = engineLabels([
      { sessionId: 'r-v4-aaa', locationId: 'us-west-1' },
      { sessionId: 'r-v4-bbb', locationId: 'us-west-2' },
    ]);
    expect(labels.get('r-v4-aaa')).toBe('us-west-1');
    expect(labels.get('r-v4-bbb')).toBe('us-west-2');
  });

  it('labels multiple Engines on one location with #ordinals', () => {
    const labels = engineLabels([
      { sessionId: 'r-v4-aaa', locationId: 'us-west-1' },
      { sessionId: 'r-v4-bbb', locationId: 'us-west-1' },
      { sessionId: 'r-v4-ccc', locationId: 'us-east-1' },
    ]);
    expect(labels.get('r-v4-aaa')).toBe('us-west-1 #1');
    expect(labels.get('r-v4-bbb')).toBe('us-west-1 #2');
    expect(labels.get('r-v4-ccc')).toBe('us-east-1');
  });
});

describe('attributeSample', () => {
  it('stamps masterId, sessionId, locationId and engineLabel onto the Sample', () => {
    const attributed = attributeSample(sample('https://example.com/a'), 'legacy', {
      masterId: '82723459',
      sessionId: 'r-v4-aaa',
      locationId: 'us-west-1',
      engineLabel: 'us-west-1',
    });
    expect(attributed.masterId).toBe('82723459');
    expect(attributed.sessionId).toBe('r-v4-aaa');
    expect(attributed.locationId).toBe('us-west-1');
    expect(attributed.engineLabel).toBe('us-west-1');
    expect(attributed.provenance).toBe('legacy');
    expect(attributed.sample.url).toBe('https://example.com/a');
  });
});
