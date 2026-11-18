---
'bzm-vitals-dashboard': patch
---

The timeline's ticks now sit on round times in the time zone you are reading
in, so an hour step reads `23:00:00` in India or Newfoundland, not `22:30:00`,
and a day step reads local midnights. When a chart's span crosses a
daylight-saving change, the axis names both zones (`EDT/EST`) and the ticks keep
to the local clock. A drill-down's Navigation rows now follow the time-zone
toggle too: the time column names the zone in force (`time (EST)`), and flipping
the toggle re-reads every row already shown, including rows added with "show
more". Building the excluded view (failed Executions left out) is more than twice
as fast at 200k Samples: the report reads every Sample's vitals once, when it
loads, and both views are computed from that.
