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

// C7 (#46, re-verifying #13): the other ways a page leaves for another site on its own.
// None of them goes through goto(), so only the document's own beforeunload can flush.

const firstSite = process.env.PW_BASE_URL ?? '';

/** Wait until the current document has painted, as a tester asserting FCP would. */
async function painted(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() =>
    performance.getEntriesByType('paint').some((e) => e.name === 'first-contentful-paint'),
  );
}

test('Cross Site Form Submit', async ({ page, vitals }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/form');

  // A real cross-site POST form, submitted by clicking its button.
  await page.evaluate((action) => {
    const f = document.createElement('form');
    f.method = 'post';
    f.action = action;
    const b = document.createElement('button');
    b.id = 'cross-site-submit';
    b.type = 'submit';
    b.textContent = 'send';
    f.appendChild(b);
    document.body.appendChild(f);
  }, `${otherSite}/second`);
  await painted(page);
  await page.click('#cross-site-submit');
  await expect(page.locator('h1')).toHaveText('Second');
});

test('Cross Site Location Assignment', async ({ page, vitals }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/location');

  // The page's own script navigates (location.href = ...) on a click; the test only
  // waits for where it lands.
  await page.locator('#target').evaluate((el, href) => {
    el.addEventListener('click', () => { location.href = href; });
  }, `${otherSite}/third`);
  await painted(page);
  await page.click('#target');
  await expect(page.locator('h1')).toHaveText('Third');
});

// A journey that leaves the site and comes back, by several routes in turn. Every
// document it commits must leave its Sample, in order, each with only its own route.
test('Cross Site Round Trip', async ({ page, vitals }) => {
  await page.goto('/');                                       // 1  127.0.0.1 /
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/trip/1');
  await painted(page);
  await page.evaluate((href) => { location.assign(href); }, `${otherSite}/second`);
  await expect(page.locator('h1')).toHaveText('Second');      // 2  localhost /second
  // An absolute link back to the first site (the page's own links are relative).
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'back-home';
    a.href = href;
    a.textContent = 'back';
    document.body.appendChild(a);
  }, `${firstSite}/third`);
  await painted(page);
  await page.click('#back-home');
  await expect(page.locator('h1')).toHaveText('Third');       // 3  127.0.0.1 /third
  vitals.route('/trip/3');
  await page.goBack();                                        // 4  localhost /second
  await expect(page.locator('h1')).toHaveText('Second');
  await page.goto(`${firstSite}/`);                           // 5  127.0.0.1 /
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/trip/5');
});
