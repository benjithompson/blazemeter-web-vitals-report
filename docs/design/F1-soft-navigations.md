# F1 · Soft Navigations (SPA route changes): design

Status: **design spike** (ticket F1, issue #47, label `needs-design`). This document is the output. It changes no production code. The prototype in [`f1-prototype/`](f1-prototype/) sits outside every package and every test glob.
Blocked by: C6 (#42), which is merged (#70). The design builds on its context-wide `navigationIndex` and its `pageIndex`.
Vocabulary: [CONTEXT.md](../../CONTEXT.md). Constraints X1 to X7: [SPEC-HARDENING.md §3](../../SPEC-HARDENING.md#3-cross-cutting-constraints-every-ticket).
Survey date: **2026-11-07**. Every claim about the platform below either cites a dated source or is marked **observed**, meaning the prototype measured it on this repo's Chromium (Chrome for Testing 153.0.8010.12, Playwright 1.63.0).

---

## 0. Summary of recommendations

| Question | Recommendation |
|---|---|
| Is the platform ready? | **Yes, on Chromium only.** The `soft-navigation` and `interaction-contentful-paint` entry types are enabled by default from Chrome 151. Firefox and Safari have neither and have taken no standards position. |
| Support detection | `PerformanceObserver.supportedEntryTypes` must contain **both** `soft-navigation` and `interaction-contentful-paint`. If either is missing, the trap behaves exactly as today: one Sample for the whole document. Never use interface names (the Chrome docs and the shipped build disagree on them, §1.2). |
| Launch flags | **None.** On Chromium 153, soft navigations are on in both the headless shell (Playwright's default) and new headless (`channel: 'chromium'`). `--enable-experimental-web-platform-features` changed nothing observable, so the collector must not add it. `--disable-features=SoftNavigationHeuristics` turns the feature off and is the tester's kill switch. |
| How a soft Navigation becomes a Sample | Each `soft-navigation` entry opens a new Navigation inside the same document. Its Sample has `ts = round(timeOrigin + entry.startTime)`, `url = entry.name`, the next context-wide `navigationIndex`, the document's `pageIndex`, and a new additive field `navigationKind: 'soft'`. The document's own load becomes `navigationKind: 'hard'`, and its window now ends where the first soft Navigation starts. |
| Field name | **`navigationKind`**, not the spec's working name `navigationType`. The shipped entry already has a `navigationType` field with different values (`push`, `replace`, `traverse`, observed), and so do Navigation Timing, web-vitals and CrUX. This is open question Q1 for the owner. |
| Absent field | Absent means **"the whole document, soft Navigations not split out"**. That is true both for every old collector and for an engine without support (Firefox, WebKit, Chromium < 151). So Firefox writes no `navigationKind` and no soft Samples, and never writes a wrong one. |
| Metrics on a soft Sample | FCP, LCP, CLS and INP are measured. LCP comes from interaction-contentful-paint, and FCP and LCP are measured from the interaction. CLS and INP restart at each Navigation. **TTFB is not carried**: the key is absent, never `0` and never a new status, because the status vocabulary is closed and a new status would mean a `schemaVersion` bump. `navigation.domContentLoadedMs` and `navigation.loadEventMs` are `null`. |
| Cold Start | **No rule change.** A soft Navigation starts after its own document's hard one, so it can never be the first Navigation by `ts` on a Worker. |
| Route | `routeOf` is unchanged, because the soft Sample's `url` is the new SPA URL. `vitals.route()` changes from "the next Navigation to report takes it" to **"the Navigation that was current when `route()` was called"**, decided by comparing timestamps. The prototype shows that the old rule would give the route to the wrong Sample (§3.6). |
| Passive measurement (X4) | Kept. The trap adds only observers. The single new page-to-Node message is sent when the browser hands the trap a `soft-navigation` entry. There is no new `page.evaluate` and no new CDP round-trip. |
| Dashboard | `navigationKind` becomes a **dimension**. Route rows split into hard and soft, because a soft LCP is measured from a click while a hard LCP is measured from a document request. Pooling the two under one p75 would mix two different quantities (CrUX blends them; we should not, §5). |

---

## 1. Survey: the platform as of 2026-11-07

### 1.1 Shipping status

| Fact | Source |
|---|---|
| Origin trial "Soft Navigation Heuristics" ran from **M139 to M144** (desktop, Android, WebView). | blink-dev *Intent to Ship: PerformanceSoftNavigation and InteractionContentfulPaint performance entry*, 2026-06-23 [S1] |
| The intent to ship targets **M151 on all platforms**, "enabled for all users". The about://flags name is `soft-navigation-heuristics` and the Finch feature is `SoftNavigationHeuristics`. Gecko and WebKit signals: "No signal". LGTM1 came from Alex Russell and LGTM2 from Vladimir Levin. A third LGTM reply was truncated in what I could fetch. | [S1] |
| "The soft navigations feature is enabled by default from Chrome 151." | Chrome for Developers, *Measuring soft navigations*, last updated 2026-09-20 [S2] |
| An earlier experiment was paused after M123 to review feedback, then re-run. | blink-dev *Intent to Extend Experiment: Soft Navigation Heuristics* [S3] |
| **Observed:** on Chromium 153 with no flags, both entry types are listed in `supportedEntryTypes` and entries fire. This holds in the headless shell and in new headless alike. | prototype, §2 |

**Not confirmed:** the exact M151 stable date. One secondary source says late July 2026 [S8], and I did not check it against the Chromium release schedule. Also unconfirmed: whether the third LGTM landed. The default-on behaviour I observed on M153 makes both moot for this design.

### 1.2 The entry types

**`soft-navigation`** (interface `PerformanceSoftNavigation`, observed). Fields, as documented in [S2] and observed:

| Field | Meaning | Observed example |
|---|---|---|
| `name` | The new URL | `http://127.0.0.1:…/products` |
| `startTime` | The start of the initiating interaction, so it includes the event handler | `575.1` |
| `duration` | From the interaction to the first contentful paint | `28.9` (fast handler), `129.0` (120 ms busy-wait handler) |
| `navigationId` | Unique per Navigation. It is also stamped on **every other entry** (`event`, `layout-shift`, `largest-contentful-paint`, `interaction-contentful-paint`), observed | `3012` |
| `interactionId` | The initiating interaction | `4537` |
| `paintTime`, `presentationTime` | The soft Navigation's FCP | `presentationTime: 584` |
| `navigationType` | `push` / `replace` / `traverse`. **Not documented in [S2]; observed** | `push` for pushState clicks, `traverse` for `page.goBack()` |
| `getLargestInteractionContentfulPaint()` | The largest ICP entry for this Navigation | present and working (observed) |

**`interaction-contentful-paint`** (interface `InteractionContentfulPaint`, observed). It is emitted after any interaction that leads to a contentful paint, including interactions that are not soft navigations [S2]. Its own `startTime` and `duration` are the **interaction's**, not the paint's. The paint is in a nested `largestContentfulPaint` entry with `renderTime`, `size` and `navigationId` (observed). My first prototype run read `icp.renderTime`, which is undefined, and produced soft LCP = 0. That is a trap to pin in a test.

**Naming discrepancy:** [S2] (as I fetched it) describes detection through a `SoftNavigationEntry` global. On M153 that global is `undefined`, and `PerformanceSoftNavigation` exists (observed). Detection therefore uses `supportedEntryTypes` only.

### 1.3 The heuristic: what counts as a soft navigation

From [S2]: it is "initiated by a user action", it "results in a visible URL change to the user", and the "interaction results in a visible paint". [S2] states that false positives and false negatives are possible. Observed:
- Playwright's `page.click()` and `keyboard.press('Enter')` on a link both count. They are trusted input, so a scripted journey triggers the heuristic.
- A click that only calls `history.replaceState` without painting new content does **not** count.
- `page.goBack()` onto a same-document history entry **does** count, as `navigationType: 'traverse'` with an `interactionId`, even though no in-page input occurred.

### 1.4 Per-metric semantics (Chrome and web-vitals)

| Metric | Soft-navigation semantics | Source |
|---|---|---|
| LCP | Initialised from `getLargestInteractionContentfulPaint()`, relative to the soft Navigation's `startTime`. Hard LCP still finalizes at the first interaction. | [S2] |
| FCP | `presentationTime` relative to the soft start. Paints from the previous view are excluded. | [S2], [S5] |
| INP | Reset at each soft Navigation. The previous Navigation's INP is finalized there, and the **triggering interaction is attributed to the previous Navigation**. | [S2], [S5] |
| CLS | Reset at each soft Navigation, with session windows per Navigation. | [S2], [S5] |
| TTFB | "Reported as 0", the same as a bfcache restore. | [S2], [S5] |

web-vitals (README on `main`, fetched 2026-11-07 [S5]) exposes this as `reportSoftNavs: true`, with `navigationType: 'soft-navigation'` on the metric and a `navigationId`. It notes that enabling it changes the first page's metrics, because CLS and INP are locked in at the first soft navigation. Our design has the same consequence (§6 R1).

### 1.5 Firefox and WebKit

- Chrome's own docs say: "limited to Chromium-based browsers only" [S2].
- Mozilla standards-positions #854 is open, status "Needs proposed position". Its last activity was 2025-02-10 [S6].
- WebKit standards-positions #235 was closed on 2026-08-19 as a duplicate of #687. #687 (opened 2026-06-11) is open with no position label [S7].
- **Not verified locally:** Firefox is not installed in this environment, so the prototype was not run on it. The design does not depend on how Firefox behaves, only on `supportedEntryTypes` lacking the two types, which follows from the sources above. The negative control (§2) reproduces the no-support path on Chromium. It also shows that **`navigationId` disappears from every entry** when the feature is off, so it cannot be used as a support signal on its own.

### 1.6 CrUX

- 2026-10-13, web.dev, *Experimental soft navigation metrics now available in CrUX* [S4]. From the October 2026 release, three metrics are in BigQuery, the CrUX API and the CrUX History API: `experimental_largest_contentful_paint_with_softnavs`, `experimental_interaction_to_next_paint_with_softnavs` and `experimental_cumulative_layout_shift_with_softnavs`.
- They "blend soft navigations with hard navigations". INP and CLS are segmented per Navigation. FCP and navigation types were "anticipated" for the November release.
- Stable CWV are unchanged. Graduation is targeted for **May 2027**, after which Search Console switches over [S4].
- **Not confirmed:** whether the November 2026 CrUX release (FCP, navigation types) has landed, and the exact BigQuery column names (a search snippet mentions `*_sn` summary columns, which I did not verify).

---

## 2. Prototype and observed output

Files:
- [`f1-prototype/spa.html`](f1-prototype/spa.html) is a minimal SPA with three routes, using `history.pushState` and re-rendering `<main>`. `/order/12345` has a 120 ms busy-wait handler (an INP signal) and a late banner 900 ms after render (a CLS signal outside the 500 ms `hadRecentInput` window). A "silent" button calls `replaceState` without painting.
- [`f1-prototype/soft-nav-trap.js`](f1-prototype/soft-nav-trap.js) is a standalone trap, injected with `context.addInitScript`. It slices one document into Navigations and computes per-slice vitals.
- [`f1-prototype/run-prototype.mjs`](f1-prototype/run-prototype.mjs) serves the SPA, drives the journey with real Playwright input, applies the proposed time-window `route()` rule in Node, and prints the would-be Samples. It runs in four launch variants. Run it with `node docs/design/f1-prototype/run-prototype.mjs` (add `--json` for every raw entry). No test glob matches `docs/`.

The journey: `goto /`, click Products then `route('/products')`, click Order then `route('/order/{id})`, wait for the banner shift, click silent, press Enter on Products, then `page.goBack()`.

Observed output, the final run of 2026-11-07, verbatim but trimmed to two variants (all four were run several times with the same shape; only the timings vary):

```
=== new headless (channel 'chromium'), no flags
  UA: ... HeadlessChrome/153.0.0.0 Safari/537.36
  supportedEntryTypes has soft-navigation: true, interaction-contentful-paint: true, globals: {"PerformanceSoftNavigation":"function","SoftNavigationEntry":"undefined","InteractionContentfulPaint":"function"}
  soft-navigation entries: 4; ICP entries: 4; event navigationId vs time window: {"agree":10,"disagree":0,"noNavigationId":0}
  timeline (ms since journey start):
    node   683  click(products) resolved
    node   683  route(/products)
    node   705  soft-navigation-seen (page 704) http://127.0.0.1:42509/products
    node  1640  soft-navigation-seen (page 1638) http://127.0.0.1:42509/order/12345
    node  1641  click(order) resolved
    node  1641  route(/order/{id})
    node  3481  Enter(products) resolved
    node  3505  soft-navigation-seen (page 3504) http://127.0.0.1:42509/products
    node  4089  goBack() resolved
    node  4105  soft-navigation-seen (page 4104) http://127.0.0.1:42509/order/12345?silent=1
  would-be Samples:
    #1 hard / navId=5896 shifts=0 {"ttfb":7.6,"fcp":44,"lcp":44,"cls":0,"inp":24}
    #2 soft /products route=/products (route() +8ms after start) navId=5903 shifts=0 {"fcp":23.4,"lcp":23.4,"cls":0,"inp":128}
    #3 soft /order/12345 route=/order/{id} (route() +134ms after start) navId=5910 shifts=1 {"fcp":130.5,"lcp":130.5,"cls":0.063,"inp":16}
    #4 soft /products navId=5917 shifts=0 {"fcp":18.1,"lcp":18.1,"cls":0,"inp":"no-interaction"}
    #5 soft /order/12345 navId=5924 shifts=0 {"fcp":8,"lcp":8,"cls":0,"inp":"no-interaction"}

=== new headless + --disable-features=SoftNavigationHeuristics (negative control)
  supportedEntryTypes has soft-navigation: false, interaction-contentful-paint: false, globals: {"PerformanceSoftNavigation":"undefined","SoftNavigationEntry":"undefined","InteractionContentfulPaint":"undefined"}
  soft-navigation entries: 0; ICP entries: 0; event navigationId vs time window: {"agree":0,"disagree":0,"noNavigationId":13}
  would-be Samples:
    #1 hard / route=/order/{id} (route() +1536ms after start) navId=- shifts=1 {"ttfb":2.4,"fcp":36,"lcp":36,"cls":0.063,"inp":136}
```

The headless shell (Playwright's default launch, `HeadlessChrome/153.0.8010.12`) and new headless with `--enable-experimental-web-platform-features` gave **the same five Samples with the same shape**. In those runs the route margins were +5 to +36 ms on `/products` and +125 to +178 ms on `/order` across all runs.

What the output shows:
1. **Detection works without flags.** The four soft Navigations are the two clicks, the Enter key and `goBack`. The silent `replaceState` correctly produced none.
2. **Splitting works.** CLS 0.063 lands on `/order/12345` (#3), where the banner shifted, and not on the hard Sample. The 120 ms handler (INP 128) lands on `/products` (#2), which is the Navigation it *left*, following web-vitals' rule. Soft FCP and LCP on `/order` (~130 ms) include the 120 ms handler, because they are measured from the interaction.
3. **`navigationId` on events agrees with the time-window assignment**, including the trigger rule (`disagree: 0`). The production trap can bucket by `navigationId` and needs no time arithmetic, keeping time windows only as a cross-check.
4. **Old route rule versus new.** The `soft-navigation` entry reaches Node 1 to 25 ms **after** `click()` resolves and after the test's `route()` call. In one run it arrived 1 ms before. "The next report takes the pending route" would therefore usually give `/products` to the hard Sample of `/`. The time-window rule put every route on the right Sample in every run.
5. **Negative control equals today's behaviour.** There is one whole-document Sample, last `route()` wins, CLS and INP span the journey, and `navigationId` is absent everywhere.
6. **The C2 defect returns per soft Navigation.** #4 and #5 read `inp: no-interaction` because the only interaction after each was a fast one (under 16 ms) or none. `first-input` fires once per document, so the C2 fix covers only the hard Navigation (Q4).

---

## 3. Design

### 3.1 Support detection (in the trap)

```js
var softOk = supported.indexOf('soft-navigation') >= 0 &&
             supported.indexOf('interaction-contentful-paint') >= 0;
```

Requiring both rules out the origin-trial-era shapes (M139 to M144 behind a flag, and older experiments), which may differ from the shipped one. They yield no soft Samples instead of possibly wrong ones. `softOk` is false on Firefox, WebKit and Chromium < 151, and with the kill switch. In that case the trap runs today's code path unchanged and writes no `navigationKind`.

### 3.2 Slicing a document into Navigations

With `softOk`, the trap keeps a list of slices for the document. Slice 0 is the hard Navigation, with `navigationId` taken from the `navigation` entry. Each `soft-navigation` entry appends a slice. Each entry is assigned to a slice:
- **by `entry.navigationId`** when it is present (observed on `event`, `layout-shift`, LCP and ICP);
- otherwise by time window `[start_i, start_i+1)`, where the interaction that **triggered** slice i+1 (matched by `interactionId`) belongs to slice i.

The CLS session windows and the INP worst-interaction map from today's trap become per-slice state. Nothing else changes.

### 3.3 From slice to Sample

| Sample field | Hard slice (`softOk`) | Soft slice |
|---|---|---|
| `ts` | `round(timeOrigin)`, as today | `round(timeOrigin + entry.startTime)` |
| `url` | the document URL | `entry.name` |
| `navigationIndex` | next context-wide index (C6), claimed at the slice's first report | same |
| `pageIndex` | the page's index (C6) | **the same page's index**: a soft Navigation never opens a tab |
| `navigationKind` | `'hard'` | `'soft'` |
| `vitals.ttfb` | `navigation.responseStart`, as today | **absent** |
| `vitals.fcp` | paint entry, as today | `entry.presentationTime − entry.startTime` (fallback `paintTime`), else `not-finalized` |
| `vitals.lcp` | last LCP candidate, as today | `getLargestInteractionContentfulPaint().largestContentfulPaint.renderTime − entry.startTime`, else `not-finalized` |
| `vitals.cls` | session windows over **this slice's** shifts | same |
| `vitals.inp` | worst interaction **in this slice** (the triggering interaction of the next slice included) | same |
| `navigation.*` | as today | `null`, `null` |
| `context.resourceCount` | resource entries with `startTime` in the slice | same |
| `context.requestCount` / `failedRequests` | Node-side requests whose time falls in the slice window (the same clock rule as §3.6) | same |

The keying in Node changes from `docId` to `docId + '#' + navigationId`, with the slice ordinal as a fallback. `OpenDoc` becomes `OpenNavigation`. The attachment name stays `bzm-vitals-sample-<navigationIndex>`.

**When a slice reports.** When a `soft-navigation` entry arrives, the trap sends a non-final reading of the slice that just closed and a first reading of the new one. Both claim their `navigationIndex` in time order, as observed (the message reaches Node 1 to 25 ms later). The settle timer (`LEAVE_SETTLE_MS`) then lets a later, more complete reading replace a closed slice's reading, for example the trigger's event-timing entry arriving after the paint. The fixture's existing flush (before `goto`/`reload`/`goBack`/`goForward`/`close`, and at teardown) sends every slice as final. A worker killed mid-journey still leaves the closed slices on disk. That is the same guarantee as today's intermediate Samples.

### 3.4 Which metrics are measured

TTFB is the only vital that does not apply to a soft Navigation: there is no document request. The options:
- **`0`**, as Chrome and web-vitals report it. Rejected: it is a number that was never measured, and it would pool as the best TTFB on record.
- **A new `not-applicable` status.** Rejected for now: `METRIC_STATUSES` is closed, a new status is a `schemaVersion` change, and this release has a "No `SCHEMA_VERSION` bump" non-goal.
- **`unsupported`.** Rejected: it means "this engine lacks the API", which is false here.
- **Absent key (chosen).** Metric names are open. The dashboard already counts an absent metric as `not-carried`, which is a different fact from a failure. With the §5 split, soft rows simply have no TTFB column value.

FCP and LCP **are** measured, from the interaction. A soft FCP therefore includes the handler's own run time (observed: 130 ms with a 120 ms handler). That is the platform's definition [S2] and it is what users feel, so it stays. The README must say that a soft FCP or LCP is not comparable to a hard one.

### 3.5 Cold Start

The rule stays "first Navigation by `ts` per (`sessionId`, `workerIndex`)". A soft Navigation always starts after its document's hard Navigation: it needs a user interaction, which needs a painted document. So a soft Sample is never a Cold Start. `markColdStarts` needs no change, and there is still exactly one Cold Start per Worker per Engine. A unit test should pin this, with a soft Sample whose `ts` is 1 ms after its hard one.

### 3.6 Route and `vitals.route()`

`routeOf` is unchanged. A soft Sample's `url` is the SPA URL, so `/order/12345` derives to its own Route, and a declared Route still wins.

`vitals.route()` today stores one `pendingRoute`, which the next document to report consumes. With soft Navigations that **races**. The test calls `route()` the moment `click()` resolves, but the `soft-navigation` entry that opens the new Navigation reaches Node 1 to 25 ms later (observed, §2 item 4). So the route would land on the Navigation being left.

**Proposal (time-window rule):**
1. `route(r)` records `{ route: r, at: Date.now() }` in a per-Execution list. It is still synchronous, and still never touches the page (X4).
2. When a Navigation commits, it takes the **last** declaration whose `at` lies in its window `[start, nextStart)`. Here `start = timeOrigin + startTime` is **unrounded** (the trap sends it), and `nextStart` is the next Navigation on the **same page**, or open-ended.
3. A declaration made while the page is on `about:blank` (before the first `goto`) belongs to the page's next Navigation, as today.
4. With several pages, a declaration is matched against the Navigation that started most recently across the Execution, which is "the Navigation the test is on". That generalizes today's "whichever page reports first".
5. Without `softOk`, the window is the whole document, which is exactly today's behaviour (last `route()` wins).

The rule relies on Node's `Date.now()` and the page's `performance.timeOrigin + startTime` reading the same wall clock. Both run on the same machine, and the observed margin is +5 ms or more (the interaction always precedes `click()` resolving). The risk is clock slew over a long test (§6 R3).

### 3.7 Passive measurement (X4)

- Injection stays `context.addInitScript`. There are only `PerformanceObserver`s, and no new listener touches the DOM.
- The one new page-to-Node message is `window[binding](reading)` from the `soft-navigation` observer callback. It is the same path the trap already uses at `beforeunload`. It is an event from the page, not a Node round-trip, and it fires after the soft Navigation's paint has been recorded.
- No new `page.evaluate`. The existing fixture-driven flushes run between test steps, as today.

### 3.8 Chromium launch flags

**Add none.** Observed on M153, default-on in the headless shell and in new headless. `--enable-experimental-web-platform-features` changes nothing here and turns on many unrelated experiments, so it would perturb what is measured. Document `--disable-features=SoftNavigationHeuristics` (Playwright `launchOptions.args`) as the opt-out: the trap then falls back to whole-document Samples. Q3 covers the BlazeMeter Engine's Chromium version.

### 3.9 Firefox and WebKit

`softOk` is false, so the trap runs its current path and writes one whole-document Sample with **no `navigationKind`**. That is honest, because absent means "not split". Writing `'hard'` there would claim the window ended at the first soft Navigation, which nobody measured. There are no soft Samples at all, so none can be wrong. A test must assert this on Firefox (it skips loudly if Firefox is missing, per A1).

---

## 4. Format change (additive, no `SCHEMA_VERSION` bump)

`packages/format/src/index.ts`:

```ts
/** The closed vocabulary of Navigation kinds — the ONE runtime definition. */
export const NAVIGATION_KINDS = ['hard', 'soft'] as const;
export type NavigationKind = (typeof NAVIGATION_KINDS)[number];
export function isNavigationKind(x: unknown): x is NavigationKind { … }

export interface Sample {
  …
  /**
   * Optional (additive). 'hard': a document load, whose window ends at the document's
   * first soft Navigation. 'soft': a same-document route change the browser reported as
   * a soft navigation (Chromium ≥ 151). ABSENT: the whole document, soft Navigations not
   * split out — every collector before F1, and every engine without the API.
   */
  navigationKind?: NavigationKind;
}
```

- `validateSample` gets `() => optional(x, 'navigationKind', '', isNavigationKind, "'hard' or 'soft'")`. An unknown value is rejected, not misread, in the house style of the closed vocabularies.
- `schema/sample.v1.json` gets `"navigationKind": { "enum": ["hard", "soft"], "description": "Optional (additive). …" }`. `conformance.test.ts` gains a soft-Sample fixture (no `ttfb`, `navigation` nulls) and an invalid `navigationKind: 'push'` case.
- The validator does **not** reject `ttfb` on a soft Sample. Metric names stay open, and that rule belongs in a collector test.
- CONTEXT.md (X7): **Navigation** widens from "one page load" to "one page load (a *hard* Navigation) or one same-document route change the browser reports as a soft navigation (a *soft* Navigation)". Add **Soft Navigation** and **Hard Navigation** as terms. `~~Page~~` stays banned.
- 0.2.x and pre-F1 0.3 fixtures still validate (X3), because the field is optional.

## 5. Dashboard impact

- **Grouping.** Route rows are keyed by `(Route, navigationKind ?? 'hard')`. A soft row is labelled, for example `/products · soft`. Absent folds into `hard`, and a footnote says that unsplit Samples (old collectors and non-Chromium engines) span the whole document. Their LCP, FCP and TTFB mean the same as a split hard Sample's, but their CLS and INP may cover more.
- **Why split instead of CrUX's blend.** CrUX blends because it answers "what do users of this origin experience" [S4]. Our p75 per Route is a regression signal for one journey. A soft LCP of 20 ms pooled with hard LCPs of 1 to 2 s drags the p75 down by whatever share of the journey is client-side, which is a property of the test, not of the site. A blended view can be added later as a toggle.
- **Coverage** is unchanged in mechanism. Soft rows show no TTFB at all instead of "0 of n".
- **Cold Starts:** no change (§3.5). **Timeline (E3):** draw soft Navigations as a distinct marker on the same lane.
- **Push sinks:** Influx gains a `navkind` tag (two values, so cardinality is trivial). BlazeMeter mapping and the F2 OTLP design gain a `bzm.navigation.kind` data-point attribute. These are follow-ups and not part of the first implementation ticket.

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The meaning of existing Chromium hard Samples changes.** CLS, INP and resource counts stop at the first soft Navigation. A Report comparison across the upgrade shows a drop that is not a site improvement. | `navigationKind: 'hard'` marks the new semantics, and absent marks the old. Release note. The dashboard footnote (§5). |
| R2 | **Heuristic false positives and negatives** [S2]. A route change without a paint is invisible, and a click that paints and changes the URL is a Navigation even if the app thinks of it otherwise. | It is the platform's definition and CrUX's too. Document it. The kill switch (§3.8). |
| R3 | **Clock domains in the route rule.** Node's `Date.now()` and `performance.timeOrigin` can drift apart under NTP slew. | Unrounded start. The observed margin is ≥ 5 ms. Fallback: if a declaration falls within 2 ms *before* a soft start, give it to the soft Navigation and log it once. Test with a fake clock. |
| R4 | **INP `no-interaction` per soft Navigation** (§2 item 6): the C2 defect returns, because `first-input` is per document. | Q4. Until it is resolved, the README says so, and the dashboard's reason text applies. |
| R5 | **Same-document `goBack()`/`goForward()` already loses data today** (found by code reading, not reproduced). The patched method flushes `final`, `commit()` writes the document's Sample, and every later reading of that `docId` is ignored, because the document never left. With F1 on Chromium the traverse opens a new soft slice, so the loss shrinks to "the current slice commits early", which is correct. On Firefox it remains. | A follow-up ticket: write a red test first (X6). Then let a final flush of a document that is still current re-open on its next reading, or flush same-document traverses non-final. |
| R6 | **The API shape is still young.** The interface name already differs from the docs (§1.2), and the ICP nesting is easy to misread (§1.2). | Detect by entry types only. Pin the observed entry shapes in a Chromium-only test that fails loudly if a field moves. |
| R7 | **Sample count grows** for SPA journeys: one per route change. | It is about 450 B per Sample. D4 and E1 already target 200k Samples. |

## 7. Follow-up implementation ticket

**F1-impl. Soft Navigations as Samples (Chromium ≥ 151)**

**What to build:** §3 and §4. The trap slices documents into Navigations when `softOk`, Node keys open Navigations by `(docId, navigationId)`, `vitals.route()` uses the time-window rule, and the format gains `navigationKind`. Dashboard grouping (§5) is a separate ticket after this one.
**Owns:** the trap and the binding in `packages/collector/src/index.ts`. **Touches:** `packages/format/src/index.ts`, `schema/sample.v1.json`, format conformance fixtures, CONTEXT.md, collector README ("Known limitations": replace "SPA link clicks are not Navigations").
**Acceptance criteria**
- [ ] On Chromium, a spec against an SPA fixture (pushState, three routes) that clicks two links writes three Samples: `navigationKind` `hard`, `soft`, `soft`, with consecutive `navigationIndex` values and equal `pageIndex`.
- [ ] Soft Samples carry no `vitals.ttfb`, have `navigation.domContentLoadedMs === null`, and have FCP and LCP `ok` measured from the interaction.
- [ ] A layout shift after the second click lands on the second soft Sample's CLS, and the hard Sample's CLS is 0.
- [ ] A slow handler on the click that opens Navigation n+1 lands on Navigation n's INP.
- [ ] `await page.click(link); vitals.route('/x/{id}')` puts the route on the soft Sample, never on the one being left. A fake-clock unit test covers the ±2 ms boundary.
- [ ] A click that only calls `replaceState` without painting writes no soft Sample.
- [ ] With `--disable-features=SoftNavigationHeuristics`, and on Firefox (skipped with a reason if it is not installed), the same spec writes exactly one Sample with **no** `navigationKind`, which is byte-compatible with today's shape.
- [ ] `validateSample` and `sample.v1.json` accept `navigationKind` `hard` and `soft`, reject `'push'`, and the 0.2.x fixtures still validate (X3).
- [ ] The Cold Start count is unchanged on a journey with soft Navigations (one per Worker).
- [ ] No new `page.evaluate` or CDP call in the diff (X4). It is checked by review and by the existing tracer test.
**Blocked by:** none (C6 merged). **Size:** L. **Risk:** medium (R1, R3).

Further follow-ups: dashboard split (§5), push-sink tag/attribute (§5), R5's same-document traverse test, and Q4.

## 8. Open questions

| # | Question | Default if not answered |
|---|---|---|
| Q1 | The field name: `navigationKind` (recommended, §0) or the spec's `navigationType`? | `navigationKind` |
| Q2 | Should the dashboard also offer a CrUX-style blended (hard plus soft) view per Route? | Split only; blend later as a toggle |
| Q3 | Which Chromium does a BlazeMeter Engine's Playwright image ship? If it is < 151, soft Samples silently never appear there, which is correct, but a tester may expect them. Should the collector state per Sample (or per Push Status) that soft detection was off? | Document it; no field |
| Q4 | INP on a soft Navigation whose interactions were all under 16 ms reads `no-interaction` (observed). Options: (a) a passive input counter per slice, so "interacted but under 16 ms" is distinguishable, though it then needs a status or value we do not have; (b) accept it and document it; (c) web-vitals reportedly synthesizes an INP when there are no entries (per a Sentry draft PR, unverified). | (b) for the first implementation |
| Q5 | Is a `traverse` soft Navigation (back/forward within the SPA) a Navigation the tester wants as a Sample, or noise? | Keep it: it is a real route change the user sees |

## 9. Sources

- [S1] blink-dev, *Intent to Ship: PerformanceSoftNavigation and InteractionContentfulPaint performance entry*, Michal Mocny, 2026-06-23. https://groups.google.com/a/chromium.org/g/blink-dev/c/BfSsaY2b_y8
- [S2] Chrome for Developers, *Measuring soft navigations* (Barry Pollard), published 2023-02-01, last updated 2026-09-20. https://developer.chrome.com/docs/web-platform/soft-navigations-experiment
- [S3] blink-dev, *Intent to Extend Experiment: Soft Navigation Heuristics* (date not checked). https://groups.google.com/a/chromium.org/g/blink-dev/c/xxrmKr-6X38
- [S4] web.dev, *Experimental soft navigation metrics now available in CrUX*, 2026-10-13. https://web.dev/blog/crux-experimental-soft-navs
- [S5] GoogleChrome/web-vitals README, `main`, fetched 2026-11-07. https://github.com/GoogleChrome/web-vitals
- [S6] mozilla/standards-positions #854, *Soft Navigations*, opened 2023-07-27, last activity 2025-02-10. https://github.com/mozilla/standards-positions/issues/854
- [S7] WebKit/standards-positions #235 (closed as a duplicate on 2026-08-19) and #687, opened 2026-06-11. https://github.com/WebKit/standards-positions/issues/687
- [S8] Secondary source, used only for the M151 stable timing, which is unverified: Apogee Watcher, *Soft Navigations in Chrome 151: How to Prepare and What to Measure* (2026). https://apogeewatcher.com/blog/soft-navigations-chrome-151-prepare-measure
- Observed: the prototype in [`f1-prototype/`](f1-prototype/), Chrome for Testing 153.0.8010.12 with Playwright 1.63.0, run 2026-11-07.
