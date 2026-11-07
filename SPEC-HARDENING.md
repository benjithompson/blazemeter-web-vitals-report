# Spec: Hardening release (format 0.3 / collector 0.3 / dashboard 0.5)

Triage: `ready-for-agent` (except tickets labelled `needs-owner-decision` / `needs-design`)

Source: the principal-engineer review of 2026-11-07. Every finding marked **verified** below was reproduced against the current `main`, not just read. Vocabulary: [CONTEXT.md](CONTEXT.md). Product decisions: [SPEC.md](SPEC.md). This spec does not reopen anything SPEC.md decided. It fixes places where the implementation falls short of those decisions, and makes the codebase cheaper to change.

---

## 1. Problem statement

The architecture is sound: the one-import fixture, the file-plus-`attach({path})` transport, `{value, status}` per metric, a generator rather than a viewer, and p75 with coverage. The defects are in the implementation.

1. **The data is wrong in three verified ways**, and silently in each case. This is the failure SPEC.md names as its enemy.
   - **Test identity collides.** `describe('A') › 'same title'` and `describe('B') › 'same title'` emit an identical `{file, title, project, repeat, worker}`. So do `a/flow.spec.ts` and `b/flow.spec.ts`. The dashboard then merges the two tests and can stamp one test's failure onto the other's Samples.
   - **Fast clicks read as "no interaction".** A real `page.click()` on a fast handler yields `inp: {value: null, status: 'no-interaction'}`, because there is no `first-input` observer and event entries under 16 ms are never recorded. The report claims nothing was clicked.
   - **`context.requestCount` is cumulative.** It reads 6 → 8 → 9 across three Navigations, because it is never reset per document.
2. **Failures are invisible.** The push `Pusher` swallows every warning. There is no CI, so the 5 Firefox tests fail with `expected +0 to be 3` instead of saying that Firefox is not installed.
3. **The dashboard breaks at realistic scale (verified).**
   - At 20k Samples it produces a 38 MB HTML file.
   - At 200k Samples it crashes with `RangeError: Maximum call stack size exceeded`, from the `Math.min(...)` / `Math.max(...)` spreads.
   - It inflates every zip entry, videos included, to find small JSON files.
4. **The cache is fragile (verified).**
   - The cache path uses `URL.pathname` instead of `fileURLToPath`, which gives a literal `%20` directory, `/usr/lib/.artifact-cache` under a global install, and `/C:/…` on Windows.
   - A manifest written while the master was still running is trusted forever.
   - Writes are not atomic.
5. **The build tooling is a liability.** Two hand-rolled regex bundlers splice source text. Their constraints leak into product code (collision-avoiding names, banned re-exports). They also block the "one source of truth" goal: `routeOf`, the status sets and the credential readers are duplicated across packages, because the format package can't carry runtime code that the regex bundler would have to inline.

## 2. Goals and non-goals

**Goals**
- Every verified data-correctness defect is fixed, and each has a test that failed before the fix.
- Silent failures become loud. Nothing degrades quietly.
- The dashboard handles 200k Samples without crashing, and its HTML size grows with the size of the data, not with Samples × charts × variants.
- One source of truth for runtime constants, `routeOf` and record validation, inside `bzm-vitals-format`.
- CI on every PR, and reproducible releases.

**Non-goals**
- No change to SPEC.md product decisions: p75 leads, coverage always shown, Cold Starts kept and flagged, generator not viewer, zero runtime dependencies, single-file standalone variants.
- No `SCHEMA_VERSION` bump. Every format change here is **additive and optional**, so an old Sample still parses.
- No new push destinations in this release. OTLP and Soft Navigations are `needs-design` tickets only.

## 3. Cross-cutting constraints (every ticket)

| # | Constraint |
|---|---|
| X1 | **Zero runtime dependencies** in all three packages. Dev dependencies are fine. The build may bundle a dev dependency into a standalone file. |
| X2 | **Standalone contracts are frozen.** A tester's spec still does `import { test, expect } from './bzm-playwright-vitals'` against one uploaded file. The dashboard still ships a single `.ts` and a single `.mjs` that run with no `npm install`. |
| X3 | **Format compatibility.** A Sample or Outcome written by collector 0.2.x must still parse and aggregate in dashboard 0.5. Tests prove this with a 0.2.x fixture. |
| X4 | **Passive measurement.** No CDP round-trip or `page.evaluate` during page load (SPEC story 16). |
| X5 | **Credentials.** Read only named env vars. Never serialize `process.env`. The credential-leak scan must stay green. |
| X6 | **Red first.** Each bug ticket starts with a test that reproduces the defect and fails on `main`. The PR description shows it failing, then passing. |
| X7 | **Vocabulary.** Use CONTEXT.md terms (Sample, Navigation, Execution, Engine, Outcome, Route, Cold Start, coverage). A new term goes into CONTEXT.md in the same PR. |

## 4. Agent operating model

This spec is built to be executed by parallel AI coding agents with one human integrator.

- **One ticket = one branch = one PR.** Name the branch `hardening/<ticket-id>-<slug>`, for example `hardening/c2-inp-fast-clicks`. Base it on the latest `main` and rebase before you request review.
- **Scope fence.** Each ticket lists **Owns** (files the agent may change freely) and **Touches** (files it may change minimally, to wire things up). Changing any other file needs a note in the PR saying why. Record out-of-scope findings under a "Follow-ups" heading in the PR body. Don't fix them.
- **Hot files** (tickets touching these are serialized on purpose, see §6):
  - `packages/collector/src/index.ts`
  - `packages/dashboard/src/view-model.ts`
  - `packages/dashboard/src/render.ts`
  - `packages/dashboard/src/cache.ts`
  - `packages/format/src/index.ts`
