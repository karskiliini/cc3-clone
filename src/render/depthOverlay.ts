// ============================================================================
// depthOverlay.ts — the Tab "depth map" view: the sim's height field (sim/heightField.ts) drawn
// as a readable relief map over the viewport.
//
//   colour ramp: deep blue-violet (< -1 m) -> dark teal (shallow holes) -> neutral grey (0 m,
//                the map datum) -> olive/yellow (low hills) -> orange (high ground) -> red ->
//                white (tall buildings standing on high ground), over an absolute 0-30 m
//   contours:    every 0.5 m below the datum, every 2 m above (a hill reads as broad bands)
//   hillshade:   subtle, lit from the NW
//   canopy:      translucent green diagonal hatch over the ground height under the trees
//
// The region around the camera (snapped, with a margin) is rasterised into an offscreen canvas at
// a few pixels per tile (4 px/tile zoomed out, 8 at zoom 1, 12 at zoom 2) with heights bilinearly
// interpolated between the 0.5 m samples, then drawn scaled with smoothing on so edges stay soft.
// The raster is rebuilt only when the field's version or the snapped region/zoom changes; idle
// frames are a single drawImage.
// ============================================================================
import type { Camera, GameMap, HeightField } from '@/shared/types';
import { TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { getHeightField, syncCraterMarks } from '@/sim/heightField';
import { drawText } from './pixelfont';

export const DEPTH_ALPHA = 0.85;
const REGION_SNAP = 8;
const MARGIN_TILES = 6;

type Stop = [number, number, number, number];
/** [metres, r, g, b]
 *
 * The colour sequence is unchanged (blue-violet holes -> teal -> neutral grey at the datum ->
 * yellow -> orange -> red -> white), but the above-ground half is now spread over the 0-30 m
 * range the model actually spans since the ground layer arrived: a map's landform is 0-19 m and
 * structures stack another 4-15 m on top of that. Spread over the old 0-16 m instead, every
 * hilltop saturated at white and the whole view read as one flat pink wash. */
export const DEPTH_RAMP: Stop[] = [
  [-2.0, 52, 22, 96],
  [-1.2, 62, 44, 150],
  [-0.7, 34, 78, 136],
  [-0.3, 26, 104, 112],
  [-0.05, 84, 118, 116],
  [0, 124, 124, 120],
  [1.5, 140, 137, 113],
  [4.0, 172, 162, 94],
  [8.0, 214, 184, 64],
  [12.0, 236, 132, 36],
  [16.0, 206, 58, 38],
  [20.0, 176, 34, 46],
  [25.0, 232, 150, 150],
  [30.0, 255, 255, 255],
];

const LUT_MIN = -2.5, LUT_MAX = 32, LUT_STEP = 0.02;
const LUT_N = Math.ceil((LUT_MAX - LUT_MIN) / LUT_STEP) + 1;
let lut: Uint8Array | null = null;
function rampLut(): Uint8Array {
  if (lut) return lut;
  lut = new Uint8Array(LUT_N * 3);
  for (let k = 0; k < LUT_N; k++) {
    const h = LUT_MIN + k * LUT_STEP;
    const c = depthColor(h);
    lut[k * 3] = c[0]; lut[k * 3 + 1] = c[1]; lut[k * 3 + 2] = c[2];
  }
  return lut;
}

/** Ramp colour for a height in metres. */
export function depthColor(h: number): [number, number, number] {
  const r = DEPTH_RAMP;
  if (h <= r[0][0]) return [r[0][1], r[0][2], r[0][3]];
  for (let i = 1; i < r.length; i++) {
    if (h <= r[i][0]) {
      const a = r[i - 1], b = r[i];
      const t = (h - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t].map(Math.round) as [number, number, number];
    }
  }
  const l = r[r.length - 1];
  return [l[1], l[2], l[3]];
}

/** Contour band index: 0.5 m bands below the datum, 2 m bands above — with the ground layer in
 * play the 2 m bands are what draw a hill as a set of broad, readable contour rings. */
export function contourBand(h: number): number {
  return h < -0.02 ? Math.floor(h / 0.5) - 1 : Math.floor(h / 2);
}

export interface DepthRegion { x0: number; y0: number; cols: number; rows: number; ppt: number }

/** Pure rasteriser (node-testable): RGBA pixels for tiles [x0,x0+cols) x [y0,y0+rows) at `ppt`
 * pixels per tile. */
export function rasterizeDepth(field: HeightField, r: DepthRegion): { data: Uint8ClampedArray; w: number; h: number } {
  const W = r.cols * r.ppt, H = r.rows * r.ppt;
  const data = new Uint8ClampedArray(W * H * 4);
  const heights = new Float32Array((W + 1) * (H + 1));
  const canopy = new Float32Array(W * H);
  const res = field.res, fw = field.w, fh = field.h;
  const hArr = field.height, cArr = field.canopy;
  const inv = res / r.ppt;
  // bilinear height per pixel (one extra row/column for gradients and contours)
  for (let py = 0; py <= H; py++) {
    const fy = (r.y0 * r.ppt + py + 0.5) * inv - 0.5;
    let sy0 = Math.floor(fy); const ay = fy - sy0;
    let sy1 = sy0 + 1;
    if (sy0 < 0) sy0 = 0; if (sy1 < 0) sy1 = 0; if (sy0 >= fh) sy0 = fh - 1; if (sy1 >= fh) sy1 = fh - 1;
    const row0 = sy0 * fw, row1 = sy1 * fw;
    for (let px = 0; px <= W; px++) {
      const fx = (r.x0 * r.ppt + px + 0.5) * inv - 0.5;
      let sx0 = Math.floor(fx); const ax = fx - sx0;
      let sx1 = sx0 + 1;
      if (sx0 < 0) sx0 = 0; if (sx1 < 0) sx1 = 0; if (sx0 >= fw) sx0 = fw - 1; if (sx1 >= fw) sx1 = fw - 1;
      const a = hArr[row0 + sx0], b = hArr[row0 + sx1], c = hArr[row1 + sx0], d = hArr[row1 + sx1];
      const top = a + (b - a) * ax;
      heights[py * (W + 1) + px] = top + (c + (d - c) * ax - top) * ay;
      if (px < W && py < H) {
        const ca = cArr[row0 + sx0], cb = cArr[row0 + sx1], cc = cArr[row1 + sx0], cd = cArr[row1 + sx1];
        const ct = ca + (cb - ca) * ax;
        canopy[py * W + px] = ct + (cc + (cd - cc) * ax - ct) * ay;
      }
    }
  }
  const ramp = rampLut();
  const metresPerPx = 2 / r.ppt;
  const hatch = Math.max(3, Math.round(r.ppt * 0.75));
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const k = py * (W + 1) + px;
      const h = heights[k];
      const hr = heights[k + 1], hd = heights[k + W + 1];
      let li = Math.round((h - LUT_MIN) / LUT_STEP);
      if (li < 0) li = 0; else if (li >= LUT_N) li = LUT_N - 1;
      let R = ramp[li * 3], G = ramp[li * 3 + 1], B = ramp[li * 3 + 2];
      // hillshade, light from the NW: ground rising toward the SE faces the light and brightens
      const gx = (hr - h) / metresPerPx, gy = (hd - h) / metresPerPx;
      let shade = (gx + gy) * 0.3;
      if (shade > 0.35) shade = 0.35; else if (shade < -0.4) shade = -0.4;
      const m = 1 + shade;
      R *= m; G *= m; B *= m;
      // contour lines
      const band = contourBand(h);
      if (band !== contourBand(hr) || band !== contourBand(hd)) {
        const f = h < 0 ? 0.62 : 0.55;
        R *= f; G *= f; B *= f;
      }
      // canopy: translucent green diagonal hatch over the ground height
      const cv = canopy[py * W + px];
      if (cv > 1) {
        const onLine = ((px + py) % hatch) === 0;
        const t = Math.min(1, (cv - 1) / 3) * (onLine ? 0.7 : 0.16);
        R += (46 - R) * t; G += (150 - G) * t; B += (54 - B) * t;
      }
      const o = (py * W + px) * 4;
      data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = 255;
    }
  }
  return { data, w: W, h: H };
}

