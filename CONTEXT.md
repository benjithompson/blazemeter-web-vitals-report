# Context

Ubiquitous language for the Playwright web-vitals dashboard. **Glossary only** — no implementation detail, no decisions. Decisions live in the [wayfinder map](.scratch/playwright-vitals-dashboard/map.md); the reasoning behind these terms is in [08](.scratch/playwright-vitals-dashboard/issues/08-identity-correlation.md).

## The chain

A **Report** fans out into **Engines**. Each Engine runs **Executions**. Each Execution performs **Navigations**. Each Navigation yields one **Sample**.

```
Report ──< Engine ──< Execution ──< Navigation ──> Sample
```

## Terms

### Report
One BlazeMeter master — a single run of a test. Identified by its `masterId`.

*Not* "test run" (ambiguous with Execution) and *not* "master" outside of API-facing code.

### Engine
One BlazeMeter execution host. Keyed by its **`sessionId`** (`r-v4-…`), which is the only true engine identity. Emits exactly one `artifacts.zip`.

Engines are **ephemeral** — a given Engine exists only within one Report, and no Engine persists across Reports.

**Engine Label** — the human-facing name, `"{locationId} #{ordinal}"` (`us-west-1 #1`). The label is for people; the `sessionId` is for joining. Never key on the label.

### Test
What a tester wrote: the triple **`file` + `title` + `project`**. The unit of authorship.

*Not* "test case", "scenario" (Taurus uses "scenario" for its own thing), or "spec".

### Execution
One run of one Test on one Engine: **(Engine, Test, `repeat`)**.

Every Engine in a Report runs the **identical** set of `repeat` indices — Executions are **replicated across Engines, never partitioned**. So Engine A's `repeat1` and Engine B's `repeat1` are the same Test measured twice, not two different pieces of work.

`repeat` is a **sample discriminator, not a correlation key**: pairing Engine A's `repeat1` with Engine B's `repeat1` is meaningless, because they ran at different moments in different orders.

### Navigation
One page load within an Execution, ordered by **`navigationIndex`**. The occasion on which vitals are measured.

### Sample
The vitals captured at one Navigation. **The atom of this domain** — everything aggregates from Samples, nothing is stored pre-aggregated.

Uniquely identified by (`sessionId`, Test, `repeat`, `navigationIndex`).

A Sample **does not know which Engine produced it**. That is not a defect — a Sample is written by a Test, and a Test has no need of its Engine's identity. See **Attributed Sample**.

### Attributed Sample
A Sample plus the Report and Engine identity stamped onto it when it is fetched: `masterId`, `sessionId`, `locationId`, Engine Label.

The distinction is the whole point: a **Sample** is what exists in a zip; an **Attributed Sample** is what can be reasoned about. Aggregation is defined only over Attributed Samples.

### URL
The raw address a Navigation went to, exactly as navigated. **Always recorded, never discarded** — it is the only thing from which a Route can be re-derived.

### Route
The normalized URL — `/order/12345` → `/order/{id}`. **The join key**: two Samples describe "the same thing" when their Routes match.

Declared by the tester when they choose to; otherwise derived from the URL. A declared Route always wins over a derived one.

### ~~Page~~ — banned
Ambiguous between URL and Route, and those are different things. Say which one you mean.

### Worker
*Which OS process picked up an Execution* (`workerIndex`). **Never an aggregation dimension** — nobody asks "how is worker 3 doing?".

But not discardable either: a Worker launches one browser and reuses it, so **the first Execution on each Worker is a Cold Start**.

### Cold Start
The first **Navigation**, by `ts`, for each (`sessionId`, `workerIndex`) — the one that pays browser launch, cold cache, and cold DNS.

A Cold Start is a **real page load**, not an error: a user arriving at a cold CDN edge experiences exactly this. It is never silently discarded. It is a **labelled subset** of Samples, not a separate kind of Sample.

Cold Starts are **predictable and countable**: a Report has exactly one per Worker per Engine.

## The pooling rule

> **Pool Attributed Samples over `sessionId` and `repeat`. Everything else is a dimension you slice by.**

`sessionId` and `repeat` are precisely what varies while the thing being measured stays the same — which is why they are what you pool over, and why nothing else may be.

## Coverage
The count of Samples that actually carry a value for a metric, against the total — *"41 of 50"*.

Coverage is stated wherever an aggregate is stated. Without it, *"CLS 0 across 50 samples"* means both *"perfectly stable"* and *"we never measured it"*, and nothing distinguishes them.
