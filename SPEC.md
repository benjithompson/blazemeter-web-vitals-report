# Spec: Playwright Web-Vitals Collector + Dashboard

Triage: `ready-for-agent`

Source: [wayfinder map](.scratch/playwright-vitals-dashboard/map.md) — destination reached 2026-07-16, 11 decisions resolved, 2 ruled out of scope, 0 open. Vocabulary: [CONTEXT.md](CONTEXT.md).

---

## Problem Statement

A tester runs a Playwright suite on BlazeMeter to find out how a site's web vitals behave while the backend is under load. Today they cannot, for two reasons.

**Nothing produces the numbers.** BlazeMeter's Timeline KPIs are a closed, JMeter-shaped set (`na, ec, ct, t, lt, ts, n, by`) with no web vitals in it. Taurus overrides Playwright's reporter with its own, whose per-Execution stream carries no vitals and offers no extension point. BlazeMeter *does* ship "browser vitals during a load test" — EUX Monitoring — but it is Selenium-only and supports only scenarios scripted inline in YAML, which is exactly what a `script: example.spec.ts` test is not. So the tester hand-rolls a collector inside their spec.

**Hand-rolling it fails silently.** A capable engineer already did, and their collector — in production now — ships an INP that can structurally never fire (`null` on all 50 real Samples), a per-Engine aggregation that has never run, an LCP flush that is a no-op twice over, CLS without session windows, a `.ndjson` file that is pretty-printed and therefore not NDJSON, and a fixed-name output file that loses **98% of its data** (1 of 50 survivors) to a filename collision nobody noticed. Every one of those failures is silent: the run goes green and the numbers look plausible. Separately, that collector reports `cls: 0` on browsers that have no `LayoutShift` API at all — perfect layout stability that never existed — because `null` means both "unavailable" and "genuinely zero".

**And even when the numbers exist, they are scattered and unreadable.** A Report fans out into many Engines across regions; each Engine runs the Test `n` times and emits its own `artifacts.zip` with hundreds of flat files. To see the run at all, the tester downloads each zip by hand and reads JSON — and if they extract two Engines into one directory, half their Samples vanish, because cross-Engine attachment filenames are provably identical (basename is `sha1` of an absolute path Taurus fixes to `/tmp/artifacts/test-output` on every Engine).

The tester wants one link that answers *"what are my vitals for this run, and how did they move over its duration?"*. They have a directory of zips and a hand-rolled collector quietly lying to them.

## Solution

Two deliverables, library first.

**A collector library** that a tester adopts by changing **one import**. Their existing tests are otherwise unmodified; vitals are captured on the Navigations the test actually drove — journey vitals, not a cold re-navigation afterwards — and written as one small JSON Sample file per Navigation, plus one Execution Outcome record per test. Every metric carries `{value, status}`, so "unsupported" never renders as `0`. No tester writes metrics code, and every Engine emits the identical shape. Forgetting the import produces **no data at all** — loud, not a silent gap.

**A dashboard generator** — a CLI pointed at a Report id — that walks the BlazeMeter API to every Engine's artifact, extracts each namespaced by `sessionId`, adapts the incumbent's records where the library hasn't been adopted, pools the Samples, and emits **one self-contained static HTML file** with the data baked in. It opens on a Route table (*"what is the state?"*), carries a wall-clock timeseries below it (*"how did it move?"*), and drills Report → Route → Test → Engine → Navigation. It contains no credentials and is safe to email.

The two are one monorepo because the record format is the spine, and format drift is this project's proven enemy.

## User Stories

### Adopting the collector

1. As a tester with an existing Playwright suite, I want to get vitals flowing by changing a single import, so that I don't have to hand-implement metrics code in every test.
2. As a tester, I want my existing test bodies to work unmodified after the import swap, so that adoption is not a rewrite.
3. As a tester, I want vitals captured on every Navigation my test drives without calling anything per-Navigation, so that I cannot silently miss one by forgetting a call.
4. As a tester who forgets to swap the import, I want to get no data at all rather than partial data, so that the failure is loud and I notice it immediately.
5. As a tester, I want vitals measured on the page my test actually drove, so that my authenticated journeys are measured as themselves rather than as the login page they silently redirect to.
6. As a tester, I want the library to capture INP from the clicks my journey already performs, so that I get an interaction metric without scripting anything extra.
7. As a tester whose journey only navigates, I want INP reported as `no-interaction` rather than `0` or missing, so that I understand it is correct rather than broken.
8. As a tester, I want the library to flush the metrics before the page closes, so that CLS and INP are not lost to a close that flushes nothing.
9. As a tester, I want to optionally declare a Route for a Navigation, so that `/order/12345` and `/order/67890` group together in the report.
10. As a tester who declares no Route, I want one derived for me, so that the optional knob stays optional.
11. As a tester, I want the library to work under whatever `--workers`, `--repeat-each`, `--project`, `-g`, `--output`, and `--reporter` Taurus imposes, so that my suite behaves the same on an Engine as on my laptop.
12. As a tester running on a non-Chromium project, I want Samples emitted with CLS marked `unsupported`, so that my Engine is not silently absent from the report entirely.
13. As a tester, I want the library published to npm with normal semver and Playwright expressed as a peer dependency, so that I add one dep and upgrade on my own schedule.
14. As a tester, I want a fix to the library to reach me by bumping a version, so that I am not hand-copying a patch into every suite the way the current collector's bugs spread.
15. As a tester whose test crashes mid-journey, I want every Navigation recorded before the crash to survive, so that a failure costs me one Navigation and not the whole Execution.
16. As a tester, I want collection to add no CDP round-trip during page load, so that the act of measuring does not perturb the metric being measured.
17. As a security-conscious tester, I want the library to read only named environment variables, so that a live `SESSION_TOKEN` is never dumped into a downloadable artifact.

### Reading a report

