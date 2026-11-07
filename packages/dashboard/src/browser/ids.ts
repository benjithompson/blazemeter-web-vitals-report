// Element ids shared by the page skeleton (render.ts) and the browser bundle (entry.ts).

/** The container the browser renders the interactive report into. It holds the
 *  server-rendered fallback summary until then; data-bzm-state on it reads
 *  static → loading → ready (or unsupported / error). */
export const APP_ID = 'bzm-app';
/** The note above it: loading, no DecompressionStream, or a render failure. */
export const STATUS_ID = 'bzm-status';
/** The data blob: the ReportData as gzip-compressed, base64-encoded JSON. */
export const DATA_BLOB_ID = 'bzm-vitals-data';
