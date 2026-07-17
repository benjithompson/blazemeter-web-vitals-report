// Fixture spec for issue #3 — the five-vitals journeys. Same rule as journey.spec.ts:
// nothing here is collector-aware beyond the one changed import. The waits are what a
// real tester writes anyway (assert what the user sees); they also make the harness's
// CLS/INP assertions deterministic instead of a race against the flush.
import { test, expect } from '@bzm/playwright-vitals';

test('Click Then Navigate', async ({ page }) => {
  // Navigation 1: a real click (INP's qualifying interaction), then navigate away —
  // this document flushes at pagehide, so its LCP/CLS/INP must survive WITHOUT the
  // teardown grace-wait.
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  // The fixture page shifts layout 50ms in; waiting for the shifted-in content pins
  // the shift before the click (so it cannot be excluded as input-adjacent).
  await expect(page.getByText('late content')).toBeVisible();
  // toBeVisible asserts LAYOUT, not paint presentation — and Chromium only REPORTS an
  // LCP candidate on the frame's presentation feedback, then stops LCP cold at the
  // first input, silently dropping a candidate whose feedback hasn't arrived yet
  // (measured: a click landing before that feedback erases LCP forever while FCP
  // still shows up). A layout shift presented after the click would likewise be
  // excluded as input-adjacent. So under CPU load the click below could race the
  // compositor and make LCP/CLS honestly unmeasurable. Wait until both entries
  // actually EXIST before clicking — plain page-side code: a buffered observer
  // replays entries the browser has already reported, synchronously via takeRecords.
  // (Gated per type on supportedEntryTypes: this spec also runs on firefox, which has
  // no layout-shift — an unsupported type would make the wait hang to the timeout.)
  await page.waitForFunction(() => {
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const has = (type: string) => {
      if (!supported.includes(type)) return true; // nothing will ever arrive — skip
      const probe = new PerformanceObserver(() => {});
      probe.observe({ type, buffered: true });
      const n = probe.takeRecords().length;
      probe.disconnect();
      return n > 0;
    };
    return has('largest-contentful-paint') && has('layout-shift');
  });
  await page.click('#target');
  // The click handler appends #clicked-flag; awaiting it forces the paint that
  // finalizes the interaction's event-timing duration before we navigate away.
  await expect(page.locator('#clicked-flag')).toBeVisible();

  // Navigation 2: no click on this document — its INP is honestly 'no-interaction'.
  // The test ends here, so this document flushes in teardown, before the page closes.
  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
  await expect(page.getByText('late content')).toBeVisible();
});

test('Navigate Only', async ({ page }) => {
  // No interaction anywhere: INP must be {value: null, status: 'no-interaction'} —
  // never 0, never absent. Ends without navigating away, so CLS surviving here proves
  // the teardown flush ran before page close (page.close() itself flushes nothing).
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(page.getByText('late content')).toBeVisible();
});
