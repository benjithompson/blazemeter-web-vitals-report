// The canonical parser — format-v1 Sample files in, DashboardSamples out.
//
// Discovery is by attachment-name prefix: the artifacts zip is flat, so the
// basename is the only handle. Playwright's attach({path}) mangles the basename
// to {name}-{sha1(path)}{ext}, so the collector's files arrive as
// {SAMPLE_ATTACHMENT_PREFIX}-{n}-{sha1}.json — a prefix match is sufficient.
//
// Rules (SPEC.md → "The record format"): validity is bzm-vitals-format's
// validateSample / validateOutcome — the ONE definition, shared with the published
// JSON Schemas. This file adds only the JSON decoding around it.
//   - schemaVersion !== 1 is REJECTED LOUDLY — recorded per-file with a reason,
//     never silently misread.
//   - Every field is type-checked: a malformed record (a string metric value, a
//     test identity missing project, a status outside the closed vocabulary, …)
//     is rejected with a reason naming the field, and lands in the session's
//     `unreadable` list instead of reaching aggregation.
//   - Metric NAMES are open: unknown names pass through untouched, as do unknown
//     fields — the additive ones (test.id, titlePath, path, pageIndex,
//     lostNavigations) and any this version has never heard of.
//   - Every field is preserved — issue #10 asserts a full round-trip of the
//     collector's real output through this parser.

import {
  OUTCOME_ATTACHMENT_PREFIX,
  SAMPLE_ATTACHMENT_PREFIX,
  validateOutcome,
  validateSample,
  type ExecutionOutcome,
  type Sample,
  type TestIdentity,
} from 'bzm-vitals-format';

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
  const decoded = decodeJson(raw);
  if (!decoded.ok) return decoded;
  // validateSample hands back the SAME object — nothing is rebuilt, so unknown fields
  // and unknown metric names ride along. Issue #10 asserts the round-trip.
  const valid = validateSample(decoded.value);
  if (!valid.ok) return valid;
  // A valid on-disk Sample is a DashboardSample (whose test/navigationIndex are only
  // widened to nullable for the legacy adapter).
  return { ok: true, sample: valid.value };
}

/** JSON.parse with the failure turned into a reason. */
function decodeJson(raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }
}

/** Is this flat-zip basename a collector-emitted Execution Outcome attachment? */
export function isOutcomeAttachment(basename: string): boolean {
  return basename.startsWith(OUTCOME_ATTACHMENT_PREFIX);
}

export type OutcomeParseResult =
  | { ok: true; outcome: ExecutionOutcome }
  | { ok: false; reason: string };

/**
 * Parse one Execution Outcome file's bytes, through the format's validateOutcome:
 * the same schemaVersion discipline as Samples, plus the full test identity (the
 * join key) and the closed status vocabulary — a missing Outcome means "crashed",
 * so a misread one must never slip through as anything.
 */
export function parseOutcomeJson(raw: string): OutcomeParseResult {
  const decoded = decodeJson(raw);
  if (!decoded.ok) return decoded;
  const valid = validateOutcome(decoded.value);
  if (!valid.ok) return valid;
  return { ok: true, outcome: valid.value };
}
