// Fixture spec for C0 — the web-vitals reference oracle (test-only; Chromium only).
//
// The web-vitals attribution build is injected NEXT TO the collector, on the same
// documents, so both measure the same Navigations from the same performance entries.
// web-vitals reports into window.__bzmOracle; before each document is left, the spec
// copies that reading out, and at the end it writes every reading to bzm-oracle.json in
// the test's output dir. oracle.test.ts pairs them with the collector's Samples.
//
// This is test infrastructure, not a tester's spec: page.evaluate here runs only after
// a document has settled, and web-vitals is a devDependency that never ships.
//
// The Navigations, in order:
//   1. /                 — the late layout shift, and a SLOW click (#target burns ~30ms)
//   2. /oracle/slow-lcp  — a slow-loading image that becomes the LCP element and shifts
//                          the text below it when it arrives; no interaction
//   3-5. /second, /third, /second — a FAST click each (on the h1, which has no handler).
//        Three of them, because Chromium rounds durations to 8ms and a lone fast click
//        occasionally measures 16 and clears the collector's threshold by luck.
import { test, expect } from 'bzm-playwright-vitals';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';

const require = createRequire(import.meta.url);
// The IIFE build defines a global `webVitals`. It is not in the package's exports map,
// so locate it beside the attribution entry point.
const WEB_VITALS_IIFE = join(
  dirname(require.resolve('web-vitals/attribution')),
  'web-vitals.attribution.iife.js',
);

export interface OracleReading {
  url: string;
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  inp: number | null;
}

type WebVitals = Record<string, (cb: (m: { value: number }) => void, o?: object) => void>;

/** Registers every web-vitals callback with reportAllChanges, so the latest value of
 *  each metric is always readable before the document is left. Receives the library
 *  object directly: the IIFE's top-level `var webVitals` is scoped to the init script
 *  it runs in, not a window global. */
function registerOracle(webVitals: WebVitals): void {
  const w = window as unknown as { __bzmOracle: Record<string, number | null> };
  if (window.top !== window) return;
  // web-vitals processes INP entries in a requestIdleCallback (or on hidden). Measured
  // in headless Chromium: after the slow click's handler the idle callback can fail to
  // fire for over a second, so the reading would never arrive. A deadline on the SAME
  // idle callback makes it run regardless; it changes when web-vitals does its
  // bookkeeping, never which entries it reads or what it computes.
  const ric = window.requestIdleCallback;
  if (typeof ric === 'function') {
    window.requestIdleCallback = (cb, opts) => ric.call(window, cb, { timeout: 100, ...opts });
  }
  const o = { lcp: null, cls: null, fcp: null, ttfb: null, inp: null } as Record<string, number | null>;
  w.__bzmOracle = o;
  const all = { reportAllChanges: true };
  webVitals.onLCP!((m) => { o.lcp = m.value; }, all);
  webVitals.onCLS!((m) => { o.cls = m.value; }, all);
  webVitals.onFCP!((m) => { o.fcp = m.value; }, all);
  webVitals.onTTFB!((m) => { o.ttfb = m.value; }, all);
  // durationThreshold 16 = the collector's own: the oracle checks the INP algorithm,
  // not a different observation threshold (web-vitals defaults to 40).
  webVitals.onINP!((m) => { o.inp = m.value; }, { reportAllChanges: true, durationThreshold: 16 });
}

/** A noisy PNG: high-entropy, so Chromium accepts it as an LCP candidate (it ignores
 *  low-entropy images such as an upscaled 1x1 pixel). */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SLOW_LCP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Slow LCP</title></head>
<body style="font-family: sans-serif; margin: 2rem;">
  <h1>Slow LCP</h1>
  <img id="hero" src="/oracle/hero.png" alt="hero">
  <p>text below the image, pushed down when it arrives</p>
</body></html>`;

/** Wait until the document's measurable entries exist and web-vitals has reported. */
async function settle(page: Page, opts: { interacted: boolean }): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((interacted) => {
        const o = (window as unknown as { __bzmOracle?: Record<string, number | null> }).__bzmOracle;
        if (!o) return false;
        const base = o.lcp !== null && o.cls !== null && o.fcp !== null && o.ttfb !== null;
        return base && (!interacted || o.inp !== null);
      }, opts.interacted),
    )
    .toBe(true);
  // A further paint, so anything web-vitals queued for idle time has landed too.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))),
  );
}

async function read(page: Page): Promise<OracleReading> {
  return page.evaluate(() => {
    const o = (window as unknown as { __bzmOracle: Record<string, number | null> }).__bzmOracle;
    return { url: location.href, lcp: o.lcp!, cls: o.cls!, fcp: o.fcp!, ttfb: o.ttfb!, inp: o.inp! };
  });
}

/** Like vitals.spec.ts: an input stops LCP, and a shift presented after it would be
 *  excluded as input-adjacent, so wait until both entries EXIST before clicking. */
async function lcpAndShiftReported(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const has = (type: string) => {
      const probe = new PerformanceObserver(() => {});
      probe.observe({ type, buffered: true });
      const n = probe.takeRecords().length;
      probe.disconnect();
      return n > 0;
    };
    return has('largest-contentful-paint') && has('layout-shift');
  });
}

test('Oracle Journey', async ({ page }, testInfo) => {
  const hero = noisePng(320, 240);
  await page.route('**/oracle/slow-lcp', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SLOW_LCP_HTML }),
  );
  await page.route('**/oracle/hero.png', async (route) => {
    await new Promise((r) => setTimeout(r, 400)); // the slow part of "slow LCP image"
    await route.fulfill({ status: 200, contentType: 'image/png', body: hero });
  });
  const lib = await readFile(WEB_VITALS_IIFE, 'utf8');
  await page.addInitScript({ content: `${lib}\n;(${registerOracle.toString()})(webVitals);` });

  const readings: OracleReading[] = [];

  // 1. Layout shift + slow click.
  await page.goto('/');
  await expect(page.getByText('late content')).toBeVisible();
  await lcpAndShiftReported(page);
  await page.click('#target');
  await expect(page.locator('#clicked-flag')).toBeVisible();
  await settle(page, { interacted: true });
  readings.push(await read(page));

  // 2. Slow LCP image.
  await page.goto('/oracle/slow-lcp');
  await page.waitForFunction(() => (document.getElementById('hero') as HTMLImageElement).complete);
  await lcpAndShiftReported(page);
  await settle(page, { interacted: false });
  readings.push(await read(page));

  // 3-5. Fast clicks.
  for (const path of ['/second', '/third', '/second']) {
    await page.goto(path);
    await expect(page.getByText('late content')).toBeVisible();
    await lcpAndShiftReported(page);
    await page.click('h1');
    await settle(page, { interacted: true });
    readings.push(await read(page));
  }

  await writeFile(testInfo.outputPath('bzm-oracle.json'), JSON.stringify(readings), 'utf8');
});
