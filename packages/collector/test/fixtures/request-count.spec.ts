// Fixture spec for C3 — context.requestCount is per Navigation. Each /rc/* page makes a
// known number of requests (its document + N images; see fixture-server.ts), and the
// three counts differ, so a counter carried across documents cannot match them all.
import { test, expect } from 'bzm-playwright-vitals';
import type { Page } from '@playwright/test';

async function settled(page: Page, title: string): Promise<void> {
  await expect(page.locator('h1')).toHaveText(title);
  // Every image has loaded (or failed) — the document's requests are all made.
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
}

test('Three Gotos', async ({ page }) => {
  await page.goto('/rc/one');
  await settled(page, 'RC One');
  await page.goto('/rc/two');
  await settled(page, 'RC Two');
  await page.goto('/rc/three');
  await settled(page, 'RC Three');
});

test('Link Clicks', async ({ page }) => {
  // The same three documents, left by clicking links instead: these documents flush at
  // beforeunload, not before a test-driven goto.
  await page.goto('/rc/one');
  await settled(page, 'RC One');
  await page.click('#to-two');
  await settled(page, 'RC Two');
  await page.click('#to-three');
  await settled(page, 'RC Three');
});
