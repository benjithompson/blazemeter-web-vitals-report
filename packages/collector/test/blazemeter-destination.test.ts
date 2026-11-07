// Unit seam for the BlazeMeterDestination's I/O half: activation (isEnabled), lazy
// masterId resolution (init), and the injection POST (send). fetch is injected and
// records every call, so auth headers, URLs, and bodies are asserted exactly without
// touching the network. The real-run Seam A (push.test.ts) proves the same against a
// live server double driven by an actual `npx playwright test`.

import { describe, it, expect } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { BlazeMeterDestination, type FetchLike } from '../src/blazemeter-destination';
import { ManualClock } from './helpers/manual-clock';

const CREDS = { BLAZEMETER_API_KEY_ID: 'key-id-123', BLAZEMETER_API_KEY_SECRET: 'secret-abc' };
const EXPECTED_AUTH = 'Basic ' + Buffer.from('key-id-123:secret-abc').toString('base64');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch double: canned responses per predicate, every call recorded. */
function fakeFetch(handler: (url: string) => { ok?: boolean; status?: number; json?: unknown }): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body });
    const r = handler(url);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
    };
  };
  return { fetch, calls };
}

function sample(vitals: Sample['vitals'], ts = 1_700_000_123_456): Sample {
  return {
    schemaVersion: 1,
    ts,
    url: 'https://shop.example.com/order/9',
    test: { file: 'x.spec.ts', title: 't', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    vitals,
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: 1, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

describe('isEnabled — creds present, not killed, and a master is resolvable', () => {
  it('is enabled with discrete creds + a SESSION_ID', () => {
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-abc' } });
    expect(d.isEnabled()).toBe(true);
  });

  it('is enabled with discrete creds + a BLAZEMETER_MASTER_ID override (no session needed)', () => {
    const d = new BlazeMeterDestination({ env: { ...CREDS, BLAZEMETER_MASTER_ID: '999' } });
    expect(d.isEnabled()).toBe(true);
  });

  it('is DISABLED with no credentials', () => {
    expect(new BlazeMeterDestination({ env: { SESSION_ID: 'r-v4-abc' } }).isEnabled()).toBe(false);
  });

  it('is DISABLED when creds are present but there is no session and no master override', () => {
    expect(new BlazeMeterDestination({ env: { ...CREDS } }).isEnabled()).toBe(false);
  });

  it('is DISABLED by the BZM_VITALS_PUSH kill switch even with full config', () => {
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-abc', BZM_VITALS_PUSH: '0' } });
    expect(d.isEnabled()).toBe(false);
  });
});

describe('init — masterId resolution, lazy and bounded', () => {
  it('a BLAZEMETER_MASTER_ID override is used verbatim, with NO network call', async () => {
    const { fetch, calls } = fakeFetch(() => ({}));
    const d = new BlazeMeterDestination({ env: { ...CREDS, BLAZEMETER_MASTER_ID: '82731957' }, fetch });
    expect(await d.init()).toBe(true);
    expect(calls).toEqual([]); // resolution never touched the network
  });

  it('resolves masterId from GET /api/v4/sessions/{SESSION_ID} with Basic api-key auth', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { result: { masterId: 82731957 } } }));
    const d = new BlazeMeterDestination({
      env: { ...CREDS, SESSION_ID: 'r-v4-xyz', BLAZEMETER_API_BASE: 'https://api.example.com' },
      fetch,
    });
    expect(await d.init()).toBe(true);
    // The resolution GET comes first (a status GET for the location follows it).
    expect(calls[0]!.url).toBe('https://api.example.com/api/v4/sessions/r-v4-xyz');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.Authorization).toBe(EXPECTED_AUTH);
  });

  it('coerces a string masterId to an integer', async () => {
    const { fetch } = fakeFetch(() => ({ json: { result: { masterId: '82731957' } } }));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(true);
    // proven live by a subsequent send carrying the integer id (below)
  });

  it('returns false (never throws) when the resolution request rejects', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
  });

  it('returns false on a non-ok response', async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 401, json: {} }));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
  });

  it('returns false when the payload carries no usable masterId', async () => {
    const { fetch } = fakeFetch(() => ({ json: { result: {} } }));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
  });
});

