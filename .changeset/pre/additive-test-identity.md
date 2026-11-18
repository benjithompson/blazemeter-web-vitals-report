---
'bzm-vitals-format': minor
'bzm-vitals-dashboard': minor
---

Format: a record's `test` identity gains three optional fields — `id` (Playwright's
`testId`), `titlePath` (the describe chain) and `path` (the spec path relative to
`testDir`) — and Samples and Outcomes gain the optional `pageIndex` and
`lostNavigations`. No `SCHEMA_VERSION` bump: every addition is optional, so records
written by collector 0.2.x still parse. `validateSample` / `validateOutcome` are the one
definition of a valid record, shared by writer and reader, and the package ships the same
rules as JSON Schema (`schema/sample.v1.json`, `schema/outcome.v1.json`).

Dashboard: every record goes through that validator, so a malformed record (a non-number
`value`, a missing `project`, an unknown metric status) is listed as unreadable, with a
reason, instead of reaching aggregation.
