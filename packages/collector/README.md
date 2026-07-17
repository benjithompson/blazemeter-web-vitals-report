# bzm-playwright-vitals

Web vitals (TTFB, FCP, LCP, CLS, INP) for Playwright suites running on
BlazeMeter — measured on the journeys your tests actually drive, while the
backend is under load.

You change **one import**. Your test bodies stay untouched.

```ts
- import { test, expect } from '@playwright/test';
+ import { test, expect } from 'bzm-playwright-vitals';
```

Every navigation your test makes now leaves one small JSON **Sample** as a
Playwright attachment, and every test leaves one **Outcome** record. On
BlazeMeter those land in each Engine's `artifacts.zip`, where the companion
[dashboard](https://github.com/benjithompson/blazemeter-web-vitals-report)
turns a finished run into a single self-contained `report.html`.

Forgetting the import swap produces **no data at all** — loud, not a silent gap.

## Install

```sh
npm install --save-dev bzm-playwright-vitals
```

`@playwright/test` is a **peer dependency** (`>=1.40.0 <2`) — the collector
rides on your suite's Playwright, never its own copy.

## Run on BlazeMeter

Nothing collector-specific: upload your suite as usual (spec, `config.yml`,
`playwright.config.ts`, `package.json`). Because `bzm-playwright-vitals` is in
your `package.json`, the Engine's `npm install` fetches it from the registry
like any other dependency.

## The one optional knob: `vitals.route()`

If your journey hits dynamic URLs, declare a Route so `/order/12345` and
`/order/67890` group as one row in the report:

```ts
test('order', async ({ page, vitals }) => {
  await page.goto('/order/12345');
  vitals.route('/order/{id}');
});
```

Skip it and the dashboard derives a Route from the URL path automatically. A
declared Route always wins over a derived one. `route()` tags the Navigation
the page is currently on — call it while you're still on that page.

## What each status means

Every metric in a Sample carries `{value, status}` — the reason travels with
the number, so an unmeasurable metric can never masquerade as `0`.

| status | meaning |
|---|---|
| `ok` | measured |
| `unsupported` | the browser lacks the API (e.g. CLS on Firefox/WebKit) |
| `no-interaction` | INP: the journey performed no qualifying interaction |
| `not-finalized` | LCP: the page closed before the browser finalized the value |
| `error` | collection threw; the failure is recorded, not hidden |
| `unknown` | written only by the dashboard's legacy adapter, never by this collector |

**A journey that only navigates reports INP as `no-interaction`. That is
correct, not broken** — INP requires an interaction, and your test didn't
perform one. It will never be faked as `0` or silently dropped.

Likewise, non-Chromium projects still emit Samples: CLS arrives as
`unsupported` rather than a fake perfect `0`.

## What gets recorded

- **One Sample per Navigation** (~450 bytes): the five vitals with statuses,
  `domContentLoaded`/`load` timings, the URL as navigated, your declared
  Route if any, and test identity (file, title, project, repeat, worker).
- **One Outcome per test execution**: `passed | failed | timedOut | skipped`
  plus retry. A *missing* Outcome means the execution crashed before
  finishing — the dashboard reads that absence as a signal.

The on-disk records above are the authoritative output and are written on
every run, credentials or none. The collector reads only the **named** env
vars documented below — never the whole of `process.env`, so your session
tokens never reach a downloadable artifact.

## Live push to BlazeMeter (optional)

When it runs on a BlazeMeter Engine **with API-key credentials present**, the
collector additionally pushes each measured vital to BlazeMeter's custom
time-series API *during the run*, so LCP/CLS/INP/TTFB/FCP show up in that
master's **Timeline report** — overlaid on the same wall-clock axis as the
backend load — within seconds of being measured.

This is a **supplement, not a replacement**: the on-disk Samples/Outcomes and
the HTML report are unchanged and remain the record of truth. Adoption is still
one import; the push turns itself on only when credentials **and** a resolvable
master are both present, and does nothing otherwise (so a local
`npx playwright test` behaves exactly as before — files only, no network).

The push is strictly best-effort: it is never awaited by your test, and a slow
or failed push never slows, perturbs, or fails the run. A metric that could not
be measured is simply **absent** from the Timeline — never sent as a fake `0`.

Enable it by setting the same discrete API-key vars the dashboard uses on the
test (`BLAZEMETER_API_KEY_ID` / `BLAZEMETER_API_KEY_SECRET`). No `config.yml`
or `playwright.config.ts` change is needed. Optional knobs, all via env:

| env var | default | purpose |
|---|---|---|
| `BLAZEMETER_API_KEY_ID` / `_SECRET` | — | api-key credentials; **both** required to push |
| `BZM_VITALS_PUSH` | on | set to `0` / `off` / `false` to disable pushing even with credentials |
| `BLAZEMETER_MASTER_ID` | — | target master; overrides auto-discovery from `SESSION_ID` |
| `BLAZEMETER_API_BASE` | `https://a.blazemeter.com` | override for EU / on-prem BlazeMeter |
| `BZM_VITALS_PROFILE` | `Web Vitals` | the Timeline profile name |
| `BZM_VITALS_FLUSH_MS` | `10000` | how often buffered points are sent |

The credential travels only in the `Authorization` header and is never written
to any Sample, log, or artifact.

## 🔴 Keep your API key out of git

The collector needs no credentials. The **dashboard** does, and BlazeMeter API
keys leak the same way every time: a key file sitting in the repo, one
`git add -A` away from being committed. During this project's own development
the key sat unignored at the root of a repo with no `.gitignore` at all.

**Put `api-key.json` in `.gitignore` before you download the key.** This
repo's `.gitignore` covers it; make sure yours does too.

Credentials follow BlazeMeter's own convention:

```sh
# locally: point at the key file downloaded from Settings → API Keys
export BLAZEMETER_API_KEY=~/.blazemeter/api-key.json   # {"id": "...", "secret": "..."}

# CI: a file is awkward — use discrete variables instead
BLAZEMETER_API_KEY_ID=...
BLAZEMETER_API_KEY_SECRET=...
```

## Known limitations

- **Keep each journey on one site.** Cross-site navigation (yoursite.com →
  othersite.com) swaps the browser process and loses the Sample for the page
  being left — a platform behavior, not a knob.
- **SPA link clicks are not Navigations.** Client-side routing creates no new
  document, so the whole journey lands in one Sample flushed at teardown.
- INP reflects only the interactions your test performs — it's a regression
  signal for your own journeys, not a field-comparable number.

## License

MIT
