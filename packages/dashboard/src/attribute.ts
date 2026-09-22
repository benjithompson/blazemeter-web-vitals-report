// Attribution — where a Sample becomes an Attributed Sample.
//
// A Sample is what exists in a zip; an Attributed Sample is what can be
// reasoned about (CONTEXT.md). The dashboard stamps masterId / sessionId /
// locationId at fetch time from the API context of the zip the Sample came
// from — a raw artifact file is not fully interpretable on its own, by design.
// The two types are distinct and never share a name.

import type { ExecutionOutcome, ExecutionStatus } from 'bzm-vitals-format';
import type { DashboardSample } from './parse.js';

/** Where a Sample came from: the library's collector, or the incumbent's
 *  performance-audit records through the legacy adapter. */
export type SampleProvenance = 'collector' | 'legacy';

/**
 * The per-Execution status a Sample carries after the Outcome join:
 *   - one of the format's closed ExecutionStatus values, joined from the
 *     Execution's Outcome record (the final retry's verdict);
 *   - 'crashed' — the Execution has NO Outcome record while other Executions
 *     in the same session DO: the collector was clearly emitting, so the
 *     absence means the Execution died before afterEach ran;
 *   - 'unavailable' — outcome-awareness does not exist for this Sample: either
 *     its session emitted zero Outcome records anywhere (an older collector,
 *     or the legacy producer), or the Sample carries no test identity to join
 *     on. Never conflated with 'crashed'.
 */
export type SampleExecutionStatus = ExecutionStatus | 'crashed' | 'unavailable';

/** An Outcome plus the Engine (sessionId) whose zip it came from — the join is
 *  strictly within a session; Engine A's repeat1 is not Engine B's repeat1. */
export interface AttributedOutcome {
  sessionId: string;
  outcome: ExecutionOutcome;
}

/** The fetch-time identity of one Engine's zip. */
export interface EngineRef {
  /** null for a local import with no master id given. */
  masterId: string | null;
  /** The sessionId (r-v4-…) — the true Engine identity; the only join key. */
  sessionId: string;
  locationId: string;
  /** For humans: "us-west-1" or "us-west-1 #2". Never key on it. */
  engineLabel: string;
}

/** A Sample plus the Report and Engine identity stamped at fetch. */
export interface AttributedSample extends EngineRef {
  provenance: SampleProvenance;
  sample: DashboardSample;
  /**
   * Cold Start flag, stamped by markColdStarts (aggregate.ts): true — the
   * first Navigation by ts for this (sessionId, workerIndex); false — a later
   * one; null — the Sample carries no workerIndex (legacy), so Cold Starts are
   * structurally unidentifiable and never guessed. Absent before marking.
   */
  coldStart?: boolean | null;
  /** Per-Execution status, stamped by joinOutcomes (aggregate.ts). Absent before the join. */
  executionStatus?: SampleExecutionStatus;
}

/**
 * Engine Labels for a Report's session list: "{locationId} #{ordinal}" when a
 * location has more than one Engine, plain "{locationId}" when it has exactly
 * one — the common single-Engine case reads naturally. Ordinals follow the API's
 * session order.
 */
export function engineLabels(
  sessions: Array<{ sessionId: string; locationId: string }>,
): Map<string, string> {
  const perLocation = new Map<string, number>();
  for (const s of sessions) {
    perLocation.set(s.locationId, (perLocation.get(s.locationId) ?? 0) + 1);
  }
  const ordinal = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const s of sessions) {
    if (perLocation.get(s.locationId)! > 1) {
      const n = (ordinal.get(s.locationId) ?? 0) + 1;
      ordinal.set(s.locationId, n);
      labels.set(s.sessionId, `${s.locationId} #${n}`);
    } else {
      labels.set(s.sessionId, s.locationId);
    }
  }
  return labels;
}

/** Stamp one Sample with the identity of the zip it was extracted from. */
export function attributeSample(
  sample: DashboardSample,
  provenance: SampleProvenance,
  engine: EngineRef,
): AttributedSample {
  return { ...engine, provenance, sample };
}
