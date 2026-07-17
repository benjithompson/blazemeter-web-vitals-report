// Unit seam for the destination-AGNOSTIC pusher (Seam B). The pusher owns buffering, the
// flush cadence, fan-out, per-destination failure isolation, a bounded buffer, and a
// time-bounded teardown drain — and knows nothing about BlazeMeter. A fake Destination
// (records what it was sent) and a fake Clock (the flush callback is invoked by hand)
// keep every assertion deterministic and network-free.

import { describe, it, expect } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { Pusher, resolveFlushMs, type Destination, type Clock, type IntervalHandle } from '../src/pusher';

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
  sendImpl?: (batch: Sample[]) => Promise<void>;
}

class FakeDestination implements Destination {
  initCalls = 0;
  closeCalls = 0;
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
    return this.opts.live ?? true;
  }
  async send(batch: Sample[]): Promise<void> {
    this.batches.push(batch);
    if (this.opts.sendImpl) await this.opts.sendImpl(batch);
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
  /** Total samples this destination ever received, across batches. */
  get received(): Sample[] {
    return this.batches.flat();
  }
}

/** A clock whose interval callback the test fires by hand — no real timers. */
class FakeClock implements Clock {
  intervalFn: (() => void) | null = null;
  intervalMs: number | null = null;
  cleared = false;
  setInterval(fn: () => void, ms: number): IntervalHandle {
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
    const { pusher } = makePusher([hang], { drainMs: 50 });
    pusher.enqueue(sample(1));
    await expect(pusher.close()).resolves.toBeUndefined();
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
