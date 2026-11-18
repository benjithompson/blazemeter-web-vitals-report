---
'bzm-vitals-dashboard': minor
---

The report stays fast at 200k Samples. The timeline draws its points on a canvas, sharp
on high-density screens, and hovering a point still shows that Navigation's tooltip. The
timeline now reads in your local time zone, shows the zone on each chart's axis, and has
a "show times in UTC" toggle. Drill-downs are built level by level as you open them
(Route, Test, Engine), and an Engine's Navigation rows load 500 at a time behind a "show
more" button. The include-failed toggle responds in well under half a second. The
excluded view is computed while the page is idle, so the toggle usually only has to
show it.
