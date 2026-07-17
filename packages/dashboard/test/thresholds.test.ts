// threshold(metric, p75) — the dot decision as computable DATA.
//
// web.dev's Core Web Vitals bands are DEFINED at p75; the renderer consumes
// this function's verdict and never re-decides. Bands, per metric:
//   LCP 2500/4000 ms · INP 200/500 ms · CLS 0.1/0.25 · FCP 1800/3000 ms ·
//   TTFB 800/1800 ms. good ≤ goodMax < needs-improvement ≤ poorMin < poor.
// Open-set metric names carry NO band — no dot, never a guessed one.

import { describe, it, expect } from 'vitest';
import { threshold } from '../src/thresholds.js';

describe('threshold — web.dev CWV bands, per metric, defined at p75', () => {
  it('LCP: good ≤ 2500 < needs-improvement ≤ 4000 < poor', () => {
    expect(threshold('lcp', 2264)).toBe('good'); // the real demo p75 (excl. one engine) is green
    expect(threshold('lcp', 2500)).toBe('good'); // boundary: 2500 is still good
    expect(threshold('lcp', 2500.1)).toBe('needs-improvement');
    expect(threshold('lcp', 4000)).toBe('needs-improvement'); // boundary
    expect(threshold('lcp', 4000.1)).toBe('poor');
  });

  it('INP: 200/500 ms', () => {
    expect(threshold('inp', 200)).toBe('good');
    expect(threshold('inp', 201)).toBe('needs-improvement');
    expect(threshold('inp', 500)).toBe('needs-improvement');
    expect(threshold('inp', 501)).toBe('poor');
  });

  it('CLS: 0.1/0.25 — unitless', () => {
    expect(threshold('cls', 0.00059)).toBe('good');
    expect(threshold('cls', 0.1)).toBe('good');
    expect(threshold('cls', 0.100001)).toBe('needs-improvement');
    expect(threshold('cls', 0.25)).toBe('needs-improvement');
    expect(threshold('cls', 0.26)).toBe('poor');
  });

  it('FCP: 1800/3000 ms', () => {
    expect(threshold('fcp', 1800)).toBe('good');
    expect(threshold('fcp', 1801)).toBe('needs-improvement');
    expect(threshold('fcp', 3000)).toBe('needs-improvement');
    expect(threshold('fcp', 3001)).toBe('poor');
  });

  it('TTFB: 800/1800 ms', () => {
    expect(threshold('ttfb', 183)).toBe('good'); // the real p75
    expect(threshold('ttfb', 800)).toBe('good');
    expect(threshold('ttfb', 801)).toBe('needs-improvement');
    expect(threshold('ttfb', 1800)).toBe('needs-improvement');
    expect(threshold('ttfb', 1801)).toBe('poor');
  });

  it('the bands are per-metric, not decorative: 2276 is green as LCP, amber as FCP', () => {
    expect(threshold('lcp', 2276)).toBe('good');
    expect(threshold('fcp', 2276)).toBe('needs-improvement');
  });

  it('open-set metric names carry no band — null, never a guessed dot', () => {
    expect(threshold('tbt', 50)).toBeNull();
    expect(threshold('myCustomTiming', 999999)).toBeNull();
  });

  it('matches metric names case-insensitively', () => {
    expect(threshold('LCP', 2000)).toBe('good');
    expect(threshold('Cls', 0.3)).toBe('poor');
  });
});
