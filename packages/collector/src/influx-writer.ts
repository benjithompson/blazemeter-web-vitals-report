// The InfluxDB 2.x line-protocol writer — the ONE piece both Influx feeds share (the live
// vitals push today; the BlazeMeter-KPI pull-export later). It is deliberately decoupled:
// it knows Points, line protocol, and `POST /api/v2/write`, and NOTHING about Playwright,
// Samples, or BlazeMeter. That is what lets it be lifted into its own package unchanged if
// the KPI feed ever grows its own life — so keep it that way: no import from this collector.
//
// Line protocol is version-agnostic across Influx 2.x and the 3.x /api/v2/write compat
// endpoint, so this writer targets both without a switch. Auth is `Authorization: Token`;
// the token appears ONLY in that header — never serialized, never logged, never in a Point.

/** Minimal response shape — the subset of the global fetch Response this uses. Named
 *  distinctly from the BlazeMeter sink's equivalent so the standalone bundler (which splices
 *  every src file into one module) sees no top-level name collision. */
interface InfluxFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The injectable transport. The default wraps the global fetch; tests pass a double. */
export type InfluxFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<InfluxFetchResponse>;

/** Everything needed to reach one bucket. All four are required for the writer to exist. */
export interface InfluxConfig {
  /** Base URL, e.g. https://us-east-1-1.aws.cloud2.influxdata.com (trailing slash trimmed). */
  url: string;
  org: string;
  bucket: string;
  token: string;
}

/**
 * One measurement observation. `tags` are the indexed dimensions (low cardinality!);
 * `fields` are the values (float64 here — we never round or scale). `timestamp` is in the
 * unit named by `precision` (ms for this project — Sample.ts is epoch-ms).
 */
export interface Point {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, number>;
  /** Integer timestamp in `precision` units. */
  timestamp: number;
}

/** Write precision. This project uses 'ms' (Sample.ts is epoch-ms); others exist for reuse. */
export type Precision = 'ns' | 'us' | 'ms' | 's';

const DEFAULT_TIMEOUT_MS = 8_000;

export interface InfluxWriterDeps {
  config: InfluxConfig;
  /** Write precision; default 'ms'. */
  precision?: Precision;
  /** Injected transport (tests); defaults to the global fetch. */
  fetch?: InfluxFetchLike;
  /** Per-request timeout override (tests). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Line protocol — PURE assembly + escaping (unit-tested without any I/O).
// ---------------------------------------------------------------------------

/** Escape a measurement name: commas and spaces are special (equals is NOT, in measurements). */
function escapeMeasurement(s: string): string {
  return s.replace(/[,\s]/g, (c) => '\\' + c);
}

/** Escape a tag key, a tag value, OR a field key — all three share the same rule in line
 *  protocol: commas, equals, and spaces are special. (Measurements and field values differ,
 *  and have their own handling.) */
function escapeKeyOrTagValue(s: string): string {
  return s.replace(/[,=\s]/g, (c) => '\\' + c);
}

/**
 * Format a float64 field value. All our fields are numeric (native ms + true-float CLS),
 * so no `i` integer suffix and no quoting — a bare decimal is a float in line protocol.
 * toString() avoids exponent notation across the vital ranges we emit; non-finite values
 * are dropped by the caller, never formatted here.
 */
function formatFieldValue(value: number): string {
  return value.toString();
}

/**
 * Render one Point as a line-protocol line, or null when it has no finite fields (a line
 * with an empty field set is invalid — the caller skips it rather than emit a broken line).
 * Tag keys are sorted for deterministic, testable output; empty tag values are dropped
 * (line protocol forbids them). Non-finite field values are dropped defensively.
 */
export function pointToLine(point: Point): string | null {
  const tagKeys = Object.keys(point.tags)
    .filter((k) => point.tags[k] !== undefined && point.tags[k] !== '')
    .sort();
  const tagSet = tagKeys
    .map((k) => `${escapeKeyOrTagValue(k)}=${escapeKeyOrTagValue(point.tags[k]!)}`)
    .join(',');

  const fieldSet = Object.keys(point.fields)
    .filter((k) => Number.isFinite(point.fields[k]))
    .map((k) => `${escapeKeyOrTagValue(k)}=${formatFieldValue(point.fields[k]!)}`)
    .join(',');
  if (fieldSet === '') return null;

  const key = tagSet === '' ? escapeMeasurement(point.measurement) : `${escapeMeasurement(point.measurement)},${tagSet}`;
  return `${key} ${fieldSet} ${point.timestamp}`;
}

/** Join a batch of Points into a line-protocol body, skipping any that render to null. */
export function pointsToLineProtocol(points: Point[]): string {
  return points
    .map(pointToLine)
    .filter((l): l is string => l !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The writer — the one place fetch is called.
// ---------------------------------------------------------------------------

export class InfluxWriter {
  private readonly config: InfluxConfig;
  private readonly precision: Precision;
  private readonly fetchImpl: InfluxFetchLike;
  private readonly timeoutMs: number;
  private readonly writeUrl: string;

  constructor(deps: InfluxWriterDeps) {
    this.config = { ...deps.config, url: deps.config.url.replace(/\/+$/, '') };
    this.precision = deps.precision ?? 'ms';
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<InfluxFetchResponse>);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const q = new URLSearchParams({
      org: this.config.org,
      bucket: this.config.bucket,
      precision: this.precision,
    });
    this.writeUrl = `${this.config.url}/api/v2/write?${q.toString()}`;
  }

  /**
   * Write a batch of Points. No-op when nothing renders (never POST an empty body).
   * Throws on transport failure or a non-2xx response (Influx returns 204 on success);
   * the pusher swallows and isolates the throw so one failed write never affects the run.
   * The token is materialised ONLY into the Authorization header here.
   */
  async write(points: Point[]): Promise<void> {
    const body = pointsToLineProtocol(points);
    if (body === '') return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await this.fetchImpl(this.writeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.config.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await safeText(res);
        throw new Error(`influx write → ${res.status}${detail ? `: ${detail}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read an error body without letting a text() failure mask the real status. */
async function safeText(res: InfluxFetchResponse): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
