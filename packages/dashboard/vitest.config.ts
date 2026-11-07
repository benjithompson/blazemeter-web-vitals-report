import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Regenerates src/browser/bundle.generated.ts (the report's inline <script>) from the
    // real sources before any test file imports render.ts, so a test run can never embed a
    // stale browser bundle, however vitest was started.
    globalSetup: ['./test/global-setup.ts'],
    // Run the test FILES one at a time. The E1 budgets in report-scale.test.ts (a
    // 200k-Sample report generated in < 15 s and opened in Chromium in < 5 s) are
    // wall-clock measurements. With files in parallel, other suites' Chromium instances
    // and the D4 200k build compete for the same cores, and the open time measured the
    // machine rather than the report (5.9 s contended vs 3.4 s alone). The collector's
    // config serializes its files for the same reason.
    fileParallelism: false,
  },
});
