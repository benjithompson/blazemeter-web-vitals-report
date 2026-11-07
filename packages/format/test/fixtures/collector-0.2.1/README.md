# collector 0.2.1 records: the format-compatibility fixture (X3)

Real bytes, not hand-written. These are the original `bzm-vitals-sample-<n>.json` and
`bzm-vitals-outcome.json` files that `bzm-playwright-vitals` 0.2.1 wrote (main at
65d3f30, before C1 adds `test.id`/`titlePath`/`path`). They come from Chromium runs of the
collector's own fixture specs (`vitals`, `route`, `journey` and `outcomes`) through the
Seam 1 harness (`packages/collector/test/helpers/run-playwright.ts`). Each file name is
`<spec>--<Playwright output folder>--<original name>`.

Between them they cover: inp `ok` and `no-interaction`, declared and absent `route`, and
the Outcome statuses `passed`, `failed`, `timedOut` and `skipped`. None has `id`,
`titlePath`, `path`, `pageIndex` or `lostNavigations`.

`test/conformance.test.ts` requires every one of them to pass `validateSample` /
`validateOutcome` and the JSON Schemas in `schema/`. If a format change rejects any of
them, it has broken compatibility with 0.2.x. Don't regenerate them to make the test pass.
