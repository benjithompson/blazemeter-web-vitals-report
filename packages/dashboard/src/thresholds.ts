// The threshold dot as computable DATA — web.dev's Core Web Vitals bands.
//
// The bands are DEFINED at p75 (which is why p75 leads and why colouring any
// other statistic against them is wrong by construction — asserted in the
// view-model tests: the dot lives on p75 and nowhere else). The renderer
// consumes this verdict; it never re-decides.
//
// Metric names are an open set; bands exist only for the documented five.
// An unbanded metric gets null — no dot, never a guessed one.

export type ThresholdBand = 'good' | 'needs-improvement' | 'poor';

/** web.dev's published p75 bands: good ≤ goodMax < needs-improvement ≤ poorMin < poor. */
const BANDS: Record<string, { goodMax: number; poorMin: number }> = {
  lcp: { goodMax: 2500, poorMin: 4000 }, // ms
  inp: { goodMax: 200, poorMin: 500 }, // ms
  cls: { goodMax: 0.1, poorMin: 0.25 }, // unitless
  fcp: { goodMax: 1800, poorMin: 3000 }, // ms
  ttfb: { goodMax: 800, poorMin: 1800 }, // ms
};

/**
 * The band a p75 value falls in for a metric, or null when the metric carries
 * no web.dev band (open-set extras). Boundary values belong to the better band,
 * matching web.dev's "good ≤ 2500ms" phrasing.
 */
export function threshold(metricName: string, p75: number): ThresholdBand | null {
  const band = BANDS[metricName.toLowerCase()];
  if (band === undefined) return null;
  if (p75 <= band.goodMax) return 'good';
  if (p75 <= band.poorMin) return 'needs-improvement';
  return 'poor';
}
