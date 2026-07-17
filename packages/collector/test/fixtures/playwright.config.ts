// The child Playwright config the Seam 1 harness drives. Deliberately minimal and close
// to what Taurus imposes: a single project literally named "chromium", output dir and
// baseURL supplied by the harness via env. The harness overrides --output/--workers/
// --repeat-each/--project on the CLI, mirroring Taurus — none of which can touch what a
// spec file imports, which is exactly why the auto-fixture survives.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // testDir defaults to this config file's directory — kept implicit so the config stays
  // ESM-safe (no __dirname; the collector package is "type": "module").
  outputDir: process.env.PW_OUTPUT_DIR,
  reporter: [['list']],
  // No retries: a retried Execution would emit a second set of Samples and cloud the
  // harness's file counts.
  retries: 0,
  use: {
    baseURL: process.env.PW_BASE_URL,
  },
  projects: [
    // channel 'chromium' is deliberate: default headless runs the old chrome-headless-shell
    // path, where LCP/INP are paint-terminated (SPEC.md). This is the path Taurus should
    // run too, so the harness measures the branded-headless behavior the library targets.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    // Non-Chromium engine: no LayoutShift API. Exists so the harness can prove a Sample
    // is STILL emitted with cls 'unsupported' — the incumbent's silent skip is the defect.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