18. As a performance engineer, I want to point a CLI at a Report id and get one HTML file, so that I don't hand-download a zip per Engine.
19. As a performance engineer, I want every Engine in the Report pulled automatically, so that I never wonder whether I missed one.
20. As a performance engineer, I want the report to open on a Route table with p75 leading, so that "what is the state?" is answered before anything else.
21. As a performance engineer, I want a threshold dot next to each p75, so that I can see good/needs-improvement/poor at a glance.
22. As a performance engineer, I want thresholds applied only to p75 and never to any other statistic, so that the colouring is not wrong by construction.
23. As a performance engineer, I want p50 and p95 alongside p75, so that I can see the shape and not just the point.
24. As a performance engineer, I want no arithmetic mean displayed, so that nobody colours a mean against a p75-defined band.
25. As a performance engineer, I want coverage stated under every aggregate — *"p75 over 41 of 50"* — so that "CLS 0" can never mean both "perfectly stable" and "never measured".
26. As a performance engineer, I want a metric with nothing measured to display its reason rather than a number — `INP — no interaction (0 of 50)` — so that I never read a `0` that isn't one.
27. As a performance engineer, I want a wall-clock timeseries below the table, so that I can see how the vitals moved over the run's duration.
28. As a performance engineer, I want the timeseries x-axis to be absolute wall-clock, so that it lines up with what the backend was doing at that moment.
29. As a performance engineer, I want the run's p75 drawn as a reference line on the timeseries, so that I can see which Samples sit above it.
30. As a performance engineer, I want Cold Starts labelled on the timeseries, so that the p95 spike is explained rather than chased as a ghost.
31. As a performance engineer, I want Cold Starts kept in the aggregate rather than trimmed, so that the report describes real page loads instead of a world that doesn't exist.
32. As a performance engineer, I want to drill Report → Route → Test → Engine → Navigation, so that I can walk from one number down to the individual Navigation that produced it.
33. As a performance engineer, I want distribution histograms in drill-in rather than on the landing view, so that the headline answers a question instead of showing a shape.
34. As a performance engineer, I want to see the spread across Engines, so that one Engine's LCP being 3× the others is visible.
35. As a performance engineer, I want Engines labelled `us-west-1 #1`, so that I can tell them apart without reading a session id.
36. As a performance engineer, I want a pooled Route to carry a visible note that it blends whatever journeys hit it, so that a number moving when a Test is added is legible rather than mysterious.
37. As a performance engineer looking at a single-Engine run, I want the report to read naturally, so that the common small case isn't disfigured by multi-Engine chrome.
38. As a performance engineer, I want the same Route across different Tests pooled by default and splittable on drill-in, so that the default is the aggregate I asked for.
39. As a performance engineer, I want failed Executions' Samples included by default, so that excluding the tests that failed *because the vitals were slow* doesn't delete my slowest Samples and report a faster site than exists.
40. As a performance engineer, I want a visible toggle to exclude failed Executions, so that a suite where failure means a genuinely half-loaded page can say so.
41. As a performance engineer, I want the outcome breakdown shown — *"4 of 50 failed — all CWV budget"* — so that the include/exclude choice is visible rather than assumed.
42. As a performance engineer, I want the metrics labelled lab/synthetic once in the UI, so that nobody mistakes them for field data.
43. As a performance engineer, I want to email the HTML file to someone without an API key, so that sharing needs no account and no server.
44. As a performance engineer, I want the file to render the same in six months as it does today, so that a report attached to a release record stays readable.
45. As a performance engineer, I want the file to make zero external requests, so that it works offline and leaks nothing.
46. As a performance engineer, I want to run the same command on my laptop and in CI, so that there are no separate modes to learn.
47. As a performance engineer, I want to supply credentials the way BlazeMeter's own tools take them, so that I learn no new convention.
48. As a performance engineer, I want the emitted HTML to contain no credentials, so that emailing it is not a leak.
49. As a performance engineer, I want the API key file gitignored by default and said loudly in the README, so that a stray `git add -A` cannot commit a live key.

### When things are partial or broken

50. As a performance engineer whose Engine died and emitted no zip, I want it listed as *no artifact*, so that a degraded run is not silently reported as a clean one.
51. As a performance engineer, I want aggregates to state that they cover a subset when an Engine is missing, so that I know what the numbers are made of.
52. As a performance engineer whose Report emitted no vitals at all, I want the report to say **"no samples"**, so that I never see `0 ms` and believe it.
53. As a performance engineer, I want an Execution whose outcome record is missing to be understood as having crashed before finishing, so that I learn that for free.
54. As a performance engineer fetching an archived Report, I want to be told it may take a moment, so that latency reads as latency and not as failure.
55. As a performance engineer, I want two Engines' identical filenames to both survive extraction, so that I don't silently lose half my Samples the way this codebase already has twice.
56. As a performance engineer, I want a Sample from a legacy collector to be marked `unknown` rather than guessed at, so that the incumbent's blind spots are legible rather than papered over.

### Adopting incrementally

57. As a team with the hand-rolled collector already in production, I want the dashboard to read our existing `performance-audit-*.json` records via an explicit legacy adapter, so that we get a report today without changing our suite.
58. As a team on the legacy adapter, I want the missing fields to arrive as `status: "unknown"` rather than absent, so that I can see exactly what adopting the library would buy me.
59. As a team, I want to migrate suites to the library one at a time, so that adoption is not a flag day.
60. As a maintainer, I want a format change to be one PR touching writer and reader together, so that the two cannot drift apart.

## Implementation Decisions

### Two packages, one repo

A monorepo with `collector` and `dashboard` packages. The argument is **atomicity, not shared types**: the record format is plain JSON, so shared TypeScript types are a convenience — but format drift is this project's recurring enemy (every serious bug found during mapping was two things silently disagreeing), and split repos let writer and reader diverge with nothing to stop them.

Both packages are TypeScript. Forced for the collector (it lives inside a Playwright suite); chosen weakly for the dashboard.

The collector publishes to **npm** with normal semver and Playwright as a **`peerDependency`**. Vendored copies were rejected — no versioning, and a fix must be hand-copied into every suite, which is precisely how the current hand-rolled collector's bugs spread. A git dep was rejected — it needs git egress, which is less likely than registry egress and unverified.

