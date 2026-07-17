// Publish-check kit — the SAME journey as upload-kit/example.spec.ts, with the one
// difference this kit exists to prove: the import is the PUBLISHED PACKAGE NAME, so
// the collector must arrive via the Engine's own `npm install` from the registry.
// No collector file is uploaded. If this import fails to resolve, the run dies at
// startup and every Execution errors — loud, which is the point.
//
// Journey shape rationale (measured, not guessed) lives in upload-kit/example.spec.ts
// and upload-kit/README.md: one site per journey (cross-site loses the departing
// Sample), server-rendered pages (SPA clicks aren't Navigations), and an interaction
// that does real rendering work so Navigation 1 earns a real INP.
import { test, expect } from 'bzm-playwright-vitals';

test('Search Journey', async ({ page, vitals }) => {
  // Navigation 1 — a server-rendered article page.
  await page.goto('https://en.wikipedia.org/wiki/Web_performance');
  await expect(page.locator('h1').first()).toContainText(/web performance/i);
  vitals.route('/wiki/{article}');

  // A real interaction: Wikipedia renders suggestions per keystroke — main-thread
  // work, so this yields a real INP.
  await page.getByRole('searchbox').first().click();
  await page.keyboard.type('playwright', { delay: 40 });
  await page.waitForTimeout(500);

  // Navigation 2 — Enter submits the search: a same-site document Navigation.
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/wiki\/Playwright|search=/i);
  await expect(page.locator('h1').first()).toBeVisible();
});

test('Single Page', async ({ page }) => {
  // One Navigation, no qualifying interaction: inp must be
  // {value: null, status: 'no-interaction'} — never 0, never absent.
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
});