- **Definition of Done (every PR)**
  1. `npm ci && npm run typecheck && npm test` is green locally and in CI. Once A1 has landed, Firefox is installed in CI. If it is missing locally, Firefox tests must *skip with a reason* and never fail confusingly.
  2. `npm run build:standalone` succeeds for every package the PR touches, and the standalone seam tests pass.
  3. Each acceptance criterion in the ticket is checked off in the PR body, with the test name that proves it.
  4. There are no new runtime dependencies (X1) and no model identifiers or secrets in the diff.
  5. The README or CONTEXT.md is updated wherever behaviour visible to a user or tester changed.
- **Reviews.** The integrator merges. Agents never merge, and never close tickets they didn't implement.
- **Size key.** S ≈ under 150 changed lines; M ≈ 150–500; L ≈ over 500, or a cross-package change.

## 5. Work tracks

| Track | Theme | Tickets |
|---|---|---|
| **A** Platform | CI, build, release, docs | A1, A2, A3, A4 |
| **B** Format | The spine: runtime constants and validation | B1, B2 |
| **C** Collector | Measurement correctness and robustness | C0, C1, C2, C3, C4, C5, C6, C7 |
| **D** Dashboard data | CLI, HTTP, cache, zip, aggregation | D1, D2, D3, D4, D5, D6, D7 |
| **E** Dashboard report | HTML security, scale and rendering | E1, E2, E3 |
| **F** Future | Research spikes that produce designs, not code | F1, F2 |

## 6. Dependency graph and waves

```
Wave 0 (all parallel, start now)
  A1 CI ─────────────────────────────────────────────┐
  A2 esbuild ──► B1 format runtime ──► B2 identity+validator ──┬─► C1 collector testId ──┐
  C3 requestCount ──────────────────────────────────────────────┘                        │
  C2 INP fast clicks ────────────────────────────────────────────────────────────────────┼─► C6 context-level ─► C7 cross-site loss (#13)
  C0 web-vitals oracle (test-only)                                                        │                    └► F1 soft navs (design)
  C4 push visibility + retry ─► F2 OTLP (design)                                          │
  C5 Influx uniqueness                                                                    │
  D2 CLI parseArgs ──┬─► D1 cache correctness ─► D5 lazy zip + one pipeline               │
  D3 HTTP timeouts ──┘                                                                    │
  D4 spread crash ──────────────────────► D6 join on testId (also needs B2) ──┐           │
  E2 CSP meta ────────────────────────────────────────────────────────────────┼─► E1 client render ─► E3 canvas + lazy drill-down
  A2 ─────────────────────────────────────────────────────────────────────────┘
  D7 percentile decision (owner)
Wave 3: A3 release automation (after A1, A2, B1)
Wave 4: A4 docs hygiene (LAST: touches comments everywhere)
```

| Wave | Tickets | Can start when |
|---|---|---|
| 0 | A1, A2, C0, C2, C3, C4, C5, D2, D3, D4, E2, D7 | Immediately. 12 parallel tracks, no shared hot regions (C2 and C3 both touch `collector/src/index.ts`, but different functions; merge C3 first). |
| 1 | B1 (after A2), D1 (after D2 and D3) | |
| 2 | B2 (after B1), then C1 (after B2 and C3), D6 (after B2 and D4), D5 (after D1) | |
| 3 | C6 (after C1 and C2), E1 (after A2, D4, D6 and E2), A3 (after A1, A2 and B1) | |
| 4 | E3 (after E1), C7 (after C6), F1 (after C6), F2 (after C4), A4 (after all code tickets) | |

**Critical path:** A2 → B1 → B2 → D6 → E1 → E3. That's 6 serial tickets, and A2, B2 and E1 are the risky ones. Staff the critical path first, and review those PRs first.

**Merge order inside a hot file**
- `collector/src/index.ts`: C3 → C2 → C1 → C6 → C7.
- `view-model.ts`: D4 → D6 → E1 → E3.
- `cache.ts`: D1 → D5.
- `render.ts`: E2 → E1 → E3.

**Release gates**
- **0.3.0-rc** = every Wave 0–3 ticket merged, with CI green on Chromium and Firefox.
- **GA** additionally needs a live Engine run of `examples/` in which the dashboard shows distinct Tests for same-titled tests, and INP `ok` for a fast click.

---

## 7. Tickets

Each ticket has: **What to build**, **Owns / Touches**, **Implementation notes**, **Acceptance criteria**, **Blocked by**, **Size**.

### Track A: Platform

#### A1. CI pipeline, and loud browser preconditions
**What to build:** A GitHub Actions workflow that runs on every PR and every push to `main`. It runs `npm ci`, `npm run typecheck`, `npx playwright install --with-deps chromium firefox`, `npm test`, and `build:standalone` for the collector and the dashboard. Cache `~/.npm` and the Playwright browsers. Also make browser-dependent tests fail clearly when a browser is missing.
**Owns:** `.github/workflows/ci.yml`, `packages/collector/test/helpers/*` (the browser-availability check).
**Touches:** `packages/collector/test/{vitals,push,roundtrip}.test.ts` (wrap the Firefox cases only).
**Implementation notes**
- Before a Firefox project runs, check whether the browser executable exists, using `require('playwright').firefox.executablePath()` plus `existsSync`.
- Locally, call `it.skipIf(!hasFirefox)` and print a one-line reason.
- When `CI=true`, a missing browser must **fail** with `Firefox not installed: run npx playwright install firefox`. CI must never skip silently.
- Pin Node 22 and test it in a matrix with Node 24.
**Acceptance criteria**
- [ ] CI runs on PRs and is green on `main`.
- [ ] Locally, with no Firefox, the Firefox tests show as skipped with the reason. None show as failing assertions.
- [ ] With `CI=true` and no Firefox, the run fails, and the error message names the missing browser.
- [ ] Both standalone builds run in CI.
**Blocked by:** none. **Size:** S

