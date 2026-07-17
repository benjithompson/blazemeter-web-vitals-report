// Unit seam for the BlazeMeter destination's PURE Sample→interval mapping and its env
// readers. No network, no browser — every input is a hand-built format-v1 Sample or a
// plain env object, so these pin the injection contract (issue #15) exactly and run in
// milliseconds. The real-run Seam A (push.test.ts) proves the SAME shapes reach a live
// server double; this file proves each rule in isolation.

import { describe, it, expect } from 'vitest';
import type { Sample, Metric } from 'bzm-vitals-format';
import {
  sampleToIntervals,
  buildInjectionBody,
  routeOf,
  resolveLocation,
  resolveEngine,
  isPushKilled,
  readDiscreteCredentials,
  type MappingContext,
} from '../src/blazemeter-destination';

const CTX: MappingContext = {
  masterId: 82_731_957,
  location: 'us-west-1',
  engine: '#1',
  profileName: 'Web Vitals',
};

function m(value: number | null, status: Metric['status']): Metric {
  return { value, status };
}

/** A Sample carrying whatever vitals the test wants; everything else plausible. */
function sample(overrides: Partial<Sample> & { vitals: Sample['vitals'] }): Sample {
  return {
    schemaVersion: 1,
    ts: 1_700_000_123_456, // epoch ms → floor/1000 = 1_700_000_123 s
    url: 'https://shop.example.com/order/98765?ref=email#top',
    test: { file: 'x.spec.ts', title: 't', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    navigation: { domContentLoadedMs: 10, loadEventMs: 20 },
    context: { workers: 2, resourceCount: 3, requestCount: 4, failedRequests: 0 },
    ...overrides,
  };
}

const TS_SECONDS = 1_700_000_123;

describe('routeOf — the same routing the file report uses', () => {
  it('a declared route wins verbatim, braces and all', () => {
    expect(routeOf(sample({ route: '/order/{id}', vitals: {} }))).toBe('/order/{id}');
  });

  it('with no declared route, derives the URL pathname (query/fragment stripped)', () => {
    expect(routeOf(sample({ vitals: {} }))).toBe('/order/98765');
  });

  it('an address the URL parser rejects (no scheme) strips query/fragment by hand', () => {
    // new URL('/order/9?x=1#y') throws (no base) → the catch strips ?…/#… by hand.
    expect(routeOf(sample({ url: '/order/9?x=1#y', vitals: {} }))).toBe('/order/9');
  });
});

describe('sampleToIntervals — one interval per ok vital, none for anything else', () => {
  it('an ms vital becomes a rounded-integer kpi under an UPPERCASE metric leaf', () => {
    const s = sample({ route: '/order/{id}', vitals: { lcp: m(2276.7, 'ok') } });
    const intervals = sampleToIntervals(s, CTX);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toEqual({
      _id: {
        masterId: 82_731_957,
        metricPath: 'Web Vitals | us-west-1 | #1 | /order/{id} | LCP',
        ts: TS_SECONDS,
      },
      kpis: [{ value: 2277, ts: TS_SECONDS }],
      profileName: 'Web Vitals',
    });
  });

  it('all four ms vitals round to integers and carry their uppercase leaf', () => {
    const s = sample({
      route: '/p',
      vitals: {
        ttfb: m(12.4, 'ok'),
        fcp: m(88.6, 'ok'),
        lcp: m(2276.2, 'ok'),
        inp: m(45.5, 'ok'),
      },
    });
    const byLeaf = new Map(
      sampleToIntervals(s, CTX).map((iv) => [iv._id.metricPath.split(' | ').pop(), iv.kpis[0]!.value]),
    );
    expect(byLeaf.get('TTFB')).toBe(12);
    expect(byLeaf.get('FCP')).toBe(89);
    expect(byLeaf.get('LCP')).toBe(2276);
    expect(byLeaf.get('INP')).toBe(46); // 45.5 rounds up
  });

  it('CLS is scaled ×1000, rounded, and pushed under the self-describing leaf CLS×1000', () => {
    const s = sample({ route: '/p', vitals: { cls: m(0.08, 'ok') } });
    const intervals = sampleToIntervals(s, CTX);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!._id.metricPath).toBe('Web Vitals | us-west-1 | #1 | /p | CLS×1000');
    expect(intervals[0]!.kpis[0]!.value).toBe(80); // 0.08 → 80, not a collapsed 0
  });

  it('a true-zero CLS (stable page, status ok) still pushes an honest 0', () => {
    const s = sample({ route: '/p', vitals: { cls: m(0, 'ok') } });
    expect(sampleToIntervals(s, CTX)[0]!.kpis[0]!.value).toBe(0);
  });

  it('ts is floored to epoch SECONDS on both _id.ts and kpi.ts', () => {
    const s = sample({ ts: 1_700_000_999_999, route: '/p', vitals: { fcp: m(1, 'ok') } });
    const iv = sampleToIntervals(s, CTX)[0]!;
    expect(iv._id.ts).toBe(1_700_000_999);
    expect(iv.kpis[0]!.ts).toBe(1_700_000_999);
  });

  it('every non-ok status produces NO interval — never a placeholder, never 0', () => {
    const s = sample({
      route: '/p',
      vitals: {
        ttfb: m(null, 'error'),
        fcp: m(null, 'not-finalized'),
        cls: m(null, 'unsupported'),
        inp: m(null, 'no-interaction'),
      },
    });
    expect(sampleToIntervals(s, CTX)).toEqual([]);
  });

  it('an ok status carrying a non-finite value is dropped, not pushed as garbage', () => {
    const s = sample({ route: '/p', vitals: { lcp: { value: NaN, status: 'ok' } } });
    expect(sampleToIntervals(s, CTX)).toEqual([]);
  });

  it('mixed vitals: only the ok ones survive, in encounter order', () => {
    const s = sample({
      route: '/p',
      vitals: {
        ttfb: m(10, 'ok'),
        fcp: m(null, 'error'),
        lcp: m(2000, 'ok'),
        cls: m(null, 'unsupported'),
        inp: m(null, 'no-interaction'),
      },
    });
    const leaves = sampleToIntervals(s, CTX).map((iv) => iv._id.metricPath.split(' | ').pop());
    expect(leaves).toEqual(['TTFB', 'LCP']);
  });

  it('the derived route feeds the metricPath when none is declared', () => {
    const s = sample({ vitals: { ttfb: m(10, 'ok') } }); // url .../order/98765
    expect(sampleToIntervals(s, CTX)[0]!._id.metricPath).toBe(
      'Web Vitals | us-west-1 | #1 | /order/98765 | TTFB',
    );
  });
});

