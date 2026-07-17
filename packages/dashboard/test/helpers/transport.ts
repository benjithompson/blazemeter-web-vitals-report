// A stubbed Transport for the dashboard tests. No test touches the network.
import type { HttpResponse, Transport } from '../../src/http.js';

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

export function bytesResponse(buf: Buffer, status = 200): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

export interface RecordingTransport {
  transport: Transport;
  /** URLs requested, in order. */
  calls: string[];
}

/** Route by handler; every request URL is recorded in order. */
export function recordingTransport(
  handler: (url: string) => HttpResponse | Promise<HttpResponse>,
): RecordingTransport {
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { transport, calls };
}
