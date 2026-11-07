# F2 · OTLP/HTTP metrics destination: design

Status: **design spike** (ticket F2, issue #48, label `needs-design`). This document is the output. It changes no production code.
Blocked by: C4 (#29), which is merged. This design reuses its retry and Push Status.
Vocabulary: [CONTEXT.md](../../CONTEXT.md). Constraints X1 to X7: [SPEC-HARDENING.md §3](../../SPEC-HARDENING.md#3-cross-cutting-constraints-every-ticket).

---

## 0. Summary of recommendations

| Question | Recommendation |
|---|---|
| Wire format | OTLP/HTTP with **JSON** encoding (`Content-Type: application/json`, exactly that string). Build plain objects and `JSON.stringify` them, adding no dependency (X1). Optional gzip through the built-in `node:zlib`. |
| Metric shape | **Explicit-bucket histogram per vital, cumulative temporality** (`webvitals.lcp`, `webvitals.inp`, …), with bucket bounds that include the good/poor thresholds. Add one **cumulative monotonic Sum** `webvitals.navigations` as the coverage denominator. An opt-in **gauge** mode (`webvitals.<vital>.sample`, one point per Sample at `Sample.ts`) serves raw-point backends. |
| Resource | One Resource per **Worker process**: `service.name`, `service.version`, `service.instance.id = <sessionId>/w<workerIndex>`, plus `bzm.session.id` and `bzm.master.id`. Worker appears **only** inside `service.instance.id`. It is a series discriminator, never a slicing attribute. |
| Data-point attributes | The dimensions people slice by: `bzm.location`, `bzm.route`, `bzm.test.project`, `bzm.test.file`, `bzm.test.title` (and `bzm.test.id` once B2/C1 land), plus `bzm.engine` only when `BZM_VITALS_PER_ENGINE` is on. **Never** `repeat`, `navigationIndex`, raw `url` or worker. |
| Temporality | Cumulative. It is native to Grafana Cloud (Mimir) and to Prometheus. The OpenTelemetry Collector's InfluxDB exporter accepts it as-is. Delta needs an experimental flag or a conversion processor almost everywhere this project targets. Gauges have no temporality, so gauge mode avoids the question. |
| Config | New `BZM_OTLP_*` vars. Credentials come only from `BZM_OTLP_TOKEN`, the var named by `BZM_OTLP_TOKEN_ENV`, or the managed secret `BZM_SECRET_otlptoken` (X5). The destination **does not** read `OTEL_EXPORTER_OTLP_*`. |
| Retry / Push Status | Reuse `sendWithRetry` and `PushError` with an OTLP-specific retry predicate (429, 502, 503, 504 only, per the OTLP spec). An HTTP 200 `partialSuccess` is never retried. It surfaces as a warning and `lastError`. |
| Replace Influx? | **Not now.** Ship OTLP alongside the Influx destination. Revisit deprecation at a named checkpoint against explicit criteria (§8). The `InfluxWriter` stays either way, because the KPI feed needs it. |

---

## 1. Where this sits

The `Pusher` (packages/collector/src/pusher.ts) is destination-agnostic. It hands every enabled `Destination` a batch of format-v1 `Sample`s every `BZM_VITALS_FLUSH_MS` (default 10 s) and runs a 15 s drain at teardown. Each Destination owns its encoding, endpoint, auth, per-request timeout and retries. `OtlpDestination` is one more entry in `createDestinationsFromEnv()` (destinations.ts) and implements the same four methods:

| Method | OTLP behaviour |
|---|---|
| `isEnabled()` | `!killed && endpoint !== null`. A token is not required, because a local collector usually has no auth. |
| `init()` | Static identity only (like Influx). It does not call BlazeMeter, so the sinks stay decoupled. It returns `isEnabled()`. |
| `send(batch, signal)` | Fold the batch into per-series cumulative state, encode **all live series** as one `ExportMetricsServiceRequest`, and POST with `sendWithRetry`. |
| `close()` | Nothing to free. The Pusher's final flush already exported the final cumulative state. |

A Destination instance lives in one Playwright worker process, which is the natural OTel "producer". That process becomes the Resource.

## 2. Metric shape: histogram vs gauge

### 2.1 The question users ask of a live feed

The live question is *"what is p75 LCP for `/checkout` in `us-west-1`, right now, pooled over every Engine and Worker?"*, plus *"what share is good?"* and *"what is the coverage?"*. The pooling rule (CONTEXT.md) is to **pool over `sessionId` and `repeat`, and slice by everything else**.

### 2.2 Options

**A. Gauge, one data point per Sample per vital** (`asDouble = value`, `timeUnixNano = Sample.ts`).
- For: it is closest to "the Sample is the atom; nothing stored pre-aggregated". It keeps exact values and Navigation time, and it maps 1:1 onto what the Influx destination writes.
- Against: in the Prometheus family (Grafana Cloud Mimir, Prometheus) **a pooled percentile across series is impossible**. `quantile_over_time` works per series. `quantile by (route) (quantile_over_time(...))` is a quantile of quantiles, not the pooled p75. Each series must also have a single writer, because Prometheus stores **millisecond** timestamps, rejects duplicate timestamps and, without an out-of-order window, rejects out-of-order samples. So Worker must be in the series identity, and you can never pool across it in PromQL. Sparse gauge samples also interact badly with the 5-minute lookback: an instant query "holds" the last Sample's value.

**B. Explicit-bucket histogram per vital, aggregated per Worker, cumulative.**
- For: `histogram_quantile(0.75, sum by (le, bzm_route, bzm_location) (rate(webvitals_lcp_milliseconds_bucket[5m])))` pools correctly across Workers and Engines, which is exactly the pooling rule. If the bounds include the Web Vitals thresholds, **share-good is exact, not interpolated**. Both OTLP and Prometheus buckets are upper-inclusive (`(b[i-1], b[i]]` and `le`), which matches "good is LCP ≤ 2500 ms". `count` per vital is the coverage numerator. Every target backend supports it.
- Against: percentiles are interpolated within a bucket. It is approximate, and the dashboard (D7) stays the exact source. It loses the per-Navigation timestamp (time resolution becomes the flush interval). It holds a little state per Worker. In Grafana Cloud each classic bucket is its own active series (cost, see §9 Q3).

**C. Exponential histogram** (base-2 buckets with scale and offset).
- For: no bucket design, and bounded relative error. Grafana Cloud turns it into one **native histogram** series.
- Against: the encoder is more involved (scale selection, downscaling on merge). Prometheus needs native-histogram ingestion enabled. The OTel Collector's InfluxDB exporter (`telegraf-prometheus-v1/v2`) has no exponential-histogram case in its dispatch, so it does not fit the Influx-through-a-collector path. Thresholds are not exact.

### 2.3 Recommendation

**B by default for every vital (TTFB, FCP, LCP, CLS, INP)**, and **A as an opt-in mode** (`BZM_OTLP_METRIC_SHAPE=gauge|both`) for raw-point backends such as Influx through a collector. C is a later option (§9 Q3).

Reasons, in order:
1. The pooled percentile is the core query, and in the Prometheus family only B answers it correctly.
2. Threshold-aligned buckets give an exact "% good", which is the CrUX framing testers already know.
3. Cumulative B recovers from failed sends. The next successful export carries the observations, so a 30 s outage costs time resolution rather than data.
4. The same vital always uses one shape and one unit, because separate metrics per vital keep CLS (unit `1`) apart from the ms vitals.

The per-Sample exact record is still the on-disk Sample. The push is a live supplement (README, "Live push").

**Bucket bounds** (upper-inclusive). The middle bounds include each vital's good / needs-improvement / poor thresholds:

| Metric | Unit | `explicitBounds` | Thresholds included |
|---|---|---|---|
| `webvitals.ttfb` | `ms` | 100, 200, 400, **800**, 1200, **1800**, 3000, 5000 | 800 / 1800 |
| `webvitals.fcp` | `ms` | 500, 1000, 1500, **1800**, 2400, **3000**, 4000, 6000 | 1800 / 3000 |
| `webvitals.lcp` | `ms` | 500, 1000, 1500, 2000, **2500**, 3000, **4000**, 6000, 10000 | 2500 / 4000 |
| `webvitals.inp` | `ms` | 50, 100, 150, **200**, 300, **500**, 1000, 2000 | 200 / 500 |
| `webvitals.cls` | `1` | 0.01, 0.05, **0.1**, 0.15, **0.25**, 0.5, 1 | 0.1 / 0.25 |

Values are kept **native**: float ms, CLS as its true float, with no rounding and no ×1000. This matches the Influx destination's reasoning. Units are UCUM `ms` and `1`. The Prometheus translator then names them `webvitals_lcp_milliseconds_bucket/_sum/_count` and `webvitals_cls_bucket/…`. Grafana documents that the `_ratio` suffix is added for **gauges** with unit `1`, so gauge-mode CLS becomes `webvitals_cls_sample_ratio` (§9 Q4). `Sample.vitals` names are an open set. A vital without a bounds table is emitted only in gauge mode (§9 Q5).

**Coverage denominator.** The Sum `webvitals.navigations` (unit `{navigation}`, monotonic, cumulative, `asInt`) is incremented once per Sample, with the same data-point attributes. In Prometheus it becomes `webvitals_navigations_total`, because the `{…}` annotation is dropped and `_total` is added. So:

```promql
# coverage of LCP: "41 of 50"
sum(increase(webvitals_lcp_milliseconds_count[$__range])) / sum(increase(webvitals_navigations_total[$__range]))
# share good (LCP ≤ 2500 ms), pooled over Engines and Workers
sum by (bzm_route) (rate(webvitals_lcp_milliseconds_bucket{le="2500"}[5m]))
  / sum by (bzm_route) (rate(webvitals_lcp_milliseconds_count[5m]))
```

**Status mapping.** A vital whose `status !== 'ok'`, or whose value is not finite, records **nothing**. It is never a 0, which is the same rule as both existing sinks. It still counts in `webvitals.navigations`, which is what makes coverage honest.

**Gauge mode** (`webvitals.<vital>.sample`) writes one `NumberDataPoint` per ok vital per Sample with `asDouble`. Its `timeUnixNano` comes from the C5 function `timestampNs(Sample.ts, engineIndex, workerIndex)`, which should move from influx-destination.ts to shared.ts. Prometheus truncates the timestamp to ms, and the sub-ms offset is harmless there. Through a collector into Influx it keeps C5's no-overwrite guarantee. The `.sample` suffix keeps the gauge name distinct from the histogram name in `both` mode, so the same name is never two types.

## 3. Attribute mapping

Placement matters per backend:
- **Grafana Cloud** keeps only `service.namespace/service.name` (as `job`), `service.instance.id` (as `instance`) and a fixed promotion list as series labels. Every other resource attribute lands on `target_info`.
- **Prometheus** promotes **no** resource attributes by default (`promote_resource_attributes`).
- **The OTel Collector's InfluxDB exporter** turns resource, scope and data-point attributes **all** into tags (`ResourceToTags`, `InstrumentationScopeToTags`).

So anything people slice by must be a **data-point attribute**. The Resource holds only producer identity.

### 3.1 Resource (one per Worker process)

| Attribute | Value | Why |
|---|---|---|
| `service.name` | `bzm-playwright-vitals` (override `BZM_OTLP_SERVICE_NAME`) | Required by Grafana Cloud. It becomes `job`. It names the *producer*. The site under test is described by `bzm.route` and the test identity. |
| `service.version` | the collector package version | Promoted by Grafana Cloud, so a collector upgrade is visible. |
| `service.instance.id` | `<SESSION_ID>/w<workerIndex>`; locally `local-<8 hex from crypto.randomUUID()>/w<workerIndex>` | It must be unique per producer. A cumulative series needs **one writer**. Playwright gives a restarted worker a **new** `workerIndex` (`parallelIndex` is what gets reused), so a series never resets mid-life. In Prometheus and Grafana it becomes `instance`, which is conventionally aggregated away. That is how Worker stays *present but never a dimension* (CONTEXT.md, "Worker"). |
| `bzm.session.id` | `SESSION_ID` (Engine identity), when set | Lets you join to BlazeMeter. Per-run, so on `target_info` (Grafana) / a tag (Influx), not a slicing label. |
| `bzm.master.id` | `BLAZEMETER_MASTER_ID`, when set, as a **string** | Report identity. A string, to avoid the int64-as-string quirk on an ID. Like Influx, it does **not** call `GET /sessions` to discover it. |

The Worker index is taken from `sample.test.worker`. `send()` groups a batch by worker into one `ResourceMetrics` each (in practice exactly one).

### 3.2 Scope

`{ "name": "bzm-playwright-vitals", "version": "<collector version>" }`. Leave `schemaUrl` out, because the `bzm.*` names belong to no semconv.

### 3.3 Data-point attributes (the dimensions)

| Attribute | Source | Notes |
|---|---|---|
| `bzm.location` | `resolveIdentity(env).location` (`BZM_VITALS_LOCATION`, else `loc-<TAURUS_LOCATIONS_INDEX>`) | The same tier as the other sinks. `cloud.region` was considered and rejected: a BlazeMeter location may be a private location, not a cloud region. |
| `bzm.engine` | `resolveEngine(env)` (`#N` or `BZM_VITALS_ENGINE`), **only** when `BZM_VITALS_PER_ENGINE` is on | By default Engines differ only by `instance`, so they pool, which matches the aggregate-per-location default of the other sinks. |
| `bzm.route` | `routeOf(sample)` (shared.ts) | Semconv `url.template` was considered and rejected: a declared Route may be a free-form label, not a path template. |
| `bzm.test.project` / `bzm.test.file` / `bzm.test.title` | `sample.test` | Test identity as defined in CONTEXT.md (file + title + project). Once B2/C1 land, add `bzm.test.id` (Playwright `testId`) and switch `file` to the B2 `path` (to avoid basename collisions). |
| **not** `repeat` | | A Sample discriminator, not a correlation key. It is pooled over and would split series. |
| **not** `navigationIndex`, `url` | | Unbounded cardinality. The raw URL stays in the on-disk Sample (CONTEXT.md, "URL"). |
| **not** worker | | It is already inside `service.instance.id`. A separate label would invite grouping by it. |

Strings must be valid UTF-8 ("Encoders SHOULD ensure string fields contain valid UTF-8"). Pass titles and routes through `String.prototype.toWellFormed()` (Node ≥ 20), or a lone-surrogate replace on older Node. Newlines are legal in JSON strings. The C5 newline folding is a line-protocol constraint and is not needed here.

**Cardinality** per Worker is about routes × tests × vitals. With histograms, each Prometheus series is multiplied by the bucket count plus 3 (`_bucket` × (n+1), `_sum`, `_count`). The total then scales with Engines × Workers through `instance`. See §9 Q3.

## 4. OTLP/HTTP JSON encoding: the quirks that matter

The source is the OTLP specification 1.11.1 (sections "JSON Protobuf Encoding" and "OTLP/HTTP"), plus `metrics.proto`.

| Rule | Consequence here |
|---|---|
| Keys are the proto field names in **lowerCamelCase**: `resourceMetrics`, `scopeMetrics`, `dataPoints`, `timeUnixNano`, `startTimeUnixNano`, `explicitBounds`, `bucketCounts`, `aggregationTemporality`, `isMonotonic`, `asDouble`, `asInt`, `stringValue`. snake_case keys are invalid. | Hand-written object literals use these keys. |
| **64-bit integers are decimal strings** (decoders accept numbers too, but encoders emit strings). This covers `fixed64` (`timeUnixNano`, `startTimeUnixNano`, `count`, `bucketCounts[]`), `sfixed64` (`asInt`) and `AnyValue.intValue`. | ns epochs (~1.79e18) exceed `Number.MAX_SAFE_INTEGER`. Build them with `BigInt` and `.toString()`. `JSON.stringify` throws on a BigInt, so convert before stringifying. `count: "1"`, not `1`. |
| **Enums are integers**. Enum *names* MUST NOT be used. | `aggregationTemporality: 2` (CUMULATIVE). `1` is DELTA, and `0` (UNSPECIFIED) MUST NOT be sent. |
| `traceId` / `spanId` are **hex strings**, not base64. Other `bytes` fields (such as `AnyValue.bytesValue`) follow the proto3 JSON mapping, which is **base64**. | We send no exemplars and no bytes. If exemplars are added later (§9 Q6), use lowercase hex IDs. |
| A `oneof` member must be present even when its value is the default. | Always write `"asDouble": 0` for CLS 0. If you leave it out, the point has *no value*: the OTel Collector's Influx exporter `continue`s past `NumberDataPointValueTypeEmpty`. Likewise, always write `sum` when `count > 0`, even if it is 0. |
| `double` must be finite. JSON has no NaN or Infinity, and proto3 JSON would need the strings `"NaN"`/`"Infinity"`. | Only finite ok values are recorded, so this never arises. Assert it in the encoder anyway. |
| Receivers MUST ignore unknown fields. Default and empty fields may be left out. | Leave out `flags`, `exemplars`, `schemaUrl`, `description` and `metadata`. Gauges have no `startTimeUnixNano` (receivers ignore it). |
| Histogram invariants: `bucketCounts.length == explicitBounds.length + 1`, the counts sum to `count`, and the bounds strictly increase. `min`/`max` cover `(start, time]`. | These are unit-test properties. For cumulative, `min`/`max` are over the series life. |
| Timestamps are Unix epoch **nanoseconds**. `timeUnixNano` is required. | Histogram/Sum: `timeUnixNano` = encode time, and `startTimeUnixNano` = the Worker's push start (one value for all its series). Gauge mode: C5 `timestampNs(Sample.ts, …)`. |

**Transport.**
- `POST {endpoint}` with `Content-Type: application/json`, **exactly that string, with no `; charset=utf-8`**. Prometheus' `DecodeOTLPWriteRequest` switches on the exact header value and rejects anything else with "unsupported content type".
- Optional `Content-Encoding: gzip` (every OTLP server MUST accept gzip and identity).
- `User-Agent: bzm-playwright-vitals/<version>` (exporters SHOULD identify themselves).
- Grafana says JSON is fine "ideally only for low-traffic" use. One Worker sends a few KB every 10 s (the example below is 3.6 KB minified), which is low traffic by any measure.

## 5. Temporality per backend

The recommended shape uses **cumulative** histograms and Sum, plus gauges (which have no temporality).

| Backend | Gauge | Cumulative histogram / Sum | Delta histogram / Sum |
|---|---|---|---|
| **Grafana Cloud, native OTLP** (`https://otlp-gateway-<region>.grafana.net/otlp` + `/v1/metrics`, Mimir behind it) | Yes, a gauge series per `instance` | **Yes, native** (the Prometheus model). Explicit buckets become classic `_bucket` series. Exponential histograms become native histograms. | Not documented on Grafana's OTLP format page. Grafana's own guidance is that Mimir and Prometheus use cumulative, and their Alloy examples convert delta to cumulative first. **Do not send delta.** |
| **OTel Collector → InfluxDB** (`influxdb` exporter, contrib, beta; default schema `telegraf-prometheus-v1`) | Measurement = metric name, field `gauge`, tags = resource + scope + point attributes | A monotonic cumulative Sum becomes field `counter`. A histogram becomes bucket fields plus `sum`/`count` on one point per flush. Influx queries need `difference()`/`derivative()`. | A delta Sum is written through `enqueueGaugeFromSum` (field `gauge`, values per interval). The histogram path does not branch on temporality, so the meaning is up to the query. The collector's `deltatocumulative` / `cumulativetodelta` processors can convert either way. |
| **Prometheus via OTLP** (`--web.enable-otlp-receiver`, `/api/v1/otlp/v1/metrics`) | Yes. Each Worker series has one writer. Set `out_of_order_time_window` (the docs suggest 30m) if C6 popups interleave pages. | **Yes, native.** | Only behind `--enable-feature=otlp-deltatocumulative` (experimental, in-memory state that is lost on restart) or `otlp-native-delta-ingestion` ("very early stage", ignores `StartTimeUnixNano`). |

**Cumulative mechanics in a Worker.**
- `OtlpDestination` keeps a `Map<seriesKey, HistState>` per vital, plus a navigations counter per attribute set.
- Each `send()` records the batch, then exports **every series seen so far** with its running totals. That set is bounded by routes × tests for one Worker's lifetime.
- `startTimeUnixNano` is fixed at the Worker's push start. Because the instance ID is unique per worker process, a series never resets, and a reset would mean a new series anyway.

**The first-increment problem.** `rate()`/`increase()` cannot see the jump from an implicit 0 to a new series' first value. With short per-Worker series, that loss is material. Mitigation: on a series' **first** export, emit two points in the same data-point list. The first is all zeros at `timeUnixNano = startTimeUnixNano`, and the second carries the real totals. Prometheus also offers start-timestamp zero injection behind a feature flag. Not relying on it keeps the design backend-neutral. This needs verification (ticket AC).

**Why not delta?** Delta is simpler per Worker (reset each flush), and deltas from many writers can be merged. But two of the three named backends need an experimental flag or a conversion hop for delta. Cumulative also gives the "failed sends are recovered by the next export" property. It does mean Push Status `failed` overstates loss for this destination (§7).

## 6. Example: one Sample, as one request

This is the Sample (Engine `r-v4-6789abcd`, `TAURUS_SESSIONS_INDEX=1`, `BZM_VITALS_LOCATION=us-west-1`, `BLAZEMETER_MASTER_ID=12345678`, per-Engine off):

```json
{ "schemaVersion": 1, "ts": 1794052800123, "url": "https://shop.example.com/order/12345?ref=mail",
  "route": "/order/{id}", "navigationIndex": 1,
  "test": { "file": "checkout.spec.ts", "title": "pays by card", "project": "chromium", "repeat": 0, "worker": 2 },
  "vitals": { "ttfb": {"value": 182.4, "status": "ok"}, "fcp": {"value": 640.1, "status": "ok"},
              "lcp": {"value": 1234.5, "status": "ok"}, "cls": {"value": 0.0812, "status": "ok"},
              "inp": {"value": null, "status": "no-interaction"} } }
```

Suppose it is the Worker's first Sample: its push started at `2026-11-07T11:59:55.000Z`, and it is flushed at `12:00:10.000Z`. The default (histogram) body for `POST …/v1/metrics` is below. `inp` is absent because it was not ok. The navigations counter still counts the Sample. For brevity this omits the zero-point-on-birth duplicates from §5. The body was produced by the sketch in §10 and checked as valid JSON:

```json
{
  "resourceMetrics": [
    {
      "resource": {
        "attributes": [
          {"key": "service.name", "value": {"stringValue": "bzm-playwright-vitals"}},
          {"key": "service.version", "value": {"stringValue": "0.3.0"}},
          {"key": "service.instance.id", "value": {"stringValue": "r-v4-6789abcd/w2"}},
          {"key": "bzm.session.id", "value": {"stringValue": "r-v4-6789abcd"}},
          {"key": "bzm.master.id", "value": {"stringValue": "12345678"}}
        ]
      },
      "scopeMetrics": [
        {
          "scope": {"name": "bzm-playwright-vitals", "version": "0.3.0"},
          "metrics": [
            {
              "name": "webvitals.ttfb",
              "unit": "ms",
              "histogram": {
                "aggregationTemporality": 2,
                "dataPoints": [
                  {
                    "attributes": [
                      {"key": "bzm.location", "value": {"stringValue": "us-west-1"}},
                      {"key": "bzm.route", "value": {"stringValue": "/order/{id}"}},
                      {"key": "bzm.test.file", "value": {"stringValue": "checkout.spec.ts"}},
                      {"key": "bzm.test.title", "value": {"stringValue": "pays by card"}},
                      {"key": "bzm.test.project", "value": {"stringValue": "chromium"}}
                    ],
                    "startTimeUnixNano": "1794052795000000000",
                    "timeUnixNano": "1794052810000000000",
                    "count": "1",
                    "sum": 182.4,
                    "bucketCounts": ["0", "1", "0", "0", "0", "0", "0", "0", "0"],
                    "explicitBounds": [100, 200, 400, 800, 1200, 1800, 3000, 5000],
                    "min": 182.4,
                    "max": 182.4
                  }
                ]
              }
            },
            {
              "name": "webvitals.fcp",
              "unit": "ms",
              "histogram": {
                "aggregationTemporality": 2,
                "dataPoints": [
                  {
                    "attributes": [
                      {"key": "bzm.location", "value": {"stringValue": "us-west-1"}},
                      {"key": "bzm.route", "value": {"stringValue": "/order/{id}"}},
                      {"key": "bzm.test.file", "value": {"stringValue": "checkout.spec.ts"}},
                      {"key": "bzm.test.title", "value": {"stringValue": "pays by card"}},
                      {"key": "bzm.test.project", "value": {"stringValue": "chromium"}}
                    ],
                    "startTimeUnixNano": "1794052795000000000",
                    "timeUnixNano": "1794052810000000000",
                    "count": "1",
                    "sum": 640.1,
                    "bucketCounts": ["0", "1", "0", "0", "0", "0", "0", "0", "0"],
                    "explicitBounds": [500, 1000, 1500, 1800, 2400, 3000, 4000, 6000],
                    "min": 640.1,
                    "max": 640.1
                  }
                ]
              }
            },
            {
              "name": "webvitals.lcp",
              "unit": "ms",
              "histogram": {
                "aggregationTemporality": 2,
                "dataPoints": [
                  {
                    "attributes": [
                      {"key": "bzm.location", "value": {"stringValue": "us-west-1"}},
                      {"key": "bzm.route", "value": {"stringValue": "/order/{id}"}},
                      {"key": "bzm.test.file", "value": {"stringValue": "checkout.spec.ts"}},
                      {"key": "bzm.test.title", "value": {"stringValue": "pays by card"}},
                      {"key": "bzm.test.project", "value": {"stringValue": "chromium"}}
                    ],
                    "startTimeUnixNano": "1794052795000000000",
                    "timeUnixNano": "1794052810000000000",
                    "count": "1",
                    "sum": 1234.5,
                    "bucketCounts": ["0", "0", "1", "0", "0", "0", "0", "0", "0", "0"],
                    "explicitBounds": [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000],
                    "min": 1234.5,
                    "max": 1234.5
                  }
                ]
              }
            },
            {
              "name": "webvitals.cls",
              "unit": "1",
              "histogram": {
                "aggregationTemporality": 2,
                "dataPoints": [
                  {
                    "attributes": [
                      {"key": "bzm.location", "value": {"stringValue": "us-west-1"}},
                      {"key": "bzm.route", "value": {"stringValue": "/order/{id}"}},
                      {"key": "bzm.test.file", "value": {"stringValue": "checkout.spec.ts"}},
                      {"key": "bzm.test.title", "value": {"stringValue": "pays by card"}},
                      {"key": "bzm.test.project", "value": {"stringValue": "chromium"}}
                    ],
                    "startTimeUnixNano": "1794052795000000000",
                    "timeUnixNano": "1794052810000000000",
                    "count": "1",
                    "sum": 0.0812,
                    "bucketCounts": ["0", "0", "1", "0", "0", "0", "0", "0"],
                    "explicitBounds": [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
                    "min": 0.0812,
                    "max": 0.0812
                  }
                ]
              }
            },
            {
              "name": "webvitals.navigations",
              "unit": "{navigation}",
              "sum": {
                "aggregationTemporality": 2,
                "isMonotonic": true,
                "dataPoints": [
                  {
                    "attributes": [
                      {"key": "bzm.location", "value": {"stringValue": "us-west-1"}},
                      {"key": "bzm.route", "value": {"stringValue": "/order/{id}"}},
                      {"key": "bzm.test.file", "value": {"stringValue": "checkout.spec.ts"}},
                      {"key": "bzm.test.title", "value": {"stringValue": "pays by card"}},
                      {"key": "bzm.test.project", "value": {"stringValue": "chromium"}}
                    ],
                    "startTimeUnixNano": "1794052795000000000",
                    "timeUnixNano": "1794052810000000000",
                    "asInt": "1"
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

In **gauge mode** the LCP of the same Sample is one point at the Navigation's time. `1794052800123` ms × 1e6 + (engineIndex 1 × 1000 + worker 2) gives `…123001002`:

```json
{
  "name": "webvitals.lcp.sample",
  "unit": "ms",
  "gauge": {
    "dataPoints": [
      {
        "attributes": [ "…the same five data-point attributes…" ],
        "timeUnixNano": "1794052800123001002",
        "asDouble": 1234.5
      }
    ]
  }
}
```

## 7. Config, auth, endpoints, retry and Push Status

### 7.1 Environment variables

All of these are named vars, read with `?.trim()` like the existing sinks. `process.env` is never serialized (X5).

| Var | Default | Purpose |
|---|---|---|
| `BZM_OTLP_ENDPOINT` | — | **Base** URL. `v1/metrics` is appended *relative to the base path*, as the OTel exporter spec does for `OTEL_EXPORTER_OTLP_ENDPOINT`. Examples: `https://otlp-gateway-prod-us-east-0.grafana.net/otlp` → `…/otlp/v1/metrics`; `http://collector:4318` → `…:4318/v1/metrics`; `http://prometheus:9090/api/v1/otlp` → `…/api/v1/otlp/v1/metrics`. The destination is enabled when this or the next var is set. |
| `BZM_OTLP_METRICS_ENDPOINT` | — | The full URL, **used verbatim**, as with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. It wins over the base var. |
| `BZM_OTLP_TOKEN` | — | The credential. Alternatively, `BZM_OTLP_TOKEN_ENV` names *another* var that holds it, or use the BlazeMeter managed secret `otlptoken` → `BZM_SECRET_otlptoken`. This mirrors `resolveInfluxToken`. |
| `BZM_OTLP_USERNAME` | — | When set, auth becomes `Authorization: Basic base64(<username>:<token>)`. For Grafana Cloud the username is the stack's OTLP **instance ID** (not a secret) and the token is a Cloud Access Policy token with metrics write. |
| `BZM_OTLP_AUTH_HEADER` | — | A header **name** for vendors that put the key in a custom header (e.g. `x-honeycomb-team`, `api-key`). It is sent as `<name>: <token>`. Validate it as an RFC 9110 token, and refuse `Content-Type`/`Content-Encoding`/`Host`. |
| (neither of the above) | | With a token: `Authorization: Bearer <token>`. Without a token: no auth header (a local collector). |
| `BZM_OTLP_METRIC_SHAPE` | `histogram` | `histogram` \| `gauge` \| `both` (§2.3). |
| `BZM_OTLP_SERVICE_NAME` | `bzm-playwright-vitals` | `service.name`. |
| `BZM_OTLP_COMPRESSION` | `none` | `gzip` uses `node:zlib`'s `gzipSync` (built-in, not a dependency). |
| Shared | | `BZM_VITALS_PUSH` (kill switch), `BZM_VITALS_FLUSH_MS`, `BZM_VITALS_LOCATION`, `BZM_VITALS_PER_ENGINE`, `BZM_VITALS_ENGINE`, `SESSION_ID`, `TAURUS_SESSIONS_INDEX`, `TAURUS_LOCATIONS_INDEX`, `BLAZEMETER_MASTER_ID`, all through `resolveIdentity()` and friends in shared.ts. |

**Deliberately not read: `OTEL_EXPORTER_OTLP_*` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`.**
1. `OTEL_EXPORTER_OTLP_HEADERS` is a free-form `k=v,…` list that usually *contains* a credential. Reading it means handling a credential whose shape we cannot classify or redact by name, which breaks X5's spirit.
2. Those vars are often already set for the *application's* own OTel SDK, or for Playwright tooling, in the same environment. Turning on a vitals push just because they exist would be a surprise, and could send vitals to a backend the tester never chose.

An explicit opt-in (`BZM_OTLP_FROM_OTEL_ENV=1`) is a possible later addition (§9 Q7).

**Plain HTTP.** If a token is set and the endpoint is `http:` to a non-loopback host, warn once (`[bzm-vitals] otlp: sending credentials over plain http to <host>`) but still send, because a collector inside a private network is a legitimate setup (§9 Q8).

### 7.2 Response handling and retry

This follows the OTLP/HTTP spec. All of it goes through `sendWithRetry` from pusher.ts, with the same injectable `Clock`, an 8 s per-request timeout, and the drain `AbortSignal`. The transport wrapper is the one `InfluxDestination.writeOnce` already has.

| Response | Action |
|---|---|
| 2xx, empty body or no `partialSuccess` | Success. Read and discard the body so the socket is released. |
| 2xx with `partialSuccess.rejectedDataPoints > 0` (an int64, so it may arrive as a **string**) | **Do not retry** (spec: "MUST NOT retry"). The batch counts as sent. Record `lastError = "partial success on POST /v1/metrics: <n> data points rejected: <errorMessage>"` and warn once per distinct reason. This needs a small additive change: `send()` may return `{ warning?: string }`, which the Pusher records without changing tallies. That touches pusher.ts (C4's file), so it is listed under Touches. |
| 429, 502, 503, 504 | Retryable `PushError`. Honour `Retry-After` through `parseRetryAfter`. |
| Every other 4xx/5xx, **including 500** | **Not retryable** ("All other 4xx or 5xx response status codes MUST NOT be retried"). This is stricter than the shared `isRetryableStatus` (429 or any 5xx), so the destination needs its own predicate, `isOtlpRetryableStatus`. |
| Network error / timeout | Retryable, as in the existing sinks. |

The failure body is a `google.rpc.Status`. Parse it only when the response `Content-Type` is `application/json`, take `message`, and truncate it to 200 characters. A protobuf body is never decoded or echoed. `PushError` messages are built from the status, the request **path** (never the host's query string or a header) and that message, for example `401 on POST /otlp/v1/metrics (check BZM_OTLP_TOKEN / BZM_OTLP_USERNAME)` or `404 on POST /v1/metrics (check BZM_OTLP_ENDPOINT; v1/metrics is appended)`.

### 7.3 Push Status semantics

The destination name is `otlp`. `sent`, `failed` and `dropped` are counted in Samples, as for every sink. Cumulative state has one subtlety: a batch whose export finally fails is counted `failed`, but its observations **ride the next successful export**. So for `otlp`, `failed` means "exports that failed", and data is lost only if no later export succeeds (for example, the final drain). Document this in the README. Leave the record shape unchanged. An extra field is §9 Q9.

## 8. Should OTLP replace the bespoke Influx destination?

**Recommendation: not now.** Keep both. Revisit at a named checkpoint.

| | Bespoke Influx destination | OTLP → Collector → Influx |
|---|---|---|
| Hops / infra | Direct to InfluxDB (Cloud or self-hosted). Works from a BlazeMeter Engine with a token. | Needs a reachable OTel Collector (contrib build) that someone runs and secures, because an Engine cannot run one as a sidecar. |
| Schema | One **wide** point per Sample (`web_vitals`, fields `ttfb…inp`, tags `route location project title worker [engine]`) at `Sample.ts`, exact values. | Measurement per metric name, field `gauge` / `counter` / bucket fields, and **every** resource attribute as a tag. Existing Flux/SQL dashboards break. |
| Fit of the recommended histogram shape | n/a | Poor. Cumulative bucket fields need `difference()`, so gauge mode is the sensible choice for Influx, which is what the bespoke sink already does natively. |
| Code | ~300 lines plus `InfluxWriter`, which the planned KPI pull-export also uses (influx-writer.ts header). | The writer remains needed for the KPI feed regardless. |

So replacing it would not delete the writer, would add an infrastructure hop for current Influx users, and would change their schema. The benefit is one generic exporter instead of N vendor sinks, which the OTLP destination already delivers **for new backends** without retiring Influx.

**Migration path, if usage justifies it later:**
1. **0.3.x/0.4:** ship `otlp` alongside `influxdb`. Add a README recipe "InfluxDB through an OTel Collector" (gauge mode, `metrics_schema: telegraf-prometheus-v2` or `v1`) with a mapping table from the old tags and fields to the new ones.
2. **Checkpoint (next minor after OTLP ships):** decide to deprecate *only if* (a) InfluxDB offers native OTLP ingestion that accepts these payloads directly (none found for 3.x at the time of writing, §9 Q10), **and** (b) issue and usage feedback shows Influx users are content with the OTLP schema.
3. **Deprecation minor:** `BZM_INFLUX_*` keeps working and prints one `[bzm-vitals] influxdb: deprecated; see …` stderr line per worker, and the README shows the equivalent `BZM_OTLP_*` config.
4. **Next major:** remove `InfluxDestination` and keep `InfluxWriter` if the KPI feed still uses it.

## 9. Open questions

1. **Out-of-order on Grafana Cloud.** Is an out-of-order window enabled by default on Grafana Cloud metrics? It matters for gauge mode once C6 lets popups interleave Navigations in one Worker. Histogram mode is unaffected, because export time only increases. Mitigation either way: sort each batch by `ts` per series before encoding.
2. **Zero point on series birth.** Confirm against Grafana Cloud and Prometheus that two points for one series in one request (a zero at `startTimeUnixNano`, then the totals) are accepted and that `increase()` then counts the first observation. If not, fall back to Prometheus start-timestamp zero injection where available, and document the loss.
3. **Series cost on Grafana Cloud.** Classic buckets multiply active series (≈ (buckets + 3) × routes × tests × vitals × Engines × Workers). Options: an exponential-histogram mode (one native-histogram series each, priced differently), or `BZM_OTLP_DROP_ATTRIBUTES=bzm.test.title,bzm.test.file` to keep only route and location. The owner should choose the default.
4. **CLS unit.** `1` is honest UCUM, but gauge-mode CLS then gets Grafana's `_ratio` suffix. An annotation unit such as `{score}` would avoid the suffix (the translator drops `{…}`), but it is non-standard for a dimensionless value. Check the translator's behaviour before choosing.
5. **Open vital set.** `Sample.vitals` names are open. Should an unknown name get a generic exponential histogram, gauge-only treatment, or be ignored?
6. **Exemplars.** Should a histogram point carry one exemplar per Sample (`filteredAttributes` with `url` and `navigationIndex`, `timeUnixNano = Sample.ts`)? That would restore drill-down in Grafana without cardinality cost. It adds payload, and Influx through a collector writes exemplars as extra points.
7. **`OTEL_*` interop.** Should there be an explicit opt-in to read `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`, and if so, how is the credential-leak scan extended to cover an unclassified header list?
8. **Plain HTTP with a token.** Warn (proposed), or refuse unless `BZM_OTLP_ALLOW_INSECURE=1`?
9. **Push Status for cumulative sinks.** Add an optional `note`/`recoveredBySubsequentExport` field, or only document the semantics (proposed)?
10. **InfluxDB native OTLP.** This spike found no first-party OTLP ingestion endpoint for InfluxDB 3 (searches turned up only third-party products' OTLP endpoints). Re-check at the §8 checkpoint.
11. **Protobuf later?** Grafana recommends binary protobuf for bulk data. The volume here is small, and a hand-written protobuf encoder (varints, fixed64, length-delimited fields) is about 150 lines with zero dependencies. Defer it unless a backend rejects JSON.
12. **`service.name`.** Should the producer be the name (`bzm-playwright-vitals`, proposed), or the system under test (for example, a tester-supplied app name)? This affects Grafana's `job` label and Application Observability views.

## 10. Encoder sketch (illustrative, not production code)

This is about 60 lines, with zero dependencies. The body in §6 was produced by an equivalent script.

```ts
import type { Sample } from 'bzm-vitals-format';
import { routeOf } from './shared.js';

type KV = { key: string; value: { stringValue: string } };
const kv = (key: string, v: string): KV => ({ key, value: { stringValue: v.toWellFormed() } });
/** Epoch ms → OTLP fixed64 ns, as the decimal STRING the JSON encoding requires. */
const nsString = (ms: number): string => (BigInt(Math.floor(ms)) * 1_000_000n).toString();

const BOUNDS: Record<string, number[]> = {
  ttfb: [100, 200, 400, 800, 1200, 1800, 3000, 5000],
  fcp: [500, 1000, 1500, 1800, 2400, 3000, 4000, 6000],
  lcp: [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000],
  inp: [50, 100, 150, 200, 300, 500, 1000, 2000],
  cls: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
};

class CumulativeHistogram {
  readonly counts: number[];
  count = 0; sum = 0; min = Infinity; max = -Infinity;
  constructor(readonly bounds: number[]) { this.counts = new Array(bounds.length + 1).fill(0); }
  record(v: number): void {
    let i = 0;
    while (i < this.bounds.length && v > this.bounds[i]!) i++; // upper-inclusive (b[i-1], b[i]]
    this.counts[i]!++; this.count++; this.sum += v;
    this.min = Math.min(this.min, v); this.max = Math.max(this.max, v);
  }
  point(attributes: KV[], startNs: string, nowNs: string) {
    return {
      attributes, startTimeUnixNano: startNs, timeUnixNano: nowNs,
      count: String(this.count),            // fixed64 → string
      sum: this.sum,                        // double → JSON number (always present when count > 0)
      bucketCounts: this.counts.map(String), // repeated fixed64 → strings
      explicitBounds: this.bounds, min: this.min, max: this.max,
    };
  }
}

/** One series per (vital, attribute set); the state lives for the Worker's life (cumulative). */
const series = new Map<string, { name: string; attrs: KV[]; h: CumulativeHistogram }>();

export function record(sample: Sample, dims: { location: string; engine: string | null }): void {
  const attrs = [
    kv('bzm.location', dims.location), ...(dims.engine !== null ? [kv('bzm.engine', dims.engine)] : []),
    kv('bzm.route', routeOf(sample)), kv('bzm.test.file', sample.test.file),
    kv('bzm.test.title', sample.test.title), kv('bzm.test.project', sample.test.project),
  ];
  for (const [name, m] of Object.entries(sample.vitals)) {
    const bounds = BOUNDS[name];
    if (!bounds || m.status !== 'ok' || typeof m.value !== 'number' || !Number.isFinite(m.value)) continue;
    const key = JSON.stringify([name, attrs]);
    let s = series.get(key);
    if (!s) series.set(key, (s = { name, attrs, h: new CumulativeHistogram(bounds) }));
    s.h.record(m.value);
  }
  // (+ the webvitals.navigations counter, keyed by attrs alone — omitted here)
}

export function encode(resource: KV[], version: string, startNs: string, nowMs: number): string {
  const nowNs = nsString(nowMs);
  const metrics = [...series.values()].map((s) => ({
    name: `webvitals.${s.name}`,
    unit: s.name === 'cls' ? '1' : 'ms',
    histogram: { aggregationTemporality: 2 /* CUMULATIVE: an enum is an int, never its name */,
                 dataPoints: [s.h.point(s.attrs, startNs, nowNs)] },
  }));
  return JSON.stringify({ resourceMetrics: [{ resource: { attributes: resource },
    scopeMetrics: [{ scope: { name: 'bzm-playwright-vitals', version }, metrics }] }] });
}
```

The production version groups points of the same vital under one `Metric`, which is the OTLP convention. The sketch emits one `Metric` per series, which is valid but more verbose. The production version also emits the zero point on series birth (§5) and groups by worker into Resources.

## 11. Proposed follow-up ticket

#### C8. OTLP/HTTP JSON metrics destination
**What to build:** `OtlpDestination` in `packages/collector/src/otlp-destination.ts`, following this design (§2 to §7). It has pure, unit-tested mapping and encoding (`samplesToExport`, histogram state, `nsString`), env readers (`resolveOtlpConfig`, `resolveOtlpToken`) and the class, which delegates I/O to an injectable fetch like `InfluxDestination`. Register it in `destinations.ts`. Move `timestampNs` to `shared.ts`.
**Owns:** `packages/collector/src/otlp-destination.ts`; `packages/collector/test/{otlp-mapping,otlp-destination,otlp-integration}.test.ts`; `packages/collector/test/helpers/otlp-server.ts` (a fake receiver that also enforces the encoding rules).
**Touches:** `destinations.ts` (one entry); `shared.ts` (receives `timestampNs`); `influx-destination.ts` (imports it from shared); `pusher.ts` (the additive optional `send()` return `{ warning? }` for partial success); the README section "Live push over OTLP (optional)"; `push.test.ts` (the leak scan covers `BZM_OTLP_TOKEN` and the Basic header).
**Acceptance criteria**
- [ ] With only `BZM_OTLP_ENDPOINT=http://127.0.0.1:<port>` set, a Playwright run POSTs to `/v1/metrics` with `Content-Type: application/json` exactly. The body parses, and every int64 field (`timeUnixNano`, `startTimeUnixNano`, `count`, `bucketCounts[]`, `asInt`) is a decimal string. `aggregationTemporality` is the integer `2`.
- [ ] For each histogram point: `bucketCounts.length === explicitBounds.length + 1`, the bucket counts sum to `count`, a value exactly on a threshold (LCP 2500, CLS 0.1) lands in the `≤` bucket, and a vital with `status !== 'ok'` adds nothing while `webvitals.navigations` still increments.
- [ ] CLS `0` is encoded with an explicit `sum: 0` (and `asDouble: 0` in gauge mode). A property test covers random Samples.
- [ ] Resource contains `service.name`, `service.version` and `service.instance.id = <SESSION_ID>/w<worker>`. No data-point attribute named `worker`, `repeat`, `url` or `navigationIndex` is ever emitted. `bzm.engine` appears only with `BZM_VITALS_PER_ENGINE=1`.
- [ ] Two flushes from one Worker export monotonically non-decreasing cumulative counts with an unchanged `startTimeUnixNano`. A failed export (fake 503 ×4) is followed by a successful one whose counts include the failed batch's observations.
- [ ] Retry: 503 then 200 delivers once (fake clock). A 500 and a 400 are **not** retried. A 429 with `Retry-After: 2` waits ≥ 2 s on the fake clock. Everything stays inside the 15 s drain.
- [ ] A 200 with `{"partialSuccess":{"rejectedDataPoints":"3","errorMessage":"x"}}` is not retried, counts as sent, and prints exactly one `[bzm-vitals] otlp: partial success…` stderr line. The Push Status `lastError` says so.
- [ ] Auth: `BZM_OTLP_USERNAME` + token → `Authorization: Basic <base64(u:t)>`. `BZM_OTLP_AUTH_HEADER=x-api-key` → `x-api-key: <t>`. A token alone → `Bearer`. `BZM_SECRET_otlptoken` and `BZM_OTLP_TOKEN_ENV` resolve. Setting `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS` alone does **not** enable the destination.
- [ ] The credential-leak scan proves the token appears in no Sample, Push Status, stderr line or attachment.
- [ ] Gauge mode: `webvitals.lcp.sample` points carry `timeUnixNano` = `timestampNs(Sample.ts, engineIndex, worker)`.
- [ ] Manual gate before merge (recorded in the PR): one live push each to Grafana Cloud OTLP, to `otelcol-contrib` → InfluxDB, and to Prometheus with `--web.enable-otlp-receiver`. Each shows the p75 query from §2.3 working, and the open questions §9 Q1 and Q2 get answered with evidence.
- [ ] `npm run build:standalone` still yields one collector file with no new runtime dependency (X1, X2).
**Blocked by:** F2 (this doc, accepted), C4 (merged). It should follow B2/C1 so that `bzm.test.id` ships from day one. **Size:** L (cross-cutting tests plus a live gate). **Labels:** `ready-for-agent` once §9 Q3 (the default attribute set and cost) is decided by the owner.

## 12. Sources

- OTLP Specification 1.11.1: OTLP/HTTP, JSON Protobuf Encoding, request/response, partial success, retryable codes, Retry-After, gzip, port 4318, `/v1/metrics`: https://opentelemetry.io/docs/specs/otlp/
- `metrics.proto` (Gauge, Sum, Histogram, NumberDataPoint, HistogramDataPoint, AggregationTemporality 0/1/2, start-time semantics): https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto
- OTLP exporter configuration (base vs signal-specific endpoint, headers, timeout, compression, User-Agent): https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- Grafana Cloud, send data with OTLP (gateway URL, `/otlp` + `/v1/metrics`, the OpenTelemetry tile for credentials): https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/
- Grafana Cloud, OTLP format considerations (`job`/`instance` mapping, `target_info`, promoted attributes, name translation, `_ratio` for unit `1` gauges, exponential to native histograms, "JSON … ideally only for low-traffic"): https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/
- Grafana blog, delta vs cumulative temporality trade-offs (Mimir/Prometheus use cumulative): https://grafana.com/blog/2023/09/26/opentelemetry-metrics-a-guide-to-delta-vs.-cumulative-temporality-trade-offs
- Alloy `otelcol.processor.deltatocumulative`: https://grafana.com/docs/grafana-cloud/send-data/alloy/reference/components/otelcol/otelcol.processor.deltatocumulative/
- Intro to sending OTLP metrics to Grafana (SPEC-HARDENING §10): https://grafana.com/docs/learning-hub/intro-to-send-data/01-send-metrics/08-opentelemetry-metrics/
- Prometheus, using Prometheus as an OpenTelemetry backend (`--web.enable-otlp-receiver`, `/api/v1/otlp/v1/metrics`, `promote_resource_attributes`, translation strategies, `out_of_order_time_window: 30m`): https://prometheus.io/docs/guides/opentelemetry/
- Prometheus feature flags (`otlp-deltatocumulative`, `otlp-native-delta-ingestion`): https://prometheus.io/docs/prometheus/latest/feature_flags/
- Prometheus `DecodeOTLPWriteRequest` (exact `application/json` match, gzip or no compression only): https://github.com/prometheus/prometheus/blob/main/storage/remote/codec.go
- OpenTelemetry Collector contrib, InfluxDB exporter (config, `telegraf-prometheus-v1/v2` schemas): https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/influxdbexporter
- `otel2influx` conversion (resource and scope attributes to tags; gauge, sum and histogram dispatch): https://github.com/influxdata/influxdb-observability/blob/main/otel2influx/metrics_telegraf_prometheus_v1.go and https://github.com/influxdata/influxdb-observability/blob/main/otel2influx/common.go
- Web Vitals thresholds (LCP 2.5/4 s, INP 200/500 ms, CLS 0.1/0.25, FCP 1.8/3 s, TTFB 0.8/1.8 s): https://web.dev/articles/vitals and https://web.dev/articles/ttfb
