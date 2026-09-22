# Full-flow example — Playwright web vitals on BlazeMeter, end to end

This directory is a complete, uploadable example of the flow in the
[root README](../README.md): a Playwright journey runs on BlazeMeter with the
`bzm-playwright-vitals` collector aboard, and one command afterwards turns the
finished run into a single self-contained `report.html`.

| file | role |
|---|---|
| [`example.spec.ts`](example.spec.ts) | the journey — a plain Playwright test whose ONE collector-aware line is the import |
| [`playwright.config.ts`](playwright.config.ts) | defines the `chromium` project Taurus targets; `retries: 0` pinned |
| [`config.yml`](config.yml) | the Taurus config — what makes the BlazeMeter test a Playwright-executor test |
| [`package.json`](package.json) | deps for the Engine's `npm install` (Taurus rewrites it there to inject its own reporter — that's normal) |

The spec is the example to follow: two tests, journeys kept on one
server-rendered site, one real interaction so INP is really measured. The
comments in it explain *why* it is shaped that way — the shape is measured
behavior, not style.

## 0. Dry-run locally (optional, recommended)

```sh
cd examples
npm install && npx playwright install chromium
npx playwright test
```

Passing tests locally means the only new variable on BlazeMeter is the Engine.
(Vitals records land in `test-results/` as `bzm-vitals-*.json` attachments —
that's the collector working.)

## 1. Create and run the BlazeMeter test

In the BlazeMeter UI: **Performance → Create Test → upload script**, then drag
in all four files — `config.yml` (select it as the main script),
`example.spec.ts`, `playwright.config.ts`, `package.json`. Run it.

Because `bzm-playwright-vitals` is in `package.json`, the Engine's
`npm install` fetches it from the npm registry like any other dependency.

When the run finishes, note the **master id** in the report URL:
`https://a.blazemeter.com/app/#/masters/`**`82731327`**

## 2. Generate the dashboard

You need a BlazeMeter API key file: BlazeMeter UI → *Settings → API Keys* →
download `api-key.json`. **Never commit it.**

```sh
export BLAZEMETER_API_KEY=path/to/api-key.json
npx bzm-vitals-dashboard --master <masterId> --out report.html
```

Open `report.html` in any browser, or email it — the reader needs no
BlazeMeter account and the file works offline forever. Artifacts are cached in
`.artifact-cache/`, so re-running for the same master is instant and needs no
credentials.

No network? Download each Engine's `artifacts.zip` from the report's **Logs**
tab and run the single-file dashboard (below):
`node bzm-vitals-dashboard.mjs --artifacts <zip-or-folder> --out report.html`.
It needs no API key and makes no network calls. Do not use `npx` on an offline
machine: when the package is not installed, `npx` contacts the npm registry.

## No npm registry? The single-file variants

Both halves of the flow also travel as single generated files, attached
to this repo's [GitHub releases](../../../releases/latest):

- **Collector** — `bzm-playwright-vitals.ts`. Upload it as a *fifth* file next
  to the spec, and change the spec's import to the sibling file:

  ```ts
  import { test, expect } from './bzm-playwright-vitals';
  ```

  Playwright's own TS loader transpiles the relative import on the Engine —
  the registry is never contacted for the collector. (You can also delete the
  `bzm-playwright-vitals` entry from `package.json`.)

- **Dashboard** — `bzm-vitals-dashboard.mjs`. Plain JavaScript: download it
  anywhere and run it with Node 20 or later. No flags, no `npm install`, no `tsx`.

  ```sh
  # offline, from downloaded artifacts:
  node bzm-vitals-dashboard.mjs --artifacts <zip-or-folder> --out report.html
  # from the API:
  export BLAZEMETER_API_KEY=path/to/api-key.json
  node bzm-vitals-dashboard.mjs --master <masterId> --out report.html
  ```

  `bzm-vitals-dashboard.ts` is the same code as TypeScript, for
  `npx tsx bzm-vitals-dashboard.ts …` or `node bzm-vitals-dashboard.ts …` on
  Node ≥ 23.6.

Both files are build artifacts generated from the real package sources
(`npm run build:standalone` in each package) — never a second source of truth.

## What to expect in the report

With this spec's two tests: `Search Journey` drives 2 Navigations (the first
tagged with the declared Route `/wiki/{article}`, with a real INP from the
search-box typing) and `Single Page` drives 1 Navigation whose INP honestly
reads **no interaction** — never a fake 0. The Route table leads with p75 and
web.dev-threshold colors; the timeline plots every measurement at the moment
its page load started, per location.
