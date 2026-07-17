// Fixture spec for issue #4 — a retry is ANOTHER Execution and records its own Outcome.
// Run under --retries 1: attempt 0 fails on the retry-index assertion, attempt 1 passes.
import { test, expect } from 'bzm-playwright-vitals';

test('Flaky', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  // Flaky by design: retry 0 fails here, retry 1 passes. Both attempts drove the same
  // Navigation, so both Executions leave Samples — joined to their own Outcome via
  // (repeat, worker), which differ because Playwright retries in a fresh worker.
  expect(testInfo.retry).toBe(1);
});
