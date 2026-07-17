// Fixture spec for issue #4 — the TRUE crash: the harness SIGKILLs the whole process
// group mid-test, so no teardown runs anywhere. The Execution must leave its already-
// flushed Samples and NO Outcome record — that absence IS the crash signal.
import { test, expect } from 'bzm-playwright-vitals';
import { writeFile } from 'node:fs/promises';

test('Killed Mid Flight', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Home');
  // Navigating away flushes Navigation 1's Sample at pagehide — it is on disk before
  // the kill lands. Navigation 2 never flushes (no teardown), and that loss is honest.
  await page.goto('/second');
  await expect(page.locator('h1')).toHaveText('Second');
  // Let Navigation 1's write settle, then signal the harness to SIGKILL us and hang.
  await page.waitForTimeout(500);
  await writeFile(process.env.PW_KILL_SENTINEL!, 'ready');
  await page.waitForTimeout(60_000);
});
