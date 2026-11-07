// Unit seam for the destination-AGNOSTIC pusher (Seam B). The pusher owns buffering, the
// flush cadence, fan-out, per-destination failure isolation, a bounded buffer, and a
// time-bounded teardown drain — and knows nothing about BlazeMeter. A fake Destination
// (records what it was sent) and a fake Clock (the flush callback is invoked by hand)
// keep every assertion deterministic and network-free.

import { describe, it, expect } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import {
  Pusher,
  resolveFlushMs,
  sendWithRetry,
  PushError,
  type Destination,
  type IntervalHandle,
} from '../src/pusher';
import { ManualClock } from './helpers/manual-clock';

/** A hand-built Sample — the pusher treats it as an opaque payload, so shape barely matters. */
function sample(ts: number): Sample {
  return {
    schemaVersion: 1,
    ts,
    url: 'https://x/p',
    test: { file: 'x.spec.ts', title: 't', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    vitals: { ttfb: { value: 1, status: 'ok' } },
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: 1, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

interface FakeOptions {
  enabled?: boolean;
  live?: boolean;
  sendImpl?: (batch: Sample[], signal?: AbortSignal) => Promise<void>;
  /** Why init() returned false — surfaced by the pusher as a warning + lastError. */
  initFailure?: string;
}

class FakeDestination implements Destination {
  initCalls = 0;
  closeCalls = 0;
  initFailure: string | null = null;
  batches: Sample[][] = [];
  constructor(
    readonly name: string,
    private opts: FakeOptions = {},
  ) {}
  isEnabled(): boolean {
    return this.opts.enabled ?? true;
  }
  async init(): Promise<boolean> {
    this.initCalls++;
    const live = this.opts.live ?? true;
    if (!live) this.initFailure = this.opts.initFailure ?? null;
    return live;
  }
  async send(batch: Sample[], signal?: AbortSignal): Promise<void> {
    this.batches.push(batch);
    if (this.opts.sendImpl) await this.opts.sendImpl(batch, signal);
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
  /** Total samples this destination ever received, across batches. */
  get received(): Sample[] {
    return this.batches.flat();
  }
}

/** A clock whose interval callback the test fires by hand — no real timers. Timeouts (the
 *  drain budget, retry waits) run on the inherited manual clock, advanced explicitly. */
class FakeClock extends ManualClock {
  intervalFn: (() => void) | null = null;
  intervalMs: number | null = null;
  cleared = false;
  override setInterval(fn: () => void, ms: number): IntervalHandle {
    this.intervalFn = fn;
    this.intervalMs = ms;
    return { clear: () => (this.cleared = true) };
  }
  /** Fire the registered flush callback and let its async work settle. */
  async tick(): Promise<void> {
    this.intervalFn?.();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makePusher(destinations: Destination[], extra: Partial<{ clock: FakeClock; maxBuffer: number; drainMs: number; onWarn: (m: string) => void }> = {}) {
  const clock = extra.clock ?? new FakeClock();
  const pusher = new Pusher({
    destinations,
    flushMs: 10_000,
    clock,
    maxBuffer: extra.maxBuffer,
    drainMs: extra.drainMs,
    onWarn: extra.onWarn,
  });
  return { pusher, clock };
}

describe('the push subsystem stays fully off when no destination is enabled', () => {
  it('a disabled destination is never inited, sent to, or closed — and the run is untouched', async () => {
    const dest = new FakeDestination('bzm', { enabled: false });
    const { pusher, clock } = makePusher([dest]);
    pusher.start();
    pusher.enqueue(sample(1000));
    await pusher.flush();
    await pusher.close();
    expect(dest.initCalls).toBe(0);
    expect(dest.batches).toEqual([]);
    expect(dest.closeCalls).toBe(0);
    // No flush timer is even scheduled — zero overhead.
    expect(clock.intervalFn).toBeNull();
    expect(pusher.isActive).toBe(false);
  });
});

describe('the happy path: enqueue → flush → the enabled destination gets the batch', () => {
  it('a flush hands every buffered sample to the destination as one batch', async () => {
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest]);
    pusher.start();
    pusher.enqueue(sample(1000));
    pusher.enqueue(sample(2000));
    await pusher.flush();
    expect(dest.batches).toHaveLength(1);
    expect(dest.batches[0]!.map((s) => s.ts)).toEqual([1000, 2000]);
  });

  it('the buffer is drained by a flush — a second flush with nothing new sends nothing', async () => {
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest]);
    pusher.enqueue(sample(1000));
    await pusher.flush();
    await pusher.flush();
    expect(dest.batches).toHaveLength(1);
  });

  it('init runs exactly once across many flushes (lazy, per worker)', async () => {
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest]);
    pusher.enqueue(sample(1));
    await pusher.flush();
    pusher.enqueue(sample(2));
    await pusher.flush();
    expect(dest.initCalls).toBe(1);
  });
});

