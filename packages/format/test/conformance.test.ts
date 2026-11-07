// JSON-Schema conformance (B2). schema/sample.v1.json and schema/outcome.v1.json are
// published so other tools can consume format v1; validateSample / validateOutcome are
// what this repo's own reader runs. They must never disagree. Every fixture in
// packages/*/test/fixtures, every hand-written invalid case and every hand-written valid
// variant goes through BOTH, and the verdicts must match. ajv is a devDependency only:
// the format package itself stays dependency-free.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020';
import {
  EXECUTION_STATUSES,
  METRIC_STATUSES,
  validateOutcome,
  validateSample,
} from '../src/index';

const FORMAT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(FORMAT_DIR, '..');

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const sampleSchema = (await readJson(join(FORMAT_DIR, 'schema', 'sample.v1.json'))) as Json;
const outcomeSchema = (await readJson(join(FORMAT_DIR, 'schema', 'outcome.v1.json'))) as Json;

// strict: an unknown keyword or a schema mistake throws at compile time, not silently passes.
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
const schemaSample = ajv.compile(sampleSchema);
const schemaOutcome = ajv.compile(outcomeSchema);

/** Both verdicts for one candidate record. */
function verdicts(kind: 'sample' | 'outcome', record: unknown) {
  const v = kind === 'sample' ? validateSample(record) : validateOutcome(record);
  const s = kind === 'sample' ? schemaSample(record) : schemaOutcome(record);
  const errors = kind === 'sample' ? schemaSample.errors : schemaOutcome.errors;
  return {
    validator: v.ok,
    reason: v.ok ? null : v.reason,
    schema: s,
    schemaErrors: ajv.errorsText(errors),
  };
}

function expectAgree(kind: 'sample' | 'outcome', record: unknown, expected: boolean, label: string) {
  const r = verdicts(kind, record);
  expect(r.validator, `${label} — validator (${r.reason ?? 'valid'})`).toBe(expected);
  expect(r.schema, `${label} — JSON Schema (${r.schemaErrors})`).toBe(expected);
}

// ---------------------------------------------------------------------------
// Every fixture in packages/*/test/fixtures
// ---------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function fixtureJsonFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pkg of await readdir(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, pkg, 'test', 'fixtures');
    try {
      files.push(...(await walk(dir)).filter((f) => f.endsWith('.json')));
    } catch {
      // a package without fixtures
    }
  }
  return files.sort();
}

const FIXTURES = await fixtureJsonFiles();
const isSampleFile = (f: string) => basename(f).includes('bzm-vitals-sample');
const isOutcomeFile = (f: string) => basename(f).includes('bzm-vitals-outcome');

describe('every fixture in packages/*/test/fixtures', () => {
  it('finds the 0.2.x record fixtures at all — an empty glob must not pass vacuously', () => {
    expect(FIXTURES.filter(isSampleFile).length).toBeGreaterThanOrEqual(10);
    expect(FIXTURES.filter(isOutcomeFile).length).toBeGreaterThanOrEqual(10);
  });

  it('every Sample fixture (0.2.x, no test.id) is valid to the validator AND the JSON Schema', async () => {
    for (const f of FIXTURES.filter(isSampleFile)) {
      const record = (await readJson(f)) as { test: Json };
      expect('id' in record.test, f).toBe(false); // genuinely pre-C1 bytes
      expectAgree('sample', record, true, relative(PACKAGES_DIR, f));
    }
  });

  it('every Outcome fixture (0.2.x, no test.id) is valid to the validator AND the JSON Schema', async () => {
    for (const f of FIXTURES.filter(isOutcomeFile)) {
      const record = (await readJson(f)) as { test: Json };
      expect('id' in record.test, f).toBe(false);
      expectAgree('outcome', record, true, relative(PACKAGES_DIR, f));
    }
  });

  it('every other JSON fixture (legacy audit records, known answers) is NOT a format record — and both sides agree', async () => {
    const others = FIXTURES.filter((f) => !isSampleFile(f) && !isOutcomeFile(f));
    expect(others.length).toBeGreaterThan(0);
    for (const f of others) {
      const record = await readJson(f);
      expectAgree('sample', record, false, relative(PACKAGES_DIR, f));
      expectAgree('outcome', record, false, relative(PACKAGES_DIR, f));
    }
  });
});

// ---------------------------------------------------------------------------
// Hand-written cases, derived from a real 0.2.x Sample / Outcome
// ---------------------------------------------------------------------------

const SAMPLE_FIXTURE = FIXTURES.find((f) => /vitals--vitals-Click-Then-Navigate.*sample-1\.json$/.test(f))!;
const OUTCOME_FIXTURE = FIXTURES.find((f) => /journey--journey-Crasher.*outcome\.json$/.test(f))!;
const baseSample = (await readJson(SAMPLE_FIXTURE)) as Json;
const baseOutcome = (await readJson(OUTCOME_FIXTURE)) as Json;