#### A2. Replace both regex bundlers with esbuild
**What to build:** Rewrite `packages/{collector,dashboard}/scripts/build-standalone.ts` to use esbuild, which is already installed as a transitive dependency; make it an explicit root devDependency. Then remove the workarounds that exist only for the regex bundlers.
**Owns:** `packages/*/scripts/build-standalone.ts`, root `package.json` (devDependency).
**Touches:** the standalone tests (`packages/*/test/standalone.test.ts`) where they assert on internals of the bundler; `FetchLike` and other collision-avoiding names; the `const S = UI_STRINGS` alias, which can be reverted if you want.
**Implementation notes**
- **Collector:**
  - Bundle `src/index.ts` with `bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['@playwright/test']`.
  - The output must still be **one `.ts` file** that Playwright's loader accepts (X2). Emit the esbuild JS into `bzm-playwright-vitals.ts` with a `// @ts-nocheck` banner and a header saying it was generated, and keep the existing upload path and filename.
  - Also emit a sibling `bzm-playwright-vitals.d.ts`, built from `tsc --emitDeclarationOnly` on the entry, so editor types still work.
  - Confirm under Seam 1 (`standalone.test.ts`) that Playwright 1.63 transpiles it.
- **Dashboard:** bundle `src/cli.ts` to `.mjs` (with a `#!/usr/bin/env node` banner) and to `.ts` (the same JS with a `// @ts-nocheck` banner), so that `tsx`/`node --experimental-strip-types` users keep working.
- Keep the **drift guarantees**: the build reads the real sources every time; the only imports allowed in the output are Node builtins and `@playwright/test` (check the esbuild metafile and fail otherwise); and the artifact stays gitignored.
- Delete the collision checker. Scope hoisting makes it unnecessary.
**Acceptance criteria**
- [ ] Both standalone seam tests pass against the esbuild output.
- [ ] The build fails if the bundle has any import other than `node:*` and `@playwright/test` (collector) or `node:*` (dashboard). A test covers this.
- [ ] Each script is under 80 lines, and the regex splicing is gone.
- [ ] `packages/collector/upload-kit/` works unchanged: its spec's import line is byte-for-byte the same.
**Blocked by:** none. **Size:** M. **Risk:** high (critical path).

#### A3. Release automation
**What to build:** Changesets for versioning three packages, a release workflow that publishes to npm with provenance (trusted publishing, OIDC), and GitHub Release assets containing the standalone files. Add an `engines` field (`"node": ">=20"`) to all three packages.
**Owns:** `.changeset/*`, `.github/workflows/release.yml`, the `engines` and `publishConfig` fields in each `package.json`.
**Implementation notes:**
- Collector and dashboard pin `bzm-vitals-format` exactly. Configure changesets so that a format bump cascades to both.
- Publishing needs a repository secret or an npm trusted-publisher setup. Document the one-time setup in the PR. **Don't** create or store any secret yourself.
- Standalone assets are attached to the GitHub Release, not committed.
**Acceptance criteria**
- [ ] `npx changeset` followed by merging the "Version Packages" PR yields a tagged release with the three packages and the three standalone files attached. Prove it with a dry run in the PR, using `--dry-run` / `npm publish --dry-run`.
- [ ] The README's "download the standalone from Releases" instructions are accurate.
**Blocked by:** A1, A2, B1. **Size:** M

#### A4. Docs and comment hygiene
**What to build:**
- Remove the dead `.scratch/…` links from SPEC.md and CONTEXT.md: inline the relevant decision, or link to the GitHub issue.
- Rewrite history-narrating comments ("Issue #4 added…", "0.1.0 bug") into present-tense *why* comments. Git history keeps the archaeology.
- Change the README's Node requirement to ≥ 22 recommended and ≥ 20 supported, matching `engines`.
**Owns:** `*.md` and comments only. **No behavioural change.** The diff must contain only comment and doc lines; verify with `git diff -G` review.
**Acceptance criteria:**
- [ ] No link in the repo points to a path that doesn't exist (a small link-check script runs in CI).
- [ ] Tests are unchanged and green.
**Blocked by:** every code ticket in Waves 0–3. Do it last, to avoid conflicts everywhere. **Size:** M

### Track B: Format (the spine)

#### B1. Runtime constants and shared helpers move into `bzm-vitals-format`
**What to build:** Turn the format package into the single runtime source of truth.
- `METRIC_STATUSES`, `EXECUTION_STATUSES`, `SAMPLE_PREFIX` / `OUTCOME_PREFIX` and `SCHEMA_VERSION` as `as const` arrays and values. Derive the TypeScript union types from them (`type MetricStatus = typeof METRIC_STATUSES[number]`).
- `routeOf(url)`, moved from collector `shared.ts:255` and dashboard `aggregate.ts:148`.
- First check that the two `routeOf` copies behave identically. Diff them and write a table test covering both. If they differ, stop and flag it to the integrator. Don't pick one silently.
**Owns:** `packages/format/src/*`, `packages/format/test/*` (new, with a vitest config and a `test` script).
**Touches:** the collector's `shared.ts` and `index.ts` (delete `COLLECTOR_STATUSES`, `OUTCOME_STATUSES` and `routeOf`, and import them instead); the dashboard's `aggregate.ts` and `parse.ts` (the same).
**Implementation notes:** The format package stays dependency-free. Thanks to A2, the standalone builds now inline it automatically.
**Acceptance criteria**
- [ ] `grep` finds exactly one definition each of `routeOf` and the status sets in the repo.
- [ ] The format package has its own unit tests, run by `npm test`.
- [ ] Both standalone builds still pass their seam tests.
**Blocked by:** A2. **Size:** M