describe('lazy init decides liveness', () => {
  it('a destination whose init returns false is never sent to', async () => {
    const dead = new FakeDestination('dead', { live: false });
    const { pusher } = makePusher([dead]);
    pusher.enqueue(sample(1));
    await pusher.flush();
    expect(dead.initCalls).toBe(1);
    expect(dead.batches).toEqual([]);
  });

  it('when NO destination resolves live, the subsystem deactivates and drops its buffer', async () => {
    const dead = new FakeDestination('dead', { live: false });
    const { pusher } = makePusher([dead]);
    pusher.enqueue(sample(1));
    await pusher.flush();
    expect(pusher.isActive).toBe(false);
    // A later enqueue is a no-op; a later flush does not re-init.
    pusher.enqueue(sample(2));
    await pusher.flush();
    expect(dead.initCalls).toBe(1);
  });
});

describe('fan-out to multiple destinations, with per-destination failure isolation', () => {
  it('every live destination receives the same batch', async () => {
    const a = new FakeDestination('a');
    const b = new FakeDestination('b');
    const { pusher } = makePusher([a, b]);
    pusher.enqueue(sample(1));
    await pusher.flush();
    expect(a.received.map((s) => s.ts)).toEqual([1]);
    expect(b.received.map((s) => s.ts)).toEqual([1]);
  });

  it('one destination throwing never blocks another and never escapes flush()', async () => {
    const warnings: string[] = [];
    const bad = new FakeDestination('bad', { sendImpl: async () => { throw new Error('network down'); } });
    const good = new FakeDestination('good');
    const { pusher } = makePusher([bad, good], { onWarn: (m) => warnings.push(m) });
    pusher.enqueue(sample(1));
    await expect(pusher.flush()).resolves.toBeUndefined();
    expect(good.received.map((s) => s.ts)).toEqual([1]);
    expect(warnings.join(' ')).toContain('bad');
  });
});

describe('the flush timer', () => {
  it('start() schedules the flush cadence; firing it drains the buffer; close() clears it', async () => {
    const dest = new FakeDestination('bzm');
    const clock = new FakeClock();
    const { pusher } = makePusher([dest], { clock });
    pusher.start();
    expect(clock.intervalMs).toBe(10_000);
    pusher.enqueue(sample(1));
    await clock.tick();
    expect(dest.batches).toHaveLength(1);
    await pusher.close();
    expect(clock.cleared).toBe(true);
  });
});

describe('teardown drain', () => {
  it('close() flushes whatever is still buffered, then closes each destination', async () => {
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest]);
    pusher.start();
    pusher.enqueue(sample(1));
    pusher.enqueue(sample(2));
    // no manual flush — the drain must catch the tail
    await pusher.close();
    expect(dest.received.map((s) => s.ts)).toEqual([1, 2]);
    expect(dest.closeCalls).toBe(1);
  });

  it('a hung destination cannot hang teardown — the drain is time-bounded', async () => {
    const hang = new FakeDestination('hang', { sendImpl: () => new Promise<void>(() => {}) });
    const { pusher, clock } = makePusher([hang], { drainMs: 50 });
    pusher.enqueue(sample(1));
    const closing = pusher.close();
    expect(await clock.runUntil(closing, { stepMs: 10 })).toBeLessThanOrEqual(50);
    await expect(closing).resolves.toBeUndefined();
  });
});

describe('resolveFlushMs — the shared cadence knob', () => {
  it('reads a positive BZM_VITALS_FLUSH_MS, else defaults to 10s', () => {
    expect(resolveFlushMs({ BZM_VITALS_FLUSH_MS: '500' })).toBe(500);
    expect(resolveFlushMs({})).toBe(10_000);
    expect(resolveFlushMs({ BZM_VITALS_FLUSH_MS: 'nonsense' })).toBe(10_000);
    expect(resolveFlushMs({ BZM_VITALS_FLUSH_MS: '0' })).toBe(10_000);
    expect(resolveFlushMs({ BZM_VITALS_FLUSH_MS: '-5' })).toBe(10_000);
  });
});

