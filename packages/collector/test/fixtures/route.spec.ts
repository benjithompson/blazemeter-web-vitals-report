// Fixture spec for issue #4 — vitals.route(), the only knob on the whole surface.
// The `vitals` fixture is destructured next to `page` exactly as SPEC.md shows; specs
// that never mention it (journey.spec.ts et al.) must keep working unchanged.
import { test, expect } from 'bzm-playwright-vitals';

test('Declared Routes', async ({ page, vitals }) => {
  // route() after goto tags the Navigation the page is currently on — including an
  // INTERMEDIATE one: Navigation 1 flushes as the next goto leaves it, after the
  // declaration below has already been consumed-into-pending.
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  vitals.route('/home/{id}');

  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
  // Verbatim, braces and all — the collector never normalizes a declared Route.
  vitals.route('/second/{orderId}');
});

test('Route Before First Navigation', async ({ page, vitals }) => {
  // Declared before any navigation: applies to the NEXT one.
  vitals.route('/pre-declared');
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});

test('No Route Declared', async ({ page, vitals }) => {
  // Destructures `vitals` but never calls route(): a supported, correct state — the
  // Sample must carry NO route field and the raw url intact.
  void vitals;
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
});
