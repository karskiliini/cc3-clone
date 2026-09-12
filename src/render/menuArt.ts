// ============================================================================
// menuArt.ts — procedural "propaganda poster" background for the CC3-style
// menu screens: fbm noise base, lower-centre fire glow, a brick texture band
// along the top, faint scratches, a soldier silhouette on the left third, and
// a vignette. Built once and cached as a canvas (800x600, the MENU_W x
// MENU_H area). Our own art only — no copied imagery.
// ============================================================================
import { hash2 } from '@/shared/rng';
import { MENU_W, MENU_H } from '@/shared/types';

// --------------------------------------------------------------------- fbm --
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const sx = smooth(x - x0);
  const sy = smooth(y - y0);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const ix0 = n00 + (n10 - n00) * sx;
  const ix1 = n01 + (n11 - n01) * sx;
  return ix0 + (ix1 - ix0) * sy;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 101) * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total > 0 ? sum / total : 0;
}

// ------------------------------------------------------------------- color --
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const STOPS = ['#2a0a06', '#7a1e10', '#c8501a', '#e8a040'].map(hexToRgb);

function mixStops(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(0.999999, t));
  const n = STOPS.length - 1;
  const scaled = c * n;
  const seg = Math.floor(scaled);
  const localT = scaled - seg;
  const a = STOPS[seg];
  const b = STOPS[seg + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * localT),
    Math.round(a[1] + (b[1] - a[1]) * localT),
    Math.round(a[2] + (b[2] - a[2]) * localT),
  ];
}

// ------------------------------------------------------------------- brick --
function drawBrickBand(ctx: CanvasRenderingContext2D, w: number, bandH: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, bandH);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  const rowH = 14;
  let row = 0;
  for (let y = 0; y < bandH; y += rowH) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    const offset = row % 2 === 0 ? 0 : 20;
    for (let x = offset; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + rowH);
      ctx.stroke();
    }
    row++;
  }
  ctx.restore();
}

// --------------------------------------------------------------- scratches --
function drawScratches(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,224,190,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 20; i++) {
    const x0 = hash2(i, 1, 71) * w;
    const y0 = hash2(i, 2, 71) * h;
    const len = 40 + hash2(i, 3, 71) * 170;
    const ang = (hash2(i, 4, 71) - 0.5) * 1.4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.restore();
}

// -------------------------------------------------------------- silhouette --
/** A large abstract soldier silhouette on the left third: helmet, shoulders,
 * and an outstretched pointing arm, built from ellipses/rects only. */
function drawSoldierSilhouette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(30,6,4,0.5)';
  const hx = w * 0.15;
  const hy = h * 0.32;
  // helmet dome
  ctx.beginPath();
  ctx.ellipse(hx, hy, 78, 60, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  // helmet brim
  ctx.fillRect(hx - 86, hy - 4, 172, 12);
  // neck/torso
  ctx.beginPath();
  ctx.ellipse(hx - 6, h * 0.74, 130, 170, 0, 0, Math.PI * 2);
  ctx.fill();
  // outstretched arm pointing toward the buttons
  ctx.save();
  ctx.translate(w * 0.2, h * 0.6);
  ctx.rotate(-0.18);
  ctx.beginPath();
  ctx.ellipse(110, 0, 130, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(228, 4, 20, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

/** 2-3 faint vertical "post" lines crossing the poster. */
function drawPosts(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 5;
  for (const fx of [0.44, 0.58, 0.73]) {
    ctx.beginPath();
    ctx.moveTo(w * fx, 0);
    ctx.lineTo(w * fx, h);
    ctx.stroke();
  }
  ctx.restore();
}

function buildPosterBackground(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / w) * 4;
      const ny = (y / h) * 4;
      let t = fbm(nx, ny, 4, 3);
      // slightly darker overall so the glow/highlights read against it
      t = Math.pow(t, 1.15);
      const [r, g, b] = mixStops(t);
      const idx = (y * w + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // fire glow, lower-centre
  const glow = ctx.createRadialGradient(w * 0.6, h * 0.95, 10, w * 0.6, h * 0.95, h * 0.8);
  glow.addColorStop(0, 'rgba(255,205,120,0.55)');
  glow.addColorStop(0.4, 'rgba(230,140,40,0.28)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  drawBrickBand(ctx, w, 112);
  drawScratches(ctx, w, h);
  drawSoldierSilhouette(ctx, w, h);
  drawPosts(ctx, w, h);

  // vignette
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.22, w / 2, h / 2, h * 0.85);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.68)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  return c;
}

let cached: HTMLCanvasElement | null = null;

/** Returns the cached 800x600 poster background canvas, building it on first use. */
export function getPosterBackground(): HTMLCanvasElement {
  if (!cached) cached = buildPosterBackground(MENU_W, MENU_H);
  return cached;
}
