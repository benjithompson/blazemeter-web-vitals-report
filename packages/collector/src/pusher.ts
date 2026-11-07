// The destination-AGNOSTIC pusher: the shared machinery every sink rides on. It owns the
// in-memory buffer, the flush cadence, fan-out to N destinations, per-destination failure
// isolation, a bounded buffer, a time-bounded teardown drain, and the per-destination push
// status. It knows nothing about BlazeMeter, metricPath, or api keys — the neutral boundary
// it hands each destination is the format-v1 Sample.
//
// Best-effort by construction: enqueue is synchronous and cheap (the test never awaits a
// send); every send failure is isolated so one broken sink never affects another sink, the
// buffer, or the run. Best-effort is not silent: each failure is warned once per destination
// per distinct reason, and tallied into the push status written at worker teardown. The
// clock is injectable so the flush timer, retry backoff and the drain budget are
// unit-testable without real timers or the network.

import type { Sample } from 'bzm-vitals-format';

/** Let a Node timer NOT keep the process alive, tolerating a non-Node timer (tests). */
function unref(handle: { unref?: () => void }): void {
  handle.unref?.();
}

/**
 * One sink for measured Samples. A Destination owns its OWN encoding, endpoint, auth,
 * identity resolution, per-request timeout and retries — the pusher only orchestrates.
 *   - isEnabled(): cheap, sync — is this sink's static config present (and not disabled)?
 *   - init():      lazy, once per worker — resolve sink-specific identity; return whether
 *                  the sink is live and should receive sends. Never throws by contract; a
 *                  sink that comes up dead may say why in `initFailure`.
 *   - send(batch, signal): project + transmit the batch, retrying transient failures (see
 *                  sendWithRetry). `signal` aborts at the teardown drain deadline: stop
 *                  waiting and settle (reject) promptly when it fires.
 *   - close():     final per-sink cleanup at teardown.
 */
export interface Destination {
  readonly name: string;
  /** Why init() returned false, credential-free (e.g. "401 on GET /api/v4/sessions/…"). */
  readonly initFailure?: string | null;
  isEnabled(): boolean;
  init(): Promise<boolean>;
  send(batch: Sample[], signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** A cancellable timer (periodic or one-shot), so time can be faked in tests. */
export interface IntervalHandle {
  clear(): void;
}

/** The ambient time the push subsystem touches — the flush cadence, retry backoff, request
 *  timeouts and the drain budget — injected so tests stay deterministic. */
export interface Clock {
  setInterval(fn: () => void, ms: number): IntervalHandle;
  setTimeout(fn: () => void, ms: number): IntervalHandle;
}

/** The real clock: unref'd so a pending timer never keeps the worker process alive. */
export const realClock: Clock = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    unref(id);
    return { clear: () => clearInterval(id) };
  },
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    unref(id);
    return { clear: () => clearTimeout(id) };
  },
};

/** The shared flush cadence, from BZM_VITALS_FLUSH_MS (positive ms), else 10s. */
export function resolveFlushMs(env: Record<string, string | undefined>): number {
  const n = env.BZM_VITALS_FLUSH_MS !== undefined ? Number(env.BZM_VITALS_FLUSH_MS) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

// ---------------------------------------------------------------------------
// Retry — shared by every Destination's send.
// ---------------------------------------------------------------------------

/**
 * A push failure with its retry classification. The message is what lands on stderr and in
 * the Push Status attachment, so destinations build it from the status code and the request
 * path only — never a header, never a credential. `retryAfterMs` carries a Retry-After.
 */
export class PushError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/** 429 and 5xx are transient; every other non-2xx (400, 401, 403, 404…) is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A Retry-After header (delta-seconds or an HTTP-date) as ms from now, or undefined. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export interface RetryOptions {
  clock: Clock;
  /** The drain deadline: once aborted, no further wait or attempt starts. */
  signal?: AbortSignal;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff step; doubles per retry. Default 500 ms (0.5, 1, 2 s, each + jitter). */
  baseMs?: number;
  /** The longest single wait honoured — a Retry-After beyond it ends the retries. Default 5 s. */
  maxWaitMs?: number;
  /** Jitter source in [0, 1). Default Math.random. */
  random?: () => number;
}