> ⚠️ **One empirical check before relying on this:** "does a published dep resolve on a BlazeMeter Engine?" is strongly evidenced but not proven. `bzt.log` shows npm querying the registry for its own update notice; the lockfile was re-resolved on the Engine against `registry.npmjs.org`; and Taurus rewrites `package.json` on the Engine to inject its own reporter as a `file:` dep, so `npm install` genuinely runs there. Confirm once with a real published dep — a failure would surface at run time on the Engine, where it would probably fail quietly.

### The record format — the spine

One file **per Navigation**, written to `outputPath()` and then attached via `testInfo.attach({ path })`. ~450 B each.

*(From the format grilling — this schema encodes the decisions more precisely than prose. It is the collector's only output and the dashboard's only input.)*

```json
{
  "schemaVersion": 1,
  "ts": 1752700745069,
  "url": "https://example.com/",
  "test": { "file": "example.spec.ts", "title": "demo Landing Page",
            "project": "chromium", "repeat": 18, "worker": 3 },
  "navigationIndex": 1,
  "vitals": {
    "ttfb": { "value": 167.8,   "status": "ok" },
    "fcp":  { "value": 2104,    "status": "ok" },
    "lcp":  { "value": 2104,    "status": "ok" },
    "cls":  { "value": 0.00059, "status": "ok" },
    "inp":  { "value": null,    "status": "no-interaction" }
  },
  "navigation": { "domContentLoadedMs": 1889.4, "loadEventMs": 2445.5 },
  "context": { "workers": 5, "resourceCount": 84,
               "requestCount": 87, "failedRequests": 0 }
}
```

**Identity is split — thin record, dashboard stamps.** The record carries only what the *Test* knows. The dashboard stamps `masterId` / `sessionId` / `locationId` at fetch time. The reason is **redundancy, not impossibility**: the artifact *can* self-identify (`SESSION_ID` is in the Engine env — an earlier claim to the contrary checked the wrong variable, `LOCATION`), but the dashboard already knows those ids, having fetched that very zip with them. Duplicated facts can disagree. Note `locationId` is *not* in env, only `TAURUS_LOCATIONS_INDEX`, so the dashboard must stamp location from the API regardless.

This creates two types, and they must be named separately: the on-disk **Sample** and the dashboard's **Attributed Sample**. A raw artifact file is not fully interpretable on its own — accept that.

**Every metric carries its own status.** `vitals` is a map of `name → {value, status}`. The reason travels *with* the value. The status vocabulary is **closed** — the dashboard must interpret it; anything unrecognized is treated as not-ok:

| status | meaning |
|---|---|
| `ok` | measured |
| `unsupported` | browser lacks the API (`LayoutShift` on webkit/firefox) |
| `no-interaction` | INP: nothing qualifying was clicked |
| `not-finalized` | LCP never received its trusted click / flush |
| `error` | collection threw |
| `unknown` | legacy adapter only — the incumbent cannot say why |

**Metric names are OPEN.** The core set is documented, nothing is forbidden. The dashboard renders what it knows and ignores what it doesn't. A closed enum would turn every metric-set change into a coordinated library+dashboard release, and would let a tester carry a custom timing only by asking permission. Status stays closed precisely because it *must* be interpreted; names needn't be.