#### B2. Additive test identity, plus one validator shared by writer and reader
**What to build**
1. Add **optional** fields to `TestIdentity`:
   - `id?: string`: Playwright's `testInfo.testId`, which is stable across file, title path and project.
   - `titlePath?: string[]`: `testInfo.titlePath`, without the file element.
   - `path?: string`: the spec path relative to `testDir`, using POSIX separators.

   `file` and `title` stay exactly as they are, for 0.2.x compatibility (X3).
2. A hand-written, dependency-free validator in format: `validateSample(x): {ok: true, value: Sample} | {ok: false, reason: string}`, plus `validateOutcome`. It checks every field: the `test` identity shape, and that every `vitals` and `context` entry is `{value: number|null, status ∈ METRIC_STATUSES}` with `value === null` unless `status === 'ok'`. Unknown metric **names** are allowed, because metric names are open by design.
3. Publish `schema/sample.v1.json` and `schema/outcome.v1.json` (JSON Schema 2020-12) generated from, or tested against, the validator, so that other tools can consume the format.
**Owns:** `packages/format/src/*`, `packages/format/schema/*`, `packages/format/test/*`.
**Touches:** `packages/dashboard/src/parse.ts`, replacing its shallow checks with `validateSample` / `validateOutcome` while keeping the `unreadable` reporting behaviour.
**Implementation notes:**
- Hand-roll the validator, about 150 lines, rather than bundling Valibot or TypeBox. That keeps X1 trivially true.
- Add a JSON-Schema conformance test: run every fixture through both the validator and `ajv` (a devDependency only).
**Acceptance criteria**
- [ ] A Sample whose `vitals.lcp` is `{value: "12", status: "ok"}`, or whose `test` is missing `project`, now lands in `unreadable` with a reason. Before this change it reached aggregation.
- [ ] Every fixture in `packages/*/test/fixtures`, including 0.2.x files without `id`, validates.
- [ ] The validator and the JSON Schemas agree on every fixture, plus a set of hand-written invalid cases.
**Blocked by:** B1. **Size:** M. **Risk:** high (critical path; format change).

### Track C: Collector

#### C0. web-vitals reference oracle (test-only)
**What to build:**
- In the Seam 1 harness, add a Chromium-only fixture spec that injects the `web-vitals` attribution build (a devDependency) next to the collector, and drives the existing fixture pages: layout shift, slow LCP image, a slow click and a fast click.
- Assert that the collector's LCP, CLS, FCP and TTFB are within tolerance of web-vitals: identical for CLS to 4 decimal places; within 1 ms for LCP, FCP and TTFB, where both come from the same entries.
- For INP, mark the comparison as `it.fails` until C2 lands, then flip it.
**Owns:** `packages/collector/test/oracle.test.ts`, `packages/collector/test/fixtures/oracle.spec.ts`, `devDependencies.web-vitals`.
**Acceptance criteria:**
- [ ] The oracle test runs in CI on Chromium and documents each tolerance in a comment.
- [ ] The production bundle doesn't contain web-vitals (check the A2 metafile, or grep `dist`).
**Blocked by:** none. **Size:** S

#### C2. INP: report fast interactions as `ok`, not `no-interaction` (verified)
**What to build:** The trap must tell "no interaction happened" apart from "an interaction happened and every one was fast".
**Owns:** the trap source section of `packages/collector/src/index.ts` (`trapSource`, roughly lines 127–300). **Touches:** `packages/collector/test/vitals.test.ts` and its fixtures.
**Implementation notes**
- Add `new PerformanceObserver(...).observe({type: 'first-input', buffered: true})`. A `first-input` entry counts as an interaction candidate with its own duration. This is what web-vitals does; see `onINP.ts`.
- Keep `durationThreshold: 16`. Even with `first-input`, interactions under 16 ms after the first one aren't observed, and that's correct, because INP takes the worst interaction.
- Status rules:
  - Any interaction entry seen → `ok`, with the INP of the worst interaction, deduplicated by `interactionId`.
  - None seen → `no-interaction` (unchanged).
  - Event Timing unsupported → `unsupported` (unchanged).
- The trap must stay passive: observers only, no event listeners that change timing.
**Acceptance criteria**
- [ ] A new test does a real `page.click()` on a handler that does no work, and gets `inp.status === 'ok'` with `value` ≥ 0 and under 50. It is red on `main`.
- [ ] The navigate-only fixture still yields `no-interaction`, and Firefox behaviour is unchanged.
- [ ] If C0 has landed, its INP `it.fails` is flipped to `it`.
**Blocked by:** none. Merge after C3 if both are open, because they share a hot file. **Size:** S

#### C3. `context.requestCount` is per Navigation (verified)
**What to build:** Make `requestCount` count only the requests made during that document's lifetime.
**Owns:** the `state` and request-listener region of `attachCollector` in `packages/collector/src/index.ts` (around lines 96–118 and 500–545).
**Implementation notes:**
- Attribute each request to the document of its frame: listen to `page.on('request')` and, for main-frame navigation requests, reset the counter when a new document's first reading arrives.
- Alternatively, snapshot the counter at each document's first reading and store the difference.
- Document which requests count (all page requests, including subframes) in the README's `context` table.
**Acceptance criteria**
- [ ] For three sequential Navigations, `requestCount` equals the number of requests each document made. The test is red on `main`, which records 6/8/9.
- [ ] `resourceCount` is unchanged.
**Blocked by:** none. **Size:** S

