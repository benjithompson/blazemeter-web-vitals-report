// Fixture spec for the STANDALONE build — written exactly as the upload kit's spec is:
// the collector arrives as a sibling file, not a package, and the one changed import is
// a RELATIVE one that Playwright's own TS loader must transpile (the same path Taurus
// takes on a BlazeMeter Engine):
//
//   import { test, expect } from './bzm-vitals';
//
// ./bzm-vitals.ts is NOT committed — test/standalone.test.ts regenerates it from
// src/index.ts via scripts/build-standalone.ts in beforeAll, so it can never be stale.
import { test, expect } from './bzm-vitals';

test('Standalone Landing Page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});

test('Standalone Journey', async ({ page, vitals }) => {
  // Navigation 1: a real click (so INP has a qualifying interaction) and a declared
  // route — vitals.route() must exist on the standalone surface too.
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/{id}');
  await expect(page.getByText('late content')).toBeVisible();
  await page.click('#target');
  // The handler appends #clicked-flag; awaiting it forces the paint that finalizes the
  // interaction's event-timing duration before we navigate away.
  await expect(page.locator('#clicked-flag')).toBeVisible();

  // Navigation 2: flushed by fixture teardown before the page closes.
  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
});
