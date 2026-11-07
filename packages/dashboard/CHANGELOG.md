# bzm-vitals-dashboard

## 0.5.0

### Minor Changes

- e2cf231: Format: a record's `test` identity gains three optional fields — `id` (Playwright's
  `testId`), `titlePath` (the describe chain) and `path` (the spec path relative to
  `testDir`) — and Samples and Outcomes gain the optional `pageIndex` and
  `lostNavigations`. No `SCHEMA_VERSION` bump: every addition is optional, so records
  written by collector 0.2.x still parse. `validateSample` / `validateOutcome` are the one
  definition of a valid record, shared by writer and reader, and the package ships the same
  rules as JSON Schema (`schema/sample.v1.json`, `schema/outcome.v1.json`).
  
  Dashboard: every record goes through that validator, so a malformed record (a non-number
  `value`, a missing `project`, an unknown metric status) is listed as unreadable, with a
  reason, instead of reaching aggregation.
- e2cf231: The report embeds its data once, compressed, and renders in the browser, so
  `report.html` is much smaller at scale. The include-failed toggle and the drill-downs are
  computed in the page. With JavaScript off, or in a browser without `DecompressionStream`,
  the report shows a summary (the Route table at p75, with coverage) instead.
- 01c203c: The report stays fast at 200k Samples. The timeline draws its points on a canvas, sharp
  on high-density screens, and hovering a point still shows that Navigation's tooltip. The
  timeline now reads in your local time zone, shows the zone on each chart's axis, and has
  a "show times in UTC" toggle. Drill-downs are built level by level as you open them
  (Route, Test, Engine), and an Engine's Navigation rows load 500 at a time behind a "show
  more" button. The include-failed toggle responds in well under half a second. The
  excluded view is computed while the page is idle, so the toggle usually only has to
  show it.
- e2cf231: Tests are grouped, and Outcomes joined to their Samples, by `test.id` when the records
  carry one, else by file + title + project as before. Two Tests that share a spec name and
  a title are now two rows, labelled by their describe chain and spec path. A Report that
  mixes old and new collector records keeps one row per Test where the match is
  unambiguous.
- e2cf231: Artifacts are read lazily, in memory: only the vitals records inside each `artifacts.zip`
  are inflated and checksum-verified, and the videos, traces and HTML reports beside them
  are skipped. The API path no longer extracts zips into the cache, and session folders an
  older cache extracted are removed. `--extract <dir>` stays, as a debugging aid only.

### Patch Changes

- 948c147: The timeline's ticks now sit on round times in the time zone you are reading
  in, so an hour step reads `23:00:00` in India or Newfoundland, not `22:30:00`,
  and a day step reads local midnights. When a chart's span crosses a
  daylight-saving change, the axis names both zones (`EDT/EST`) and the ticks keep
  to the local clock. A drill-down's Navigation rows now follow the time-zone
  toggle too: the time column names the zone in force (`time (EST)`), and flipping
  the toggle re-reads every row already shown, including rows added with "show
  more". Building the excluded view (failed Executions left out) is more than twice
  as fast at 200k Samples: the report reads every Sample's vitals once, when it
  loads, and both views are computed from that.
- Updated dependencies [e2cf231]
  - bzm-vitals-format@0.3.0
