// Parse the embedded JSON data blob back out of an emitted HTML file.
// The blob is a product requirement (the 20-min dataUrl expiry forces
// embedding), so Seam 2 asserts on it — one seam, no new interface.
import type { ReportData } from '../../src/report.js';

export const BLOB_RE =
  /<script type="application\/json" id="bzm-vitals-data">([\s\S]*?)<\/script>/;

export function parseBlob(html: string): ReportData {
  const match = BLOB_RE.exec(html);
  if (!match) throw new Error('the embedded JSON data blob is missing from the emitted HTML');
  return JSON.parse(match[1]!) as ReportData;
}
