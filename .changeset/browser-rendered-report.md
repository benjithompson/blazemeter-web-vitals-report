---
'bzm-vitals-dashboard': minor
---

The report embeds its data once, compressed, and renders in the browser, so
`report.html` is much smaller at scale. The include-failed toggle and the drill-downs are
computed in the page. With JavaScript off, or in a browser without `DecompressionStream`,
the report shows a summary (the Route table at p75, with coverage) instead.
