// The report's one inline <script> (E1), bundled for the browser by
// scripts/build-browser.ts and embedded by render.ts. It:
//   1. reads the embedded data blob — the ReportData as gzip-compressed,
//      base64-encoded JSON — and unpacks it with DecompressionStream('gzip');
//   2. builds the view with the SAME view-model.ts code Node runs
//      (buildView / buildExcludedView, one Test-key function for both);
//   3. renders it with the SAME markup functions (views.ts) into #bzm-app,
//      replacing the server-rendered fallback summary;
//   4. wires the include-failed toggle (the excluded variant's view is
//      recomputed here — once the page is idle after first paint, or on the
//      toggle's first flip if that comes sooner — and rendered on that first
//      flip; never pre-rendered on the server), the drill-downs
//      (every level — Route, Test, Engine, Navigation rows — is built on its
//      first expand), the timeline's canvas points (canvas.ts), its time-zone
//      toggle (local by default, or UTC) and the tooltip.
//
// It fetches nothing: no fetch(), no XHR, no blob: or data: URL, no worker.
// The CSP (render.ts) would block any of them anyway. If DecompressionStream
// is missing, or anything throws, the fallback summary stays and a note says
// why — the Report never goes blank.

import { summarizeOutcomes } from '../aggregate.js';
import type { ReportData } from '../report.js';
import { UI_STRINGS as S } from '../ui-strings.js';
import {
  buildExcludedView,
  buildView,
  hasExcludedVariant,
  testKeyFor,
  type EngineView,
  type ReportView,
  type ReportVariants,
  type RouteView,
  type TestGroupView,
} from '../view-model.js';
import { drawTimelinePoints } from './canvas.js';
import {
  appHtml,
  drillContentHtml,
  engineBodyHtml,
  excludedVariantHtml,
  moreNavigationsHtml,
  NAV_CHUNK,
  navigationRowsHtml,
  testGroupBodyHtml,
  timelineHit,
  timelineHtml,
  UTC,
  type ZoneChoice,
} from './views.js';
import { APP_ID, DATA_BLOB_ID, STATUS_ID } from './ids.js';


/** What the page exposes for the drift guard (test/browser-render.test.ts):
 *  the views the browser built, to deep-equal against Node's. */
export interface BzmVitalsHandle {
  data: ReportData;
  /** The variants built so far; `excluded` is undefined until first needed. */
  variants: Omit<ReportVariants, 'excluded'> & { excluded?: ReportView | null };
  /** Build (once) and return the excluded variant. */
  excluded(): ReportView | null;
  /** Milliseconds per load phase (unpack, parse, view, render), the excluded
   *  variant's view build once it is built (excludedView), and the canvas
   *  drawing so far (draw) — diagnostics. */
  timings: Record<string, number>;
  /** The timeline's time zone in force, and the viewer's own (E3). */
  zone?: ZoneChoice;
}

declare global {
  interface Window {
    bzmVitals?: BzmVitalsHandle;
  }
}

function setState(app: HTMLElement, state: string): void {
  app.setAttribute('data-bzm-state', state);
}

function showStatus(text: string): void {
  const status = document.getElementById(STATUS_ID);
  if (!status) return;
  status.textContent = text;
  status.removeAttribute('hidden');
}

/** base64 → bytes. atob yields a binary string, one char per byte. */
function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** gunzip in memory: a ReadableStream over the bytes, through the platform's
 *  DecompressionStream, decoded incrementally as UTF-8. No URL is involved. */
async function gunzipText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/** The time zone in force, and the viewer's own. Local by default; the UTC
 *  toggle flips `tz`. */
function initialZone(): ZoneChoice {
  let localTz = UTC;
  try {
    localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || UTC;
  } catch {
    localTz = UTC;
  }
  return { tz: localTz, localTz };
}

