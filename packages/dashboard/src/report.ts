// Build the ReportData — the object the emitted HTML embeds and Seam 2 parses
// back out. Walks a cached master's extracted session directories, parses
// canonical Samples, adapts legacy records, attributes everything with the
// Engine identity from the manifest, and aggregates crudely.
//
// A file that LOOKS like a record but cannot be read is recorded per-file
// under its session as unreadable, with a reason — loud, never silently
// misread and never silently dropped. Files that are neither canonical Samples
// nor legacy audit records (bzt.log, config.yml, the html report twins…) are
// simply not records, and are ignored.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MasterManifest } from './cache.js';
import {
  isOutcomeAttachment,
  isSampleAttachment,
  parseOutcomeJson,
  parseSampleJson,
} from './parse.js';
import { adaptLegacyAuditRecord, isLegacyAuditJsonName } from './legacy-adapter.js';
import {
  attributeSample,
  engineLabels,
  type AttributedOutcome,
  type AttributedSample,
} from './attribute.js';
import { aggregateRoutes, joinOutcomes, markColdStarts, type RouteRow } from './aggregate.js';

export interface UnreadableFile {
  file: string;
  reason: string;
}

export interface SessionSummary {
  sessionId: string;
  locationId: string;
  status: string;
  engineLabel: string;
  /** 'no-artifact' — the Engine emitted no zip. Listed, never silently absent. */
  artifact: 'present' | 'no-artifact';
  sampleCount: number;
  /** Execution Outcome records this Engine emitted. 0 means outcome-awareness
   *  is unavailable for the whole session — its Samples are never "crashed". */
  outcomeCount: number;
  unreadable: UnreadableFile[];
}

/** Everything the emitted HTML embeds. Issue #7 extends this shape. */
export interface ReportData {
  masterId: string;
  /** When this HTML was generated — not when the Report ran. */
  generatedAt: string;
  sessions: SessionSummary[];
  /** Failed Executions INCLUDED (the honest default — excluding them deletes
   *  the slowest Samples). #9's toggle re-aggregates via
   *  excludeFailedExecutions(samples) → aggregateRoutes. */
  routes: RouteRow[];
  /** Every Sample, Cold-Start-flagged and Outcome-joined. */
  samples: AttributedSample[];
  /** The raw Execution Outcomes, session-attributed. */
  outcomes: AttributedOutcome[];
}

/** Read every record out of a cached, extracted master directory. */
export async function buildReportData(
  manifest: MasterManifest,
  masterDir: string,
): Promise<ReportData> {
  const labels = engineLabels(
    manifest.sessions.map((s) => ({ sessionId: s.sessionId, locationId: s.locationId })),
  );

  const sessions: SessionSummary[] = [];
  const samples: AttributedSample[] = [];
  const outcomes: AttributedOutcome[] = [];

  for (const session of manifest.sessions) {
    const engine = {
      masterId: manifest.masterId,
      sessionId: session.sessionId,
      locationId: session.locationId,
      engineLabel: labels.get(session.sessionId)!,
    };
    const summary: SessionSummary = {
      sessionId: session.sessionId,
      locationId: session.locationId,
      status: session.status,
      engineLabel: engine.engineLabel,
      artifact: session.artifact,
      sampleCount: 0,
      outcomeCount: 0,
      unreadable: [],
    };
    sessions.push(summary);
    if (session.artifact !== 'present') continue;

    const sessionDir = path.join(masterDir, session.sessionId);
    // The artifacts zip carries each record TWICE when Taurus flattens the
    // test-results tree in beside the attachments dir: the sha1-suffixed
    // attachment copy, plus a bare fixed-name survivor of the flattening
    // collision (last writer wins — observed on master 82731327, where it
    // double-counted the final Execution per Engine). Two files in one session
    // carrying the identical record are one Sample: distinct Navigations
    // always differ in ts/navigationIndex, so content identity is safe.
    const seenRecords = new Set<string>();
    const firstSighting = (parsed: unknown): boolean => {
      const key = JSON.stringify(parsed);
      if (seenRecords.has(key)) return false;
      seenRecords.add(key);
      return true;
    };
    for (const file of (await readdir(sessionDir)).sort()) {
      if (isSampleAttachment(file)) {
        const parsed = parseSampleJson(await readFile(path.join(sessionDir, file), 'utf8'));
        if (!parsed.ok) {
          summary.unreadable.push({ file, reason: parsed.reason });
        } else if (firstSighting(parsed.sample)) {
          samples.push(attributeSample(parsed.sample, 'collector', engine));
          summary.sampleCount += 1;
        }
      } else if (isOutcomeAttachment(file)) {
        const parsed = parseOutcomeJson(await readFile(path.join(sessionDir, file), 'utf8'));
        if (!parsed.ok) {
          summary.unreadable.push({ file, reason: parsed.reason });
        } else if (firstSighting(parsed.outcome)) {
          outcomes.push({ sessionId: session.sessionId, outcome: parsed.outcome });
          summary.outcomeCount += 1;
        }
      } else if (isLegacyAuditJsonName(file)) {
        const raw = await readFile(path.join(sessionDir, file), 'utf8');
        let record: unknown;
        try {
          record = JSON.parse(raw);
        } catch (err) {
          summary.unreadable.push({ file, reason: `not valid JSON: ${(err as Error).message}` });
          continue;
        }
        const adapted = adaptLegacyAuditRecord(record);
        if (!adapted.ok) {
          summary.unreadable.push({ file, reason: adapted.reason });
        } else if (firstSighting(adapted.sample)) {
          samples.push(attributeSample(adapted.sample, 'legacy', engine));
          summary.sampleCount += 1;
        }
      }
      // Anything else is not a record; ignore it.
    }
  }

  // The model's two stampings, in order: Cold Start flags (first Navigation by
  // ts per (sessionId, workerIndex); null when unidentifiable), then the
  // Outcome join (per-Execution status; crashed only where the session was
  // clearly emitting Outcomes).
  const flagged = joinOutcomes(markColdStarts(samples), outcomes);

  return {
    masterId: manifest.masterId,
    generatedAt: new Date().toISOString(),
    sessions,
    routes: aggregateRoutes(flagged),
    samples: flagged,
    outcomes,
  };
}
