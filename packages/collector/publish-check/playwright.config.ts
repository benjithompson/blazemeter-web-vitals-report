import { defineConfig, devices } from '@playwright/test';

// Publish-check kit — identical to upload-kit/playwright.config.ts. Taurus overrides
// --output, --workers, --repeat-each, --project and --reporter on the CLI regardless;
// none of that can touch what the spec imports, which is what this kit tests.
//
// A `chromium` project MUST exist — Taurus passes --project=chromium.

export default defineConfig({
  testDir: '.',
  fullyParallel: true,

  // Deliberate: NOT `process.env.CI ? 2 : 0`. Retries would emit extra
  // Samples/Outcomes and cloud the expected file counts. Pin it.
  retries: 0,

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
