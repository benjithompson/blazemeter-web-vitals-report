// Build the ReportData — the object the emitted HTML embeds and Seam 2 parses
// back out. Reads each Engine's record files — from a cached master's
// extracted session directories, or from local artifacts (local.ts) — parses
// canonical Samples, adapts legacy records, attributes everything with the
// Engine identity, and aggregates crudely.
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
  /** null when the Report was imported from local artifacts with no master
   *  id given — there is then no BlazeMeter Report to name or link to. */
  masterId: string | null;
  /** The Report's name (GET /masters/{id} → result.name); null when the API
   *  carried none, so the header falls back to the master id. */
  reportName: string | null;
  /** The basename of the local path the artifacts were imported from; absent
   *  when they were fetched from the API. Never the full path — that would
   *  leak the importer's filesystem layout into a shareable file. */
  localSource?: string;
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

/** One candidate record file, wherever it lives — a cache directory, a local
 *  folder, or an entry inside a zip. */
export interface RecordFile {
  /** Display path, '/'-separated; its last segment is the attachment basename
   *  discovery keys on. Reported verbatim when the file is unreadable. */
  file: string;
  read(): Promise<string>;
}

/** One Engine's identity plus its candidate record files. */
export interface EngineRecords {
  sessionId: string;
  locationId: string;
  status: string;
  artifact: 'present' | 'no-artifact';
  files: RecordFile[];
}

export interface AssembleInput {
  masterId: string | null;
  reportName: string | null;
  localSource?: string;
  engines: EngineRecords[];
}

function basenameOf(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Is this basename one of the three record kinds the dashboard reads? */
export function isRecordFileName(basename: string): boolean {
  return (
    isSampleAttachment(basename) ||
    isOutcomeAttachment(basename) ||
    isLegacyAuditJsonName(basename)
  );
}

/** Read every record out of a cached, extracted master directory. */
export async function buildReportData(
  manifest: MasterManifest,
  masterDir: string,
): Promise<ReportData> {
  const engines: EngineRecords[] = [];
  for (const session of manifest.sessions) {
    const files: RecordFile[] = [];
    if (session.artifact === 'present') {
      const sessionDir = path.join(masterDir, session.sessionId);
      for (const file of (await readdir(sessionDir)).sort()) {
        files.push({ file, read: () => readFile(path.join(sessionDir, file), 'utf8') });
      }
    }
    engines.push({
      sessionId: session.sessionId,
      locationId: session.locationId,
      status: session.status,
      artifact: session.artifact,
      files,
    });
  }
  return assembleReportData({
    masterId: manifest.masterId,
    reportName: manifest.reportName ?? null,
    engines,
  });
}

/** Parse, attribute, and aggregate every Engine's records — source-agnostic. */
export async function assembleReportData(input: AssembleInput): Promise<ReportData> {
  const labels = engineLabels(
    input.engines.map((s) => ({ sessionId: s.sessionId, locationId: s.locationId })),
  );

  const sessions: SessionSummary[] = [];
  const samples: AttributedSample[] = [];
  const outcomes: AttributedOutcome[] = [];

  for (const session of input.engines) {
    const engine = {
      masterId: input.masterId,
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
    for (const { file, read } of session.files) {
      const name = basenameOf(file);
      if (isSampleAttachment(name)) {
        const parsed = parseSampleJson(await read());
        if (!parsed.ok) {
          summary.unreadable.push({ file, reason: parsed.reason });
        } else if (firstSighting(parsed.sample)) {
          samples.push(attributeSample(parsed.sample, 'collector', engine));
          summary.sampleCount += 1;
        }
      } else if (isOutcomeAttachment(name)) {
        const parsed = parseOutcomeJson(await read());
        if (!parsed.ok) {
          summary.unreadable.push({ file, reason: parsed.reason });
        } else if (firstSighting(parsed.outcome)) {
          outcomes.push({ sessionId: session.sessionId, outcome: parsed.outcome });
          summary.outcomeCount += 1;
        }
      } else if (isLegacyAuditJsonName(name)) {
        const raw = await read();
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
    masterId: input.masterId,
    reportName: input.reportName,
    ...(input.localSource !== undefined ? { localSource: input.localSource } : {}),
    generatedAt: new Date().toISOString(),
    sessions,
    routes: aggregateRoutes(flagged),
    samples: flagged,
    outcomes,
  };
}