export function depthRegion(map: GameMap, cam: Camera): DepthRegion {
  const px = TILE_PX * cam.zoom;
  const ppt = cam.zoom >= 2 ? 12 : cam.zoom >= 1 ? 8 : 4;
  const x0 = Math.max(0, Math.floor((cam.x - MARGIN_TILES) / REGION_SNAP) * REGION_SNAP);
  const y0 = Math.max(0, Math.floor((cam.y - MARGIN_TILES) / REGION_SNAP) * REGION_SNAP);
  const x1 = Math.min(map.width, Math.ceil((cam.x + VIEW_W / px + MARGIN_TILES) / REGION_SNAP) * REGION_SNAP);
  const y1 = Math.min(map.height, Math.ceil((cam.y + VIEW_H / px + MARGIN_TILES) / REGION_SNAP) * REGION_SNAP);
  return { x0, y0, cols: Math.max(1, x1 - x0), rows: Math.max(1, y1 - y0), ppt };
}

export interface DepthOverlayStats { lastBuildMs: number; builds: number }

export class DepthOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private shown: { region: DepthRegion; version: number; field: HeightField } | null = null;
  readonly stats: DepthOverlayStats = { lastBuildMs: 0, builds: 0 };

  constructor() {
    if (typeof window !== 'undefined') (window as unknown as { __cc3DepthStats?: DepthOverlayStats }).__cc3DepthStats = this.stats;
  }

  reset(): void { this.shown = null; }

  /** Rebuilds the raster when the field changed or the camera left the cached region. */
  update(map: GameMap, cam: Camera): void {
    const field = getHeightField(map);
    syncCraterMarks(map, field);
    const want = depthRegion(map, cam);
    const s = this.shown;
    if (s && s.field === field && s.version === field.version && s.region.x0 === want.x0 && s.region.y0 === want.y0
      && s.region.cols === want.cols && s.region.rows === want.rows && s.region.ppt === want.ppt) return;
    const t0 = performance.now();
    const img = rasterizeDepth(field, want);
    if (!this.canvas) this.canvas = document.createElement('canvas');
    if (this.canvas.width !== img.w || this.canvas.height !== img.h) { this.canvas.width = img.w; this.canvas.height = img.h; }
    this.canvas.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
    this.shown = { region: want, version: field.version, field };
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.builds++;
  }

  /** Draws the relief over the map viewport (call after terrain, before units). */
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (!this.shown || !this.canvas) return;
    const px = TILE_PX * cam.zoom;
    const r = this.shown.region;
    ctx.save();
    ctx.globalAlpha = DEPTH_ALPHA;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(this.canvas, (r.x0 - cam.x) * px, (r.y0 - cam.y) * px, r.cols * px, r.rows * px);
    ctx.restore();
  }

  /** Legend panel at the top-left of the map viewport. */
  drawLegend(ctx: CanvasRenderingContext2D): void {
    drawDepthLegend(ctx, 8, 8);
  }
}