describe('buildInjectionBody — the POST payload for a batch', () => {
  it('flattens every sample’s intervals under one intervals[] array', () => {
    const batch = [
      sample({ route: '/a', vitals: { ttfb: m(10, 'ok'), lcp: m(20, 'ok') } }),
      sample({ route: '/b', vitals: { fcp: m(30, 'ok') } }),
    ];
    const body = buildInjectionBody(batch, CTX);
    expect(body.intervals).toHaveLength(3);
    expect(body.intervals.every((iv) => iv._id.masterId === CTX.masterId)).toBe(true);
    expect(body.intervals.every((iv) => iv.profileName === 'Web Vitals')).toBe(true);
  });

  it('a batch with nothing ok yields an empty intervals[] (caller skips the POST)', () => {
    const body = buildInjectionBody([sample({ vitals: { cls: m(null, 'unsupported') } })], CTX);
    expect(body.intervals).toEqual([]);
  });
});

describe('env readers — activation and identity, all from named vars only', () => {
  it('isPushKilled recognises 0 / off / false (case-insensitive), nothing else', () => {
    for (const v of ['0', 'off', 'false', 'OFF', 'False']) {
      expect(isPushKilled({ BZM_VITALS_PUSH: v }), v).toBe(true);
    }
    for (const v of ['1', 'on', 'true', '', undefined]) {
      expect(isPushKilled({ BZM_VITALS_PUSH: v as string }), String(v)).toBe(false);
    }
  });

  it('resolveLocation reads LOCATION, with a stable fallback', () => {
    expect(resolveLocation({ LOCATION: 'eu-west-1' })).toBe('eu-west-1');
    expect(resolveLocation({})).toBe('unknown-location');
  });

  it('resolveEngine: explicit override wins; else a #-ordinal from the Taurus index; else #1', () => {
    expect(resolveEngine({ BZM_VITALS_ENGINE: '#7' })).toBe('#7');
    expect(resolveEngine({ TAURUS_INDEX_ALL: '0' })).toBe('#1'); // 0-based → #1
    expect(resolveEngine({ TAURUS_INDEX_ALL: '2' })).toBe('#3');
    expect(resolveEngine({})).toBe('#1');
  });

  it('readDiscreteCredentials returns id/secret only when BOTH discrete vars are present', () => {
    expect(readDiscreteCredentials({ BLAZEMETER_API_KEY_ID: 'k', BLAZEMETER_API_KEY_SECRET: 's' }))
      .toEqual({ id: 'k', secret: 's' });
    expect(readDiscreteCredentials({ BLAZEMETER_API_KEY_ID: 'k' })).toBeNull();
    expect(readDiscreteCredentials({ BLAZEMETER_API_KEY_SECRET: 's' })).toBeNull();
    // The file-path form is local-only and deliberately ignored on an Engine.
    expect(readDiscreteCredentials({ BLAZEMETER_API_KEY: '/tmp/key.json' })).toBeNull();
  });
});
