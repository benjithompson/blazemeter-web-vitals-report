# collector 0.3.x records: the post-C1 fixture

Real bytes, not hand-written. These are the original `bzm-vitals-sample-<n>.json` and
`bzm-vitals-outcome.json` files a collector writes when `testIdentity()` populates
`test.id`, `test.titlePath` and `test.path`. They come from Chromium runs of the
collector's own fixture specs (`identity/`, `vitals` and `outcomes`) through the Seam 1
harness (`packages/collector/test/helpers/run-playwright.ts`). Each file name is
`<spec>--<Playwright output folder>--<original name>`.

The `identity` files are the collisions C1 breaks: two `Same Title` tests in different
describe blocks of `identity/collision.spec.ts`, and two `same-name.spec.ts` files in
`identity/alpha/` and `identity/beta/`. Each pair shares `(file, title, project)` but has
a different `id`, and a different `titlePath` or `path`.

`test/conformance.test.ts` requires every one of them to carry `id`, `titlePath` and
`path`, and to pass `validateSample` / `validateOutcome` and the JSON Schemas in
`schema/`. Don't regenerate them to make the test pass.