type Mutation = (r: any) => void;

function mutated(base: Json, m: Mutation): Json {
  const r = structuredClone(base);
  m(r);
  return r;
}

const INVALID_SAMPLES: Array<[string, Mutation]> = [
  ['lcp value is the string "12"', (r) => (r.vitals.lcp = { value: '12', status: 'ok' })],
  ['test missing project', (r) => delete r.test.project],
  ['test missing file', (r) => delete r.test.file],
  ['test missing entirely', (r) => delete r.test],
  ['test is an array', (r) => (r.test = [])],
  ['test.repeat is a string', (r) => (r.test.repeat = '0')],
  ['test.worker is negative', (r) => (r.test.worker = -1)],
  ['test.repeat is fractional', (r) => (r.test.repeat = 1.5)],
  ['test.id is a number', (r) => (r.test.id = 42)],
  ['test.titlePath is a string', (r) => (r.test.titlePath = 'a › b')],
  ['test.titlePath holds a number', (r) => (r.test.titlePath = ['a', 1])],
  ['test.path is null', (r) => (r.test.path = null)],
  ['schemaVersion 2', (r) => (r.schemaVersion = 2)],
  ['schemaVersion "1"', (r) => (r.schemaVersion = '1')],
  ['schemaVersion missing', (r) => delete r.schemaVersion],
  ['ts is an ISO string', (r) => (r.ts = '2026-11-07T00:00:00Z')],
  ['ts missing', (r) => delete r.ts],
  ['url missing', (r) => delete r.url],
  ['url is null', (r) => (r.url = null)],
  ['route is null', (r) => (r.route = null)],
  ['navigationIndex missing', (r) => delete r.navigationIndex],
  ['navigationIndex is a string', (r) => (r.navigationIndex = '1')],
  ['pageIndex is negative', (r) => (r.pageIndex = -1)],
  ['pageIndex is a string', (r) => (r.pageIndex = '0')],
  ['vitals missing', (r) => delete r.vitals],
  ['vitals is null', (r) => (r.vitals = null)],
  ['vitals is an array', (r) => (r.vitals = [])],
  ['a metric is a bare number', (r) => (r.vitals.lcp = 2104)],
  ['a metric is null', (r) => (r.vitals.lcp = null)],
  ['a metric has no value key', (r) => (r.vitals.lcp = { status: 'ok' })],
  ['a metric has no status', (r) => (r.vitals.lcp = { value: 1 })],
  ['an unknown metric status', (r) => (r.vitals.lcp = { value: 1, status: 'brand-new-status' })],
  ['status ok with a null value', (r) => (r.vitals.lcp = { value: null, status: 'ok' })],
  ['unsupported with a value', (r) => (r.vitals.cls = { value: 0, status: 'unsupported' })],
  ['no-interaction with a value', (r) => (r.vitals.inp = { value: 0, status: 'no-interaction' })],
  ['unknown status with a value', (r) => (r.vitals.lcp = { value: 2104, status: 'unknown' })],
  ['an unknown metric NAME with a malformed metric', (r) => (r.vitals.myTiming = { value: '3', status: 'ok' })],
  ['navigation missing', (r) => delete r.navigation],
  ['navigation.loadEventMs missing', (r) => delete r.navigation.loadEventMs],
  ['navigation.domContentLoadedMs is a string', (r) => (r.navigation.domContentLoadedMs = '16')],
  ['context missing', (r) => delete r.context],
  ['context.requestCount missing', (r) => delete r.context.requestCount],
  ['context.requestCount is a string', (r) => (r.context.requestCount = '1')],
  ['context.workers is fractional', (r) => (r.context.workers = 0.5)],
  ['context.failedRequests is negative', (r) => (r.context.failedRequests = -1)],
];

const VALID_SAMPLES: Array<[string, Mutation]> = [
  ['the base 0.2.x Sample itself', () => {}],
  [
    'with the additive B2 identity fields',
    (r) => Object.assign(r.test, { id: 'f3a1-9c2e', titlePath: ['Checkout', 'pays'], path: 'flows/checkout.spec.ts' }),
  ],
  ['with an empty titlePath', (r) => (r.test.titlePath = [])],
  ['with the C6 pageIndex', (r) => (r.pageIndex = 1)],
  ['with a declared route', (r) => (r.route = '/order/{id}')],
  ['with an unknown metric NAME', (r) => (r.vitals.myCustomTiming = { value: 42, status: 'ok' })],
  ['with no vitals at all', (r) => (r.vitals = {})],
  ['with every non-ok status, value null', (r) => {
    for (const status of METRIC_STATUSES.filter((s) => s !== 'ok')) r.vitals[`m-${status}`] = { value: null, status };
  }],
  ['with cls ok at exactly 0', (r) => (r.vitals.cls = { value: 0, status: 'ok' })],
  ['with unknown top-level, identity and metric fields (additive, forward-compatible)', (r) => {
    r.someFutureField = { nested: true };
    r.test.someFutureIdentityField = 'x';
    r.vitals.lcp.someFutureMetricField = 1;
  }],
  ['with null navigation and context entries', (r) => {
    r.navigation = { domContentLoadedMs: null, loadEventMs: null };
    r.context = { workers: null, resourceCount: null, requestCount: null, failedRequests: null };
  }],
];