describe('send — the injection POST', () => {
  async function liveDestination(env: Record<string, string>, handler: Parameters<typeof fakeFetch>[0]) {
    const { fetch, calls } = fakeFetch(handler);
    const d = new BlazeMeterDestination({ env: { ...CREDS, ...env }, fetch });
    await d.init();
    return { d, calls };
  }

  it('POSTs to /api/v4/data/timeseries with Basic auth, JSON content-type, and the mapped body', async () => {
    const { d, calls } = await liveDestination(
      { BLAZEMETER_MASTER_ID: '82731957', LOCATION: 'us-west-1', BZM_VITALS_ENGINE: '#1', BZM_VITALS_PER_ENGINE: '1', BLAZEMETER_API_BASE: 'https://api.example.com' },
      () => ({}),
    );
    await d.send([sample({ lcp: { value: 2276.4, status: 'ok' } })]);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.example.com/api/v4/data/timeseries');
    expect(post.headers.Authorization).toBe(EXPECTED_AUTH);
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.body).toEqual({
      intervals: [
        {
          _id: { masterId: 82731957, metricPath: 'Web Vitals | us-west-1 | #1 | /order/9 | LCP', ts: 1_700_000_123 },
          kpis: [{ value: 2276, ts: 1_700_000_123 }],
          profileName: 'Web Vitals',
        },
      ],
    });
  });

  it('aggregates per location by DEFAULT — no Engine tier in the metricPath', async () => {
    const { d, calls } = await liveDestination(
      { BLAZEMETER_MASTER_ID: '1', LOCATION: 'us-west-1', BZM_VITALS_ENGINE: '#1' }, // PER_ENGINE unset
      () => ({}),
    );
    await d.send([sample({ lcp: { value: 2276.4, status: 'ok' } })]);
    const post = calls.find((c) => c.method === 'POST')!;
    const path = (post.body as { intervals: Array<{ _id: { metricPath: string } }> }).intervals[0]!._id.metricPath;
    expect(path).toBe('Web Vitals | us-west-1 | /order/9 | LCP');
  });

  it('carries the string-resolved masterId as an integer in the body', async () => {
    const { d, calls } = await liveDestination(
      { SESSION_ID: 'r-v4-xyz' },
      (url) => (url.includes('/sessions/') ? { json: { result: { masterId: '5551212' } } } : {}),
    );
    await d.send([sample({ ttfb: { value: 10, status: 'ok' } })]);
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as { intervals: Array<{ _id: { masterId: number } }> }).intervals[0]!._id.masterId).toBe(5551212);
  });

  it('sends NOTHING when the batch has no ok vitals (no empty POST)', async () => {
    const { d, calls } = await liveDestination({ BLAZEMETER_MASTER_ID: '1' }, () => ({}));
    await d.send([sample({ cls: { value: null, status: 'unsupported' } })]);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('resolves the real location name from /masters/{id}/status matched by SESSION_ID', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes('/sessions/')) return { json: { result: { masterId: 500 } } };
      if (url.endsWith('/status')) {
        return { json: { result: { sessions: [{ id: 'other', locationId: 'eu-1' }, { id: 'r-v4-me', locationId: 'us-west-1' }] } } };
      }
      return {};
    });
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-me', TAURUS_SESSIONS_INDEX: '1', BZM_VITALS_PER_ENGINE: '1' }, fetch });
    await d.init();
    await d.send([sample({ lcp: { value: 100, status: 'ok' } })]);
    const post = calls.find((c) => c.method === 'POST')!;
    const path = (post.body as { intervals: Array<{ _id: { metricPath: string } }> }).intervals[0]!._id.metricPath;
    expect(path).toBe('Web Vitals | us-west-1 | #1 | /order/9 | LCP');
  });

  it('an explicit LOCATION override wins and the status endpoint is never called', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.includes('/sessions/') ? { json: { result: { masterId: 1 } } } : {}));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-me', LOCATION: 'my-loc' }, fetch });
    await d.init();
    expect(calls.some((c) => c.url.endsWith('/status'))).toBe(false);
    await d.send([sample({ ttfb: { value: 1, status: 'ok' } })]);
    const path = (calls.find((c) => c.method === 'POST')!.body as { intervals: Array<{ _id: { metricPath: string } }> }).intervals[0]!._id.metricPath;
    expect(path).toContain(' | my-loc | ');
  });

  it('falls back to loc-{TAURUS_LOCATIONS_INDEX} when status carries no usable locationId', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes('/sessions/')) return { json: { result: { masterId: 1 } } };
      if (url.endsWith('/status')) return { json: { result: { sessions: [{ id: 'r-v4-me', locationId: null }] } } };
      return {};
    });
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-me', TAURUS_LOCATIONS_INDEX: '2' }, fetch });
    await d.init();
    await d.send([sample({ ttfb: { value: 1, status: 'ok' } })]);
    const path = (calls.find((c) => c.method === 'POST')!.body as { intervals: Array<{ _id: { metricPath: string } }> }).intervals[0]!._id.metricPath;
    expect(path).toContain(' | loc-2 | ');
  });

  it('honours BZM_VITALS_PROFILE for the profileName', async () => {
    const { d, calls } = await liveDestination(
      { BLAZEMETER_MASTER_ID: '1', BZM_VITALS_PROFILE: 'FE Vitals' },
      () => ({}),
    );
    await d.send([sample({ ttfb: { value: 10, status: 'ok' } })]);
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as { intervals: Array<{ profileName: string }> }).intervals[0]!.profileName).toBe('FE Vitals');
  });
});

