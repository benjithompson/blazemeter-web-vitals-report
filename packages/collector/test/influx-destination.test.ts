// Unit seam for the InfluxDestination's I/O half: activation (isEnabled), init, and the
// write (send). fetch is injected and records every call, so the write URL (org/bucket/
// precision query), the `Token` auth header, and the line-protocol body are asserted
// exactly without touching the network. The Docker integration test proves the same body
// round-trips a real bucket.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { InfluxDestination } from '../src/influx-destination';
import type { InfluxFetchLike } from '../src/influx-writer';
import { startInfluxServer, type InfluxServer } from './helpers/influx-server';
import { ManualClock } from './helpers/manual-clock';

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
  it('posts the wide-format line protocol with the org/bucket/precision query (ns, worker tag)', async () => {
    const { fetch, calls } = fakeFetch();
    const d = new InfluxDestination({ env: { ...CONN, BZM_VITALS_LOCATION: 'us-west-1' }, fetch });
    await d.init();
    await d.send([sample({ lcp: m(2276.7, 'ok'), cls: m(0.083, 'ok') }, { route: '/order/{id}' })]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      'https://influx.example.com/api/v2/write?org=perf&bucket=vitals&precision=ns',
    );
    expect(call.headers.Authorization).toBe('Token tok-123');
    expect(call.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(call.body).toBe(
      'web_vitals,location=us-west-1,project=chromium,route=/order/{id},title=t,worker=0 lcp=2276.7,cls=0.083 1700000123456000000',
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

// ---------------------------------------------------------------------------
// C5 — point uniqueness and newline handling, checked against the integration double
// (a real HTTP endpoint that parses line protocol strictly and overwrites like Influx).
// ---------------------------------------------------------------------------

describe('same-millisecond Samples never overwrite each other (C5)', () => {
  let influx: InfluxServer;
  beforeAll(async () => {
    influx = await startInfluxServer();
  });
  afterAll(async () => {
    await influx?.close();
  });

  const env = (extra: Record<string, string> = {}) => ({
    ...CONN,
    BZM_INFLUX_URL: influx.url,
    BZM_VITALS_LOCATION: 'us-west-1',
    ...extra,
  });
  const at = (worker: number, route: string) =>
    sample({ lcp: m(890, 'ok') }, { route, test: { file: 'x.spec.ts', title: 't', project: 'chromium', repeat: 0, worker } });

  it('two Samples from different workers with the same ts land as two distinct points', async () => {
    const d = new InfluxDestination({ env: env({ TAURUS_SESSIONS_INDEX: '1' }) });
    await d.init();
    await d.send([at(0, '/same-ms-workers'), at(1, '/same-ms-workers')]);
    const points = influx.points().filter((p) => p.tags.route === '/same-ms-workers');
    expect(points).toHaveLength(2);
    expect(new Set(points.map((p) => p.tags.worker))).toEqual(new Set(['0', '1']));
  });

  it('the same worker index on two Engines (aggregate mode, no engine tag) still lands as two points', async () => {
    for (const engine of ['1', '2']) {
      const d = new InfluxDestination({ env: env({ TAURUS_SESSIONS_INDEX: engine }) });
      await d.init();
      await d.send([at(0, '/same-ms-engines')]);
    }
    const points = influx.points().filter((p) => p.tags.route === '/same-ms-engines');
    expect(points).toHaveLength(2);
    expect(points.every((p) => p.tags.engine === undefined)).toBe(true); // aggregate mode
    expect(new Set(points.map((p) => p.timestampNs)).size).toBe(2); // told apart by timestamp
  });

  it('writes at ns precision, and the point time is still the Sample ts to the millisecond', async () => {
    const d = new InfluxDestination({ env: env() });
    await d.init();
    await d.send([at(3, '/precision')]);
    expect(influx.precisions.at(-1)).toBe('ns');
    const [p] = influx.points().filter((x) => x.tags.route === '/precision');
    expect(p!.timestampNs / 1_000_000n).toBe(BigInt(1_700_000_123_456));
  });

  it('a title containing \\n (and \\r) produces a valid line, with the newline as a space', async () => {
    const d = new InfluxDestination({ env: env() });
    await d.init();
    const s = sample(
      { lcp: m(890, 'ok') },
      { route: '/multi\nline', test: { file: 'x.spec.ts', title: 'line one\r\nline two', project: 'chromium', repeat: 0, worker: 0 } },
    );
    await expect(d.send([s])).resolves.toBeUndefined();
    expect(influx.rejections).toEqual([]);
    const [p] = influx.points().filter((x) => x.tags.route === '/multi line');
    expect(p!.tags.title).toBe('line one  line two');
    expect(influx.bodies.at(-1)!.split('\n')).toHaveLength(1); // one Sample, one line
  });
});

// ---------------------------------------------------------------------------
// C4 — retries with backoff (fake clock), and failure reasons that say why.
// ---------------------------------------------------------------------------

type Scripted = { status: number; retryAfter?: string; text?: string } | 'network-error' | 'hang';

/** A fetch double that answers writes from a script, in order (the last entry repeats). */
function scriptedFetch(script: Scripted[]): { fetch: InfluxFetchLike; posts: string[]; accepted: string[] } {
  const posts: string[] = [];
  const accepted: string[] = [];
  const fetch: InfluxFetchLike = (url, init) => {
    posts.push(init!.body!);
    const step = script[Math.min(posts.length - 1, script.length - 1)]!;
    if (step === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (step === 'hang') {
      return new Promise((_, reject) => init!.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const ok = step.status >= 200 && step.status < 300;
    if (ok) accepted.push(init!.body!);
    const res = {
      ok,
      status: step.status,
      text: async () => step.text ?? '',
      headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? step.retryAfter ?? null : null) },
    };
    return Promise.resolve(res);
  };
  return { fetch, posts, accepted };
}

async function retryingDestination(script: Scripted[]) {
  const clock = new ManualClock();
  const f = scriptedFetch(script);
  const d = new InfluxDestination({ env: { ...CONN }, fetch: f.fetch, clock, random: () => 0 });
  await d.init();
  return { d, clock, ...f };
}

const OK = () => sample({ lcp: m(890, 'ok') });

describe('send retries 429 / 5xx / network errors with backoff — never other 4xx (C4)', () => {
  it('a 503 followed by a 204 delivers the batch exactly once', async () => {
    const { d, clock, posts, accepted } = await retryingDestination([{ status: 503 }, { status: 204 }]);
    const sending = d.send([OK()]);
    await clock.runUntil(sending);
    await expect(sending).resolves.toBeUndefined();
    expect(posts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toBe(posts[0]);
  });

  it('a 401 is never retried, and the reason leads with the status (body detail kept)', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 401, text: '{"code":"unauthorized"}' }]);
    const sending = d.send([OK()]);
    sending.catch(() => {});
    await clock.runUntil(sending);
    await expect(sending).rejects.toThrow(/^401 on POST \/api\/v2\/write.*unauthorized/);
    expect(posts).toHaveLength(1);
  });

  it('a 400 (bad line protocol) is never retried', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 400 }]);
    const sending = d.send([OK()]);
    sending.catch(() => {});
    await clock.runUntil(sending);
    await expect(sending).rejects.toThrow(/^400 on POST/);
    expect(posts).toHaveLength(1);
  });

  it('gives up after 3 retries (4 writes) on a persistent 500', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 500 }]);
    const sending = d.send([OK()]);
    sending.catch(() => {});
    await clock.runUntil(sending);
    await expect(sending).rejects.toThrow(/^500 on POST/);
    expect(posts).toHaveLength(4);
  });

  it('a network error is retried', async () => {
    const { d, clock, posts, accepted } = await retryingDestination(['network-error', { status: 204 }]);
    const sending = d.send([OK()]);
    await clock.runUntil(sending);
    await sending;
    expect(posts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
  });

  it('honours Retry-After on a 429', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 429, retryAfter: '2' }, { status: 204 }]);
    const sending = d.send([OK()]);
    await clock.advance(1_900);
    expect(posts).toHaveLength(1);
    await clock.advance(200);
    await sending;
    expect(posts).toHaveLength(2);
  });

  it('a write that never answers times out on the injected clock and is retried', async () => {
    const { d, clock, posts, accepted } = await retryingDestination(['hang', { status: 204 }]);
    const sending = d.send([OK()]);
    await clock.advance(7_999);
    expect(posts).toHaveLength(1);
    await clock.runUntil(sending);
    expect(posts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
  });

  it('the drain signal stops a retrying send promptly, with the real reason', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 503 }]);
    const ctl = new AbortController();
    const sending = d.send([OK()], ctl.signal);
    sending.catch(() => {});
    await clock.advance(100);
    ctl.abort();
    await expect(sending).rejects.toThrow(/^503 on POST/);
    expect(posts).toHaveLength(1);
  });

  it('no failure reason carries the token', async () => {
    for (const status of [401, 403, 500]) {
      const { d, clock } = await retryingDestination([{ status }]);
      const sending = d.send([OK()]);
      sending.catch(() => {});
      await clock.runUntil(sending);
      const err = await sending.then(() => null, (e: Error) => e);
      expect(err!.message).not.toContain(CONN.BZM_INFLUX_TOKEN);
    }
  });
});
