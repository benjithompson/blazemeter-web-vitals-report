// The example journey — written exactly as a tester would write it. The ONE
// collector-aware line is the import: '@playwright/test' became
// 'bzm-playwright-vitals'. Everything else is a plain Playwright test.
//
// (No npm registry access on your Engines? Download bzm-playwright-vitals.ts
// from this repo's GitHub release, upload it next to this spec, and change the
// import to './bzm-playwright-vitals' — nothing else changes.)
//
// WHY THIS JOURNEY IS SHAPED THE WAY IT IS (measured, not guessed — see README):
//   * Both Navigations stay on ONE site. A cross-SITE navigation (e.g.
//     example.com -> iana.org) swaps the Chromium renderer process and the
//     departing document's Sample is lost — a platform behavior, not a
//     collector bug. Same-site document navigations flush reliably.
//   * The site is server-rendered (real document Navigations). An SPA like
//     playwright.dev intercepts link clicks client-side — no document
//     Navigation, so by design no second Sample.
//   * The interaction (typing in Wikipedia's search box) does real rendering
//     work, so its event-timing duration clears the 16ms floor and
//     Navigation 1 gets a REAL INP. A click on idle static text finishes under
//     16ms and honestly reports 'no-interaction'. The short pause afterwards
//     lets the paint that finalizes the interaction's duration happen before
//     we navigate away.
import { test, expect } from 'bzm-playwright-vitals';

test('Search Journey', async ({ page, vitals }) => {
  // Navigation 1 — a server-rendered article page.
  await page.goto('https://en.wikipedia.org/wiki/Web_performance');
  await expect(page.locator('h1').first()).toContainText(/web performance/i);
  // The one optional knob: name the Route the page is currently on, so dynamic
  // URLs group under one dashboard row. Skip it and the URL path is the Route.
  vitals.route('/wiki/{article}');

  // A real interaction: focus the search box and type. Wikipedia fetches and
  // renders suggestions per keystroke — main-thread work, so a real INP.
  await page.getByRole('searchbox').first().click();
  await page.keyboard.type('playwright', { delay: 40 });
  // Let the suggestion render (the paint that finalizes the interaction's duration).
  await page.waitForTimeout(500);

  // Navigation 2 — Enter submits the search: a same-site document Navigation to
  // the matching article (or the search results page — assert on either).
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/wiki\/Playwright|search=/i);
  await expect(page.locator('h1').first()).toBeVisible();
});

test('Single Page', async ({ page }) => {
  // A one-Navigation test with NO qualifying interaction: its record reports
  // inp {value: null, status: 'no-interaction'} — never 0, never absent.
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
});
