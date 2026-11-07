// Fixture spec for C2 — a fast click is still an interaction. The #fast handler does no
// work, so the click usually finishes under event-timing's 16ms durationThreshold and
// produces no 'event' entry; INP must nonetheless be 'ok', never 'no-interaction'.
// Nothing here waits for a paint or an entry after the click: the click is all a tester
// writes, and the collector's flush has to capture it on its own.
//
// Three Navigations, one fast click each. Chromium rounds durations to 8ms, so a fast
// click occasionally measures exactly 16 and slips past the threshold anyway; three
// documents make it vanishingly unlikely that EVERY click does, so the defect is
// reproduced reliably rather than most of the time.
import { test, expect } from 'bzm-playwright-vitals';

test('Fast Click', async ({ page }) => {
  for (const n of [1, 2, 3]) {
    await page.goto(`/fast?n=${n}`);
    await expect(page.locator('h1')).toHaveText('Fast');
    // The page's own late layout shift has landed, so nothing else is painting when the
    // click arrives.
    await expect(page.getByText('late content')).toBeVisible();
    await page.click('#fast');
  }
});
