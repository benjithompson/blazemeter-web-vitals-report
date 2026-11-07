import { defineConfig, devices } from '@playwright/test';

// Standalone-collector upload kit — mirrors a probe config that ran on BlazeMeter
// (SPEC.md, "The real Taurus invocation").
//
// Minimal on purpose. Taurus overrides --output, --workers, --repeat-each,
// --project and --reporter on the CLI regardless of what's declared here — none
// of which can touch what the spec imports, which is why the collector survives.
//
// A `chromium` project MUST exist — Taurus passes --project=chromium.

export default defineConfig({
  testDir: '.',
  fullyParallel: true,

  // Deliberate: NOT `process.env.CI ? 2 : 0`. If CI is set on the Engine, retries
  // would emit extra Samples/Outcomes and cloud the expected file counts. Pin it.
  retries: 0,

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