/** The variant a node of the report belongs to, if built. */
function variantOf(handle: BzmVitalsHandle, node: Element): ReportView | null {
  return node.closest('#bzm-variant-excluded')
    ? (handle.variants.excluded ?? null)
    : handle.variants.included;
}

/** The canvas layer: each chart's points are (re)drawn whenever its canvas
 *  gets a layout box or changes size — on first paint, when the excluded
 *  variant is first shown, on a resize — and when the color scheme flips. A
 *  ResizeObserver runs after layout and before paint, so a chart on (or a
 *  quarter screen from) the screen is drawn in the frame it appears in; one
 *  further away waits for an IntersectionObserver to bring it within half a
 *  screen of the viewport. */
function canvasLayer(handle: BzmVitalsHandle): { observe(root: Element): void } {
  const draw = (canvas: HTMLCanvasElement): void => {
    const view = variantOf(handle, canvas);
    if (!view) return;
    const t0 = performance.now();
    if (drawTimelinePoints(canvas, view, Number(canvas.getAttribute('data-chart')))) {
      handle.timings['draw'] = (handle.timings['draw'] ?? 0) + Math.round(performance.now() - t0);
    }
  };
  const near = (canvas: HTMLCanvasElement): boolean => {
    const box = canvas.getBoundingClientRect();
    const screen = window.innerHeight || 800;
    return box.bottom >= -screen / 4 && box.top <= screen * 1.25;
  };
  const approaching =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || !(entry.target instanceof HTMLCanvasElement)) continue;
              approaching?.unobserve(entry.target);
              if (entry.target.isConnected) draw(entry.target);
            }
          },
          { rootMargin: '50% 0px' },
        )
      : null;
  const sized =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const canvas = entry.target;
            if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) continue;
            if (approaching === null || near(canvas)) draw(canvas);
            else approaching.observe(canvas);
          }
        })
      : null;
  const all = (root: ParentNode): HTMLCanvasElement[] => [
    ...root.querySelectorAll<HTMLCanvasElement>('canvas.tl-points'),
  ];
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    for (const canvas of all(document)) draw(canvas);
  });
  return {
    observe(root) {
      for (const canvas of all(root)) {
        if (sized) sized.observe(canvas);
        else draw(canvas);
      }
    },
  };
}

