// Unit seam for the InfluxDestination's I/O half: activation (isEnabled), init, and the
// write (send). fetch is injected and records every call, so the write URL (org/bucket/
// precision query), the `Token` auth header, and the line-protocol body are asserted
// exactly without touching the network. The Docker integration test proves the same body
// round-trips a real bucket.

import { describe, it, expect } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { InfluxDestination } from '../src/influx-destination';
import type { InfluxFetchLike } from '../src/influx-writer';

const CONN = {
  BZM_INFLUX_URL: 'https://influx.example.com',
  BZM_INFLUX_ORG: 'perf',
  BZM_INFLUX_BUCKET: 'vitals',
  BZM_INFLUX_TOKEN: 'tok-123',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch double: canned response, every call recorded. */
function fakeFetch(resp: { ok?: boolean; status?: number; text?: string } = {}): {
  fetch: InfluxFetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: InfluxFetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 204,
      text: async () => resp.text ?? '',
    };
  };
  return { fetch, calls };
}

function sample(vitals: Sample['vitals'], overrides: Partial<Sample> = {}): Sample {
  return {
    schemaVersion: 1,
    ts: 1_700_000_123_456,
    url: 'https://shop.example.com/order/9',
    test: { file: 'x.spec.ts', title: 't', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    vitals,
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: 1, resourceCount: null, requestCount: null, failedRequests: null },
    ...overrides,
  };
}

const m = (value: number | null, status: Sample['vitals'][string]['status']) => ({ value, status });

describe('isEnabled — full connection present and not killed', () => {
  it('is enabled with url + org + bucket + token', () => {
    expect(new InfluxDestination({ env: { ...CONN } }).isEnabled()).toBe(true);
  });

  it('is DISABLED when any connection part is missing', () => {
    const { BZM_INFLUX_TOKEN, ...noToken } = CONN;
    expect(new InfluxDestination({ env: noToken }).isEnabled()).toBe(false);
  });

  it('is enabled via the managed-secret token name', () => {
    const { BZM_INFLUX_TOKEN, ...rest } = CONN;
    expect(new InfluxDestination({ env: { ...rest, BZM_SECRET_influxtoken: 'tok-s' } }).isEnabled()).toBe(true);
  });

  it('is DISABLED by the BZM_VITALS_PUSH kill switch even with full config', () => {
    expect(new InfluxDestination({ env: { ...CONN, BZM_VITALS_PUSH: 'off' } }).isEnabled()).toBe(false);
  });

  it('init returns whether the sink is live, with NO network call', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({ env: { ...CONN }, fetch });
    expect(await d.init()).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('send — POST to /api/v2/write with Token auth and a line-protocol body', () => {
  it('posts the wide-format line protocol with the org/bucket/precision query', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({ env: { ...CONN, BZM_VITALS_LOCATION: 'us-west-1' }, fetch });
    await d.init();
    await d.send([sample({ lcp: m(2276.7, 'ok'), cls: m(0.083, 'ok') }, { route: '/order/{id}' })]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      'https://influx.example.com/api/v2/write?org=perf&bucket=vitals&precision=ms',
    );
    expect(call.headers.Authorization).toBe('Token tok-123');
    expect(call.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(call.body).toBe(
      'web_vitals,location=us-west-1,project=chromium,route=/order/{id},title=t lcp=2276.7,cls=0.083 1700000123456',
    );
  });

  it('never POSTs when the batch has no ok vital', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({ env: { ...CONN }, fetch });
    await d.init();
    await d.send([sample({ lcp: m(null, 'error') })]);
    expect(calls).toEqual([]);
  });

  it('adds the engine tag in per-engine mode', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({
      env: { ...CONN, BZM_VITALS_LOCATION: 'us-west-1', BZM_VITALS_PER_ENGINE: '1', BZM_VITALS_ENGINE: '#3' },
      fetch,
    });
    await d.init();
    await d.send([sample({ lcp: m(890, 'ok') })]);
    expect(calls[0]!.body).toContain('engine=#3');
  });

  it('throws on a non-2xx write so the pusher can isolate it', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 401, text: 'unauthorized' });
    const d = new InfluxDestination({ env: { ...CONN }, fetch });
    await d.init();
    await expect(d.send([sample({ lcp: m(890, 'ok') })])).rejects.toThrow(/401/);
  });

  it('the token appears ONLY in the Authorization header, never in the body', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({ env: { ...CONN }, fetch });
    await d.init();
    await d.send([sample({ lcp: m(890, 'ok') })]);
    expect(calls[0]!.body).not.toContain('tok-123');
  });
});
