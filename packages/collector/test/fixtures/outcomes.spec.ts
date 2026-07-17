// Fixture spec for issue #4 — the Outcome statuses beyond 'passed'/'failed' (those two
// ride the journey.spec.ts run). Same rule as every fixture spec: nothing here is
// collector-aware beyond the one changed import.
import { test, expect } from '@bzm/playwright-vitals';

test('Times Out', async ({ page }) => {
  // Small budget so the run stays fast; the wait below blows through it. The Sample
  // for Navigation 1 must still land — a timed-out Execution keeps its Samples.
  test.setTimeout(2_000);
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  await page.waitForTimeout(60_000);
});

// Statically skipped: Playwright never sets up fixtures for it — observed behavior is
// NO outcome record at all (asserted in outcome.test.ts, documented there).
test.skip('Skipped Statically', async ({ page }) => {
  await page.goto('/');
});

test('Skipped In Body', async ({ page }) => {
  // Fixtures ARE set up here (the body is running), so teardown sees status 'skipped'
  // and an Outcome records it. No navigation happened, so no Samples.
  test.skip(true, 'skipped from inside the body');
  await page.goto('/');
});
