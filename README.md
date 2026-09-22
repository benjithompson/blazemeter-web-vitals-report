# Playwright Web Vitals on BlazeMeter

Run your Playwright suite on BlazeMeter and find out how your site's web vitals
(TTFB, FCP, LCP, CLS, INP) behave while the backend is under load — then share
the answer as a single HTML file.

Two pieces:

- **The collector** ([`bzm-playwright-vitals`](packages/collector) on npm) —
  rides along with your test and records vitals for every page your test
  visits. You change one import; your tests are otherwise untouched.
- **The dashboard** — one command that turns a finished BlazeMeter run into
  one self-contained `report.html`. No server, no credentials inside, safe to
  email.

**Want the whole flow as ready-to-upload files?** [`examples/`](examples)
holds a complete kit — an example spec to follow, `config.yml`,
`playwright.config.ts`, `package.json` — with a step-by-step walkthrough.

---

## 1. Add the collector to your suite

Add the dependency, then change one line in the spec:

```sh
npm install --save-dev bzm-playwright-vitals
```

```ts
- import { test, expect } from '@playwright/test';
+ import { test, expect } from 'bzm-playwright-vitals';
```

Done. Every navigation your test makes now leaves a vitals record — you don't
call anything, and your test bodies don't change.

**Optional:** if your journey hits dynamic URLs, group them under one name:

```ts
test('order', async ({ page, vitals }) => {
  await page.goto('/order/12345');
  vitals.route('/order/{id}');   // '/order/12345' and '/order/67890' become one row
});
```

Skip it and the dashboard groups by URL path automatically.

## 2. Run on BlazeMeter

Upload your test files as usual — spec, `config.yml`, `playwright.config.ts`,
`package.json`. Because `bzm-playwright-vitals` is in your `package.json`, the
Engine's `npm install` fetches it from the registry like any other dependency.
Run the test.

When it finishes, note the **master id** in the report's URL:
`https://a.blazemeter.com/app/#/masters/`**`82731327`**

## 3. Generate the dashboard

You need a BlazeMeter API key: in the BlazeMeter UI, *Settings → API Keys*,
download the key file.

```bash
export BLAZEMETER_API_KEY=~/.blazemeter/api-key.json
npx bzm-vitals-dashboard --master <masterId> --out report.html
```

(From a checkout of this repo,
`npx tsx packages/dashboard/src/cli.ts --master <masterId> --out report.html`
does the same.)

Open `report.html` in any browser. Send it to anyone — the reader needs no
BlazeMeter account, and the file works offline forever.

> 🔴 **Never commit your API key.** Keep `api-key.json` out of git
> (this repo's `.gitignore` already covers it). A leaked key is a live
> credential to your BlazeMeter account.

## Reading the report

- **The Route table** answers *"what is the state?"* — one row per page
  (Route), **p75 leading**, colored dots using the official
  [web.dev thresholds](https://web.dev/articles/vitals) (green / amber / red).
  Under every number: **coverage** — "8 of 8" means all eight measurements
  carried a value. A metric that couldn't be measured tells you *why*
  ("no interaction") instead of showing a misleading 0.
- **The timeline** answers *"how did it move?"* — every measurement plotted
  at the wall-clock moment its page load started, per metric, with the run's
  p75 as a reference line. Hover any point for its exact value. ◆ diamonds
  are **Cold Starts**: first load on a fresh browser (cold cache, cold DNS) —
  real page loads a real first-time visitor experiences, kept in the numbers
  and flagged so a slow tail is explained, not mysterious.
- **Click a Route row** to drill down: per-Test, per-Engine breakdowns and
  distribution histograms.
- **Failed test runs are included by default.** Tests often fail *because*
  the site was slow — excluding them would delete your slowest measurements
  and report a faster site than exists. The toggle above the table lets you
  exclude them; the breakdown line shows what failed either way.

## Good to know

- **INP** only reflects the clicks your test actually performs — it's a
  regression signal for your own journeys, not a field-comparable number.
- A journey that only navigates (no clicks) shows **"no interaction"** for
  INP. That's correct, not broken.
- Firefox/WebKit projects still report — CLS shows "unsupported" there
  (the browser lacks the API) rather than a fake 0.
- Before each `goto()`, `reload()`, `goBack()` or `goForward()`, the collector
  records the page being left. It waits for the next paint first, so a click
  just before the navigation still counts for INP. The wait is usually a few
  milliseconds and is always bounded.
- Re-running the dashboard for the same master is instant — artifacts are
  cached locally in `.artifact-cache/` (also never committed).

## No npm access? Single-file builds

Both pieces also ship as single generated `.ts` files, attached to every
[GitHub release](../../releases/latest) — for Engines with no registry access
and for machines where `npm install` isn't an option:

- **`bzm-playwright-vitals.ts`** (collector): upload it next to your spec and
  change the import to the sibling file —
  `import { test, expect } from './bzm-playwright-vitals';`. Playwright's own
  TS loader transpiles it on the Engine; the registry is never contacted.
- **`bzm-vitals-dashboard.ts`** (dashboard): download it anywhere and run
  `npx tsx bzm-vitals-dashboard.ts --master <masterId> --out report.html` —
  or, zero-install on Node ≥ 23.6,
  `node bzm-vitals-dashboard.ts --master <masterId> --out report.html`.
  It imports node builtins only.

Both are build artifacts generated from the real package sources
(`npm run build:standalone` in [`packages/collector`](packages/collector) and
[`packages/dashboard`](packages/dashboard)) and regenerated by each package's
standalone seam test — never a second source of truth. The
[`examples/`](examples) walkthrough covers both variants.

---

*On npm:
[`bzm-playwright-vitals`](https://www.npmjs.com/package/bzm-playwright-vitals)
(the collector, with
[`bzm-vitals-format`](https://www.npmjs.com/package/bzm-vitals-format) as its
one dependency) and
[`bzm-vitals-dashboard`](https://www.npmjs.com/package/bzm-vitals-dashboard)
(the dashboard CLI).*