const LEGEND_TICKS: [number, string][] = [
  [-2, '-2'], [-1, '-1'], [0, '0'], [1, '1'], [2, '2'], [6, '6'], [12, '12'], [20, '20'], [30, '30+'],
];

export function drawDepthLegend(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const w = 206, h = 50;
  ctx.save();
  ctx.fillStyle = 'rgba(12,12,10,0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(200,190,150,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  drawText(ctx, 'DEPTH MAP (Tab)', x + 6, y + 5, '#e8d890');
  // the scale is piecewise so the shallow range gets room: -2..2 m over half the bar, 2..30 m
  // (ground relief plus structures) over the other half
  const barX = x + 8, barY = y + 18, barW = w - 16, barH = 9;
  const toX = (m: number) => m <= 2 ? barX + ((m + 2) / 4) * barW * 0.5 : barX + barW * 0.5 + ((Math.min(30, m) - 2) / 28) * barW * 0.5;
  for (let i = 0; i < barW; i++) {
    const f = i / barW;
    const m = f <= 0.5 ? -2 + (f / 0.5) * 4 : 2 + ((f - 0.5) / 0.5) * 28;
    const c = depthColor(m);
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(barX + i, barY, 1, barH);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, barH + 1);
  ctx.fillStyle = '#d8d8d0';
  for (const [m, label] of LEGEND_TICKS) {
    const tx = Math.round(toX(m));
    ctx.fillRect(tx, barY + barH + 1, 1, 3);
    drawText(ctx, label, tx - (label.length * 3) + 1, barY + barH + 6, '#d8d8d0');
  }
  drawText(ctx, 'm', x + w - 10, y + 5, '#a8a898');
  // canopy swatch
  ctx.fillStyle = 'rgba(46,150,54,0.35)';
  ctx.fillRect(x + w - 70, y + 4, 10, 8);
  ctx.strokeStyle = 'rgba(46,150,54,0.9)';
  ctx.beginPath();
  ctx.moveTo(x + w - 70, y + 12); ctx.lineTo(x + w - 62, y + 4);
  ctx.stroke();
  drawText(ctx, 'trees', x + w - 56, y + 5, '#9ccf98');
  ctx.restore();
}
