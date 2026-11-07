// Issue #34 (E2) — a Content-Security-Policy that enforces "zero external
// requests". The emitted file carries a CSP <meta> that lets the browser load
// nothing but its own inline <style> and <script>. This test opens the real
// emitted HTML in Chromium over file:// and asserts the browser saw no CSP
// violation and made no request other than the file itself — and that the
// page's interactions (the include-failed toggle, a drill-down) still work
// under that policy.
//
// Skips with a reason when no Chromium is installed for Playwright.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { Metric } from 'bzm-vitals-format';
import { aggregateRoutes, joinOutcomes, markColdStarts } from '../src/aggregate.js';
import type { AttributedOutcome, AttributedSample } from '../src/attribute.js';
import type { ReportData } from '../src/report.js';
import { renderHtml } from '../src/render.js';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

let chromiumPath: string | null = null;
try {
  chromiumPath = chromium.executablePath();
} catch {
  chromiumPath = null;
}
const haveChromium = chromiumPath !== null && existsSync(chromiumPath);
if (!haveChromium) {
  console.warn('csp.test.ts: skipping browser checks — no Playwright Chromium installed');
}

// ---------------------------------------------------------------- fixture

const tid = (repeat: number) => ({
  file: 'shop.spec.ts',
  title: 'checkout',
  project: 'chromium',
  repeat,
  worker: 0,
});

function sample(repeat: number, url: string, lcp: number, ts: number): AttributedSample {
  const vitals: Record<string, Metric> = {
    lcp: { value: lcp, status: 'ok' },
    cls: { value: 0.05, status: 'ok' },
  };
  return {
    masterId: '90000001',
    sessionId: 'r-v4-eng-a',
    locationId: 'us-west-1',
    engineLabel: 'us-west-1',
    provenance: 'collector',
    sample: {
      schemaVersion: 1,
      ts,
      url,
      test: tid(repeat),
      navigationIndex: 0,
      vitals,
      navigation: { domContentLoadedMs: 800, loadEventMs: 1200 },
      context: { workers: 1, resourceCount: 10, requestCount: 12, failedRequests: 0 },
    },
  };
}

/** Two Routes, 8 passed + 2 failed Executions, so the toggle is live and every
 *  route has a drill-down. */
function fixture(): ReportData {
  const raw: AttributedSample[] = [];
  const outcomes: AttributedOutcome[] = [];
  for (let i = 0; i < 10; i++) {
    const failed = i >= 8;
    raw.push(sample(i, 'https://example.com/checkout', failed ? 3200 + i : 2000 + i * 10, 1752700000000 + i * 1000));
    raw.push(sample(i, 'https://example.com/cart', failed ? 2900 + i : 1500 + i * 10, 1752700000500 + i * 1000));
    outcomes.push({
      sessionId: 'r-v4-eng-a',
      outcome: { schemaVersion: 1, test: tid(i), status: failed ? 'failed' : 'passed', retry: 0 },
    });
  }
  const samples = joinOutcomes(markColdStarts(raw), outcomes);
  return {
    masterId: '90000001',
    reportName: 'CSP fixture',
    generatedAt: '2026-07-16T00:00:00.000Z',
    sessions: [
      {
        sessionId: 'r-v4-eng-a',
        locationId: 'us-west-1',
        status: 'ENDED',
        engineLabel: 'us-west-1',
        artifact: 'present',
        sampleCount: raw.length,
        outcomeCount: outcomes.length,
        unreadable: [],
      },
    ],
    routes: aggregateRoutes(samples),
    samples,
    outcomes,
  };
}

// ----------------------------------------------------------- the emitted bytes

describe('CSP meta — on the emitted bytes', () => {
  const html = renderHtml(fixture());

  it('declares the zero-external-requests policy and no-referrer first in <head>', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    // Before anything it governs.
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<style>'));
  });

  it('has no inline event-handler attributes the policy would block', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });
});

// ------------------------------------------------------------ in the browser

interface Observed {
  violations: string[];
  consoleCsp: string[];
  requests: string[];
  failed: string[];
  pageErrors: string[];
}

