// Browser preconditions for the Seam 1 harness. A child `playwright test --project firefox`
// against a missing browser fails deep inside the child run, and the vitest assertions
// that read its (empty) output then fail as confusing count mismatches, or pass vacuously
// over an empty array. This module checks the executable up front instead:
//
//   - locally, with the browser missing, the cases that need it are SKIPPED and a one-line
//     reason is printed;
//   - with CI=true, a missing browser is a FAILURE whose message names the browser and the
//     install command. CI never skips silently.
//
// Use `firefoxRunOrSkip` in beforeAll to avoid launching a child run that cannot work,
// and `itFirefox` for every case whose assertions depend on that run.

import { existsSync } from 'node:fs';
import { firefox, type BrowserType } from '@playwright/test';
import { it } from 'vitest';

export interface BrowserCheck {
  /** Display name, e.g. "Firefox". */
  name: string;
  available: boolean;
  /** The executable Playwright would launch ('' if it could not be resolved). */
  executablePath: string;
  /** The one-line failure/skip reason, naming the browser and the fix. */
  message: string;
}

/** True when running under CI (GitHub Actions sets CI=true). */
export const IS_CI = /^(1|true)$/i.test(process.env.CI ?? '');

function checkBrowser(name: string, type: BrowserType, installName: string): BrowserCheck {
  let executablePath = '';
  try {
    executablePath = type.executablePath();
  } catch {
    // Unsupported platform or a broken registry: treat as missing.
  }
  const available = executablePath !== '' && existsSync(executablePath);
  const where = executablePath === '' ? '' : ` (looked for ${executablePath})`;
  return {
    name,
    available,
    executablePath,
    message: `${name} not installed: run npx playwright install ${installName}${where}`,
  };
}

export const FIREFOX: BrowserCheck = checkBrowser('Firefox', firefox, 'firefox');
export const hasFirefox = FIREFOX.available;

let warned = false;
function warnSkipOnce(check: BrowserCheck): void {
  if (warned) return;
  warned = true;
  console.warn(`[bzm-vitals test] skipping ${check.name} cases: ${check.message}`);
}

type TestFn = () => unknown;

/**
 * `it` for a case that needs Firefox. Present: a normal test. Missing locally: skipped,
 * with the reason in the test name and printed once. Missing with CI=true: a failing
 * test whose error is `Firefox not installed: run npx playwright install firefox`.
 */
export function itFirefox(name: string, fn: TestFn): void {
  if (FIREFOX.available) {
    it(name, fn);
  } else if (IS_CI) {
    it(name, () => {
      throw new Error(FIREFOX.message);
    });
  } else {
    warnSkipOnce(FIREFOX);
    it.skipIf(!FIREFOX.available)(`${name} [skipped: ${FIREFOX.name} not installed]`, fn);
  }
}

/**
 * Run `start` only when Firefox is installed; otherwise resolve to undefined so the
 * beforeAll never launches a child run that cannot work. The cases that read its result
 * are gated by `itFirefox`, which is where the skip or the CI failure is reported.
 */
export async function firefoxRunOrSkip<T>(start: () => Promise<T>): Promise<T | undefined> {
  return FIREFOX.available ? start() : undefined;
}
