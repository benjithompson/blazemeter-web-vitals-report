---
'bzm-playwright-vitals': minor
---

Every Sample and Outcome now carries a stable, unique test identity: `test.id`
(Playwright's `testId`), `test.titlePath` (the describe chain, without the file) and
`test.path` (the spec path relative to `testDir`). Two tests with the same title in
different `describe` blocks, or same-named spec files in different directories, are no
longer indistinguishable.
