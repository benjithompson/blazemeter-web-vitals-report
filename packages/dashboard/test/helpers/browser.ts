// Open an emitted report in Playwright's Chromium, over file://, and wait for
// the in-browser render to settle. Callers skip with a reason when no
// Chromium is installed (haveChromium).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

let chromiumPath: string | null = null;
try {
  chromiumPath = chromium.executablePath();
} catch {
  chromiumPath = null;
}
export const haveChromium = chromiumPath !== null && existsSync(chromiumPath);

export function warnNoChromium(file: string): void {
  if (!haveChromium) console.warn(`${file}: skipping browser checks — no Playwright Chromium installed`);
}

export { chromium, type Browser, type BrowserContext, type Page };

/** The states #bzm-app ends in; 'loading' and 'static' are transient. */
export const SETTLED = '#bzm-app[data-bzm-state="ready"], #bzm-app[data-bzm-state="error"], #bzm-app[data-bzm-state="unsupported"]';

/** Write `html` into `dir`, open it, and wait for the render to settle — in a
 *  new page of `browser`, or of a context (an emulated time zone, a pixel ratio). */
export async function openReport(
  browser: Browser | BrowserContext,
  html: string,
  dir: string,
  opts: { timeout?: number; before?: (page: Page) => Promise<void> } = {},
): Promise<{ page: Page; fileUrl: string; ms: number; errors: string[] }> {
  const file = join(dir, `report-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const fileUrl = pathToFileURL(file).href;
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (opts.before) await opts.before(page);
  const t0 = Date.now();
  await page.goto(fileUrl, { waitUntil: 'load', timeout: opts.timeout ?? 30_000 });
  await page.waitForSelector(SETTLED, { state: 'attached', timeout: opts.timeout ?? 30_000 });
  return { page, fileUrl, ms: Date.now() - t0, errors };
}

/** Poll `predicate` in the page until it returns a truthy value (which is
 *  returned). page.waitForFunction cannot be used here: it evaluates its
 *  predicate from a string, which the report's CSP (no 'unsafe-eval') blocks. */
export async function until<A, R>(
  page: Page,
  predicate: (arg: A) => R,
  arg: A,
  timeout = 30_000,
): Promise<R> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate as (arg: A) => R, arg);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`until: still false after ${timeout} ms`);
    await page.waitForTimeout(25);
  }
}

export async function appState(page: Page): Promise<string | null> {
  return page.getAttribute('#bzm-app', 'data-bzm-state');
}
