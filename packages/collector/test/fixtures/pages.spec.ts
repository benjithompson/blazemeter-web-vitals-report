// Fixture spec — C6 (#42): every page the test opens in its context is measured, not
// only the `page` fixture. A popup the page opens, a page the test adds with
// context.newPage(), and a test that never touches `page` at all must all leave Samples,
// each stamped with the pageIndex of the page it was measured on (0 = the context's
// first page, then in the order the pages opened).
import { test, expect } from 'bzm-playwright-vitals';

test('Popup', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');

  // A real target=_blank link, clicked: the browser opens the popup itself.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'open-popup';
    a.href = '/second';
    a.target = '_blank';
    a.textContent = 'popup';
    document.body.appendChild(a);
  });
  const popupOpened = page.waitForEvent('popup');
  await page.click('#open-popup');
  const popup = await popupOpened;
  await expect(popup.locator('h1')).toHaveText('Second');

  // A test-driven navigation in the popup: its first document must flush before it goes.
  await popup.goto('/third');
  await expect(popup.locator('h1')).toHaveText('Third');
});

test('New Page Alongside Page', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');

  const second = await context.newPage();
  await second.goto('/second');
  await expect(second.locator('h1')).toHaveText('Second');
  await second.goto('/third');
  await expect(second.locator('h1')).toHaveText('Third');
});

test('Context Only', async ({ context }) => {
  // Never touches `page`: the first page the test opens is pageIndex 0.
  const only = await context.newPage();
  await only.goto('/');
  await expect(only.locator('h1')).toHaveText('Home');
});

test('Popup Closed By The Test', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');

  const popupOpened = page.waitForEvent('popup');
  await page.evaluate(() => window.open('/second', '_blank'));
  const popup = await popupOpened;
  await expect(popup.locator('h1')).toHaveText('Second');
  // page.close() itself flushes nothing; the popup's Sample must still be written.
  await popup.close();
});

test('Own Browser Context Is Not Measured', async ({ browser }) => {
  // A context the test creates itself is outside the fixture graph: not instrumented,
  // so it writes no Sample — and its pages' methods are Playwright's own, unpatched.
  const own = await browser.newContext();
  try {
    const p = await own.newPage();
    expect(Object.prototype.hasOwnProperty.call(p, 'goto')).toBe(false);
    await p.goto('/');
    await expect(p.locator('h1')).toHaveText('Home');
  } finally {
    await own.close();
  }
});

test('Patches Are Per Page Instance', async ({ page, context }) => {
  const other = await context.newPage();
  for (const method of ['goto', 'reload', 'goBack', 'goForward', 'close'] as const) {
    // Own properties on each measured page, never on the shared prototype.
    expect(Object.prototype.hasOwnProperty.call(page, method), method).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(other, method), method).toBe(true);
    expect(Object.getPrototypeOf(page)[method], method).not.toBe(page[method]);
  }
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});

test('Context Closed By The Test', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  const popupOpened = page.waitForEvent('popup');
  await page.evaluate(() => window.open('/second', '_blank'));
  const popup = await popupOpened;
  await expect(popup.locator('h1')).toHaveText('Second');
  // Closing the context flushes nothing by itself; both pages' Samples must be written.
  await context.close();
});
