// F1 prototype runner. NOT production code, and not a test: no test glob in this repo
// matches docs/, so `npm test` never runs it. Run it by hand from the repo root:
//
//   node docs/design/f1-prototype/run-prototype.mjs            # all variants
//   node docs/design/f1-prototype/run-prototype.mjs --json     # full raw output
//
// Uses the Chromium Playwright already has (never `playwright install`). For each launch
// variant it serves spa.html on a local port, injects soft-nav-trap.js with
// context.addInitScript (passive, X4), drives a journey with REAL Playwright clicks, and
// prints the would-be Samples. The flush at the end is a page.evaluate after the journey,
// which is what the real fixture's teardown flush does.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, 'spa.html'), 'utf8');
const trap = await readFile(join(here, 'soft-nav-trap.js'), 'utf8');
const asJson = process.argv.includes('--json');

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html); // history fallback: every path serves the SPA
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const VARIANTS = [
  { name: 'headless-shell (Playwright default), no flags', launch: {} },
  { name: "new headless (channel 'chromium'), no flags", launch: { channel: 'chromium' } },
  {
    name: "new headless + --enable-experimental-web-platform-features",
    launch: { channel: 'chromium', args: ['--enable-experimental-web-platform-features'] },
  },
  {
    name: 'new headless + --disable-features=SoftNavigationHeuristics (negative control)',
    launch: { channel: 'chromium', args: ['--disable-features=SoftNavigationHeuristics'] },
  },
];

async function runVariant(v) {
  const browser = await chromium.launch(v.launch);
  const context = await browser.newContext();
  const log = [];
  const t0 = Date.now();
  const rel = (t) => Math.round(t - t0);
  await context.exposeBinding('__f1Report', (_src, msg) => {
    log.push({ nodeAt: rel(Date.now()), kind: msg.kind, pageAt: rel(msg.at), url: msg.entry?.name });
  });
  await context.addInitScript(trap);
  const page = await context.newPage();

  // vitals.route() as a TIME-stamped declaration (the design's proposal), not "next report".
  const routes = [];
  const route = (r) => { routes.push({ route: r, at: Date.now() }); log.push({ nodeAt: rel(Date.now()), kind: `route(${r})` }); };

  await page.goto(`${origin}/`);
  await page.waitForTimeout(500);
  await page.click('#to-products');
  log.push({ nodeAt: rel(Date.now()), kind: 'click(products) resolved' });
  route('/products');
  await page.waitForTimeout(800);
  await page.click('#to-order');
  log.push({ nodeAt: rel(Date.now()), kind: 'click(order) resolved' });
  route('/order/{id}');
  await page.waitForTimeout(1200);      // the late banner shift lands at +300 ms
  await page.click('#silent');          // URL change, no new paint: must NOT be soft
  await page.waitForTimeout(600);
  await page.focus('#to-products');     // a KEYBOARD-initiated route change
  await page.keyboard.press('Enter');
  log.push({ nodeAt: rel(Date.now()), kind: 'Enter(products) resolved' });
  await page.waitForTimeout(600);
  // A browser-initiated same-document traverse (no in-page user activation). Raw
  // goBack here, not the production fixture's patched one (which flushes first).
  await page.goBack();
  log.push({ nodeAt: rel(Date.now()), kind: 'goBack() resolved' });
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => window.__f1Flush());
  await browser.close();

  // Apply the time-window route rule Node-side, exactly as the design proposes.
  for (let i = 0; i < out.slices.length; i++) {
    const from = out.slices[i].ts;
    const to = i + 1 < out.slices.length ? out.slices[i + 1].ts : Infinity;
    const declared = routes.filter((r) => r.at >= from && r.at < to).pop();
    if (declared) {
      out.slices[i].route = declared.route;
      // How far after the slice's start (the interaction) Node's route() call came: the
      // safety margin of the time-window rule (page and Node read the same wall clock).
      out.slices[i].routeMarginMs = declared.at - (out.slices[i].ts);
    }
  }
  return { variant: v.name, log, ...out };
}

const results = [];
for (const v of VARIANTS) {
  try {
    results.push(await runVariant(v));
  } catch (err) {
    results.push({ variant: v.name, error: String(err) });
  }
}
server.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const r2 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
  for (const r of results) {
    console.log(`\n=== ${r.variant}`);
    if (r.error) { console.log('  ERROR', r.error); continue; }
    console.log(`  UA: ${r.userAgent}`);
    console.log(`  supportedEntryTypes has soft-navigation: ${r.softSupported}, interaction-contentful-paint: ${r.icpSupported}, globals: ${JSON.stringify(r.globals)}`);
    console.log(`  soft-navigation entries: ${r.raw.softNavs.length}; ICP entries: ${r.raw.icp.length}; event navigationId vs time window: ${JSON.stringify(r.eventNavigationIdVsTimeWindow)}`);
    console.log('  timeline (ms since journey start):');
    for (const l of r.log) console.log(`    node ${String(l.nodeAt).padStart(5)}  ${l.kind}${l.pageAt !== undefined ? ` (page ${l.pageAt})` : ''}${l.url ? ` ${l.url}` : ''}`);
    console.log('  would-be Samples:');
    r.slices.forEach((s, i) => {
      const v = Object.fromEntries(Object.entries(s.vitals).map(([k, m]) => [k, m.status === 'ok' ? r2(m.value) : m.status]));
      console.log(`    #${i + 1} ${s.navigationType.padEnd(4)} ${new URL(s.url).pathname}${s.route ? ` route=${s.route} (route() +${s.routeMarginMs}ms after start)` : ''} navId=${s.navigationId ?? '-'} shifts=${s.shiftCount} ${JSON.stringify(v)}`);
    });
  }
}
