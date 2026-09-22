// Fixture spec — navigations that swap the document's frame. A cross-SITE navigation
// (127.0.0.1 -> localhost are different sites) moves to a new renderer process, and
// from Playwright 1.63 Chromium's RenderDocument swaps the frame on EVERY navigation.
// Either way the departing document can no longer reach Node at pagehide, so its Sample
// must already be on its way: flushed before a test-driven goto(), or at beforeunload
// for a link click.
import { test, expect } from 'bzm-playwright-vitals';

const otherSite = (process.env.PW_BASE_URL ?? '').replace('127.0.0.1', 'localhost');

test('Cross Site Goto', async ({ page, vitals }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/goto');

  await page.goto(`${otherSite}/second`);
  await expect(page.locator('h1')).toHaveText('Second');
});

test('Cross Site Link Click', async ({ page, vitals }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/click');

  // A real link to the other site, clicked: the page navigates itself, so there is no
  // goto() to flush before — only the document's own beforeunload.
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'cross-site-link';
    a.href = href;
    a.textContent = 'elsewhere';
    document.body.appendChild(a);
  }, `${otherSite}/third`);
  // beforeunload reads the timeline as it stands — it cannot wait. Under load the first
  // paint can trail the visible h1 by 400ms+, and a click before it would (honestly)
  // leave fcp 'not-finalized'. Wait until FCP exists, as a tester asserting it would.
  await page.waitForFunction(() =>
    performance.getEntriesByType('paint').some((e) => e.name === 'first-contentful-paint'),
  );
  await page.click('#cross-site-link');
  await expect(page.locator('h1')).toHaveText('Third');
});
