// The timeline's plain points (Navigations), drawn on a <canvas> (E3) — the
// one browser-only drawing module. Axes, gridlines, the p75 line and the Cold
// Start diamonds stay SVG (views.ts); this paints the dots between those two
// layers from the same geometry the hover hit-test searches
// (timelineGeometry), so what is under the pointer is what was drawn.
//
// Crisp at any devicePixelRatio: the backing store is sized to the canvas's
// CSS box × devicePixelRatio, and every dot is rasterized at that resolution.
// The colors are the page's own custom properties (light or dark), read at
// draw time.
//
// How, at 200k points per chart: each Engine hue is ONE layer — the union of
// its dots, as the SVG batches were — painted in order of first appearance.
// A layer's union of radius-r discs is exactly "every pixel within r of some
// point centre", so it is rasterized from a Euclidean distance transform of
// the centre pixels (Felzenszwalb & Huttenlocher's two-pass, O(pixels)), with
// a one-pixel anti-aliased edge — the cost depends on the canvas size, not on
// the point count, where one canvas arc per point took seconds. Centres snap
// to the device-pixel grid (at most half a device pixel).
//
// Canvas needs nothing the CSP forbids: no blob:/data: URL, no worker.

import type { ReportView } from '../view-model.js';
import { slotColorVar, timelineGeometry, TL_H, TL_POINT_R, TL_W } from './views.js';

/** What each canvas was last drawn as (size and colors). */
const drawnAs = new WeakMap<HTMLCanvasElement, string>();

const FAR = 1e20; // "no centre here" — finite, so the envelope math never sees Inf − Inf

// Scratch buffers, grown on demand and reused across draws.
let field = new Float64Array(0);
let rowIn = new Float64Array(0);
let rowOut = new Float64Array(0);
let hullV = new Int32Array(0);
let hullZ = new Float64Array(0);

function ensure(w: number, h: number): void {
  if (field.length < w * h) field = new Float64Array(w * h);
  const n = Math.max(w, h);
  if (rowIn.length < n) {
    rowIn = new Float64Array(n);
    rowOut = new Float64Array(n);
    hullV = new Int32Array(n);
    hullZ = new Float64Array(n + 1);
  }
}

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher):
 *  out[q] = min over p of (q − p)² + f[p]. */
function dt1d(f: Float64Array, out: Float64Array, n: number): void {
  let k = 0;
  hullV[0] = 0;
  hullZ[0] = -FAR;
  hullZ[1] = FAR;
  for (let q = 1; q < n; q++) {
    let p = hullV[k]!;
    let s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
    while (s <= hullZ[k]!) {
      k--;
      p = hullV[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
    }
    k++;
    hullV[k] = q;
    hullZ[k] = s;
    hullZ[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (hullZ[k + 1]! < q) k++;
    const p = hullV[k]!;
    out[q] = (q - p) * (q - p) + f[p]!;
  }
}

function parseColor(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(css);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [42, 120, 214]; // the slot-1 blue
}

/** Paint chart `chartIndex` of `view` into `canvas`. Returns false (drawing
 *  nothing) while the canvas has no layout box — a hidden variant. */
export function drawTimelinePoints(canvas: HTMLCanvasElement, view: ReportView, chartIndex: number): boolean {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const geo = timelineGeometry(view, chartIndex);
  const ctx = canvas.getContext('2d');
  if (geo === null || ctx === null) return false;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const sx = w / TL_W;
  const sy = h / TL_H;
  const r = TL_POINT_R * Math.min(sx, sy);
  const reach = (r + 1) * (r + 1); // beyond this, coverage is 0
  const cap = Math.ceil(r + 1);

  const { xs, ys, slots, cold } = geo;
  const n = xs.length;
  // The hues present, in order of first appearance.
  const order: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (cold[i] === 1) continue; // Cold Starts are SVG diamonds, in front
    const slot = slots[i]!;
    if (!seen.has(slot)) {
      seen.add(slot);
      order.push(slot);
    }
  }

  const style = getComputedStyle(canvas);
  const colors = order.map((slot) => style.getPropertyValue(slotColorVar(slot)).trim());
  // Shown again at the same size and in the same colors: the pixels stand.
  const key = `${w}x${h}|${colors.join(',')}`;
  if (drawnAs.get(canvas) === key) return true;

  ensure(w, h);
  const image = ctx.createImageData(w, h);
  const px = image.data;
  for (const [li, slot] of order.entries()) {
    const [cr, cg, cb] = parseColor(colors[li]!);
    // 1. The layer's centre pixels: 0 there, FAR elsewhere (field holds the
    //    vertical distance to the nearest centre, in pixels, once swept).
    field.fill(FAR, 0, w * h);
    let top = h;
    let bottom = -1;
    for (let i = 0; i < n; i++) {
      if (slots[i] !== slot || cold[i] === 1) continue;
      const x = Math.round(xs[i]! * sx);
      const y = Math.round(ys[i]! * sy);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      field[y * w + x] = 0;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    if (bottom < 0) continue;
    // 2. Vertical distance, capped at `cap` (farther never reaches a dot):
    //    two row-major sweeps, down then up.
    const y0 = Math.max(0, top - cap);
    const y1 = Math.min(h - 1, bottom + cap);
    for (let y = top + 1; y <= y1; y++) {
      const row = y * w;
      const prev = row - w;
      for (let x = 0; x < w; x++) {
        const up = field[prev + x]! + 1;
        if (up < field[row + x]!) field[row + x] = up;
      }
    }
    for (let y = bottom - 1; y >= y0; y--) {
      const row = y * w;
      const next = row + w;
      for (let x = 0; x < w; x++) {
        const down = field[next + x]! + 1;
        if (down < field[row + x]!) field[row + x] = down;
      }
    }
    // 3. Per row, the exact squared distance to the nearest centre (1-D
    //    transform over the squared vertical distances), then coverage with a
    //    one-pixel anti-aliased edge, composited over the layers already
    //    painted ("source-over", straight alpha).
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      let hit = false;
      for (let x = 0; x < w; x++) {
        const g = field[row + x]!;
        if (g <= cap) {
          rowIn[x] = g * g;
          hit = true;
        } else rowIn[x] = FAR;
      }
      if (!hit) continue;
      dt1d(rowIn, rowOut, w);
      for (let x = 0; x < w; x++) {
        const d2 = rowOut[x]!;
        if (d2 >= reach) continue;
        const a = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(d2)));
        if (a <= 0) continue;
        const o = (row + x) * 4;
        const da = px[o + 3]! / 255;
        const oa = a + da * (1 - a);
        px[o] = (cr * a + px[o]! * da * (1 - a)) / oa;
        px[o + 1] = (cg * a + px[o + 1]! * da * (1 - a)) / oa;
        px[o + 2] = (cb * a + px[o + 2]! * da * (1 - a)) / oa;
        px[o + 3] = oa * 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  drawnAs.set(canvas, key);
  return true;
}
