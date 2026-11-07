// What the browser renders into #bzm-app, built in Node with the SAME
// functions the browser bundle calls (src/browser/views.ts over
// buildReportVariants). test/browser-render.test.ts proves the page's DOM is
// exactly this markup, so string assertions on it are assertions on the
// rendered report. Drill-downs and the excluded variant are filled eagerly
// here; the browser fills them on first use, with the same functions. The
// timeline reads in UTC unless a zone is given (the browser: the viewer's).
import type { ReportData } from '../../src/report.js';
import { appHtml, type DrillMode, type ZoneChoice } from '../../src/browser/views.js';
import { buildReportVariants } from '../../src/view-model.js';

export function renderedHtml(data: ReportData, drills: DrillMode = 'eager', zone?: ZoneChoice): string {
  const variants = buildReportVariants(data);
  return appHtml({
    outcomes: variants.outcomes,
    included: variants.included,
    toggleEnabled: variants.excluded !== null,
    excluded: drills === 'eager' ? variants.excluded : undefined,
    drills,
    ...(zone === undefined ? {} : { zone }),
  });
}
