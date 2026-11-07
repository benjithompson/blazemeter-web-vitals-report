// Fixture spec for C1 (#40): two describe blocks holding a test with the SAME title. On
// (file, title, project) alone the two are indistinguishable: the collision that the
// collector's test.id and test.titlePath must break.
import { test, expect } from 'bzm-playwright-vitals';

test.describe('Checkout', () => {
  test('Same Title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');
  });
});

test.describe('Search', () => {
  test('Same Title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');
  });
});
