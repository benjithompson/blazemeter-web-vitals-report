# bzm-playwright-vitals

## 0.3.0

### Minor Changes

- 853bf61: Every page a test opens in its context is measured, not only the `page` fixture: popups
  (`page.waitForEvent('popup')`) and `context.newPage()` pages now write Samples too. Each
  Sample carries `pageIndex` (0 = the context's first page, then in open order), and a
  page or context the test closes itself still records its last Navigation. A context
  created with `browser.newContext()` is not measured.
- e2cf231: Every Sample and Outcome now carries a stable, unique test identity: `test.id`
  (Playwright's `testId`), `test.titlePath` (the describe chain, without the file) and
  `test.path` (the spec path relative to `testDir`). Two tests with the same title in
  different `describe` blocks, or same-named spec files in different directories, are no
  longer indistinguishable.

### Patch Changes

- db60f1a: README: drop the "keep each journey on one site" limitation. Re-verified on Playwright
  1.63 (#13): a cross-site navigation by `goto()`, link click, form submit, location
  assignment or history keeps the departing document's Sample, and a pending
  `vitals.route()` lands on the document it was declared for. No code change.
- Updated dependencies [e2cf231]
  - bzm-vitals-format@0.3.0