#### C1. Collector writes a stable, unique test identity (verified collision)
**What to build:** Populate the B2 fields: `id: testInfo.testId`, `titlePath: testInfo.titlePath.slice(1)` and `path: relative(testInfo.project.testDir, testInfo.file)` (POSIX). Do this in `testIdentity()` for both Samples and Outcomes.
**Owns:** `testIdentity()` in `packages/collector/src/index.ts`. **Touches:** `packages/collector/test/outcome.test.ts` and a new fixture spec containing two `describe` blocks with the same test title.
**Acceptance criteria**
- [ ] The two same-titled tests emit different `test.id` values and different `titlePath`s. The test is red on `main`.
- [ ] Two same-basename specs in different folders emit different `path`s.
- [ ] `roundtrip.test.ts` passes, because the dashboard validator accepts the new fields.
**Blocked by:** B2, C3 (hot-file order). **Size:** S

#### C4. Push failures are visible; sends retry with backoff
**What to build**
- **Warnings:** wire the `Pusher` `onWarn` to `process.stderr`, once per destination per distinct reason, so the log doesn't flood. Prefix it with `[bzm-vitals]`.
- **Teardown summary:** at worker teardown, write a `bzm-vitals-push-status-<worker>.json` attachment through the same `writeFile` + `attach({path})` path. It records `{destination, sent, failed, dropped, lastError}` and no credentials. The dashboard ignores it for now. Name it in CONTEXT.md.
- **Retry:** `BlazeMeterDestination` and `InfluxDestination` retry 429, 5xx and network errors up to 3 times with exponential backoff plus jitter, honouring `Retry-After`. They never retry other 4xx responses. Retries stay inside the existing 15 s drain budget, and use the injectable `Clock` for tests.
**Owns:** `packages/collector/src/{pusher,blazemeter-destination,influx-destination}.ts`, `packages/collector/test/{pusher,blazemeter-destination,influx-destination}.test.ts`.
**Touches:** the line in `index.ts` that constructs the `Pusher` (the `onWarn` wiring and the teardown attachment).
**Acceptance criteria**
- [ ] With bad credentials (the fake server returns 401), stderr shows exactly one `[bzm-vitals] blazemeter: 401…` line, and the push-status attachment shows `failed > 0`.
- [ ] A 503 followed by a 200 delivers the batch exactly once (fake clock).
- [ ] The credential-leak scan covers the new attachment.
**Blocked by:** none. **Size:** M

#### C5. Influx point uniqueness and escaping
**What to build:**
- Prevent same-millisecond points from overwriting each other. Write at **ns** precision, with `timestamp_ns = ts_ms * 1e6 + (engineIndex * 1000 + workerIndex) % 1e6`, so it is deterministic and unique per writer. Also add `worker` as a tag. Its cardinality is bounded by `--workers`.
- Escaping: line protocol can't represent a newline in a tag or field key, so replace `\n` and `\r` with a space in tag values (`route`, `title`) instead of escaping them.
**Owns:** `packages/collector/src/{influx-writer,influx-destination}.ts` and their tests. **Touches:** the Influx section of the README.
**Acceptance criteria**
- [ ] Two Samples from different workers with the same `ts` produce two distinct points: different timestamp or tag set, checked against the integration double.
- [ ] A title containing `\n` produces a valid line.
- [ ] The README states the precision and the tags.
**Blocked by:** none. **Size:** S

#### C6. Context-level instrumentation (popups and `context.newPage()`)
**What to build:**
- Move injection from the `page` fixture to the `context` fixture: `context.addInitScript`, `context.exposeBinding`, and the per-page flush patching applied from `context.on('page')`.
- Every page the test opens is measured, including popups and `context.newPage()`. Samples gain an optional `pageIndex` (additive; describe it in the B2 validator, so this ticket coordinates a one-line format change with the integrator).
**Owns:** `attachCollector`, `flushBeforeNavigating` and the fixtures in `packages/collector/src/index.ts`.
**Implementation notes:**
- Keep the existing `page` override working; it becomes "the first page of the context".
- Patch methods per page instance, never on the prototype.
- Add a guard test that fails if Playwright renames `goto`, `reload`, `goBack` or `goForward`.
**Acceptance criteria**
- [ ] A spec that opens a popup with `page.waitForEvent('popup')` and navigates it gets Samples for both pages.
- [ ] A spec that uses `context.newPage()` gets Samples.
- [ ] Existing tests are unchanged and green on Chromium and Firefox.
**Blocked by:** C1, C2. **Size:** L. **Risk:** medium.

#### C7. Cross-site Navigation loss: verify, then make it loud (existing #13)
**What to build:**
- First, **re-verify #13 on Playwright 1.63**. PR #18 changed the flush to run before `goto()` and at `beforeunload`, and the upload kit's README now says cross-site navigations are recorded. Write the cross-site repro test.
- If the test passes, close #13 with the test as proof.
- If it fails:
  1. Detect loss by comparing main-frame `framenavigated` events seen in Node with the Samples that were written, and record `lostNavigations` in the Outcome. This is additive, and goes through the B2 validator.
  2. Expire any pending `vitals.route()` when a new document commits, so it can't land on the wrong Sample.
