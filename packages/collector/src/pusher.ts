// The destination-AGNOSTIC pusher: the shared machinery every sink rides on. It owns the
// in-memory buffer, the flush cadence, fan-out to N destinations, per-destination failure
// isolation, a bounded buffer, and a time-bounded teardown drain. It knows nothing about
// BlazeMeter, metricPath, or api keys — the neutral boundary it hands each destination is
// the format-v1 Sample. A future InfluxDestination slots in with no change here.
//
// Best-effort by construction: enqueue is synchronous and cheap (the test never awaits a
// send); every send failure is swallowed and isolated so one broken sink never affects
// another sink, the buffer, or the run. The clock is injectable so the flush timer and
// the drain budget are unit-testable without real timers or the network.

import type { Sample } from 'bzm-vitals-format';

/** Let a Node timer NOT keep the process alive, tolerating a non-Node timer (tests). */
function unref(handle: { unref?: () => void }): void {
  handle.unref?.();
}

/**
 * One sink for measured Samples. A Destination owns its OWN encoding, endpoint, auth,
 * identity resolution, and per-request timeout — the pusher only orchestrates.
 *   - isEnabled(): cheap, sync — is this sink's static config present (and not disabled)?
 *   - init():      lazy, once per worker — resolve sink-specific identity; return whether
 *                  the sink is live and should receive sends.
 *   - send(batch): project + transmit the batch as one request; owns its own timeout.
 *   - close():     final per-sink cleanup at teardown.
 */
export interface Destination {
  readonly name: string;
  isEnabled(): boolean;
  init(): Promise<boolean>;
  send(batch: Sample[]): Promise<void>;
  close(): Promise<void>;
}

/** A cancellable periodic timer, so the flush cadence can be faked in tests. */
export interface IntervalHandle {
  clear(): void;
}

/** The one bit of ambient time the pusher touches — injected so tests stay deterministic. */
export interface Clock {
  setInterval(fn: () => void, ms: number): IntervalHandle;
}

/** The real clock: unref'd so a pending flush timer never keeps the worker process alive. */
export const realClock: Clock = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    unref(id);
    return { clear: () => clearInterval(id) };
  },
};

/** The shared flush cadence, from BZM_VITALS_FLUSH_MS (positive ms), else 10s. */
export function resolveFlushMs(env: Record<string, string | undefined>): number {
  const n = env.BZM_VITALS_FLUSH_MS !== undefined ? Number(env.BZM_VITALS_FLUSH_MS) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export interface PusherOptions {
  destinations: Destination[];
  /** Flush cadence in ms. */
  flushMs: number;
  clock?: Clock;
  /** Max buffered samples before the OLDEST are dropped (with a warning). Default 10_000. */
  maxBuffer?: number;
  /** Total budget for the teardown drain across destinations. Default 15_000. */
  drainMs?: number;
  /** Where drop/failure warnings go. Default: swallowed. */
  onWarn?: (message: string) => void;
}

/** Resolve `promise`, but never wait longer than `ms` — a hung send can't hang teardown. */
function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    unref(timer);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export class Pusher {
  private readonly enabledDests: Destination[];
  private readonly flushMs: number;
  private readonly clock: Clock;
  private readonly maxBuffer: number;
  private readonly drainMs: number;
  private readonly onWarn: (message: string) => void;

  private buffer: Sample[] = [];
  private live: Destination[] = [];
  private initialized = false;
  private deactivated = false;
  private closed = false;
  private timer: IntervalHandle | null = null;
  /** Serializes flushes so the timer and teardown drain never overlap or interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: PusherOptions) {
    // Only destinations whose static config is present are ever considered — the rest of
    // the subsystem treats them as if they did not exist (zero overhead, the local path).
    this.enabledDests = opts.destinations.filter((d) => d.isEnabled());
    this.flushMs = opts.flushMs;
    this.clock = opts.clock ?? realClock;
    this.maxBuffer = opts.maxBuffer ?? 10_000;
    this.drainMs = opts.drainMs ?? 15_000;
    this.onWarn = opts.onWarn ?? (() => {});
  }

  /** True while the subsystem should do work: an enabled destination exists, init has not
   *  turned up all-dead, and teardown has not run. When false, enqueue/flush are no-ops. */
  get isActive(): boolean {
    return this.enabledDests.length > 0 && !this.deactivated && !this.closed;
  }

  /** Start the flush cadence. No-op (no timer, zero overhead) when nothing is enabled. */
  start(): void {
    if (!this.isActive || this.timer !== null) return;
    this.timer = this.clock.setInterval(() => {
      void this.flush();
    }, this.flushMs);
  }

  /** Enqueue a measured Sample. Synchronous, cheap, never awaited by the test body. */
  enqueue(sample: Sample): void {
    if (!this.isActive) return;
    this.buffer.push(sample);
    if (this.buffer.length > this.maxBuffer) {
      const dropped = this.buffer.length - this.maxBuffer;
      this.buffer.splice(0, dropped); // drop the OLDEST — the tail is the freshest signal
      this.onWarn(`vitals push buffer over ${this.maxBuffer}; dropped ${dropped} oldest sample(s)`);
    }
  }

  /** Flush the buffer to every live destination. Serialized; safe to call concurrently. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.doFlush());
    return this.chain;
  }

  private async doFlush(): Promise<void> {
    if (!this.isActive) return;
    if (!this.initialized) {
      await this.initialize();
      if (!this.isActive) return; // initialize() may have deactivated (all destinations dead)
    }
    const batch = this.buffer.splice(0); // take everything; new enqueues start a fresh buffer
    if (batch.length === 0) return;
    await Promise.allSettled(this.live.map((d) => this.sendSafe(d, batch)));
  }

  /** Resolve every enabled destination's identity ONCE. Keep the live ones; if none are
   *  live, the subsystem deactivates and drops its buffer — nothing more will be attempted. */
  private async initialize(): Promise<void> {
    this.initialized = true;
    const results = await Promise.all(
      this.enabledDests.map(async (d) => {
        try {
          return (await d.init()) ? d : null;
        } catch (err) {
          this.onWarn(`destination ${d.name} init failed: ${errText(err)}`);
          return null;
        }
      }),
    );
    this.live = results.filter((d): d is Destination => d !== null);
    if (this.live.length === 0) {
      this.deactivated = true;
      this.buffer = [];
    }
  }

  private async sendSafe(dest: Destination, batch: Sample[]): Promise<void> {
    try {
      await dest.send(batch);
    } catch (err) {
      this.onWarn(`destination ${dest.name} send failed: ${errText(err)}`);
    }
  }

  /** Stop the timer, drain what remains within a bounded budget, then close each sink. */
  async close(): Promise<void> {
    this.timer?.clear();
    this.timer = null;
    if (!this.isActive) {
      this.closed = true;
      return;
    }
    await withTimeout(this.drain(), this.drainMs);
    this.closed = true;
  }

  private async drain(): Promise<void> {
    await this.flush(); // one final flush empties the buffer (splice takes all of it)
    await Promise.allSettled(
      this.live.map(async (d) => {
        try {
          await d.close();
        } catch (err) {
          this.onWarn(`destination ${d.name} close failed: ${errText(err)}`);
        }
      }),
    );
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
