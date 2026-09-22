# Standalone collector — BlazeMeter upload kit

Runs the `bzm-playwright-vitals` collector on real BlazeMeter Engines **without an npm
publish**: the collector travels as a single generated file (`bzm-playwright-vitals.ts`) uploaded
next to the spec, and the spec's one changed import is relative:

```ts
import { test, expect } from './bzm-playwright-vitals';
```

This kit exists for direct-upload validation and for Engines with no registry
access. The normal path is the published npm package (`npm install --save-dev
bzm-playwright-vitals`, import from `'bzm-playwright-vitals'`) —
`bzm-playwright-vitals.ts` is a build artifact, never a second source of truth.

## 1. Build the artifact

```sh
# from the repo root
npm --workspace bzm-playwright-vitals run build:standalone
```

This regenerates `packages/collector/dist-standalone/bzm-playwright-vitals.ts` from the actual
collector + format sources and copies it into this directory. `bzm-playwright-vitals.ts` is
gitignored here — if it's missing, you haven't built it.

## 2. Upload — five files, together

Create (or edit) a BlazeMeter **Performance** test (Taurus, `executor: playwright` —
the same shape as the probe run that already succeeded on 2 Engines) and upload ALL of:

| file | role |
|---|---|
| `config.yml` | the Taurus config — this is what makes it a Playwright-executor test |
| `example.spec.ts` | the journey (2 tests; imports `./bzm-playwright-vitals`) |
| `bzm-playwright-vitals.ts` | the standalone collector (generated — step 1) |
| `playwright.config.ts` | defines the `chromium` project Taurus targets; `retries: 0` pinned |
| `package.json` | deps for the Engine's `npm install` (Taurus REWRITES it there to inject its own reporter — that's normal) |

In the BlazeMeter UI: Performance → Create Test → Taurus/upload-script flow → drag all
five files into the test's files area, make sure `config.yml` is the selected/main
script, choose nothing else, run. (Via API/`bzt`-cloud the same five files are the
test's file set.)

Do **not** set a `CI` env var on the test: the config pins `retries: 0` deliberately,
and retried Executions would emit extra Samples/Outcomes and cloud the expected counts.

## 3. What to expect

`concurrency: 4` over two locations (us-west-1, us-west-2) with `iterations: 2` becomes,
per Engine: `--workers 2 --repeat-each 4 --project=chromium` (workers = concurrency ÷
engines; repeat-each = workers × iterations). With 2 tests in the spec:

- **2 Engines** (one per location), each running 2 tests × 4 repeats = **8 Executions**
  (16 total).
- Per Execution: one `bzm-vitals-outcome*.json` attachment, plus one
  `bzm-vitals-sample-<n>*.json` per Navigation (`Search Journey` drives 2 Navigations,
  `Single Page` drives 1) — so per Engine expect 8 Outcomes and 12 Samples, as
  sha1-suffixed attachment copies in that Engine's flat `artifacts.zip`.
- Artifacts land **per-Engine** (per session). A failed/ungracefully-terminated Engine
  may emit no artifacts.zip at all — absence is a signal, not a retrieval bug.
- `Search Journey`'s Navigation-1 Samples carry `route: "/wiki/{article}"`, all five
  vitals `ok`, and a real `inp` (the search-box typing does real rendering work);
  Navigation-2 and `Single Page` Samples carry
  `inp: {value: null, status: "no-interaction"}` — never 0, never absent.

## Why the journey is shaped this way (measured)

Found while validating this kit locally, with the collector behaving identically via
the package and the standalone file:

- **Cross-site navigation used to lose the departing document's Sample.** Navigating
  example.com → iana.org swaps the Chromium renderer process, and an `exposeBinding`
  call made at `pagehide` never reaches Node (a platform behavior). From Playwright
  1.63, Chromium's RenderDocument swaps the frame on EVERY navigation, same-site
  included. The collector now flushes before a test-driven `goto()` /
  `reload()` / `goBack()` / `goForward()`, and at `beforeunload` for link clicks, so
  cross-site journeys keep both Samples (pinned in `test/crosssite.test.ts`).
- **SPA link clicks are not Navigations.** playwright.dev (Docusaurus) intercepts
  internal links client-side: no document unload, no new document, so by design no
  second Sample — the whole journey lands in one Sample flushed at teardown. Use
  server-rendered pages to demonstrate multi-Navigation journeys.

## 4. Point the dashboard at the run

Grab the **master id** from the report URL (`.../masters/<masterId>/...`), then from the
repo root:

```sh
# fetch every Engine's artifacts into the gitignored .artifact-cache/
BLAZEMETER_API_KEY=./api-key.json \
  npx tsx packages/dashboard/scripts/fetch-cache.ts <masterId>

# render the report (cache-through: re-runs do zero network calls)
npx tsx packages/dashboard/src/cli.ts --master <masterId> --out report.html
```

Open `report.html` — Samples attributed per session/location, Routes
`/example-landing` (declared) plus derived ones for the IANA page.

## Unproven until a real run

Local Seam 1 coverage (`test/standalone.test.ts`) proves the relative-import file works
under a real `npx playwright test` locally. What only the Engine can prove: the Engine's
Playwright version (kit pins `^1.61.1` like the probe; the Engine installs its own),
its TS transpilation of the sibling import under that version, and which Chromium
channel/headless shell the Engine actually launches.
