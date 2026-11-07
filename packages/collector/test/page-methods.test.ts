// Guard — the collector flushes a document before a test-driven navigation by
// wrapping these Page methods on each measured page instance. If Playwright ever renames
// or removes one, the wrap would no longer sit on the method testers call and that
// navigation would silently stop flushing. This fails first, naming the method.
//
// Keep this list in step with NAVIGATING_PAGE_METHODS in src/index.ts (the source check
// below fails if they drift).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';

const METHODS = ['goto', 'reload', 'goBack', 'goForward', 'close'] as const;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe('the Page methods the collector wraps still exist under those names', () => {
  for (const method of METHODS) {
    it(`Page.prototype.${method} is a function`, () => {
      const proto = Object.getPrototypeOf(page) as Record<string, unknown>;
      expect(typeof proto[method], `Playwright Page has no '${method}' method`).toBe('function');
    });
  }

  it('an unmeasured page carries no own wrapper (the collector never patches the prototype)', () => {
    for (const method of METHODS) {
      expect(Object.prototype.hasOwnProperty.call(page, method), method).toBe(false);
    }
  });

  it('src/index.ts wraps exactly these methods', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const match = /const NAVIGATING_PAGE_METHODS = \[([^\]]*)\] as const;/.exec(source);
    expect(match, 'NAVIGATING_PAGE_METHODS not found in src/index.ts').not.toBeNull();
    const listed = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...METHODS]);
  });
});