async function openReport(browser: Browser, html: string, dir: string): Promise<{ page: Page; seen: Observed }> {
  const file = join(dir, `report-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const fileUrl = pathToFileURL(file).href;
  const page = await browser.newPage();
  const seen: Observed = { violations: [], consoleCsp: [], requests: [], failed: [], pageErrors: [] };
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Content-Security-Policy/i.test(t)) seen.consoleCsp.push(t);
  });
  page.on('pageerror', (e) => seen.pageErrors.push(String(e)));
  page.on('request', (r) => {
    if (r.url() !== fileUrl) seen.requests.push(r.url());
  });
  page.on('requestfailed', (r) => seen.failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.goto(fileUrl, { waitUntil: 'load' });
  return { page, seen };
}

async function collect(page: Page, seen: Observed): Promise<Observed> {
  // Violation events are dispatched asynchronously; give them a tick to land.
  await page.waitForTimeout(100);
  seen.violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  return seen;
}

describe.skipIf(!haveChromium)('CSP — the browser enforces zero external requests', () => {
  let browser: Browser;
  let dir: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), 'bzm-csp-'));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads with no CSP violation and no request but the file itself; toggle and drill-down work', async () => {
    const { page, seen } = await openReport(browser, renderHtml(fixture()), dir);
    try {
      // The include-failed toggle: included variant shown by default; flipping
      // it shows the excluded variant, and back.
      const toggle = page.locator('#bzm-include-failed');
      await expect(toggle.isChecked()).resolves.toBe(true);
      await expect(page.locator('#bzm-variant-included').isVisible()).resolves.toBe(true);
      await expect(page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(false);
      await toggle.uncheck();
      await expect(page.locator('#bzm-variant-included').isVisible()).resolves.toBe(false);
      await expect(page.locator('#bzm-variant-excluded').isVisible()).resolves.toBe(true);
      await toggle.check();
      await expect(page.locator('#bzm-variant-included').isVisible()).resolves.toBe(true);

      // A drill-down in the visible variant opens and closes.
      const btn = page.locator('#bzm-variant-included button.expand').first();
      const rowId = await btn.getAttribute('aria-controls');
      expect(rowId).toBeTruthy();
      const row = page.locator(`[id="${rowId}"]`);
      await expect(row.isVisible()).resolves.toBe(false);
      await btn.click();
      await expect(btn.getAttribute('aria-expanded')).resolves.toBe('true');
      await expect(row.isVisible()).resolves.toBe(true);
      await btn.click();
      await expect(row.isVisible()).resolves.toBe(false);

      // Hover a visible chart mark so the tooltip script runs too.
      const tipped = page.locator('#bzm-variant-included [data-tip]:visible').first();
      if ((await tipped.count()) > 0) {
        await tipped.hover();
        await expect(page.locator('#bzm-tip').isVisible()).resolves.toBe(true);
      }

      const out = await collect(page, seen);
      expect(out.violations).toEqual([]);
      expect(out.consoleCsp).toEqual([]);
      expect(out.requests).toEqual([]);
      expect(out.failed).toEqual([]);
      expect(out.pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('is not vacuous: injected external image, script and fetch are blocked and reported', async () => {
    // Negative control. NOTE: `script-src 'unsafe-inline'` also permits inline
    // event-handler attributes, so the policy cannot catch those — the
    // bytes-level test above bans them instead.
    const tampered = renderHtml(fixture()).replace(
      '</body>',
      '<img src="https://example.invalid/x.png" alt="">' +
        '<script src="https://example.invalid/x.js"></script>' +
        '<script>fetch("https://example.invalid/api").catch(function () {});</script></body>',
    );
    const { page, seen } = await openReport(browser, tampered, dir);
    try {
      const out = await collect(page, seen);
      const v = out.violations.join(' | ');
      expect(v).toContain('img-src https://example.invalid/x.png');
      expect(v).toMatch(/script-src(-elem)? https:\/\/example\.invalid\/x\.js/);
      expect(v).toContain('connect-src https://example.invalid/api');
      expect(out.consoleCsp.length).toBeGreaterThanOrEqual(3);
      // Playwright sees the attempted requests, and every one fails with "csp".
      expect(out.requests.length).toBeGreaterThan(0);
      expect(out.failed.length).toBeGreaterThan(0);
      for (const f of out.failed) expect(f).toMatch(/ csp$/);
    } finally {
      await page.close();
    }
  }, 60_000);
});