**Owns:** the cross-site test, plus the route-pending logic in `index.ts`.
**Acceptance criteria:** match the outcome you found and state it in the PR. Either the test proves no loss, or the loss count shows up in the Outcome and a pending route never lands on the next document.
**Blocked by:** C6. **Size:** M

### Track D: Dashboard data

#### D2. CLI: `util.parseArgs`, `--help`, `--version`, clear errors
**What to build:**
- Replace the hand-rolled parser in `cli.ts` with `node:util` `parseArgs` (`strict: true`).
- Add `--help` / `-h` (usage, every flag, both input modes, the env vars) and `--version`, read from `package.json`. The standalone build inlines it.
- A missing flag value or an unknown flag exits with code 2 and prints a one-line error plus a hint to use `--help`.
- Leave a place for D1's flags (`--cache-dir`, `--refresh`), but don't implement them.
**Owns:** `packages/dashboard/src/cli.ts` (argument parsing only), `packages/dashboard/test/cli-*.test.ts`.
**Acceptance criteria**
- [ ] `--master` with no value exits 2 with a clear message. Today it becomes `undefined`.
- [ ] `--help` and `--version` work in the package build and both standalone builds.
- [ ] `isEntryPoint`'s realpath behaviour is preserved, and its test stays.
**Blocked by:** none. **Size:** S

#### D3. Dashboard HTTP: timeouts, retry, configurable API base
**What to build:**
- In `http.ts`, wrap every transport call in `AbortSignal.timeout`: 30 s for API calls, and 120 s plus a stall timeout for artifact downloads.
- Retry 429, 5xx and network errors up to 3 times with backoff plus jitter, honouring `Retry-After`.
- Make `api.ts`'s `BASE` read `BLAZEMETER_API_BASE`, matching the collector, with a default of `https://a.blazemeter.com`.
- Keep `withCertHint`.
**Owns:** `packages/dashboard/src/{http,api}.ts`, `packages/dashboard/test/{api,tls-hint,credentials}.test.ts`.
**Acceptance criteria:**
- [ ] A fake server that hangs makes the CLI fail within the timeout, with an error that names the URL host. The error must not include the signed query string.
- [ ] A 503 then a 200 succeeds.
- [ ] `BLAZEMETER_API_BASE` is honoured, and the README documents it.
**Blocked by:** none. **Size:** S

#### D4. Remove the argument-spread crash at scale (verified)
**What to build:** Replace every `Math.min(...xs)` / `Math.max(...xs)` in `view-model.ts` with a single-pass loop helper. There are six spreads: lines 377, 378, 547, 548 and 549, plus the timeline's `dataMax` (`Math.max(p75 ?? 0, ...values)`), which this list first missed. Add a scale regression test.
**Owns:** `packages/dashboard/src/view-model.ts` (those helpers only), `packages/dashboard/test/report-scale.test.ts`.
**Implementation notes:** Check the rest of `packages/*/src` for any other spread of an unbounded array into a function call, such as `push(...xs)`, and fix those too.
**Acceptance criteria**
- [ ] A synthetic 200k-Sample `assembleReportData` + `buildReportVariants` run completes without throwing. It is red on `main`. Use a cheap generator and keep the test under 15 s; it may be tagged `@slow`, but it runs in CI.
- [ ] Output is byte-for-byte identical on the existing known-answer fixtures.
**Blocked by:** none. **Size:** S

#### D7. Decide and document the percentile method
**Decided 2026-11-07 by the owner: Option 1, keep the current method.** It is documented in the README, in the Route table's note line in the report, and in the `percentile` doc comment. The known answers are unchanged.