describe('the bounded buffer cannot grow without limit', () => {
  it('past the cap, the oldest samples are dropped (with a warning) and the newest kept', async () => {
    const warnings: string[] = [];
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest], { maxBuffer: 3, onWarn: (m) => warnings.push(m) });
    for (let i = 1; i <= 5; i++) pusher.enqueue(sample(i));
    await pusher.flush();
    // Only the last 3 survive; 1 and 2 were dropped.
    expect(dest.received.map((s) => s.ts)).toEqual([3, 4, 5]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('warnings are visible but never flood (C4)', () => {
  it('a send failure warns as "<destination>: <reason>", once per destination per distinct reason', async () => {
    const warnings: string[] = [];
    const bad = new FakeDestination('blazemeter', {
      sendImpl: async () => {
        throw new PushError('401 on POST /api/v4/data/timeseries', false);
      },
    });
    const { pusher } = makePusher([bad], { onWarn: (m) => warnings.push(m) });
    for (let i = 1; i <= 4; i++) {
      pusher.enqueue(sample(i));
      await pusher.flush();
    }
    expect(bad.batches).toHaveLength(4); // every flush still tried…
    expect(warnings).toEqual(['blazemeter: 401 on POST /api/v4/data/timeseries']); // …one line
  });

  it('a different reason, or another destination, gets its own single line', async () => {
    const warnings: string[] = [];
    let status = 401;
    const a = new FakeDestination('a', {
      sendImpl: async () => {
        throw new PushError(`${status} on POST /x`, false);
      },
    });
    const b = new FakeDestination('b', {
      sendImpl: async () => {
        throw new PushError('401 on POST /x', false);
      },
    });
    const { pusher } = makePusher([a, b], { onWarn: (m) => warnings.push(m) });
    pusher.enqueue(sample(1));
    await pusher.flush();
    pusher.enqueue(sample(2));
    await pusher.flush();
    status = 403;
    pusher.enqueue(sample(3));
    await pusher.flush();
    expect(warnings.sort()).toEqual(['a: 401 on POST /x', 'a: 403 on POST /x', 'b: 401 on POST /x']);
  });

  it('a destination that comes up dead says why (its initFailure), once', async () => {
    const warnings: string[] = [];
    const dead = new FakeDestination('blazemeter', { live: false, initFailure: '401 on GET /api/v4/sessions/r-v4-x' });
    const { pusher } = makePusher([dead], { onWarn: (m) => warnings.push(m) });
    pusher.enqueue(sample(1));
    await pusher.flush();
    expect(warnings).toEqual(['blazemeter: 401 on GET /api/v4/sessions/r-v4-x']);
  });

  it('the buffer-overflow warning is one line, not one per overflow', async () => {
    const warnings: string[] = [];
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest], { maxBuffer: 2, onWarn: (m) => warnings.push(m) });
    for (let i = 1; i <= 6; i++) pusher.enqueue(sample(i));
    expect(warnings).toHaveLength(1);
  });
});

describe('the push status: per-destination {sent, failed, dropped, lastError} (C4)', () => {
  it('counts delivered and failed Samples per destination, with the last error', async () => {
    let fail = false;
    const flaky = new FakeDestination('blazemeter', {
      sendImpl: async () => {
        if (fail) throw new PushError('401 on POST /api/v4/data/timeseries', false);
      },
    });
    const good = new FakeDestination('influxdb');
    const { pusher } = makePusher([flaky, good]);
    pusher.enqueue(sample(1));
    pusher.enqueue(sample(2));
    await pusher.flush();
    fail = true;
    pusher.enqueue(sample(3));
    await pusher.close();
    expect(pusher.status()).toEqual([
      { destination: 'blazemeter', sent: 2, failed: 1, dropped: 0, lastError: '401 on POST /api/v4/data/timeseries' },
      { destination: 'influxdb', sent: 3, failed: 0, dropped: 0, lastError: null },
    ]);
  });

  it('a destination that never came up counts every Sample as failed, with its initFailure', async () => {
    const dead = new FakeDestination('blazemeter', { live: false, initFailure: '401 on GET /api/v4/sessions/s' });
    const { pusher } = makePusher([dead]);
    pusher.enqueue(sample(1));
    await pusher.flush(); // init runs; the subsystem deactivates
    pusher.enqueue(sample(2)); // still counted, though nothing is attempted
    await pusher.close();
    expect(pusher.status()).toEqual([
      { destination: 'blazemeter', sent: 0, failed: 2, dropped: 0, lastError: '401 on GET /api/v4/sessions/s' },
    ]);
  });

  it('buffer-overflow drops are counted as dropped', async () => {
    const dest = new FakeDestination('bzm');
    const { pusher } = makePusher([dest], { maxBuffer: 3 });
    for (let i = 1; i <= 5; i++) pusher.enqueue(sample(i));
    await pusher.close();
    expect(pusher.status()).toEqual([{ destination: 'bzm', sent: 3, failed: 0, dropped: 2, lastError: null }]);
  });

  it('Samples still in flight when the drain budget runs out are counted as dropped', async () => {
    const hang = new FakeDestination('hang', { sendImpl: () => new Promise<void>(() => {}) });
    const { pusher, clock } = makePusher([hang], { drainMs: 100 });
    pusher.enqueue(sample(1));
    pusher.enqueue(sample(2));
    await clock.runUntil(pusher.close(), { stepMs: 10 });
    expect(pusher.status()).toEqual([{ destination: 'hang', sent: 0, failed: 0, dropped: 2, lastError: null }]);
  });

  it('is empty when no destination is enabled (the local path writes no status)', async () => {
    const { pusher } = makePusher([new FakeDestination('off', { enabled: false })]);
    pusher.enqueue(sample(1));
    await pusher.close();
    expect(pusher.status()).toEqual([]);
  });
});

describe('sendWithRetry: 429/5xx/network retried with backoff + jitter, other 4xx never (C4)', () => {
  const noJitter = () => 0;

  it('a 503 then success succeeds on the second attempt, after the first backoff', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new PushError('503 on POST /x', true);
      },
      { clock, random: noJitter },
    );
    const took = await clock.runUntil(p, { stepMs: 10 });
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(took).toBeGreaterThanOrEqual(500); // the first backoff step
  });

  it('a non-retryable 4xx is attempted exactly once', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        throw new PushError('401 on POST /x', false);
      },
      { clock },
    );
    await expect(p).rejects.toThrow('401 on POST /x');
    expect(calls).toBe(1);
  });

  it('gives up after 3 retries (4 attempts) and rethrows the last error', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        throw new PushError(`503 on POST /x`, true);
      },
      { clock, random: noJitter },
    );
    p.catch(() => {});
    const took = await clock.runUntil(p, { stepMs: 10 });
    await expect(p).rejects.toThrow('503 on POST /x');
    expect(calls).toBe(4);
    // Exponential: 500 + 1000 + 2000 with zero jitter.
    expect(took).toBeGreaterThanOrEqual(3_500);
    expect(took).toBeLessThan(3_600);
  });

  it('jitter spreads each wait between 1x and 2x its exponential step', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new PushError('503', true);
      },
      { clock, random: () => 0.5 },
    );
    await clock.advance(0);
    expect(clock.pendingDelays()).toEqual([750]);
    await clock.runUntil(p);
  });

  it('a plain (network) error is retried', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TypeError('fetch failed');
      },
      { clock, random: noJitter },
    );
    await clock.runUntil(p);
    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('honours Retry-After: waits at least that long before the retry', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new PushError('429 on POST /x', true, 3_000);
      },
      { clock, random: noJitter },
    );
    await clock.advance(2_900);
    expect(calls).toBe(1); // backoff alone (500 ms) would have retried by now
    await clock.advance(200);
    await p;
    expect(calls).toBe(2);
  });

  it('a Retry-After longer than the wait cap is not waited for — it gives up at once', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        throw new PushError('429 on POST /x', true, 60_000);
      },
      { clock },
    );
    await expect(p).rejects.toThrow('429 on POST /x');
    expect(calls).toBe(1);
  });

  it('an aborted signal (the drain deadline) stops the retry wait and rethrows', async () => {
    const clock = new ManualClock();
    const ctl = new AbortController();
    let calls = 0;
    const p = sendWithRetry(
      async () => {
        calls++;
        throw new PushError('503 on POST /x', true);
      },
      { clock, signal: ctl.signal, random: noJitter },
    );
    p.catch(() => {});
    await clock.advance(100);
    ctl.abort();
    await expect(p).rejects.toThrow('503 on POST /x');
    expect(calls).toBe(1);
  });
});

