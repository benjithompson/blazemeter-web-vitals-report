// The Docker integration seam: proves the wide-format points the InfluxDestination writes
// actually round-trip a REAL InfluxDB 2.x bucket — native float64 fields land as written,
// the bounded tags land as tags, and precision=ms preserves the millisecond timestamp.
//
// This is the ONLY test that touches a network, so it SKIPS unless a live Influx is
// configured (BZM_INFLUX_URL + BZM_INFLUX_TOKEN present). Bring one up with:
//   docker compose -f docker-compose.influx.yml up -d
//   export BZM_INFLUX_URL=http://localhost:8086 BZM_INFLUX_ORG=perf \
//          BZM_INFLUX_BUCKET=vitals BZM_INFLUX_TOKEN=dev-token-please-change
// The unit tests (influx-mapping / influx-destination) stay network-free and always run.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Sample } from 'bzm-vitals-format';
import { InfluxDestination } from '../src/influx-destination';

const URL_ = process.env.BZM_INFLUX_URL?.trim();
const ORG = process.env.BZM_INFLUX_ORG?.trim() || 'perf';
const BUCKET = process.env.BZM_INFLUX_BUCKET?.trim() || 'vitals';
const TOKEN = process.env.BZM_INFLUX_TOKEN?.trim();
const LIVE = Boolean(URL_ && TOKEN);

const m = (value: number | null, status: Sample['vitals'][string]['status']) => ({ value, status });

/** A unique route per run so re-runs never read each other's points. */
const RUN_TAG = `/it/${Date.now()}`;

function sample(vitals: Sample['vitals'], ts: number): Sample {
  return {
    schemaVersion: 1,
    ts,
    url: 'https://shop.example.com' + RUN_TAG,
    route: RUN_TAG,
    test: { file: 'it.spec.ts', title: 'integration', project: 'chromium', repeat: 0, worker: 0 },
    navigationIndex: 1,
    vitals,
    navigation: { domContentLoadedMs: null, loadEventMs: null },
    context: { workers: 1, resourceCount: null, requestCount: null, failedRequests: null },
  };
}

/** Query the bucket back as annotated CSV via the Flux API. */
async function queryFlux(flux: string): Promise<string> {
  const res = await fetch(`${URL_}/api/v2/query?org=${encodeURIComponent(ORG)}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${TOKEN}`,
      'Content-Type': 'application/vnd.flux',
      Accept: 'application/csv',
    },
    body: flux,
  });
  if (!res.ok) throw new Error(`flux query → ${res.status}: ${await res.text()}`);
  return res.text();
}

describe.skipIf(!LIVE)('InfluxDestination — round-trips a real InfluxDB 2.x bucket', () => {
  const TS = 1_700_000_123_456; // epoch ms; precision=ms must preserve it exactly

  beforeAll(async () => {
    const d = new InfluxDestination({
      env: {
        BZM_INFLUX_URL: URL_,
        BZM_INFLUX_ORG: ORG,
        BZM_INFLUX_BUCKET: BUCKET,
        BZM_INFLUX_TOKEN: TOKEN,
        BZM_VITALS_LOCATION: 'us-west-1',
      },
    });
    expect(d.isEnabled()).toBe(true);
    expect(await d.init()).toBe(true);
    // One point, two native-float fields (ms + true-float CLS) and a not-ok vital omitted.
    await d.send([sample({ lcp: m(2276.7, 'ok'), cls: m(0.083, 'ok'), inp: m(null, 'no-interaction') }, TS)]);
  });

  it('the fields land as their native float64 values', async () => {
    const csv = await queryFlux(`
      from(bucket: "${BUCKET}")
        |> range(start: 2020-01-01T00:00:00Z)
        |> filter(fn: (r) => r._measurement == "web_vitals" and r.route == "${RUN_TAG}")
    `);
    // annotated CSV carries adjacent _value,_field columns; assert both vitals round-tripped exactly.
    expect(csv).toMatch(/,2276\.7,lcp,/);
    expect(csv).toMatch(/,0\.083,cls,/);
    // the not-ok vital was never written
    expect(csv).not.toContain(',inp,');
  });

  it('the bounded dimensions land as tags and the ms timestamp is preserved', async () => {
    const csv = await queryFlux(`
      from(bucket: "${BUCKET}")
        |> range(start: 2020-01-01T00:00:00Z)
        |> filter(fn: (r) => r._measurement == "web_vitals" and r.route == "${RUN_TAG}")
        |> filter(fn: (r) => r._field == "lcp")
    `);
    expect(csv).toContain('us-west-1'); // location tag
    expect(csv).toContain('chromium'); // project tag
    // precision=ms means the point time is exactly our epoch-ms, rendered as RFC3339 ms
    // (a second-floored write would drop the .456 and fail this).
    const iso = new Date(TS).toISOString(); // 2023-11-14T22:15:23.456Z
    expect(iso).toMatch(/\.456Z$/); // guard the fixture keeps sub-second ms
    expect(csv).toContain(iso);
  });
});
