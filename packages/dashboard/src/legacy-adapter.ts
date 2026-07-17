// The legacy adapter — explicitly named, deliberately small.
//
// Maps the incumbent collector's performance-audit-*.json records into the
// canonical shape so the dashboard is demoable against real data today
// (SPEC.md → "Two producers, so the seam is real"). The library's format is
// canonical; this adapter is the second producer that proves the format is a
// contract, not the library's private output shape.
//
// What the incumbent cannot say is represented honestly, never guessed:
//   - a null metric becomes {value: null, status: "unknown"} — the incumbent
//     cannot distinguish "unsupported" from "no interaction" from "error";
//   - test identity and navigationIndex are null — the incumbent carries no
//     test identity at all beyond a URL;
//   - context.workers is null — never inferred from config.

import type { Metric } from '@bzm/vitals-format';
import type { DashboardSample } from './parse.js';

/**
 * The incumbent attaches SIX files per audited URL; only the
 * `performance-audit-…-json-…` one is the audit record. The paired `…-html-…`
 * copy and the other json attachments (performance-, network-,
 * resource-contribution-) must not be selected — matching loosely here would
 * double-count or misread.
 */
const LEGACY_AUDIT_JSON_NAME = /^performance-audit-.+-json(-[0-9a-f]{40})?\.json$/;

/** Is this flat-zip basename an incumbent audit record (the JSON one, never the html twin)? */
export function isLegacyAuditJsonName(basename: string): boolean {
  return LEGACY_AUDIT_JSON_NAME.test(basename);
}

/** The five vitals the incumbent records. fullpageloadtime and firstByteMs are
 *  byte-identical duplicates of loadEventMs and ttfb and are dropped. */
const LEGACY_VITAL_NAMES = ['fcp', 'lcp', 'cls', 'inp', 'ttfb'] as const;

interface LegacyAuditRecord {
  url: string;
  generatedAt: string;
  navigation?: {
    domContentLoadedMs?: number | null;
    loadEventMs?: number | null;
    firstByteMs?: number | null; // duplicate of coreWebVitals.ttfb — dropped
  };
  coreWebVitals: Record<string, number | null | undefined>;
  resourceCount?: number | null;
  requestCount?: number | null;
  failedRequests?: number | null;
}

function isLegacyAuditRecord(value: unknown): value is LegacyAuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.url === 'string' &&
    typeof rec.generatedAt === 'string' &&
    typeof rec.coreWebVitals === 'object' &&
    rec.coreWebVitals !== null
  );
}

export type AdaptResult =
  | { ok: true; sample: DashboardSample }
  | { ok: false; reason: string };

/** Map one incumbent audit record to the canonical shape. */
export function adaptLegacyAuditRecord(record: unknown): AdaptResult {
  if (!isLegacyAuditRecord(record)) {
    return { ok: false, reason: 'not a legacy performance-audit record (expected {url, generatedAt, coreWebVitals})' };
  }

  // generatedAt stamps when the AUDIT ran, not Navigation start — the canonical
  // ts means "epoch ms at Navigation start" and this is the closest the
  // incumbent can offer. The adapter must not claim otherwise; the discrepancy
  // is inherent to the incumbent's cold re-navigation design.
  const ts = Date.parse(record.generatedAt);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: `unparseable generatedAt: ${JSON.stringify(record.generatedAt)}` };
  }

  const vitals: Record<string, Metric> = {};
  for (const name of LEGACY_VITAL_NAMES) {
    const value = record.coreWebVitals[name];
    // ok if non-null (0 is a measured value), else unknown — the incumbent
    // cannot say WHY a metric is missing, and the adapter never guesses.
    vitals[name] =
      typeof value === 'number'
        ? { value, status: 'ok' }
        : { value: null, status: 'unknown' };
  }
  // Dropped, deliberately: coreWebVitals.fullpageloadtime (byte-identical to
  // navigation.loadEventMs) and navigation.firstByteMs (byte-identical to
  // coreWebVitals.ttfb).

  return {
    ok: true,
    sample: {
      schemaVersion: 1,
      ts,
      url: record.url,
      test: null, // the incumbent carries no test identity at all
      navigationIndex: null, // nor a navigation index
      vitals,
      navigation: {
        domContentLoadedMs: record.navigation?.domContentLoadedMs ?? null,
        loadEventMs: record.navigation?.loadEventMs ?? null,
      },
      context: {
        workers: null, // unavailable — never inferred
        resourceCount: record.resourceCount ?? null,
        requestCount: record.requestCount ?? null,
        failedRequests: record.failedRequests ?? null,
      },
    },
  };
}