/** Wait `ms` on the clock; resolves false (early) if `signal` aborts first. */
function sleepOn(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      timer.clear();
      resolve(false);
    };
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `attempt`, retrying transient failures: a PushError marked retryable (429, 5xx, a
 * timeout, a network error) or any non-PushError throw (a raw transport failure). A
 * non-retryable PushError (any other 4xx) is thrown at once. Backoff is exponential with
 * jitter — baseMs·2^n·(1 + random) — and never shorter than a server's Retry-After; a
 * Retry-After longer than maxWaitMs is honoured by giving up rather than retrying early.
 * When `signal` aborts (the drain deadline) the loop stops and the last REAL failure is
 * thrown, so the reported reason is the endpoint's, not the deadline's.
 */
export async function sendWithRetry(attempt: () => Promise<void>, opts: RetryOptions): Promise<void> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? 5_000;
  const random = opts.random ?? Math.random;
  let lastReal: unknown = undefined;
  for (let n = 0; ; n++) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw lastReal ?? err;
      lastReal = err;
      const retryable = err instanceof PushError ? err.retryable : true;
      if (!retryable || n >= retries) throw err;
      const retryAfter = err instanceof PushError ? err.retryAfterMs : undefined;
      if (retryAfter !== undefined && retryAfter > maxWaitMs) throw err;
      const wait = Math.max(baseMs * 2 ** n * (1 + random()), retryAfter ?? 0);
      if (!(await sleepOn(opts.clock, wait, opts.signal))) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Push Status — the per-destination tally written at worker teardown.
// ---------------------------------------------------------------------------

/** Attachment name prefix of the per-worker Push Status record (see CONTEXT.md). */
export const PUSH_STATUS_ATTACHMENT_PREFIX = 'bzm-vitals-push-status';

/**
 * One destination's outcome for this worker, counted in Samples:
 *   - sent:    accepted by the destination.
 *   - failed:  not delivered because of an error — the send was rejected (after retries),
 *              or the destination never came up (init failed). `lastError` says why.
 *   - dropped: discarded for capacity or time — the buffer overflowed, or the Sample was
 *              still buffered or in flight when the teardown drain budget ran out.
 * Carries no credential: lastError is built from status codes and request paths only.
 */
export interface PushStatus {
  destination: string;
  sent: number;
  failed: number;
  dropped: number;
  lastError: string | null;
}

interface Tally {
  sent: number;
  failed: number;
  dropped: number;
  inFlight: number;
  lastError: string | null;
  /** Distinct warning reasons already emitted for this destination (the dedupe). */
  warned: Set<string>;
}

/** Distinct warning reasons per destination before the rest are suppressed. */
const MAX_DISTINCT_WARNINGS = 5;
/** The drain signal fires this far ahead of the hard cutoff, so a retrying send can settle
 *  (and be tallied as failed, with its real reason) before the status is snapshotted. */
const DRAIN_SETTLE_MS = 500;

export interface PusherOptions {
  destinations: Destination[];
  /** Flush cadence in ms. */
  flushMs: number;
  clock?: Clock;
  /** Max buffered samples before the OLDEST are dropped (with a warning). Default 10_000. */
  maxBuffer?: number;
  /** Total budget for the teardown drain across destinations, retries included. Default 15_000. */
  drainMs?: number;
  /** Where warnings go, as "<destination>: <reason>". Default: swallowed. Each distinct
   *  reason is emitted once per destination, so a dead endpoint never floods the log. */
  onWarn?: (message: string) => void;
}