describe('retries stay inside the 15 s drain budget (C4, fake clock)', () => {
  it('a destination retrying an endpoint that never answers cannot stretch teardown past drainMs', async () => {
    const clock = new ManualClock();
    // Every attempt hangs until its own 8 s timeout or the drain deadline aborts it —
    // 4 attempts + backoff would take ~40 s unbounded.
    const slow = new FakeDestination('blazemeter', {
      sendImpl: (_batch, signal) =>
        sendWithRetry(
          () =>
            new Promise<void>((_, reject) => {
              const t = clock.setTimeout(() => reject(new PushError('timed out after 8000ms on POST /x', true)), 8_000);
              signal?.addEventListener('abort', () => {
                t.clear();
                reject(new PushError('drain budget exhausted', false));
              });
            }),
          { clock, signal },
        ),
    });
    const pusher = new Pusher({ destinations: [slow], flushMs: 10_000, clock });
    pusher.enqueue(sample(1));
    const took = await clock.runUntil(pusher.close(), { stepMs: 100 });
    expect(took).toBeLessThanOrEqual(15_000);
    // The deadline cut the retry loop short and it settled as a failure — not lost — and
    // the reported reason is the real one, not the deadline.
    expect(pusher.status()).toEqual([
      { destination: 'blazemeter', sent: 0, failed: 1, dropped: 0, lastError: 'timed out after 8000ms on POST /x' },
    ]);
    expect(slow.batches).toHaveLength(1);
  });
});
