// Standalone-collector upload kit — a realistic small journey against public, stable
// pages. Written exactly as a tester would write it, except the one changed import
// points at the SIBLING FILE instead of the npm package (which is not published yet):
//
//   import { test, expect } from './bzm-vitals';   // was '@playwright/test'
//
// Playwright's own TS loader transpiles this relative import on the Engine, the same
// way it transpiles the spec itself. Nothing else here is collector-aware.
//
// WHY THIS JOURNEY IS SHAPED THE WAY IT IS (measured, not guessed — see README):
//   * Both Navigations stay on ONE site. A cross-SITE navigation (e.g. example.com ->
//     iana.org) swaps the Chromium renderer process, and the departing document's
//     pagehide flush is LOST — its Sample never lands (reproduced with an 8-line
//     exposeBinding probe; it is a platform behavior, not a collector bug). Same-site
//     document navigations flush reliably.
//   * The site is server-rendered (real document Navigations). An SPA like
//     playwright.dev intercepts link clicks client-side — no document Navigation, so
//     by design no second Sample.
//   * The interaction (typing in Wikipedia's search box) does real rendering work, so
//     its event-timing duration clears the 16ms floor and Navigation 1 gets a REAL
//     INP. A click on idle static text finishes under 16ms and honestly reports
//     'no-interaction'. The short pause afterwards lets the paint that finalizes the
//     interaction's duration happen before we navigate away.
import { test, expect } from './bzm-vitals';

test('Search Journey', async ({ page, vitals }) => {
  // Navigation 1 — a server-rendered article page.
  await page.goto('https://en.wikipedia.org/wiki/Web_performance');
  await expect(page.locator('h1').first()).toContainText(/web performance/i);
  // The one optional knob: declare a Route for the Navigation the page is currently on.
  vitals.route('/wiki/{article}');

  // A real interaction: focus the search box and type. Wikipedia fetches and renders
  // suggestions per keystroke — main-thread work, so this yields a real INP.
  await page.getByRole('searchbox').first().click();
  await page.keyboard.type('playwright', { delay: 40 });
  // Let the suggestion render (the paint that finalizes the interaction's duration).
  await page.waitForTimeout(500);

  // Navigation 2 — Enter submits the search: a same-site document Navigation to the
  // matching article (or the search results page — assert on either).
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/wiki\/Playwright|search=/i);
  await expect(page.locator('h1').first()).toBeVisible();
});

test('Single Page', async ({ page }) => {
  // A one-Navigation Execution with NO qualifying interaction: its Sample must report
  // inp {value: null, status: 'no-interaction'} — never 0, never absent. Flushes in
  // fixture teardown (no navigation away), so no cross-site caveat applies.
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
});
