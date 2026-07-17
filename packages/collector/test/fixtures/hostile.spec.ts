// Fixture spec for the 'error' status path. The /hostile page shadows
// performance.getEntriesByType with a thrower AFTER the trap's init script ran (page
// scripts always run after init scripts), so the trap's flush-time timeline reads throw
// while its already-registered observers keep working. A throw must cost the metric,
// never the file.
import { test, expect } from '@bzm/playwright-vitals';

test('Hostile Page', async ({ page }) => {
  await page.goto('/hostile');
  await expect(page.locator('h1')).toHaveText('Hostile');
  await expect(page.getByText('late content')).toBeVisible();
});