function wire(app: HTMLElement, handle: BzmVitalsHandle, zone: ZoneChoice): void {
  const variantFor = (prefix: string): ReportView | null =>
    prefix === 'inc' ? handle.variants.included : (handle.variants.excluded ?? null);
  const canvases = canvasLayer(handle);
  canvases.observe(app);

  /** The Route a drill-down node sits under: [view, route]. */
  const routeOf = (node: Element): [ReportView, RouteView] | null => {
    const row = node.closest('tr.drill');
    const match = row ? /^drill-(inc|exc)-(\d+)$/.exec(row.id) : null;
    const view = match ? variantFor(match[1]!) : null;
    const route = view && match ? view.routes[Number(match[2])] : undefined;
    return view && route ? [view, route] : null;
  };
  const testOf = (node: Element, route: RouteView): TestGroupView | undefined => {
    const group = node.closest('details.test-group');
    return group ? route.tests[Number(group.getAttribute('data-ti'))] : undefined;
  };
  const engineOf = (node: Element, route: RouteView): EngineView | undefined => {
    const engine = node.closest('details.engine');
    const group = testOf(node, route);
    return engine && group ? group.engines[Number(engine.getAttribute('data-ei'))] : undefined;
  };

  // Drill-downs. The Route's row: toggled open and closed; filled on first
  // open. Its Tests and Engines are <details>, filled on their first open
  // (the toggle event, captured: it does not bubble). An Engine's rows come
  // NAV_CHUNK at a time behind a "show more" button.
  app.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const more = target?.closest('button.more');
    if (more) {
      const at = routeOf(more);
      const engine = at ? engineOf(more, at[1]) : undefined;
      const tbody = more.closest('details.engine')?.querySelector('table.navs > tbody');
      if (!at || !engine || !tbody) return;
      const shown = Number(more.getAttribute('data-shown'));
      tbody.insertAdjacentHTML('beforeend', navigationRowsHtml(engine, at[0].metricNames, shown, shown + NAV_CHUNK));
      more.outerHTML = moreNavigationsHtml(engine, shown + NAV_CHUNK);
      return;
    }
    const btn = target?.closest('button.expand');
    if (!btn) return;
    const id = btn.getAttribute('aria-controls');
    const row = id === null ? null : document.getElementById(id);
    if (!row || id === null) return;
    const opening = row.hasAttribute('hidden');
    if (opening && row.hasAttribute('data-lazy')) {
      const cell = row.firstElementChild;
      const at = cell ? routeOf(cell) : null;
      if (at && cell) cell.innerHTML = drillContentHtml(at[1], at[0].metricNames, 'lazy');
      row.removeAttribute('data-lazy');
    }
    if (opening) row.removeAttribute('hidden');
    else row.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(opening));
    btn.textContent = opening ? '▾' : '▸';
  });
  app.addEventListener(
    'toggle',
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement) || !details.open || !details.hasAttribute('data-lazy')) return;
      details.removeAttribute('data-lazy');
      const at = routeOf(details);
      if (!at) return;
      const [view, route] = at;
      let body = '';
      if (details.classList.contains('test-group')) {
        const group = testOf(details, route);
        if (group) body = testGroupBodyHtml(group, view.metricNames, route.tests.length === 1, 'lazy');
      } else if (details.classList.contains('engine')) {
        const engine = engineOf(details, route);
        if (engine) body = engineBodyHtml(engine, view.metricNames, 'lazy');
      }
      details.insertAdjacentHTML('beforeend', body);
    },
    true,
  );

  // The include-failed toggle: the excluded variant's view is recomputed here,
  // from the same data (at idle, or now); its markup is rendered on the first
  // flip — then the two containers swap.
  const toggle = document.getElementById('bzm-include-failed');
  const included = document.getElementById('bzm-variant-included');
  const excluded = document.getElementById('bzm-variant-excluded');
  if (toggle instanceof HTMLInputElement && !toggle.disabled && included && excluded) {
    let rendered = false; // the excluded variant's markup: on the first flip only
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        included.removeAttribute('hidden');
        excluded.setAttribute('hidden', '');
        return;
      }
      if (!rendered) {
        rendered = true;
        const view = handle.excluded(); // built already, unless the flip beat the idle build
        excluded.innerHTML =
          view === null ? '' : excludedVariantHtml(view, handle.variants.included, 'lazy', zone);
        canvases.observe(excluded);
      }
      excluded.removeAttribute('hidden');
      included.setAttribute('hidden', '');
    });
  }

  // The time-zone toggle (one checkbox per built timeline, kept in step):
  // re-read the timelines in the other zone — axis labels, zone label,
  // tooltips, text alternative — and redraw their points.
  app.addEventListener('change', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains('bzm-tz-utc')) return;
    zone.tz = box.checked ? UTC : zone.localTz;
    const built: Array<[HTMLElement | null, ReportView | null | undefined]> = [
      [included ?? app, handle.variants.included],
      [excluded, handle.variants.excluded],
    ];
    for (const [container, view] of built) {
      const section = container?.querySelector('section.timeline');
      if (!section || !view) continue;
      section.outerHTML = timelineHtml(view, zone.tz, zone.localTz);
      if (container) canvases.observe(container);
    }
  });
}

/** The hover tooltip. Its text is a [data-tip] attribute (histogram bars,
 *  Cold Start diamonds), or — over a chart's canvas points — the nearest
 *  point's, found by timelineHit in svg units. It composes nothing itself. */
