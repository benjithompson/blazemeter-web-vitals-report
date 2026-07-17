// A fixture spec written exactly as a tester would after the ONE changed import.
// Nothing here is collector-aware: no per-Navigation call, no teardown, no vitals import
// beyond `test`/`expect`. The only edit from a stock Playwright spec is this line:
//
//   import { test, expect } from '@bzm/playwright-vitals';   // was '@playwright/test'
//
// Every Navigation these tests drive must leave one Sample file behind on its own.
import { test, expect } from '@bzm/playwright-vitals';

test('Landing Page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});

test('Two Navigations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
});

test('Crasher', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  // Crash mid-journey, after Navigation 1 and before test end. Navigation 1's Sample
  // must already be on disk and must survive this throw.
  throw new Error('boom mid-journey');
});