/** Resolve `promise`, but never wait longer than `ms` — a hung send can't hang teardown. */
function withTimeout(clock: Clock, promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = clock.setTimeout(resolve, ms);
    const done = () => {
      timer.clear();
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
  private readonly tallies = new Map<Destination, Tally>();
  /** Aborted at the drain deadline; every send receives its signal. */
  private readonly deadline = new AbortController();

  private buffer: Sample[] = [];
  private live: Destination[] = [];
  private initialized = false;
  private deactivated = false;
  private closed = false;
  private overflowWarned = false;
  private finalStatus: PushStatus[] | null = null;
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
    for (const d of this.enabledDests) {
      this.tallies.set(d, { sent: 0, failed: 0, dropped: 0, inFlight: 0, lastError: null, warned: new Set() });
    }
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
    if (!this.isActive) {
      // Every destination came up dead: nothing is attempted, but the Sample still counts
      // as failed so the Push Status says how much never left the worker.
      if (this.deactivated && !this.closed) for (const t of this.tallies.values()) t.failed++;
      return;
    }
    this.buffer.push(sample);
    if (this.buffer.length > this.maxBuffer) {
      const dropped = this.buffer.length - this.maxBuffer;
      this.buffer.splice(0, dropped); // drop the OLDEST — the tail is the freshest signal
      for (const t of this.tallies.values()) t.dropped += dropped;
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.onWarn(`push buffer: over ${this.maxBuffer} samples; dropping the oldest (counted in the push status)`);
      }
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
    for (const d of this.enabledDests) {
      if (!this.live.includes(d)) this.tally(d).failed += batch.length; // came up dead
    }
    await Promise.allSettled(this.live.map((d) => this.sendSafe(d, batch)));
  }

  /** Resolve every enabled destination's identity ONCE. Keep the live ones; if none are
   *  live, the subsystem deactivates and drops its buffer — nothing more will be attempted. */
  private async initialize(): Promise<void> {
    this.initialized = true;
    const results = await Promise.all(
      this.enabledDests.map(async (d) => {
        try {
          if (await d.init()) return d;
          if (d.initFailure) this.fail(d, d.initFailure);
          return null;
        } catch (err) {
          this.fail(d, `init failed: ${errText(err)}`);
          return null;
        }
      }),
    );
    this.live = results.filter((d): d is Destination => d !== null);
    if (this.live.length === 0) {
      this.deactivated = true;
      for (const t of this.tallies.values()) t.failed += this.buffer.length;
      this.buffer = [];
    }
  }

  private async sendSafe(dest: Destination, batch: Sample[]): Promise<void> {
    const t = this.tally(dest);
    t.inFlight += batch.length;
    try {
      await dest.send(batch, this.deadline.signal);
      t.sent += batch.length;
    } catch (err) {
      t.failed += batch.length;
      this.fail(dest, errText(err));
    } finally {
      t.inFlight -= batch.length;
    }
  }

  /** Record a destination's failure reason and warn — once per distinct reason. */
  private fail(dest: Destination, reason: string): void {
    const t = this.tally(dest);
    t.lastError = reason;
    if (t.warned.has(reason) || t.warned.size > MAX_DISTINCT_WARNINGS) return;
    t.warned.add(reason);
    if (t.warned.size > MAX_DISTINCT_WARNINGS) {
      this.onWarn(`${dest.name}: further distinct failures suppressed (see the push status attachment)`);
    } else {
      this.onWarn(`${dest.name}: ${reason}`);
    }
  }

  private tally(dest: Destination): Tally {
    return this.tallies.get(dest)!;
  }

  /** Stop the timer, drain what remains within a bounded budget, then close each sink. */
  async close(): Promise<void> {
    this.timer?.clear();
    this.timer = null;
    if (!this.isActive) {
      this.closed = true;
      this.finalStatus = this.snapshot();
      return;
    }
    // Retries honour the deadline signal, which fires just before the hard cutoff, so the
    // whole drain — flush, retries and close — fits inside drainMs.
    const settleMs = Math.min(DRAIN_SETTLE_MS, this.drainMs / 10);
    const abortTimer = this.clock.setTimeout(() => this.deadline.abort(), this.drainMs - settleMs);
    await withTimeout(this.clock, this.drain(), this.drainMs);
    abortTimer.clear();
    this.closed = true;
    this.finalStatus = this.snapshot();
  }

  /**
   * The Push Status, one record per enabled destination (empty when none is enabled — the
   * local path). Final once close() has resolved: anything still buffered or in flight at
   * that point is counted as dropped.
   */
  status(): PushStatus[] {
    return this.finalStatus ?? this.snapshot();
  }

  private snapshot(): PushStatus[] {
    return this.enabledDests.map((d) => {
      const t = this.tally(d);
      const unsent = this.live.includes(d) ? t.inFlight + this.buffer.length : 0;
      return { destination: d.name, sent: t.sent, failed: t.failed, dropped: t.dropped + unsent, lastError: t.lastError };
    });
  }

  private async drain(): Promise<void> {
    await this.flush(); // one final flush empties the buffer (splice takes all of it)
    await Promise.allSettled(
      this.live.map(async (d) => {
        try {
          await d.close();
        } catch (err) {
          this.fail(d, `close failed: ${errText(err)}`);
        }
      }),
    );
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
