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
  // darken the whole band toward near-black before the mortar-line texture,
  // fading out at the bottom edge so it blends into the poster body
  const dark = ctx.createLinearGradient(0, 0, 0, bandH);
  dark.addColorStop(0, 'rgba(21,13,10,0.85)');
  dark.addColorStop(0.7, 'rgba(21,13,10,0.5)');
  dark.addColorStop(1, 'rgba(21,13,10,0)');
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, w, bandH);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
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

// ---------------------------------------------------------------- warscene --
// A backlit war-poster tableau along the lower third: a row of small marching
// soldiers plus a tank in profile, silhouetted dark against the fire glow,
// with wavering smoke columns rising behind them. Small, simple shapes read
// far more convincingly at this scale than one giant abstract figure.
const SIL_DARK = '#1d0c08';
const SIL_RIM = '#7a3216';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One small marching-soldier silhouette: helmet (flattened ellipse + brim
 * ledge), head/neck rect, trapezoid torso, two angled mid-stride legs, and a
 * rifle slung diagonally over the shoulder. `gx`/`groundY` are the figure's
 * feet position; `H` is its total height. Uses whatever fillStyle the caller
 * has already set (so it can be called once per rim/dark pass). */
function drawMarchingSoldierShape(ctx: CanvasRenderingContext2D, gx: number, groundY: number, H: number, seed: number): void {
  const legH = H * 0.4;
  const torsoH = H * 0.32;
  const neckH = H * 0.08;
  const helmetRX = H * 0.21;
  const helmetRY = H * 0.13;
  const shoulderHalfW = H * 0.18;
  const waistHalfW = H * 0.12;
  const legW = H * 0.1;
  const stride = H * 0.14 + (hash2(seed, 1, 41) - 0.5) * H * 0.08;
  const frontLeg = seed % 2 === 0 ? 1 : -1;

  const torsoBottomY = groundY - legH;
  const torsoTopY = torsoBottomY - torsoH;
  const neckTopY = torsoTopY - neckH;
  const headCY = neckTopY - helmetRY * 0.55;

  // legs, mid-stride (one forward, one back)
  ctx.save();
  ctx.translate(gx - frontLeg * stride * 0.5, torsoBottomY);
  ctx.rotate(-frontLeg * 0.16);
  ctx.fillRect(-legW / 2, 0, legW, legH);
  ctx.restore();
  ctx.save();
  ctx.translate(gx + frontLeg * stride * 0.5, torsoBottomY);
  ctx.rotate(frontLeg * 0.24);
  ctx.fillRect(-legW / 2, 0, legW, legH);
  ctx.restore();

  // torso trapezoid (wider at the shoulders)
  ctx.beginPath();
  ctx.moveTo(gx - shoulderHalfW, torsoTopY);
  ctx.lineTo(gx + shoulderHalfW, torsoTopY);
  ctx.lineTo(gx + waistHalfW, torsoBottomY);
  ctx.lineTo(gx - waistHalfW, torsoBottomY);
  ctx.closePath();
  ctx.fill();

  // neck
  ctx.fillRect(gx - neckH * 0.45, neckTopY, neckH * 0.9, neckH);

  // helmet: brim ledge then dome, touching/overlapping the neck
  ctx.beginPath();
  ctx.ellipse(gx, headCY + helmetRY * 0.55, helmetRX * 1.2, helmetRY * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(gx, headCY, helmetRX, helmetRY, 0, 0, Math.PI * 2);
  ctx.fill();

  // rifle slung diagonally over the shoulder
  ctx.save();
  ctx.translate(gx + shoulderHalfW * 0.4, torsoTopY + torsoH * 0.3);
  ctx.rotate(-0.62 - (hash2(seed, 2, 41) - 0.5) * 0.3);
  ctx.fillRect(-H * 0.03, -H * 0.5, H * 0.06, H * 0.62);
  ctx.restore();
}

/** Draws one marching soldier with a 1px rim-light pass (fire side) under a
 * dark main pass, so it reads as backlit rather than a flat cutout. */
function drawMarchingSoldier(ctx: CanvasRenderingContext2D, gx: number, groundY: number, H: number, seed: number): void {
  ctx.save();
  ctx.translate(1, -1);
  ctx.fillStyle = SIL_RIM;
  drawMarchingSoldierShape(ctx, gx, groundY, H, seed);
  ctx.restore();
  ctx.fillStyle = SIL_DARK;
  drawMarchingSoldierShape(ctx, gx, groundY, H, seed);
}

/** A tank in profile: hull trapezoid, rounded turret, long barrel, and a row
 * of road-wheel circles along the hull's underside. `x0` is the hull's left
 * edge, `groundY` its track line, `wPx` its overall width. */
function drawTankShape(ctx: CanvasRenderingContext2D, x0: number, groundY: number, wPx: number): void {
  const hullH = wPx * 0.26;
  const hullY = groundY - hullH;
  const turretW = wPx * 0.42;
  const turretH = wPx * 0.17;
  const turretX = x0 + wPx * 0.28;
  const turretY = hullY - turretH * 0.85;
  const barrelLen = wPx * 0.5;
  const barrelH = wPx * 0.045;

  // hull
  ctx.beginPath();
  ctx.moveTo(x0 + wPx * 0.06, hullY);
  ctx.lineTo(x0 + wPx * 0.94, hullY);
  ctx.lineTo(x0 + wPx, groundY);
  ctx.lineTo(x0, groundY);
  ctx.closePath();
  ctx.fill();

  // turret + barrel
  roundRectPath(ctx, turretX, turretY, turretW, turretH, turretH * 0.4);
  ctx.fill();
  ctx.fillRect(turretX + turretW * 0.72, turretY + turretH * 0.38, barrelLen, barrelH);

  // road wheels
  const wheelR = hullH * 0.3;
  const wheelY = groundY - wheelR * 0.5;
  const wheelCount = 5;
  for (let i = 0; i < wheelCount; i++) {
    const wx = x0 + wPx * 0.1 + (i * (wPx * 0.8)) / (wheelCount - 1);
    ctx.beginPath();
    ctx.ellipse(wx, wheelY, wheelR, wheelR, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTank(ctx: CanvasRenderingContext2D, x0: number, groundY: number, wPx: number): void {
  ctx.save();
  ctx.translate(1, -1);
  ctx.fillStyle = SIL_RIM;
  drawTankShape(ctx, x0, groundY, wPx);
  ctx.restore();
  ctx.fillStyle = SIL_DARK;
  drawTankShape(ctx, x0, groundY, wPx);
}

/** One wavering column of smoke: stacked translucent ellipses that widen and
 * fade as they rise toward the fire glow, with a per-level horizontal wobble
 * so the column doesn't read as a rigid straight line. */
function drawSmokeColumn(ctx: CanvasRenderingContext2D, x: number, baseY: number, topY: number, seed: number): void {
  ctx.save();
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const y = baseY + (topY - baseY) * t;
    const wobble = (hash2(seed, i, 53) - 0.5) * 46 * t;
    const rx = 9 + 30 * t;
    const ry = 12 + 9 * t;
    const alpha = 0.4 - 0.18 * t;
    ctx.fillStyle = `rgba(18,12,10,${Math.max(0.06, alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x + wobble, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** The full lower-third war-poster tableau: dark horizon ground, wavering
 * smoke columns rising into the fire glow, a tank silhouette at the left,
 * and a row of small marching soldiers (varied height/pose via hash) —
 * everything backlit and silhouetted, per the original's poster composition. */
function drawWarScene(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const groundY = h * 0.78;

  // smoke columns first, so the ground/figures drawn afterward occlude
  // their base and they read as rising from behind the horizon
  drawSmokeColumn(ctx, w * 0.13, groundY - 8, h * 0.08, 5);
  drawSmokeColumn(ctx, w * 0.48, groundY - 8, h * 0.05, 19);
  drawSmokeColumn(ctx, w * 0.8, groundY - 8, h * 0.12, 31);

  // dark ground strip the figures stand on, with a thin fire-lit rim at the
  // horizon line itself
  ctx.fillStyle = 'rgba(12,7,5,0.6)';
  ctx.fillRect(0, groundY, w, h - groundY);
  ctx.fillStyle = 'rgba(255,154,60,0.3)';
  ctx.fillRect(0, groundY - 1, w, 2);

  drawTank(ctx, 0, groundY, 180);

  const soldierCount = 7;
  const startX = 216;
  const endX = w - 30;
  for (let i = 0; i < soldierCount; i++) {
    const gx = startX + ((endX - startX) * i) / (soldierCount - 1);
    const H = 70 + hash2(i, 7, 61) * 20;
    drawMarchingSoldier(ctx, gx, groundY, H, i);
  }
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

  // fire glow: strongest right along the horizon band so the war-scene
  // silhouettes drawn on top read as backlit
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.76, 10, w * 0.5, h * 0.76, h * 0.68);
  glow.addColorStop(0, 'rgba(255,154,60,0.7)');
  glow.addColorStop(0.35, 'rgba(255,154,60,0.4)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  drawBrickBand(ctx, w, 90);
  drawScratches(ctx, w, h);
  drawWarScene(ctx, w, h);
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
