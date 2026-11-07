// A hand-driven Clock for the push subsystem's unit seams: nothing fires until the test
// advances time, so retry backoff, Retry-After, per-request timeouts and the teardown drain
// budget are all asserted in fake milliseconds — deterministic, and with no real waiting.

import type { Clock, IntervalHandle } from '../../src/pusher';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/** Let already-resolved promise chains run (fakes resolve promptly, never on a timer). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

export class ManualClock implements Clock {
  /** Fake time in ms since the clock was made. */
  now = 0;
  private timers: Timer[] = [];
  private nextId = 1;

  setInterval(fn: () => void, ms: number): IntervalHandle {
    return this.add(fn, ms, ms);
  }

  setTimeout(fn: () => void, ms: number): IntervalHandle {
    return this.add(fn, ms, null);
  }

  /** Delays (ms from the time they were scheduled) of the timers pending right now. */
  pendingDelays(): number[] {
    return this.timers.map((t) => t.at - this.now);
  }

  /** Advance fake time by `ms`, firing every timer due on the way, in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.now = due.at;
      if (due.every === null) this.timers = this.timers.filter((t) => t !== due);
      else due.at += due.every;
      due.fn();
      await settle();
    }
    this.now = target;
    await settle();
  }

  /**
   * Advance in `stepMs` steps until `promise` settles; returns the fake ms it took.
   * Throws if it has not settled by `limitMs` — a runaway retry loop fails the test
   * instead of hanging it.
   */
  async runUntil(promise: Promise<unknown>, { stepMs = 50, limitMs = 120_000 } = {}): Promise<number> {
    const start = this.now;
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    await settle();
    while (!done) {
      if (this.now - start > limitMs) throw new Error(`did not settle within ${limitMs} fake ms`);
      await this.advance(stepMs);
    }
    return this.now - start;
  }

  private add(fn: () => void, ms: number, every: number | null): IntervalHandle {
    const timer: Timer = { id: this.nextId++, at: this.now + Math.max(0, ms), fn, every };
    this.timers.push(timer);
    return { clear: () => (this.timers = this.timers.filter((t) => t !== timer)) };
  }
}
