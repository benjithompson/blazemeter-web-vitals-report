// The canonical parser — format-v1 Sample files in, DashboardSamples out.
//
// Discovery is by attachment-name prefix: the artifacts zip is flat, so the
// basename is the only handle. Playwright's attach({path}) mangles the basename
// to {name}-{sha1(path)}{ext}, so the collector's files arrive as
// {SAMPLE_ATTACHMENT_PREFIX}-{n}-{sha1}.json — a prefix match is sufficient.
//
// Rules (SPEC.md → "The record format"):
//   - schemaVersion !== 1 is REJECTED LOUDLY — recorded per-file with a reason,
//     never silently misread.
//   - Metric NAMES are open: unknown names pass through untouched.
//   - Metric STATUS is closed: the parser preserves whatever it finds verbatim;
//     aggregation treats anything that is not exactly "ok" as not-ok.
//   - Every field is preserved — issue #10 asserts a full round-trip of the
//     collector's real output through this parser.

import {
  SAMPLE_ATTACHMENT_PREFIX,
  SCHEMA_VERSION,
  type Sample,
  type TestIdentity,
} from '@bzm/vitals-format';

/**
 * The dashboard's internal Sample. Identical to the on-disk format Sample except
 * that test identity and navigationIndex are widened to nullable: the legacy
 * adapter produces Samples from records that carry NO test identity at all, and
 * that absence is represented honestly as null — never a fabricated sentinel
 * TestIdentity. The on-disk format types stay untouched; provenance (collector
 * vs legacy) is carried at the Attributed level, not here.
 */
export interface DashboardSample extends Omit<Sample, 'test' | 'navigationIndex'> {
  test: TestIdentity | null;
  navigationIndex: number | null;
}

/** Is this flat-zip basename a collector-emitted Sample attachment? */
export function isSampleAttachment(basename: string): boolean {
  return basename.startsWith(SAMPLE_ATTACHMENT_PREFIX);
}

export type ParseResult =
  | { ok: true; sample: DashboardSample }
  | { ok: false; reason: string };

/**
 * Parse one Sample file's bytes. Returns the parsed record with every field
 * preserved (the JSON object is returned as-is — nothing is rebuilt, so unknown
 * fields and unknown metric names ride along), or a loud rejection reason.
 */
export function parseSampleJson(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schemaVersion ${JSON.stringify(record.schemaVersion)} is not the supported version ${SCHEMA_VERSION} — rejected, not misread`,
    };
  }
  if (typeof record.url !== 'string') {
    return { ok: false, reason: 'missing url' };
  }
  if (typeof record.ts !== 'number') {
    return { ok: false, reason: 'missing ts (epoch ms)' };
  }
  if (typeof record.vitals !== 'object' || record.vitals === null) {
    return { ok: false, reason: 'missing vitals map' };
  }
  // Everything else — including fields this version has never heard of — is
  // preserved verbatim. Do not rebuild the object; issue #10 asserts round-trip.
  return { ok: true, sample: record as unknown as DashboardSample };
}
