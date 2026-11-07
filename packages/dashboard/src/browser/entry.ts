// The report's one inline <script> (E1), bundled for the browser by
// scripts/build-browser.ts and embedded by render.ts. It:
//   1. reads the embedded data blob — the ReportData as gzip-compressed,
//      base64-encoded JSON — and unpacks it with DecompressionStream('gzip');
//   2. builds the view with the SAME view-model.ts code Node runs
//      (buildView / buildExcludedView, one Test-key function for both);
//   3. renders it with the SAME markup functions (views.ts) into #bzm-app,
//      replacing the server-rendered fallback summary;
//   4. wires the include-failed toggle (the excluded variant is built on its
//      first flip — recomputed here, never pre-rendered), the drill-downs
//      (each Route's drill-down is built on first expand) and the tooltip.
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
  type ReportView,
  type ReportVariants,
} from '../view-model.js';
import { appHtml, drillContentHtml, excludedVariantHtml, timelineHit } from './views.js';
import { APP_ID, DATA_BLOB_ID, STATUS_ID } from './ids.js';


/** What the page exposes for the drift guard (test/browser-render.test.ts):
 *  the views the browser built, to deep-equal against Node's. */
export interface BzmVitalsHandle {
  data: ReportData;
  /** The variants built so far; `excluded` is undefined until first needed. */
  variants: Omit<ReportVariants, 'excluded'> & { excluded?: ReportView | null };
  /** Build (once) and return the excluded variant. */
  excluded(): ReportView | null;
  /** Milliseconds per load phase (unpack, parse, view, render) — diagnostics. */
  timings: Record<string, number>;
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

function wire(app: HTMLElement, handle: BzmVitalsHandle): void {
  const variantFor = (prefix: string): ReportView | null =>
    prefix === 'inc' ? handle.variants.included : (handle.variants.excluded ?? null);

  // Drill-downs: toggled open and closed; a lazy row is filled on first open.
  app.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button.expand') : null;
    if (!btn) return;
    const id = btn.getAttribute('aria-controls');
    const row = id === null ? null : document.getElementById(id);
    if (!row || id === null) return;
    const opening = row.hasAttribute('hidden');
    if (opening && row.hasAttribute('data-lazy')) {
      const match = /^drill-(inc|exc)-(\d+)$/.exec(id);
      const view = match ? variantFor(match[1]!) : null;
      const route = view && match ? view.routes[Number(match[2])] : undefined;
      const cell = row.firstElementChild;
      if (view && route && cell) cell.innerHTML = drillContentHtml(route, view.metricNames);
      row.removeAttribute('data-lazy');
    }
    if (opening) row.removeAttribute('hidden');
    else row.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(opening));
    btn.textContent = opening ? '▾' : '▸';
  });

  // The include-failed toggle: the excluded variant is recomputed here, from
  // the same data, on its first flip — then the two containers swap.
  const toggle = document.getElementById('bzm-include-failed');
  const included = document.getElementById('bzm-variant-included');
  const excluded = document.getElementById('bzm-variant-excluded');
  if (toggle instanceof HTMLInputElement && !toggle.disabled && included && excluded) {
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        included.removeAttribute('hidden');
        excluded.setAttribute('hidden', '');
        return;
      }
      if (handle.variants.excluded === undefined) {
        const view = handle.excluded();
        excluded.innerHTML =
          view === null ? '' : excludedVariantHtml(view, handle.variants.included, 'lazy');
      }
      excluded.removeAttribute('hidden');
      included.setAttribute('hidden', '');
    });
  }
}

/** The hover tooltip. Its text is a [data-tip] attribute (histogram bars,
 *  Cold Start diamonds), or — over a chart's batched points — the nearest
 *  point's, found by timelineHit in svg units. It composes nothing itself. */
function wireTooltip(): void {
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
    const svg = target.closest('svg[data-chart]');
    const handle = window.bzmVitals;
    if (!(svg instanceof SVGSVGElement) || !handle) return null;
    const view = svg.closest('#bzm-variant-excluded')
      ? (handle.variants.excluded ?? null)
      : handle.variants.included;
    const ctm = svg.getScreenCTM();
    if (!view || !ctm) return null;
    const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return timelineHit(view, Number(svg.getAttribute('data-chart')), at.x, at.y);
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
          handle.variants.excluded = buildExcludedView(data, outcomes, testKey);
        }
        return handle.variants.excluded;
      },
    };
    window.bzmVitals = handle;
    wireTooltip();
    app.innerHTML = appHtml({
      outcomes,
      included: handle.variants.included,
      toggleEnabled: hasExcludedVariant(outcomes),
      drills: 'lazy',
    });
    wire(app, handle);
    lap('render');
    document.getElementById(STATUS_ID)?.setAttribute('hidden', '');
    setState(app, 'ready');
  } catch (err) {
    app.innerHTML = fallback; // never a half-rendered Report: back to the summary
    setState(app, 'error');
    showStatus(`${S.renderFailedNote} ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (typeof document !== 'undefined') void start();
