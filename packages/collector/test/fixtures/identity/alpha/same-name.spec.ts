// Fixture spec for C1 (#40): identity/alpha/ and identity/beta/ each hold a spec named
// same-name.spec.ts with the same test title, so (file, title, project) collide and
// only test.path (relative to the project's testDir) tells them apart.
import { test, expect } from 'bzm-playwright-vitals';

test('Same Basename', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});
