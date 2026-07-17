# Publish check — does a published npm dep resolve on an Engine?

> ✅ **Answered YES on 2026-07-17.** `bzm-playwright-vitals@0.1.0` (with its
> `bzm-vitals-format@0.1.0` dep) was published to npm, then this kit ran on a
> real us-west-1 Engine as master **82731957** — four files uploaded, no
> collector `.ts`. The Engine emitted 6 unique Samples (route `/wiki/{article}`
> declared, real INP on the search interaction) and 4 Outcomes. Samples can
> only exist if the Engine's `npm install` resolved the published package from
> the registry. The distribution story holds; the standalone kit stays only as
> the no-registry fallback. Set `dedicated-ips: false` unless the account has
> dedicated IPs provisioned — `true` fails master creation with a generic
> "Failed to create master".

The empirical check issue #11 owns. Evidence says yes (npm's own update notice
proves registry egress; the lockfile re-resolves on the Engine; Taurus rewrites
`package.json` there to inject its reporter, so `npm install` genuinely runs) —
but it was never proven with a package of ours. A failure would surface at run
time on the Engine, where this platform's pattern is to fail quietly. So: one
real run, one published version, before anyone relies on the distribution story.

## How this kit differs from `../upload-kit`

| | upload-kit | publish-check |
|---|---|---|
| collector arrives via | uploaded `bzm-playwright-vitals.ts` file | **registry** (`npm install` on the Engine) |
| spec imports | `'./bzm-playwright-vitals'` | `'bzm-playwright-vitals'` |
| files uploaded | five | **four** (no collector file) |
| `package.json` deps | Playwright only | Playwright + `bzm-playwright-vitals` |

Same journey, same Playwright config. The only variable is how the collector
gets there — which is the point.

## Run it

1. **Publish first.** `npm publish` in `packages/format`, then in
   `packages/collector` (the collector depends on `bzm-vitals-format` at an
   exact version — publish order matters). Confirm both are live:
   `npm view bzm-playwright-vitals version`.
2. Create (or update) a BlazeMeter **Performance** test (Taurus,
   `executor: playwright`) and upload all four files: `config.yml` (main
   script), `example.spec.ts`, `playwright.config.ts`, `package.json`.
3. Run it. Do **not** set a `CI` env var (the config pins `retries: 0`).

## Reading the result

**Pass:** the Engine's `artifacts.zip` contains `bzm-vitals-sample-*` and
`bzm-vitals-outcome-*` attachments — 4 Outcomes and 6 Samples for this config
(2 tests × 2 repeats; `Search Journey` drives 2 Navigations, `Single Page` 1).
Samples can only exist if the registry install worked: nothing else puts the
collector on the Engine. Then point the dashboard at the master id and look.

**Fail:** the import doesn't resolve, every Execution errors at startup, no
Samples. Also check `bzt.log` in the session artifacts for the `npm install`
output — it names the registry it hit and any resolution error. Per #11: if
resolution fails, **write the finding up before choosing a workaround** — the
whole distribution story changes with it.