function wireTooltip(zone: ZoneChoice): void {
  const tip = document.getElementById('bzm-tip');
  if (!tip) return;
  const place = (e: PointerEvent): void => {
    const pad = 12;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + tip.offsetWidth > window.innerWidth - 4) x = e.clientX - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > window.innerHeight - 4) y = e.clientY - tip.offsetHeight - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const textAt = (e: PointerEvent): string | null => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return null;
    const tipped = target.closest('[data-tip]');
    if (tipped) return tipped.getAttribute('data-tip');
    // The front svg layer covers the plot; the canvas points lie under it.
    const svg = target.closest('svg[data-chart]');
    const handle = window.bzmVitals;
    if (!(svg instanceof SVGSVGElement) || !handle) return null;
    const view = variantOf(handle, svg);
    const ctm = svg.getScreenCTM();
    if (!view || !ctm) return null;
    const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return timelineHit(view, Number(svg.getAttribute('data-chart')), at.x, at.y, zone.tz);
  };
  const update = (e: PointerEvent): void => {
    const text = textAt(e);
    if (text === null) {
      tip.setAttribute('hidden', '');
      return;
    }
    if (tip.textContent !== text) tip.textContent = text;
    tip.removeAttribute('hidden');
    place(e);
  };
  document.addEventListener('pointerover', update);
  document.addEventListener('pointermove', update);
  document.addEventListener('pointerout', (e) => {
    if (e.relatedTarget === null) tip.setAttribute('hidden', '');
  });
}

/** Run `task` when the main thread is idle (after the current frame's paint). */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 2_000 });
  else setTimeout(task, 200);
}

async function start(): Promise<void> {
  const app = document.getElementById(APP_ID);
  const blob = document.getElementById(DATA_BLOB_ID);
  if (!app || !blob) return;
  // The feature check: without DecompressionStream the data cannot be read.
  // Say so, and leave the server-rendered summary in place.
  if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function') {
    setState(app, 'unsupported');
    showStatus(S.noDecompressionNote);
    return;
  }
  showStatus(S.loadingNote);
  setState(app, 'loading');
  const fallback = app.innerHTML;
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (phase: string): void => {
    const now = performance.now();
    timings[phase] = Math.round(now - t);
    t = now;
  };
  try {
    const json = await gunzipText(base64Bytes((blob.textContent ?? '').trim()));
    lap('unpack');
    const data = JSON.parse(json) as ReportData;
    lap('parse');
    const outcomes = summarizeOutcomes(data.samples, data.outcomes);
    // ONE Test-key function over the FULL Sample set, for both variants.
    const testKey = testKeyFor(data.samples);
    const included = buildView(data, testKey);
    lap('view');
    const handle: BzmVitalsHandle = {
      data,
      timings,
      variants: { outcomes, included },
      excluded() {
        if (handle.variants.excluded === undefined) {
          const t0 = performance.now();
          handle.variants.excluded = buildExcludedView(data, outcomes, testKey);
          timings['excludedView'] = Math.round(performance.now() - t0);
        }
        return handle.variants.excluded;
      },
    };
    window.bzmVitals = handle;
    const zone = initialZone();
    handle.zone = zone;
    wireTooltip(zone);
    app.innerHTML = appHtml({
      outcomes,
      included: handle.variants.included,
      toggleEnabled: hasExcludedVariant(outcomes),
      drills: 'lazy',
      zone,
    });
    wire(app, handle, zone);
    lap('render');
    document.getElementById(STATUS_ID)?.setAttribute('hidden', '');
    setState(app, 'ready');
    // E3: the excluded variant's VIEW (not its markup) is built once the page
    // is idle after first paint, so the toggle usually only renders it. A flip
    // before then builds it on the spot, as it always could.
    if (hasExcludedVariant(outcomes)) whenIdle(() => void handle.excluded());
  } catch (err) {
    app.innerHTML = fallback; // never a half-rendered Report: back to the summary
    setState(app, 'error');
    showStatus(`${S.renderFailedNote} ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (typeof document !== 'undefined') void start();
