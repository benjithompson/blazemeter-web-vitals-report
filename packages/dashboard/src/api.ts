// The BlazeMeter API chain (SPEC.md → "The API chain").
//
//   GET /api/v4/masters/{id}/status          -> result.sessions[] {id, status, locationId}
//   GET /api/v4/sessions/{sid}/reports/logs  -> result.data[] {filename, dataUrl}  (pick "artifacts.zip")
//   GET {dataUrl}                            -> zip bytes (pre-signed, 20-min expiry)
//
// Always enumerate sessions (at least one, never assume exactly one). The dataUrl
// is pre-signed and expires in 20 minutes, so we re-list /reports/logs immediately
// before each download, never persist a dataUrl, and retry a stale 403 by re-listing.
// Credentials authenticate only the two listing calls; the dataUrl GET needs none.

import { basicAuthHeader, defaultTransport, type Credentials, type Transport } from './http.js';

const BASE = 'https://a.blazemeter.com';

const ARTIFACTS_ZIP = 'artifacts.zip';

export interface SessionInfo {
  /** The sessionId (r-v4-…) — the true Engine identity. */
  id: string;
  status: string;
  locationId: string;
}

export interface ApiOptions {
  creds: Credentials;
  transport?: Transport;
}

interface StatusEnvelope {
  result?: { sessions?: Array<Partial<SessionInfo>> };
}

interface LogsEnvelope {
  result?: { data?: Array<{ filename?: string; dataUrl?: string }> };
}

/** GET /masters/{id}/status → the session list. Always returns every session. */
export async function listSessions(
  masterId: string,
  opts: ApiOptions,
): Promise<SessionInfo[]> {
  const transport = opts.transport ?? defaultTransport;
  const res = await transport(`${BASE}/api/v4/masters/${masterId}/status`, {
    headers: { Authorization: basicAuthHeader(opts.creds) },
  });
  if (!res.ok) {
    throw new Error(`GET /masters/${masterId}/status failed: ${res.status}`);
  }
  const body = (await res.json()) as StatusEnvelope;
  const sessions = body.result?.sessions ?? [];
  return sessions.map((s) => ({
    id: String(s.id),
    status: String(s.status ?? ''),
    locationId: String(s.locationId ?? ''),
  }));
}

/**
 * GET /sessions/{sid}/reports/logs and pick the artifacts.zip dataUrl. Returns
 * null when the session has no artifacts.zip entry — an Engine that terminated
 * ungracefully emits no zip at all, which is a normal outcome, not an error.
 * The returned URL is pre-signed and short-lived; never persist it.
 */
export async function findArtifactUrl(
  sessionId: string,
  opts: ApiOptions,
): Promise<string | null> {
  const transport = opts.transport ?? defaultTransport;
  const res = await transport(`${BASE}/api/v4/sessions/${sessionId}/reports/logs`, {
    headers: { Authorization: basicAuthHeader(opts.creds) },
  });
  if (!res.ok) {
    throw new Error(`GET /sessions/${sessionId}/reports/logs failed: ${res.status}`);
  }
  const body = (await res.json()) as LogsEnvelope;
  const data = body.result?.data ?? [];
  const entry = data.find((d) => d.filename === ARTIFACTS_ZIP);
  return entry?.dataUrl ?? null;
}

/**
 * Fetch one Engine's artifacts.zip bytes. Re-lists /reports/logs immediately
 * before the download (never reuses a cached dataUrl) and retries a stale 403
 * once by re-listing. Returns null when the session has no artifact.
 */
export async function fetchArtifactBytes(
  sessionId: string,
  opts: ApiOptions,
): Promise<Buffer | null> {
  const transport = opts.transport ?? defaultTransport;

  const url = await findArtifactUrl(sessionId, opts);
  if (url === null) return null;

  let res = await transport(url); // pre-signed — no auth header
  if (res.status === 403) {
    // dataUrl went stale between listing and download; re-list once and retry.
    const fresh = await findArtifactUrl(sessionId, opts);
    if (fresh === null) return null;
    res = await transport(fresh);
  }
  if (!res.ok) {
    throw new Error(`download of ${sessionId} artifacts.zip failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
