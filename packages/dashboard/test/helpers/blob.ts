// Decode the embedded data blob back out of an emitted HTML file.
// The blob is a product requirement (the 20-min dataUrl expiry forces
// embedding), so Seam 2 asserts on it — one seam, no new interface. Since E1
// it is the ReportData as gzip-compressed, base64-encoded JSON.
import { gunzipSync } from 'node:zlib';
import type { ReportData } from '../../src/report.js';

export const BLOB_RE =
  /<script type="application\/gzip" data-encoding="base64" id="bzm-vitals-data">([\s\S]*?)<\/script>/;

/** The blob's raw payload (base64 text) as it sits in the file. */
export function blobPayload(html: string): string {
  const match = BLOB_RE.exec(html);
  if (!match) throw new Error('the embedded data blob is missing from the emitted HTML');
  return match[1]!;
}

export function parseBlob(html: string): ReportData {
  const payload = blobPayload(html);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error('the data blob is not base64');
  return JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString('utf8')) as ReportData;
}

/** The file's one executable inline <script> — the browser bundle. */
export function inlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('the inline browser script is missing from the emitted HTML');
  return match[1]!;
}

/** The emitted bytes minus the blob and the bundle: the server-rendered markup. */
export function staticMarkup(html: string): string {
  return html.replace(BLOB_RE, '').replace(/<script>[\s\S]*?<\/script>/, '');
}
