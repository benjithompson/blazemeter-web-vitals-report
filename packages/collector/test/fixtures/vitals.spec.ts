// Fixture spec for issue #3 — the five-vitals journeys. Same rule as journey.spec.ts:
// nothing here is collector-aware beyond the one changed import. The waits are what a
// real tester writes anyway (assert what the user sees); they also make the harness's
// CLS/INP assertions deterministic instead of a race against the flush.
import { test, expect } from '@bzm/playwright-vitals';

test('Click Then Navigate', async ({ page }) => {
  // Navigation 1: a real click (INP's qualifying interaction), then navigate away —
  // this document flushes at pagehide, so its LCP/CLS/INP must survive WITHOUT the
  // teardown grace-wait.
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  // The fixture page shifts layout 50ms in; waiting for the shifted-in content pins
  // the shift before the click (so it cannot be excluded as input-adjacent).
  await expect(page.getByText('late content')).toBeVisible();
  await page.click('#target');
  // The click handler appends #clicked-flag; awaiting it forces the paint that
  // finalizes the interaction's event-timing duration before we navigate away.
  await expect(page.locator('#clicked-flag')).toBeVisible();

  // Navigation 2: no click on this document — its INP is honestly 'no-interaction'.
  // The test ends here, so this document flushes in teardown, before the page closes.
  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
  await expect(page.getByText('late content')).toBeVisible();
});

test('Navigate Only', async ({ page }) => {
  // No interaction anywhere: INP must be {value: null, status: 'no-interaction'} —
  // never 0, never absent. Ends without navigating away, so CLS surviving here proves
  // the teardown flush ran before page close (page.close() itself flushes nothing).
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(page.getByText('late content')).toBeVisible();
});
