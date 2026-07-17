// Unit seam for the BlazeMeterDestination's I/O half: activation (isEnabled), lazy
// masterId resolution (init), and the injection POST (send). fetch is injected and
// records every call, so auth headers, URLs, and bodies are asserted exactly without
// touching the network. The real-run Seam A (push.test.ts) proves the same against a
// live server double driven by an actual `npx playwright test`.

import { describe, it, expect } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { BlazeMeterDestination, type FetchLike } from '../src/blazemeter-destination';

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
      { BLAZEMETER_MASTER_ID: '82731957', LOCATION: 'us-west-1', BZM_VITALS_ENGINE: '#1', BLAZEMETER_API_BASE: 'https://api.example.com' },
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
    const d = new BlazeMeterDestination({ env: { ...CREDS, SESSION_ID: 'r-v4-me', TAURUS_SESSIONS_INDEX: '1' }, fetch });
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