// ---------------------------------------------------------------------------
// C4 — retries with backoff (fake clock), and failure reasons that say why.
// ---------------------------------------------------------------------------

type Scripted = { status: number; retryAfter?: string } | 'network-error' | 'hang';

/** A fetch double that answers POSTs from a script, in order (the last entry repeats). */
function scriptedFetch(script: Scripted[]): { fetch: FetchLike; posts: unknown[]; accepted: unknown[] } {
  const posts: unknown[] = [];
  const accepted: unknown[] = [];
  const fetch: FetchLike = (url, init) => {
    if (init?.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    const body = JSON.parse(init.body!);
    posts.push(body);
    const step = script[Math.min(posts.length - 1, script.length - 1)]!;
    if (step === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (step === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const ok = step.status >= 200 && step.status < 300;
    if (ok) accepted.push(body);
    return Promise.resolve({
      ok,
      status: step.status,
      json: async () => ({}),
      headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? step.retryAfter ?? null : null) },
    });
  };
  return { fetch, posts, accepted };
}

const OK_SAMPLE = () => sample({ lcp: { value: 100, status: 'ok' } });

async function retryingDestination(script: Scripted[]) {
  const clock = new ManualClock();
  const f = scriptedFetch(script);
  const d = new BlazeMeterDestination({ env: { ...CREDS, BLAZEMETER_MASTER_ID: '1' }, fetch: f.fetch, clock, random: () => 0 });
  await d.init();
  return { d, clock, ...f };
}

describe('send retries 429 / 5xx / network errors with backoff — never other 4xx (C4)', () => {
  it('a 503 followed by a 200 delivers the batch exactly once', async () => {
    const { d, clock, posts, accepted } = await retryingDestination([{ status: 503 }, { status: 200 }]);
    const sending = d.send([OK_SAMPLE()]);
    await clock.runUntil(sending);
    await expect(sending).resolves.toBeUndefined();
    expect(posts).toHaveLength(2); // one retry…
    expect(accepted).toHaveLength(1); // …and the batch landed exactly once
    expect(accepted[0]).toEqual(posts[0]); // the same body, re-sent unchanged
  });

  it('a 401 is never retried, and the reason leads with the status', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 401 }]);
    const sending = d.send([OK_SAMPLE()]);
    sending.catch(() => {});
    await clock.runUntil(sending);
    await expect(sending).rejects.toThrow(/^401 on POST \/api\/v4\/data\/timeseries/);
    expect(posts).toHaveLength(1);
  });

  it('gives up after 3 retries (4 POSTs) on a persistent 500', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 500 }]);
    const sending = d.send([OK_SAMPLE()]);
    sending.catch(() => {});
    await clock.runUntil(sending);
    await expect(sending).rejects.toThrow(/^500 on POST/);
    expect(posts).toHaveLength(4);
  });

  it('a network error is retried', async () => {
    const { d, clock, posts, accepted } = await retryingDestination(['network-error', { status: 200 }]);
    const sending = d.send([OK_SAMPLE()]);
    await clock.runUntil(sending);
    await sending;
    expect(posts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
  });

  it('honours Retry-After on a 429', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 429, retryAfter: '3' }, { status: 200 }]);
    const sending = d.send([OK_SAMPLE()]);
    await clock.advance(2_900);
    expect(posts).toHaveLength(1);
    await clock.advance(200);
    await sending;
    expect(posts).toHaveLength(2);
  });

  it('a request that never answers times out on the injected clock and is retried', async () => {
    const { d, clock, posts, accepted } = await retryingDestination(['hang', { status: 200 }]);
    const sending = d.send([OK_SAMPLE()]);
    await clock.advance(7_999);
    expect(posts).toHaveLength(1);
    await clock.runUntil(sending);
    expect(posts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
  });

  it('the drain signal stops a retrying send promptly, with the real reason', async () => {
    const { d, clock, posts } = await retryingDestination([{ status: 503 }]);
    const ctl = new AbortController();
    const sending = d.send([OK_SAMPLE()], ctl.signal);
    sending.catch(() => {});
    await clock.advance(100);
    ctl.abort();
    await expect(sending).rejects.toThrow(/^503 on POST/);
    expect(posts).toHaveLength(1);
  });

  it('no failure reason carries the credential', async () => {
    for (const status of [401, 403, 500]) {
      const { d, clock } = await retryingDestination([{ status }]);
      const sending = d.send([OK_SAMPLE()]);
      sending.catch(() => {});
      await clock.runUntil(sending);
      const err = await sending.then(() => null, (e: Error) => e);
      expect(err!.message).not.toContain(CREDS.BLAZEMETER_API_KEY_ID);
      expect(err!.message).not.toContain(CREDS.BLAZEMETER_API_KEY_SECRET);
      expect(err!.message).not.toContain(EXPECTED_AUTH);
    }
  });
});

describe('a destination that comes up dead says why — initFailure (C4)', () => {
  it('a 401 on the masterId resolution is reported with the status', async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 401, json: {} }));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
    expect(d.initFailure).toMatch(/^401 on GET \/api\/v4\/sessions\/r-v4-xyz/);
  });

  it('a transport failure on resolution is reported', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
    expect(d.initFailure).toContain('ECONNREFUSED');
  });

  it('a payload with no usable masterId is reported', async () => {
    const { fetch } = fakeFetch(() => ({ json: { result: {} } }));
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-xyz' }, fetch });
    expect(await d.init()).toBe(false);
    expect(d.initFailure).toContain('masterId');
  });

  it('is null when init succeeds', async () => {
    const d = new BlazeMeterDestination({ env: { ...CREDS, BLAZEMETER_MASTER_ID: '1' } });
    expect(await d.init()).toBe(true);
    expect(d.initFailure).toBeNull();
  });
});