**Original question:** keep `sorted[floor((n−1)q)]` (NumPy "lower") or change it.
- **Option 1 (recommended):** keep it. Name it "lower (NumPy `method='lower'`)" in the README and the report footer, and explain that it always returns an observed value.
- **Option 2:** nearest-rank (`ceil(q·n)−1`). Every known answer changes.
- **Option 3:** linear interpolation (NumPy's default). The value may not be an observed one.

**Owns, once decided:** the `percentile` function in `aggregate.ts`, `known-answers.test.ts`, the README.
**Acceptance criteria:**
- [ ] The decision is recorded in this spec and the README.
- [ ] If the method changes, the known answers are regenerated in the same PR, and the PR shows the diff.
**Blocked by:** owner decision. **Size:** S

#### D1. Cache correctness, flags and parallel downloads (verified)
**What to build**
- **Cache root:**
  - Use `fileURLToPath`.
  - The new default is `$BZM_VITALS_CACHE_DIR`, else `--cache-dir`, else `./.artifact-cache` under the **cwd**, for every install mode.
  - The in-repo dev setup keeps working because tests pass `cacheRoot` explicitly. Drop the walk up to `../../../..`.
- **Invalidation:**
  - Record the master's status in the manifest. Trust a manifest only if the master had ENDED when it was written.
  - Otherwise re-list the sessions and fetch only the ones that are missing or changed.
  - `--refresh` ignores the manifest.
- **Atomic writes:** write each zip and the manifest to a `.tmp` file, then `rename`. A truncated zip found at startup is deleted and fetched again, with a warning.
- **Parallel downloads:** download at most 4 sessions at once (a small semaphore, no dependency), through D3's retrying transport.
**Owns:** `packages/dashboard/src/cache.ts`, `packages/dashboard/test/cache.test.ts`. **Touches:** `cli.ts` (wire `--cache-dir` / `--refresh` into D2's parser).
**Acceptance criteria**
- [ ] When the module path contains a space, the cache root has no `%20`. Unit-test `defaultCacheRoot` with an injected URL.
- [ ] A master cached while RUNNING is refreshed on the next run, and a master cached when ENDED makes no network call.
- [ ] Killing the process mid-download leaves no file that a later run trusts.
- [ ] With 8 sessions and a fake server, the maximum concurrency observed is 4 and the minimum is above 1.
**Blocked by:** D2, D3. **Size:** M

#### D5. Lazy zip reading, and one in-memory pipeline
**What to build:**
- **Lazy reading:** `readZipEntries(buf, filter)` inflates and CRC-checks only the entries whose name matches the record prefixes (`bzm-vitals-sample`, `bzm-vitals-outcome`, `performance-audit-`) plus `bzt.log` when engine inference needs it.
- **One pipeline:** the API/cache path reads cached zips in memory, using the same code as `local.ts`, and stops extracting every entry to disk. Delete `extract.ts`, or reduce it to a debug `--extract` option if any test or README relies on extraction; say which in the PR.
**Owns:** `packages/dashboard/src/{zip,extract,local,report}.ts`. **Touches:** `cache.ts` (only the read side).
**Acceptance criteria**
- [ ] A zip that also contains a 50 MB `video.webm` doesn't inflate that entry; spy on the inflate count.
- [ ] `--master` and `--artifacts` over the same data produce an identical embedded blob, apart from source metadata. Add a test for this.
- [ ] The collision test (`collision.test.ts`), which checks namespacing by sessionId, still passes.
**Blocked by:** D1. **Size:** M

#### D6. Join and group on `test.id`, with a fallback
**What to build:**
- In `aggregate.ts` `executionKey`, use `sessionId + test.id + repeat` when `test.id` exists, and the current 6-tuple otherwise.
- In `view-model.ts` `testKey`, use `test.id ?? [file,title,project]`.
- Test labels use `titlePath.join(' › ')` and `path` when they are present.
**Owns:** `executionKey` and `joinOutcomes` in `packages/dashboard/src/aggregate.ts`; `testKey` and the label code in `view-model.ts`.
**Acceptance criteria**
- [ ] With records from C1's same-title fixture (or hand-made equivalents if C1 hasn't merged), the report shows **two** Tests, and each Outcome joins to its own Samples. It is red against current behaviour.
- [ ] 0.2.x fixtures with no `id` aggregate exactly as before; the known answers are unchanged.
**Blocked by:** B2, D4 (hot-file order). **Size:** S

### Track E: Dashboard report

#### E2. A Content-Security-Policy that enforces "zero external requests"
**What to build:** Add these to the generated `<head>`:
- `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`
- `<meta name="referrer" content="no-referrer">`

**Owns:** the `<head>` template in `render.ts`.
**Acceptance criteria:**
- [ ] A Playwright test opens the generated HTML, collects every `console` CSP violation and `requestfailed` event, and finds none. The page's interactions (the toggle and drill-down) still work.
**Blocked by:** none. **Size:** S

#### E1. One data blob, rendered in the browser
**What to build:**
- Stop rendering both variants (included and excluded failures) as full HTML on the server. Embed the attributed Samples and Outcomes **once**, as gzip-compressed, base64-encoded JSON.
- Ship the **same** `buildView` / `buildReportVariants` code, bundled for the browser by esbuild (A2), as one inline `<script>`. The browser decompresses the data with `DecompressionStream('gzip')` and renders.
- The include/exclude toggle recomputes in the browser, instead of switching between two pre-rendered DOMs.
**Owns:** `render.ts`, plus a new `packages/dashboard/src/browser/entry.ts`.
**Touches:** `view-model.ts`, to make it isomorphic: no `node:*` imports, and pure functions only.
**Implementation notes**
- **Fallback:** keep a small server-rendered summary (the Route table at p75 with coverage), so the report still says something if JS fails. Add a `<noscript>` note.
- **"Works in 6 months":** don't fetch anything. The compressed blob and the code are inline, and E2's CSP guards this.
- **Decompression support:** `DecompressionStream` is available in all evergreen browsers (Baseline since 2023). Put a feature check in front of it, with a fallback message.
**Acceptance criteria**
- [ ] A 20k-Sample report is **under 8 MB**. Today it is 38 MB. Record the size in `report-scale.test.ts`.
- [ ] A 200k-Sample report generates in under 15 s and opens in Chromium in under 5 s (Playwright test).
- [ ] The view model the browser builds deep-equals the one Node builds for the same fixture. This is the new drift guard.
- [ ] Existing seam2, outcome-toggle and timeline assertions pass. Port them to run against the rendered DOM where needed.
- [ ] No credentials appear in the HTML; the leak scan stays.
**Blocked by:** A2, D4, D6, E2. **Size:** L. **Risk:** high (critical path). Split it into E1a (blob, bundle, Route table) and E1b (toggle and drill-downs) if the PR goes over about 800 lines.

#### E3. Canvas timeline, lazy drill-downs, local-time labels
**What to build:**
- Draw the timeline scatter points (Navigations) on a `<canvas>`; keep axes and threshold bands in SVG.
- Build the drill-downs (Report → Route → Test → Engine → Navigation) only when they are first expanded.
- Timeline tick labels follow the viewer's local time zone, with a UTC toggle; show the zone on the axis.
**Owns:** the timeline and drill-down rendering in `src/browser/*`.
**Acceptance criteria:**
- [ ] With 200k Samples, toggling a variant takes under 500 ms and the DOM has fewer than 5k nodes on first paint.
- [ ] Hovering a canvas point still shows the per-Navigation tooltip.
- [ ] The time-zone label is visible and the toggle works.
**Blocked by:** E1. **Size:** M

### Track F: Future (design spikes; their output is a design doc in the PR, not production code)

#### F1. Soft Navigations (SPA route changes): design
- Survey the shipped state of the Chrome Soft Navigations API and the `soft-navigation` entry type, and CrUX's experimental soft-navigation CWV.
- Propose how the trap detects support (`PerformanceObserver.supportedEntryTypes`), how a soft Navigation becomes a Sample (`navigationType: 'soft'`, an additive field), and how the Cold Start and Route rules apply.
- Write a working prototype on a branch, against a minimal SPA fixture.
**Blocked by:** C6. **Labels:** `needs-design`.

#### F2. OTLP/HTTP metrics destination: design
- Design a `Destination` that sends OTLP/HTTP JSON metrics (gauge or histogram per vital) with zero dependencies, hand-encoding the JSON.
- Cover which resource attributes map to location, engine and route; temporality (delta vs cumulative) per backend; and Grafana Cloud's native OTLP versus InfluxDB through a collector.
- Decide whether it replaces the bespoke Influx destination over time.
**Blocked by:** C4. **Labels:** `needs-design`.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The esbuild output isn't accepted by Playwright's TS loader on an Engine (A2). | The Seam 1 standalone test runs the real Playwright loader. Before merge, do one manual upload-kit run on a live Engine, and treat it as a gate. |
| A format change breaks old Samples (B2). | Fields are additive and optional. 0.2.x fixtures are kept and must validate (X3). |
| Hot-file conflicts between parallel agents. | The hot-file merge order in §6, Owns/Touches fences, and rebasing before review. |
| E1 regresses report fidelity. | Node and browser must build deep-equal view models; the existing DOM assertions are ported, not deleted. |
| Retries lengthen worker teardown (C4). | Retries stay inside the existing 15 s drain budget, enforced with a fake clock. |

## 9. Verified evidence (reproduced 2026-11-07 on `main` @ 81c2fd5)

- **Identity collision.** A probe spec with two `same title` tests in different `describe` blocks: both Samples had `{file:"probe.spec.ts", title:"same title", repeat:0, worker:0}`.
- **INP.** `page.click()` on a trivial handler gave `{value:null, status:"no-interaction"}`.
- **`requestCount`.** 6, 8, 9 across three Navigations, while `resourceCount` read 6, 2, 1.
- **Scale.**
  - 2k Samples: 4.2 MB.
  - 20k Samples: 38.2 MB, with a 14.3 MB JSON blob.
  - 200k Samples: `RangeError: Maximum call stack size exceeded` in `view-model.ts`.
- **Cache root.** `URL.pathname` gives `/home/me/My%20Projects/.artifact-cache`, `/usr/lib/.artifact-cache` and `/C:/…`.
- **Tests.** The dashboard has 178 passing; the collector has 176 passing and 5 failing, all Firefox, because Firefox isn't installed. They fail with `expected +0 to be 3`.

## 10. References

- web-vitals `onINP.ts` (`first-input` and the 40 ms default): https://cdn.jsdelivr.net/npm/web-vitals@5.2.0/src/onINP.ts and https://github.com/GoogleChrome/web-vitals/issues/228
- Soft Navigations: https://developer.chrome.com/blog/final-soft-navigations-origin-trial
- InfluxDB line protocol (duplicate points): https://docs.influxdata.com/influxdb3/core/reference/line-protocol
- OTLP metrics into Grafana: https://grafana.com/docs/learning-hub/intro-to-send-data/01-send-metrics/08-opentelemetry-metrics/

## 11. Ticket → GitHub issue map

Parent: **#23**. Every ticket is a sub-issue of #23; its "Blocked by" section lists the issue numbers it waits on.

| Wave | Ticket | Issue | Blocked by |
|---|---|---|---|
| 0 | A1 CI + loud browser preconditions | #24 | none |
| 0 | A2 esbuild bundlers ★ | #25 | none |
| 0 | C0 web-vitals reference oracle | #26 | none |
| 0 | C3 requestCount per Navigation | #27 | none |
| 0 | C2 INP fast clicks | #28 | none (merge after #27) |
| 0 | C4 push visibility and retry | #29 | none |
| 0 | C5 Influx point uniqueness | #30 | none |
| 0 | D2 CLI parseArgs | #31 | none |
| 0 | D3 HTTP timeouts and retry | #32 | none |
| 0 | D4 spread crash at scale | #33 | none |
| 0 | E2 CSP meta | #34 | none |
| 0 | D7 percentile decision (owner) | #35 | owner decision |
| 1 | B1 format runtime ★ | #36 | #25 |
| 1 | D1 cache correctness | #37 | #31, #32 |
| 2 | B2 identity fields and validator ★ | #38 | #36 |
| 2 | D5 lazy zip, one pipeline | #39 | #37 |
| 2 | C1 collector test identity | #40 | #38, #27 |
| 2 | D6 join on test.id ★ | #41 | #38, #33 |
| 3 | C6 context-level instrumentation | #42 | #40, #28 |
| 3 | E1 client-side render ★ | #43 | #25, #33, #41, #34 |
| 3 | A3 release automation | #44 | #24, #25, #36 |
| 4 | E3 canvas and lazy drill-down ★ | #45 | #43 |
| 4 | C7 cross-site loss (#13) | #46 | #42 |
| 4 | F1 soft navigations (design) | #47 | #42 |
| 4 | F2 OTLP destination (design) | #48 | #29 |
| 4 | A4 docs hygiene (last) | #49 | every Wave 0–3 code ticket |

★ = critical path.
