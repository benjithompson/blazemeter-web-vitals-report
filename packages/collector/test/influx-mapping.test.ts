// Unit seam for the InfluxDB destination's PURE half: the Sample→wide-Point mapping, the
// line-protocol assembly + escaping, and the env readers. No network, no browser — every
// input is a hand-built format-v1 Sample or a plain env object, so these pin the line-
// protocol contract exactly and run in milliseconds. The injected-fetch seam
// (influx-destination.test.ts) proves the same shapes reach a live write endpoint; the
// Docker integration test (influx-integration.test.ts) proves they round-trip a real bucket.

import { describe, it, expect } from 'vitest';
import type { Sample, Metric } from 'bzm-vitals-format';
import {
  sampleToPoint,
  samplesToPoints,
  resolveInfluxConfig,
  resolveInfluxToken,
  resolveMeasurement,
  DEFAULT_MEASUREMENT,
  type InfluxMappingContext,
} from '../src/influx-destination';
import { pointToLine, pointsToLineProtocol, type Point } from '../src/influx-writer';

const CTX: InfluxMappingContext = {
  measurement: 'web_vitals',
  location: 'us-west-1',
  engine: null,
};

function m(value: number | null, status: Metric['status']): Metric {
  return { value, status };
}

/** A Sample carrying whatever vitals the test wants; everything else plausible. */
function sample(overrides: Partial<Sample> & { vitals: Sample['vitals'] }): Sample {
  return {
    schemaVersion: 1,
    ts: 1_700_000_123_456, // epoch ms — written verbatim at precision=ms
    url: 'https://shop.example.com/order/98765?ref=email#top',
    test: { file: 'x.spec.ts', title: 'checkout journey', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    navigation: { domContentLoadedMs: 10, loadEventMs: 20 },
    context: { workers: 2, resourceCount: 3, requestCount: 4, failedRequests: 0 },
    ...overrides,
  };
}

describe('sampleToPoint — one wide point per Sample, one field per ok vital', () => {
  it('keeps native float64 values: ms verbatim, CLS as its true float (no rounding, no ×1000)', () => {
    const s = sample({ vitals: { lcp: m(2276.7, 'ok'), cls: m(0.083, 'ok') } });
    const p = sampleToPoint(s, CTX);
    expect(p).not.toBeNull();
    expect(p!.fields).toEqual({ lcp: 2276.7, cls: 0.083 });
  });

  it('field keys are the lowercase vital names, exactly the Sample.vitals keys', () => {
    const s = sample({
      vitals: { ttfb: m(120, 'ok'), fcp: m(340, 'ok'), lcp: m(890, 'ok'), cls: m(0.02, 'ok'), inp: m(45, 'ok') },
    });
    const p = sampleToPoint(s, CTX)!;
    expect(Object.keys(p.fields).sort()).toEqual(['cls', 'fcp', 'inp', 'lcp', 'ttfb']);
  });

  it('a not-ok vital is simply ABSENT from the field set — never a placeholder or 0', () => {
    const s = sample({
      vitals: {
        lcp: m(890, 'ok'),
        cls: m(null, 'unsupported'),
        inp: m(null, 'no-interaction'),
        ttfb: m(null, 'error'),
      },
    });
    const p = sampleToPoint(s, CTX)!;
    expect(p.fields).toEqual({ lcp: 890 });
  });

  it('a genuine-zero CLS (status ok, value 0) IS a field — distinct from unsupported', () => {
    const s = sample({ vitals: { cls: m(0, 'ok') } });
    expect(sampleToPoint(s, CTX)!.fields).toEqual({ cls: 0 });
  });

  it('a Sample with NO ok vital maps to null (an empty field set is not a valid line)', () => {
    const s = sample({ vitals: { lcp: m(null, 'not-finalized'), cls: m(null, 'unsupported') } });
    expect(sampleToPoint(s, CTX)).toBeNull();
  });

  it('tags are the bounded dimensions: route, location, project, title — never worker/repeat', () => {
    const s = sample({ route: '/order/{id}', vitals: { lcp: m(890, 'ok') } });
    const p = sampleToPoint(s, CTX)!;
    expect(p.tags).toEqual({
      route: '/order/{id}',
      location: 'us-west-1',
      project: 'chromium',
      title: 'checkout journey',
    });
  });

  it('with no declared route, the tag derives the URL pathname (query/fragment stripped)', () => {
    const p = sampleToPoint(sample({ vitals: { lcp: m(1, 'ok') } }), CTX)!;
    expect(p.tags.route).toBe('/order/98765');
  });

  it('in per-engine mode the engine tag is added; by default it is omitted entirely', () => {
    const s = sample({ vitals: { lcp: m(890, 'ok') } });
    expect(sampleToPoint(s, CTX)!.tags.engine).toBeUndefined();
    const withEngine = sampleToPoint(s, { ...CTX, engine: '#2' })!;
    expect(withEngine.tags.engine).toBe('#2');
  });

  it('timestamp is Sample.ts verbatim (epoch-ms) and the measurement comes from the context', () => {
    const p = sampleToPoint(sample({ vitals: { lcp: m(1, 'ok') } }), CTX)!;
    expect(p.timestamp).toBe(1_700_000_123_456);
    expect(p.measurement).toBe('web_vitals');
  });
});

describe('samplesToPoints — batch mapping drops the no-ok-vital Samples', () => {
  it('keeps only Samples with at least one ok vital', () => {
    const points = samplesToPoints(
      [
        sample({ vitals: { lcp: m(890, 'ok') } }),
        sample({ vitals: { lcp: m(null, 'error') } }), // dropped
        sample({ vitals: { cls: m(0.01, 'ok') } }),
      ],
      CTX,
    );
    expect(points).toHaveLength(2);
  });
});

describe('pointToLine — line-protocol assembly + escaping', () => {
  const base: Point = {
    measurement: 'web_vitals',
    tags: { route: '/order/{id}', location: 'us-west-1', project: 'chromium', title: 'checkout journey' },
    fields: { lcp: 890, cls: 0.083 },
    timestamp: 1_700_000_123_456,
  };

  it('sorts tag keys deterministically and appends fields then the timestamp', () => {
    expect(pointToLine(base)).toBe(
      'web_vitals,location=us-west-1,project=chromium,route=/order/{id},title=checkout\\ journey lcp=890,cls=0.083 1700000123456',
    );
  });

  it('escapes commas, equals, and spaces in tag values', () => {
    const line = pointToLine({
      ...base,
      tags: { route: '/a,b=c d' },
      fields: { lcp: 1 },
    });
    expect(line).toBe('web_vitals,route=/a\\,b\\=c\\ d lcp=1 1700000123456');
  });

  it('drops empty tag values (line protocol forbids them)', () => {
    const line = pointToLine({ ...base, tags: { route: '/x', location: '' }, fields: { lcp: 1 } });
    expect(line).toBe('web_vitals,route=/x lcp=1 1700000123456');
  });

  it('drops non-finite field values, and returns null when that empties the field set', () => {
    expect(pointToLine({ ...base, fields: { lcp: NaN }, tags: {} })).toBeNull();
    expect(pointToLine({ ...base, fields: { lcp: 890, cls: Infinity }, tags: {} })).toBe(
      'web_vitals lcp=890 1700000123456',
    );
  });

  it('a point with no tags renders just the measurement', () => {
    expect(pointToLine({ ...base, tags: {}, fields: { lcp: 1 } })).toBe('web_vitals lcp=1 1700000123456');
  });
});

describe('pointsToLineProtocol — newline-joined body, null lines skipped', () => {
  it('joins renderable points and skips the empty-field ones', () => {
    const body = pointsToLineProtocol([
      { measurement: 'web_vitals', tags: { route: '/a' }, fields: { lcp: 1 }, timestamp: 1000 },
      { measurement: 'web_vitals', tags: { route: '/b' }, fields: { lcp: NaN }, timestamp: 2000 }, // skipped
      { measurement: 'web_vitals', tags: { route: '/c' }, fields: { cls: 0.5 }, timestamp: 3000 },
    ]);
    expect(body).toBe('web_vitals,route=/a lcp=1 1000\nweb_vitals,route=/c cls=0.5 3000');
  });
});

describe('resolveInfluxToken — named vars only, with the managed-secret + pointer paths', () => {
  it('reads BZM_INFLUX_TOKEN directly', () => {
    expect(resolveInfluxToken({ BZM_INFLUX_TOKEN: 'tok-1' })).toBe('tok-1');
  });

  it('falls back to the BZM_SECRET_influxtoken managed-secret name', () => {
    expect(resolveInfluxToken({ BZM_SECRET_influxtoken: 'tok-secret' })).toBe('tok-secret');
  });

  it('a pointer var names WHICH env var holds the token', () => {
    expect(resolveInfluxToken({ BZM_INFLUX_TOKEN_ENV: 'MY_TOKEN', MY_TOKEN: 'tok-ptr' })).toBe('tok-ptr');
  });

  it('is undefined when nothing supplies a token', () => {
    expect(resolveInfluxToken({})).toBeUndefined();
  });
});

describe('resolveInfluxConfig — all four parts required', () => {
  const full = {
    BZM_INFLUX_URL: 'https://influx.example.com',
    BZM_INFLUX_ORG: 'perf',
    BZM_INFLUX_BUCKET: 'vitals',
    BZM_INFLUX_TOKEN: 'tok-1',
  };

  it('resolves a full connection', () => {
    expect(resolveInfluxConfig(full)).toEqual({
      url: 'https://influx.example.com',
      org: 'perf',
      bucket: 'vitals',
      token: 'tok-1',
    });
  });

  it.each(['BZM_INFLUX_URL', 'BZM_INFLUX_ORG', 'BZM_INFLUX_BUCKET', 'BZM_INFLUX_TOKEN'])(
    'is null when %s is missing',
    (missing) => {
      const env: Record<string, string | undefined> = { ...full };
      delete env[missing];
      expect(resolveInfluxConfig(env)).toBeNull();
    },
  );
});

describe('resolveMeasurement — default with an override', () => {
  it('defaults to web_vitals', () => {
    expect(resolveMeasurement({})).toBe(DEFAULT_MEASUREMENT);
    expect(resolveMeasurement({})).toBe('web_vitals');
  });

  it('honors BZM_INFLUX_MEASUREMENT', () => {
    expect(resolveMeasurement({ BZM_INFLUX_MEASUREMENT: 'front_end_vitals' })).toBe('front_end_vitals');
  });
});