const INVALID_OUTCOMES: Array<[string, Mutation]> = [
  ['status unknown to the vocabulary', (r) => (r.status = 'exploded')],
  ['status interrupted (never written as an Outcome)', (r) => (r.status = 'interrupted')],
  ['status missing', (r) => delete r.status],
  ['retry missing', (r) => delete r.retry],
  ['retry is a string', (r) => (r.retry = '0')],
  ['test missing', (r) => delete r.test],
  ['test missing project', (r) => delete r.test.project],
  ['test.repeat is a string', (r) => (r.test.repeat = '18')],
  ['test.id is null', (r) => (r.test.id = null)],
  ['schemaVersion 2', (r) => (r.schemaVersion = 2)],
  ['lostNavigations negative', (r) => (r.lostNavigations = -1)],
  ['lostNavigations a string', (r) => (r.lostNavigations = '2')],
];

const VALID_OUTCOMES: Array<[string, Mutation]> = [
  ['the base 0.2.x Outcome itself', () => {}],
  ['with the additive B2 identity fields', (r) => Object.assign(r.test, { id: 'f3a1', titlePath: ['A', 'same'], path: 'a/flow.spec.ts' })],
  ['with the C7 lostNavigations', (r) => (r.lostNavigations = 2)],
  ['with lostNavigations 0', (r) => (r.lostNavigations = 0)],
  ['with an unknown field', (r) => (r.someFutureField = 1)],
  ...EXECUTION_STATUSES.map((s): [string, Mutation] => [`with status ${s}`, (r) => (r.status = s)]),
];

describe('hand-written cases: the validator and the JSON Schema agree', () => {
  it.each(INVALID_SAMPLES)('invalid Sample: %s', (label, m) => {
    expectAgree('sample', mutated(baseSample, m), false, label);
  });
  it.each(VALID_SAMPLES)('valid Sample: %s', (label, m) => {
    expectAgree('sample', mutated(baseSample, m), true, label);
  });
  it.each(INVALID_OUTCOMES)('invalid Outcome: %s', (label, m) => {
    expectAgree('outcome', mutated(baseOutcome, m), false, label);
  });
  it.each(VALID_OUTCOMES)('valid Outcome: %s', (label, m) => {
    expectAgree('outcome', mutated(baseOutcome, m), true, label);
  });
  it('non-objects are rejected by both', () => {
    for (const x of [null, 1, 'x', [], true]) {
      expectAgree('sample', x, false, JSON.stringify(x));
      expectAgree('outcome', x, false, JSON.stringify(x));
    }
  });
});

describe('the JSON Schemas restate the runtime vocabularies exactly', () => {
  it('sample.v1.json metric status enum === METRIC_STATUSES', () => {
    const defs = sampleSchema.$defs as { metric: { properties: { status: { enum: string[] } } } };
    expect(defs.metric.properties.status.enum).toEqual([...METRIC_STATUSES]);
  });
  it('outcome.v1.json status enum === EXECUTION_STATUSES', () => {
    const props = outcomeSchema.properties as { status: { enum: string[] } };
    expect(props.status.enum).toEqual([...EXECUTION_STATUSES]);
  });
  it('both schemas declare the identical testIdentity', () => {
    expect((outcomeSchema.$defs as Json).testIdentity).toEqual((sampleSchema.$defs as Json).testIdentity);
  });
});

describe('the schemas ship in the package', () => {
  it('npm pack includes schema/sample.v1.json and schema/outcome.v1.json, and exports them', async () => {
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json'], { cwd: FORMAT_DIR });
    const [report] = JSON.parse(stdout) as [{ files: Array<{ path: string }> }];
    const paths = report.files.map((f) => f.path);
    expect(paths).toContain('schema/sample.v1.json');
    expect(paths).toContain('schema/outcome.v1.json');
    const pkg = (await readJson(join(FORMAT_DIR, 'package.json'))) as { exports: Json; dependencies?: Json };
    expect(pkg.exports['./schema/sample.v1.json']).toBe('./schema/sample.v1.json');
    expect(pkg.exports['./schema/outcome.v1.json']).toBe('./schema/outcome.v1.json');
    expect(pkg.dependencies).toBeUndefined(); // X1: ajv is a devDependency only
  }, 60_000);
});