**Field-level:**
- `ts` is **epoch milliseconds at Navigation start** — not ISO, not audit time, and exactly one timestamp (a second "read at" field risks plotting the wrong one). Navigation start is when the user experienced the page; LCP/CLS finalize later, but the Sample belongs at the moment its page began loading, which is what lines it up with backend load at that moment. Three consumers need this one field.
- **CLS is a true float.** Any integer-valued consumer converts at its own boundary; don't leak a deferred effort's constraint into the spine.
- `context.workers` is the **derived** per-Engine number (the Taurus reporter's `concurency` field), never `config.yml`'s declared `concurrency` — BlazeMeter splits concurrency across locations (10 ÷ 2 engines = 5).
- `schemaVersion` so the dashboard can reject or migrate. Adding a metric is **not** a version bump; changing status semantics or nesting is.
- **Discovery is by attachment-name prefix.** The zip is flat — no entry contains a `/` — so directories cannot be a handle. The name is the only discriminator; make it distinctive and stable.
- **Duplicates removed:** `firstByteMs` was byte-identical to `ttfb`; `fullpageloadtime` was byte-identical to `loadEventMs`. TTFB lives under `vitals` only (it is a vital); `fullpageloadtime` is not a vital and never belonged under `coreWebVitals`.

**A second record type — the Execution Outcome.** A Sample cannot carry `passed/failed`: Samples are attached mid-test for crash tolerance, but the outcome is only known at test end. (`retry` *is* known upfront.) So `afterEach` attaches one small record per Execution — `{schemaVersion, test:{file,title,project,repeat,worker}, status: passed|failed|timedOut|skipped, retry}`. It joins **exactly** to Samples on `(repeat, worker)`. A **missing** outcome record means the Execution crashed before finishing — the dashboard learns that for free. Cost is ~200 bytes per Execution against a zip already carrying 375 files.

Reading the outcome from the Taurus reporter's jsonl was rejected despite being free and already present: it carries `label` + `timestamp` + `duration` and **no repeat/worker index**, so with concurrent workers the Execution windows overlap and a Sample's `ts` can fall inside several. Fragile in exactly the concurrent case that is normal here.

**The 10 MB per-file cap does not constrain this format.** Records are ~450 B and the cap is per file, so one-file-per-Navigation never approaches it at any run length. The cap only ever threatened a *single accumulating* file — one reason the per-Execution NDJSON alternative lost. File count is likewise a non-issue: the real zip already holds 375 files/Engine (~300 being the incumbent's six attachments per URL); vitals were 50 of 375. Files ride inside the per-Engine zip, so cost scales with **Engines, not Navigations**.

### Transport — the two-step is mandatory

`attach({path})` and `attach({body})` are **not** the same transport, and the distinction is load-bearing.

- `attach({path})` copies the file to `attachments/{sanitize(name)}-{sha1(path)}{ext}` — **hash of the path string, not the content**. Uniqueness comes from `outputPath()` being per-test.
- `attach({body})` writes **no file**. It hands the buffer to the reporter — and **Taurus replaces the reporter** with one that discards it.

Measured on real Engines, same run, same payload, both Engines: `attach({path})` → **4/4 files**; `attach({body})` → **ZERO, and no error anywhere**. So: **write a file to `outputPath()`, then `attach({path})`**. The ergonomic shortcut does not exist, and reaching for it fails silently — producing a green run with no data, which is this library's entire reason to exist, demonstrated once more.

### Cross-Engine filename collision — a certainty, not a risk

Taurus passes a **fixed absolute `--output /tmp/artifacts/test-output`** to every Engine with the same `--repeat-each` range. Since the attachment basename is `sha1` of that absolute path, Engine A's `repeat18` and Engine B's `repeat18` resolve to the **same basename holding different vitals**. Confirmed twice: all 50/50 hashes in the real bundle were reproduced exactly from the derived path, and the probe run's two Engines emitted the same four filenames byte for byte.

**The dashboard must namespace every extraction by `sessionId`.** Merging Engines into one directory silently destroys half the Samples — the exact failure that has already hit this codebase twice (30 videos → 1; the incumbent's 98% loss).

What this does *not* threaten: identity comes from the record's **contents** (`test.repeat`, `test.worker`), never the filename. The filename is a handle, not a key. *(Note `repeat0` has no suffix.)*

### Collector ergonomics — auto-fixture

The library's whole surface is **one changed import**:

```ts
- import { test, expect, chromium } from '@playwright/test';
+ import { test, expect } from '@bzm/playwright-vitals';
```

The only optional knob the entire design adds, declared only where a tester cares about grouping:

```ts
test('order', async ({ page, vitals }) => {
  await page.goto('/order/12345');
  vitals.route('/order/{id}');   // optional. Omit it and the dashboard derives one.
});
```

**Journey vitals, not a cold audit.** Measure the page the test actually drove — do not launch a second browser to re-navigate each URL afterwards. This makes INP reachable (it was `null` ×50 *structurally*: the audit browser only `goto()`s), fixes the trap where a cold cookie-less browser silently measured the **login page** while labelling it `/account`, and halves the browser count per Engine.

**The fixture supplies everything invisibly — it must not ask the tester for anything.**
- **The flush before close is the fixture's.** `page.close()` flushes **nothing** (`runBeforeUnload: true` included), losing CLS and INP. The fixture flushes in **teardown, before the page closes**. This works because the trap is **hand-rolled**: it listens on its own `visibilitychange` listener, which synthetic events *do* reach — dodging the `web-vitals` `onLCP` `isTrusted` gate that silently drops LCP under the popular synthetic-event workaround. Navigating away flushes naturally.
- **The "real click for LCP" is not needed.** The `isTrusted` gate is a property of the `web-vitals` library, not of `PerformanceObserver`. A hand-rolled observer records every LCP candidate unconditionally, and under journey vitals the test's own clicks are real anyway. LCP is the last candidate at flush time — honest, and stated as such.

**Injection is passive `addInitScript` only; the trap pushes to Node via `exposeBinding` on flush.** Never `page.on('load')` → `evaluate()`, which perturbs the very metrics being measured.

**Use the UMD build of `web-vitals` if used at all** — the IIFE build silently breaks under `addInitScript` (its `var` never reaches `window`), yielding a plausible-looking empty result rather than an error. Prefer `channel: 'chromium'` over default headless, since LCP/INP are paint-terminated and the default runs the old `chrome-headless-shell` path.

**Rivals and why they lost — every one fails quietly:**
- *Explicit `collectVitals(page)`* — one missed call is one silently-missing Navigation. This *is* the hand-rolling the library exists to eliminate, and it cannot own the flush.
- *Navigation wrapper* — rewrites every `goto()`, and is blind to click-driven SPA route changes.
- *Reporter plugin* — dead: Taurus passes its own `--reporter` on the CLI, overriding the config. A run configuring `[['html'],['json']]` produced neither.
- *`addInitScript` in config `use:`* — dead: it cannot reach `testInfo`, and `attach()` requires it.

**Verified the fixture survives Taurus.** Taurus overrides `--reporter`, `--output`, `--workers`, `--repeat-each`, `--project`, and `-g`. **None can touch what a spec file imports.** The auto-fixture survives by construction, unlike every reporter-based design.

**Two bugs the library must not inherit:**
- **Never dump env wholesale** — the Engine env contains `SESSION_TOKEN`, a live credential. The probe printed it straight into a downloadable artifact. Read **named** variables only.
- **Do not skip non-Chromium Engines** — the incumbent's `afterEach` returns early on `browserName !== 'chromium'`, emitting nothing at all. Still emit; CLS simply carries `status: "unsupported"`. The status field exists precisely so nothing has to be skipped.

### The v1 metric set

**All five ship: TTFB, FCP, LCP, CLS, INP.** `{value, status}` carries every caveat honestly, so no metric needs dropping to dodge an awkward case — that is what `status` is *for*.

| metric | note |
|---|---|
| TTFB | Unconditional, contention-resistant. p75 183 ms on real data. |
| FCP | Unconditional. p75 2276 ms. |
| LCP | Journey clicks finalize it. LCP ≡ FCP on all 50 real Samples is a **real property of that page**, not a bug — the collector's LCP path was read and is correct. Still unverified against a page whose LCP element demonstrably differs from its FCP element. |
| CLS | Chromium-only → `unsupported` on firefox/webkit, never a fake `0`. Real float: `0.00059` ×35, `0.00062` ×6, exact `0` ×9 — so `cls: 0` and `cls: null` genuinely coexist. |
| INP | Reachable under journey vitals. **Honest framing: it samples only the interactions you scripted — a within-harness regression signal, not a field-comparable p75.** |

Supporting non-vital timings (`domContentLoadedMs`, `loadEventMs`) ride along in the record.

### Aggregation semantics

> **Pool Attributed Samples over `sessionId` and `repeat`; everything else is a dimension you slice by.** Pool raw Samples, then compute the percentile **once** — never average per-Engine percentiles. The mean of p75s is not the p75.

**p75 leads. No mean.** p50/p95 shown for shape. The user's *"avg across all"* means **one aggregate over everything** — which the pooling rule delivers — not the arithmetic mean. On real data mean and p75 differ by just 58 ms (2.6%), so this is **not** an accuracy argument. The decisive one: **web.dev's thresholds are *defined* at p75**, so colouring a mean against them is wrong by construction. Today both land "good", so the error would be invisible — and would bite silently later, which is this project's recurring failure mode.

**Cold Starts: keep, flag, never trim silently.** Measured — the five slowest of 50 Samples are `repeat0..4`, the first Execution on each of five Workers, **~45% inflated** (3284 → 2200 ms). Identifiable directly as the *first Navigation by `ts` for each (`sessionId`, `workerIndex`)*. They are **real page loads** — a user hitting a cold CDN edge experiences exactly this — so deleting them reports a world that doesn't exist, and silent trimming breaks reproducibility from the raw data. p75 is robust to them by proportion (5/50 = top 10%). *This corrected an argument made earlier in the same grilling: the p95 of 3120 is not a tail, it is a Cold Start.*

**Unavailable ≠ zero.** Compute over `status: ok` Samples only and **always state the denominator** — *"p75 over 41 of 50 — 9 unsupported"*. When nothing is `ok`, show the **reason, not a number**: `INP — no interaction (0 of 50)`. Coverage is the only thing stopping *"CLS 0 across 50 samples"* from meaning both "perfectly stable" and "we never measured it".

**Weight Samples, not Engines.** Engines run **identical `(Test × repeat)` sets** — Executions are replicated across Engines, never partitioned — so counts differ **only via failure**, never by design. Equal-weighting Engines would correct for an imbalance that only exists when something broke, and the coverage line already reports that.

**Failed Executions: include by default, configurable to exclude.** The intuitive default is actively harmful here. Measured: failed n=4, mean FCP **3252**; passed n=46, mean FCP **2129**. All 4 failures were `[CWV HARD FAIL]` budget breaches — **zero were real breakages**. Those tests failed *because the vitals were slow*, so excluding them deletes exactly the slowest Samples (and almost certainly the Cold Starts), biasing every percentile faster, silently and directionally. Show the outcome breakdown so the choice is visible. The escape hatch exists for suites where failure means the page genuinely broke and its vitals describe a half-loaded page.

**No minimum sample count.** The coverage line makes an `n=2` percentile *visible* rather than misleading, which is the honest fix.

A retry is **another Execution**; passing retries pool normally. (Note `retries: process.env.CI ? 2 : 0` in the real config — if `CI` is set on Engines, retried Executions are live today and silently add Samples.)

### Identity and correlation

**The Route is the join key** — the normalized URL. The tester declares it optionally; the dashboard derives it otherwise; a declared Route always wins. The **raw URL is always kept**, so any normalization stays re-derivable forever.

Same Route across different Tests **pools by default, splits on drill-in** — with the caveat, carried visibly, that a pooled Route is a blend of whatever journeys hit it.

**Engine Label = `us-west-1 #1`** — label for humans, `sessionId` for joining; never key on the label. Runs with one Engine per location read simply as `us-west-1`. Engines are **ephemeral** — `sessionId` changes every run, so no Engine is stable across Reports.

`repeat` is a **sample discriminator, not a correlation key**: pairing Engine A's `repeat1` with Engine B's `repeat1` is meaningless — they ran at different moments in different orders. **Worker** is not a domain term and never an aggregation dimension, but it is not discardable either: it identifies Cold Starts. **"Page" is banned** as ambiguous between URL and Route.

### The dashboard is a generator, not a viewer — forced, not chosen

```bash
npx @bzm/vitals-dashboard --master 82723459 --out report.html
```

`dataUrl` **expires in 20 minutes**, so a file holding a pre-signed URL renders beautifully today and is **broken tomorrow, silently**. The tool therefore **fetches → embeds → emits**: data baked in at build time, artifact permanent. Same command on a laptop or as a CI step — no separate modes. Nothing hosted, nothing stateful.

**Pleasant consequence:** `dataUrl` is **pre-signed** — an unauthenticated GET returns 200. So credentials are needed only to **find** artifacts, never to **fetch** them. The generator authenticates the two listing calls; the bytes need nothing. The emitted HTML contains **no credentials** and is safe to email.

### The API chain

Everything is **per-session**, so the session list always comes first — *there will be at least one*, never assume exactly one:

```
GET /api/v4/masters/{id}/status          -> result.sessions[] {id, status, locationId}
GET /api/v4/sessions/{sid}/reports/logs  -> result.data[] {filename, dataUrl}   (pick filename == "artifacts.zip")
GET {dataUrl}                            -> zip bytes (storage.blazemeter.com, pre-signed, 20-min expiry)
```

Artifacts are **session-scoped only** — there is no merged master-level artifact. The session id **is** the Engine id (`r-v4-…`), with **no human-meaningful label** (`session.name` is the report name repeated per Engine), which is why drill-down must synthesize one. **Session↔Engine is 1:1** — verified; the whole per-Engine premise rests on it. The API-served zip is **flat**, confirmed independently of the UI bundle.

Never cache a `dataUrl`; **re-list `/reports/logs` immediately before each download**, cache the *bytes*, and retry a stale 403 by re-listing. Lazy per-Engine drill-down is therefore viable, which makes eager whole-report download an explicit choice rather than a necessity.

Auth is **Basic `api_key_id:api_key_secret`** — exercised for real against a live master.

The fetch path for the deferred trending work **already exists**: `GET /api/v4/masters?testId={testId}` walks a Test's whole run history. v1 takes `--master {id}`; nothing needs inventing later.

**Archived Reports are readable.** Archiving is a **storage tier, not an expiry** — the API retrieves archived Reports and data older than 30 days. Proven: a master created ~48 days prior returns `ENDED`, lists 4 sessions, and its `artifacts.zip` is still fetchable. *(The contrary belief was inherited from the BlazeMeter MCP's own stated inability to read archived detail — that is the MCP's limit, not the platform's. Trust the API over the MCP; trust the archives over the docs.)* A restore may add latency, so *"fetching an archived report — this may take a moment"* is a nicety, not a failure state.

### Two producers, so the seam is real: the legacy adapter

The library's format is **canonical**. A small, **explicitly named** legacy adapter maps today's `performance-audit-*.json` into it. The incumbent has 50 real Samples in a bundle right now; the library has zero adopters — so the adapter means the dashboard is buildable and demoable against real data **today**, and teams migrate at their own pace. It also proves the format is a genuine contract rather than the library's private output shape: one adapter is a hypothetical seam, two is a real one.

The mapping, and what it exposes: `url` → `url`; `generatedAt` → `ts` (**with the caveat that it stamps the audit, not Navigation start — the adapter must not claim otherwise**); `coreWebVitals.*` → `vitals.*.value`; **status is `ok` if non-null, else `unknown`** — the incumbent cannot say why; `navigation.*` → `navigation.*`; counts → `context.*`. **Unavailable entirely: `test.*`, `navigationIndex`, `context.workers`** — the incumbent carries no test identity at all beyond a URL.

That is not the adapter being lossy — it is the incumbent's blind spot, finally legible.

### Dashboard shape

**Winner, chosen by prototyping four variants against the real 50 Samples: the Route table, then the timeline.** *"What is the state?"* then *"how did it move?"*, in the order people ask.

- **Landing view** — Routes as rows, metrics as columns, p75 leading, coverage under every value, threshold dot (p75-vs-p75 only), drill-in expands.
- **Timeline second** — vitals across the run's duration with the p75 as a reference line.
- **Distribution histograms lost as a landing view** — they are a **drill-in detail**, not a headline. The timeline carries shape at the top level; the histogram carries it per-metric below.
- **Drill-down: Report → Route → Test → Engine → Navigation.** No invented levels. Use the glossary's words in the UI.
- **Engine is a level, not a screen.** Engines are ephemeral, so "compare this Engine across Reports" is impossible by construction. Show the spread; never adjudicate it.
- **Label the metrics lab/synthetic once** — a word, not a caveat engine.
- **Empty/partial states are the normal case, not an edge case.** `INP — no interaction (0 of 50)` renders as a real case. Engines with no artifact are listed as *no artifact*. Never render a `null` as `0`.

**Build the N-series seam now, ship one series through it.** The timeseries must be modelled as **N series on a shared absolute wall-clock axis**, vitals merely the first. v1 ships vitals only — but the deferred enrichment work joins foreign series that may arrive from a **different master** overlapping partially or not at all, and wall-clock is then the only thing they share. A vitals-only chart keyed on a test-relative axis would need tearing open; the seam costs near nothing now.

**What the real data proved on screen** (and why the prototype earned its keep): all five Cold Starts stack visibly at 0s, top-left of the LCP timeline — the finding renders as a **picture**, not a caveat. TTFB is visibly flat while LCP scatters. LCP and FCP histograms are identical — impossible to miss once plotted. And **LCP 2276 renders green while FCP 2276 renders amber** — same number, opposite verdict, because the bands are per-metric. Per-metric thresholds are load-bearing, not decorative.

> ⚠️ **Multi-Engine layout is unvalidated.** The real bundle has one Route, one Test, one Engine; the prototype's other rows are labelled synthetic and exist only to show layout. **A validation target already exists** — master `82280099` (test `15662714`, "PlaywrightJam - Web Vitals"), **four Engines on four continents** (`us-east-1`, `europe-west2-a`, `australia-southeast1-a`, `africa-south1-a`), still fetchable at 48 days old, and it should carry real vitals. It is the hardest possible case for the pooling rule: TTFB from `africa-south1-a` vs `us-east-1` differs by **network distance, not application performance** — the objection that was descoped on the user's call. **Pooling stands, but seeing what it looks like on screen is worth doing before shipping.** Cheapest next step for whoever builds this: fetch those four zips (namespaced by `sessionId` — the filenames **will** collide), point the prototype at them, and look.

### Secrets

BlazeMeter's own convention, so nobody learns a new one:

```bash
export BLAZEMETER_API_KEY=~/.blazemeter/api-key.json     # {"id": "...", "secret": "..."}

# CI — a file is awkward; accept discrete vars
BLAZEMETER_API_KEY_ID / BLAZEMETER_API_KEY_SECRET
```

🔴 **Ship `api-key.json` in `.gitignore` and say so loudly in the README.** Not hypothetical: during this project's own mapping the key sat **unignored at the repo root of a git repo with no `.gitignore` at all**. It was untracked so nothing leaked — but a stray `git add -A` would have committed a live key. If it happened here, it will happen to a user.

## Testing Decisions

### What makes a good test here

**Test external behavior, never implementation details.** For this codebase that has a sharp, specific meaning, because every expensive bug found during mapping was invisible to a unit test: `attach({body})` returning normally while writing nothing; a fixed-name file surviving locally and collapsing to 1-of-50 under Taurus's flattening; an `afterEach` early-returning on non-Chromium and emitting nothing; `page.close()` flushing nothing. **Each of those passes any test that mocks the boundary it fails at.** So the tests must bite at the boundary where the artifact actually appears — a file on disk, an HTML file on disk — not at a function that returns an object.

Corollary: **a test that asserts "we called `attach()`" is worthless here.** The whole point is that calling it correctly and still getting nothing is the normal failure. Assert the **files that exist**.

Seams confirmed with the user. Three, and no more.

### Seam 1 — the collector: a real Playwright run, asserting files on disk

Fixture specs import the library exactly as a tester would and run against a **local static page** under a real `npx playwright test`. Tests then read the output directory and assert on the JSON files that survive.

This is the **highest possible seam** — it is literally the tester's entry point, and it is the only seam that can catch the silent-failure class above. What it covers:

- The one-changed-import surface works with an otherwise-unmodified test body.
- One Sample file per Navigation exists, with the right shape and `schemaVersion`.
- The write-then-`attach({path})` two-step actually produced a file.
- The Execution Outcome record exists in `afterEach` and joins to Samples on `(repeat, worker)`.
- CLS and INP survive the flush — i.e. the fixture's teardown flush happens **before** the page closes. A local page that shifts layout and has a clickable target makes both assertable.
- A journey that only navigates reports INP `no-interaction`, not `0` and not absent.
- A non-Chromium project still emits Samples, with CLS `unsupported`.
- `ts` is epoch ms at Navigation start.
- A test that throws mid-journey keeps the Navigations already recorded, and its outcome record says so.
- The optional `vitals.route()` lands in the record; omitting it is fine.
- **The library never reads env wholesale** — assert no artifact contains a token-shaped value.

**Prior art to steal from, including its mistakes:** the incumbent `example.spec.ts` (1,673 lines) is a working reference implementation whose six named defects are this seam's checklist. Every one of them should have a test that fails against the incumbent's behavior and passes against the library's.

### Seam 2 — the dashboard: the CLI end-to-end, asserting the embedded JSON

Run the CLI with the BlazeMeter HTTP calls stubbed and **real zip bytes as fixtures** (the `artifacts (17)` bundle and the two-Engine probe run — both real, both already carrying the collision). Then parse the JSON data blob the HTML **must embed anyway** (the 20-min `dataUrl` expiry forces it) back out of the emitted file, and assert on that.

This keeps the dashboard to **one seam and no new interface** — the embedded blob is a real product requirement, not a test hook. What it covers:

- The full chain: sessions enumerated (never assume exactly one), `artifacts.zip` picked from `/reports/logs`, bytes fetched.
- **Extraction is namespaced by `sessionId`** — the load-bearing test. Feed it the two-Engine probe fixture whose Engines emit byte-identical filenames and assert **both** Engines' Samples survive. This test exists because the failure it prevents has already happened twice in this codebase.
- Attributed Samples carry `masterId` / `sessionId` / `locationId` stamped at fetch.
- Pooling is over `sessionId` and `repeat`; percentiles computed once over pooled raw Samples.
- p75 leads; **no mean** appears anywhere in the model.
- Coverage accompanies every aggregate, with the right denominator.
- `status != ok` is excluded from percentiles and **never pooled as 0**.
- Cold Starts are identified as first-`ts`-per-(`sessionId`, `workerIndex`) and labelled, not trimmed. The real bundle's five are a known-answer fixture.
- Failed Executions included by default; the exclude toggle changes the numbers in the expected direction.
- The legacy adapter maps `performance-audit-*.json` with missing metrics as `unknown` — asserted against the real 50-Sample bundle.
- Partial states: a session with no artifact is listed as *no artifact*; a Report with zero vitals files yields **"no samples"**, never `0`.
- **The emitted HTML makes zero external requests and contains no credentials** — assert on the file's bytes.
- Engine Label ordinals (`us-west-1 #1`).

Known-answer fixtures from the real bundle make several assertions exact rather than approximate: LCP `mean 2218.4 · p50 2152 · p75 2276 · p95 3120 · max 3364`; INP `no-interaction` on 50 of 50; CLS `0.00059` ×35, `0.00062` ×6, `0` ×9; 4 failed Executions, all CWV budget.

### Seam 3 — the format-drift guard

**One cross-package test**: the collector's real emitted files, fed straight into the dashboard's parser, asserted to round-trip. The monorepo's atomicity argument only pays off if something actually checks — and format drift is the failure mode that produced every serious bug on this map.

### Not tested, deliberately

- **Rendering geometry.** The prototype found a real layout bug (CLS axis labels colliding, since 41 of 50 Samples share a value) by being *looked at*, not asserted. A colour/contrast validator catches colour; nothing cheap catches geometry. Look at it; don't write a test that pretends to.
- **Live BlazeMeter API calls in the test suite.** Stub the HTTP; the real chain is verified by the one-off empirical checks named below.

### Two empirical checks that are not unit tests

1. **Does a published npm dep resolve on a BlazeMeter Engine?** Strongly evidenced, unproven. Confirm once with a real published dep before relying on it — a failure surfaces at run time on the Engine, where it would probably fail quietly.
2. **Does the multi-Engine layout hold on real multi-Engine data?** Fetch master `82280099`'s four zips and look, before trusting the layout.

## Out of Scope

**Measurement validity / backend attribution.** Whether a vital measured on a contended Engine can attribute degradation to the backend rather than the rig. The user's explicit call: load is generated independently of Playwright, multi-Engine concurrency is a given, and *"this is not the issue I care about."* This project **gathers and presents**; adjudicating attributability is a different product.

The contention is **real and measured** — LCP inflates **4.3×** from concurrency 1→16 on identical content, and the observed run put 5 Playwright workers on one Engine sharing one cgroup-scoped CPU. Out of scope means *not answered here*, not *not true*. It is a **known property of the data**, recorded so nobody rediscovers it and assumes it was missed. It never gates a decision, and the dashboard must **show the spread without explaining it**.

It is also a **configuration, not a platform constraint**: sessions-per-engine is a knob, and 1 session per Engine is available and would make the point moot. So the dashboard must not assume, hardcode, or infer the contention level — it is a **per-run property to be recorded** (`context.workers` per Sample; `locationId` per Attributed Sample).

**How bad contention is on real BlazeMeter infra.** Abandoned, not resolved — it existed only to quantify a question no longer being asked. Returns only if the destination is redrawn toward attribution.

**Phase two — enriching the report with foreign timeseries.** Pulling two more series *in*: a concurrent JMeter test's backend load metrics, and Engine health. **Deferred, not blocked — and it constrains v1 by design** (the user's call: *"design the seam now, build only vitals"*): the timeseries is N series on a shared absolute wall-clock axis, the format carries absolute epoch `ts`, and identity carries `masterId`/`sessionId`/`locationId`. See Further Notes for what is already known about it.

**Phase three — injecting vitals back into BlazeMeter's Timeline** via `POST /api/v4/data/timeseries`. Feasibility is proven; the user's call is a separate spec and grilling session. Its constraint on v1 is already absorbed: CLS stays a true float, and phase three converts at its own boundary.

**Cross-run trending.** A trend store consuming the same format. The format carries enough identity (absolute epoch `ts`, run id) not to preclude it, and the fetch path already exists (`GET /api/v4/masters?testId=`). **There is no deadline** — archiving is a storage tier, not an expiry, so a v1 that persists nothing forecloses nothing. One real constraint survives: Engines are **ephemeral**, so a trend store can never trend "the same Engine over time". **Trend Routes, not Engines.**

**Non-Playwright executors.** Whether the format could carry Selenium/scriptless vitals.

**Full Playwright report replacement** — traces, videos, screenshots, merged multi-Engine HTML. BlazeMeter's UI already serves these; vitals are the gap.

**Test outcomes / pass-fail / flake dashboards.** Same reason. (The Execution Outcome record exists to *contextualize vitals*, not to become an outcomes product.)

## Further Notes

### Trust the archives over the docs; trust the API over the MCP

Two standing rules, both earned. The executor docs describe a config mapping that `bzt.log` contradicts. The Playwright docs describe a `json` reporter that Taurus overrides on the CLI. The BlazeMeter MCP states archived reports cannot be read in detail — which is **the MCP's limitation, not the API's**, and it got attributed to the platform, where a research agent then read a `Not Found` on an old master as corroboration. Anyone building against this should verify against real artifacts and the live API, not documentation.

### The real Taurus invocation

`config.yml`'s `concurrency`/`iterations` do **not** map 1:1 to Playwright flags:

```
config.yml:  concurrency: 10   iterations: 10   locations: us-west-1:1, us-west-2:1

actual CLI:  npx playwright test /tmp/artifacts/example.spec.ts \
               --reporter "@taurus/playwright-custom-reporter" \
               --output /tmp/artifacts/test-output \
               --workers 5 --repeat-each 50 --project=chromium -g 'Landing_Page'
```

**`--workers` = concurrency ÷ engines** (10 ÷ 2 = 5) and **`--repeat-each` = workers × iterations** (5 × 10 = **50**, not 10). Total Executions = `concurrency × iterations`, split per Engine. `--output` being a **fixed absolute path identical on every Engine** is what causes the filename collision. Read this from `bzt.log`, not the docs.

### The Playwright test is a Taurus *Performance* test

`type: taurus`, `executionType: taurusCloud` — **not** "GUI Functional". This decides which BlazeMeter features apply to it, and it is why it would be eligible for a perf Multi-Test (which yields **one master spanning constituent tests**, run simultaneously, artifacts still per-session — so the retrieval design is unaffected). *Unverified:* no doc explicitly states a `playwright`-executor test can join a perf multi-test.

### What phase two already knows, so it isn't re-researched

- **All BlazeMeter timestamps are absolute UNIX epoch**, so a concurrently-run *separate* master needs no correlation trick — just a shared wall clock. **Two traps:** KPI `ts` is in **seconds** while Engine-health interval keys are in **milliseconds**; and there is **no documented `started` field** on a master — use `/api/v4/masters/{id}/sessions` for per-session times.
- **Backend timeseries: two endpoints, both read-only.** `GET /api/v4/data/kpis` (`interval`, `from`, `master_ids[]`, repeated `kpis[]`, repeated `labels[]` — **max 100 labels**) and `GET /api/v4/masters/{id}/kpi-values` (**only 1, 10, or 60s granularity**). `/reports/aggregatereport/data` is a **summary per label, not a timeseries**.
- **Engine health is collected on the Playwright Engines themselves** — confirmed against the user's own run: the Engine's `bzt.log` shows `Using Cgroups2LocalMonitor` and the `Launching Playwright:` line in the same run. So browser-host CPU/memory *is* recorded on the very host measuring the vitals. **Caveat: `Cgroups2` means container-scoped, not bare-host.**
- **Engine health is an artifact file, not a KPI stream** — it will **not** come from `data/kpis`, and it is **not in the artifacts bundle** (verified: 375 files, zero matching `*monitoring*`). Read it at `GET https://a.blazemeter.com/hs/api/v1/metrics/engine-health?sessionId={sessionId}&itemsCount=1000`. **Note the surface — `/hs/api/v1/`, not `/api/v4/`** — a different, **undocumented** API, which is why a docs sweep finds nothing. Treat as stable-in-practice, not a contract. Keyed by `sessionId`, the same key v1 already carries, so the join is direct. It **downsamples adaptively past 500 points**, so granularity degrades on long runs — it is not a fixed grid.
- **`Compare Reports` is a two-run A/B overlay**, not a cross-master time-correlation tool. It cannot merge browser vitals with backend load.

### The map's own record is worth reading before building

It corrected itself repeatedly, and the corrections are the valuable part: the `attach()` mechanism was right for the wrong reason (path-hash, not content-hash); the 10 MB cap never applied to this format; `iterations → --repeat-each` was wrong; Lighthouse was never running (someone saw filenames and inferred a tool — the files are hand-rolled by the spec itself); "LCP is fake" was a false alarm retired by reading the code; "engine drift" was the exact opposite of the truth (Executions are replicated, not partitioned — which is *why* pooling is coherent); and the intuitive default on failed Samples would have reported a faster site than exists.

**Every one of those was caught by measuring rather than reasoning.** That is the habit this build should inherit.

### Other odds and ends

- `artifacts.zip` **is not generated at all** if a test terminates ungracefully — which compounds "failed Engines may emit no artifact" into a normal case rather than an edge one.
- The incumbent's file is named `.ndjson` but is **pretty-printed** — not valid NDJSON even at one record. Don't inherit that.
- A third vitals copy exists in the Taurus reporter jsonl's `logs` field as ANSI-coloured text. Log files bypass the 10 MB cap, so it is a viable **fallback** source — not a primary one.
- Domain vocabulary is pinned in [CONTEXT.md](CONTEXT.md) and should be used in code, UI, and tickets alike.
