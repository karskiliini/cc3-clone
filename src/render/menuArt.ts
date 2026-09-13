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

const STOPS = ['#1a0505', '#4a0c0c', '#8b1a1a', '#c84a2a'].map(hexToRgb);

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
// A war-poster tableau: one large painted soldier on the left, smoke rising
// into the fire glow, and a small rubble scene with a couple of figures.
const SIL_DARK = '#1d0c08';
const SIL_RIM = '#7a3216';

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
  // near-rectangular torso: shoulders only slightly wider than the waist
  // (a boxy body reads as human at this scale far better than a cone)
  const shoulderHalfW = H * 0.155;
  const waistHalfW = H * 0.135;
  const legW = H * 0.1;
  const stride = H * 0.14 + (hash2(seed, 1, 41) - 0.5) * H * 0.08;
  const frontLeg = seed % 2 === 0 ? 1 : -1;
  const rifleAcrossBody = seed % 2 === 1;

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

  // small backpack bump on the trailing (back) side, tucked slightly behind
  // the torso's upper silhouette so it fuses rather than floats
  const backSide = -frontLeg;
  ctx.fillRect(
    gx + backSide * waistHalfW * 0.55 - H * 0.05,
    torsoTopY + torsoH * 0.1,
    H * 0.12,
    torsoH * 0.55,
  );

  // torso: a rectangle with gently sloped shoulders and a narrower waist
  ctx.beginPath();
  ctx.moveTo(gx - shoulderHalfW, torsoTopY + torsoH * 0.1);
  ctx.lineTo(gx - waistHalfW * 0.6, torsoTopY);
  ctx.lineTo(gx + waistHalfW * 0.6, torsoTopY);
  ctx.lineTo(gx + shoulderHalfW, torsoTopY + torsoH * 0.1);
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

  // rifle: half the figures carry it slung diagonally over the shoulder,
  // half hold it diagonally across the body (port arms) for pose variety
  ctx.save();
  if (rifleAcrossBody) {
    ctx.translate(gx - shoulderHalfW * 0.5, torsoBottomY - torsoH * 0.15);
    ctx.rotate(0.5 + (hash2(seed, 2, 41) - 0.5) * 0.2);
    ctx.fillRect(-H * 0.03, -H * 0.32, H * 0.06, H * 0.6);
  } else {
    ctx.translate(gx + shoulderHalfW * 0.4, torsoTopY + torsoH * 0.3);
    ctx.rotate(-0.62 - (hash2(seed, 2, 41) - 0.5) * 0.3);
    ctx.fillRect(-H * 0.03, -H * 0.5, H * 0.06, H * 0.62);
  }
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

/** One wavering column of smoke: overlapping soft radial-gradient puffs
 * (rather than discrete hard-edged circles) that grow and fade as they rise
 * toward the fire glow, spaced closely enough (~0.4x their own radius) to
 * merge into a continuous plume, with a smooth lateral drift so the column
 * leans rather than reading as a rigid vertical stack. */
function drawSmokeColumn(ctx: CanvasRenderingContext2D, x: number, baseY: number, topY: number, seed: number): void {
  ctx.save();
  const totalRise = baseY - topY;
  const startR = 10;
  const endR = 44;
  // walk upward in steps sized to the *current* radius so puffs overlap by
  // a consistent fraction regardless of how fast the column widens
  let y = baseY;
  let i = 0;
  const drift = (hash2(seed, 0, 59) - 0.5) * 0.6; // per-column drift direction/strength
  while (y > topY) {
    const t = Math.min(1, (baseY - y) / totalRise);
    const r = startR + (endR - startR) * t;
    const sway = Math.sin(t * 3.1 + hash2(seed, 1, 59) * 6) * 26 * t;
    const dx = x + drift * (baseY - y) * 0.55 + sway;
    const alpha = 0.36 * (1 - t) + 0.04;
    const grad = ctx.createRadialGradient(dx, y, 0, dx, y, r);
    grad.addColorStop(0, `rgba(20,8,6,${alpha.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(20,8,6,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(dx, y, r, 0, Math.PI * 2);
    ctx.fill();
    y -= Math.max(6, r * 0.4);
    i++;
    if (i > 60) break; // safety
  }
  ctx.restore();
}

/** The big painted-soldier silhouette filling the left ~45% of the poster:
 * helmet dome + brim, head, neck, broad shoulders, and a foreshortened arm
 * pointing out at the viewer. Our own simple shapes — dark red-brown so it
 * reads like the original's oxblood painted figure without copying it. */
function drawHeroSoldierShape(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const sx = w / 800;
  const sy = h / 600;
  const X = (v: number) => v * sx;
  const Y = (v: number) => v * sy;
  // torso / shoulders
  ctx.beginPath();
  ctx.moveTo(X(0), Y(600));
  ctx.lineTo(X(0), Y(420));
  ctx.quadraticCurveTo(X(20), Y(360), X(95), Y(340));
  ctx.lineTo(X(215), Y(338));
  ctx.quadraticCurveTo(X(290), Y(352), X(318), Y(410));
  ctx.lineTo(X(345), Y(600));
  ctx.closePath();
  ctx.fill();
  // neck
  ctx.fillRect(X(122), Y(290), X(72), Y(60));
  // head
  ctx.beginPath();
  ctx.ellipse(X(158), Y(262), X(56), Y(68), 0, 0, Math.PI * 2);
  ctx.fill();
  // helmet dome
  ctx.beginPath();
  ctx.ellipse(X(160), Y(205), X(98), Y(95), 0, Math.PI, Math.PI * 2);
  ctx.fill();
  // helmet brim (slight downward flare)
  ctx.beginPath();
  ctx.ellipse(X(160), Y(210), X(122), Y(26), 0.05, 0, Math.PI * 2);
  ctx.fill();
  // pointing arm: a thick foreshortened sleeve from the right shoulder
  // coming out toward the viewer, ending in a fist with the index finger
  ctx.beginPath();
  ctx.moveTo(X(200), Y(345));
  ctx.quadraticCurveTo(X(270), Y(330), X(300), Y(300));
  ctx.lineTo(X(338), Y(318));
  ctx.quadraticCurveTo(X(318), Y(380), X(250), Y(430));
  ctx.lineTo(X(210), Y(440));
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(X(318), Y(306), X(30), Y(24), -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(X(322), Y(290));
  ctx.rotate(-0.9);
  ctx.fillRect(0, -X(6), X(22), X(12));
  ctx.restore();
}

function drawHeroSoldier(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Render the opaque silhouette offscreen first so overlapping parts don't
  // show alpha seams, then composite it at 0.85.
  const layer = document.createElement('canvas');
  layer.width = w;
  layer.height = h;
  const lc = layer.getContext('2d')!;
  lc.save();
  lc.translate(3, -2);
  lc.fillStyle = '#9a3418';
  drawHeroSoldierShape(lc, w, h);
  lc.restore();
  lc.fillStyle = '#2a0806';
  drawHeroSoldierShape(lc, w, h);
  // faint painted modelling on face / helmet dome, clipped to the figure
  lc.globalCompositeOperation = 'source-atop';
  const face = lc.createRadialGradient(w * (172 / 800), h * (258 / 600), 2, w * (172 / 800), h * (258 / 600), w * (60 / 800));
  face.addColorStop(0, 'rgba(120,34,20,0.55)');
  face.addColorStop(1, 'rgba(120,34,20,0)');
  lc.fillStyle = face;
  lc.fillRect(0, 0, w, h);
  const dome = lc.createRadialGradient(w * (200 / 800), h * (150 / 600), 2, w * (200 / 800), h * (150 / 600), w * (70 / 800));
  dome.addColorStop(0, 'rgba(140,44,24,0.5)');
  dome.addColorStop(1, 'rgba(140,44,24,0)');
  lc.fillStyle = dome;
  lc.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** Rubble mound in the lower right, below the button column, with 2 small
 * figures silhouetted against the fire. */
function drawRubble(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const baseY = h * 0.94;
  ctx.save();
  ctx.fillStyle = 'rgba(26,8,5,0.8)';
  ctx.beginPath();
  ctx.moveTo(w * 0.46, h);
  let x = w * 0.46;
  let i = 0;
  while (x < w) {
    const t = (x - w * 0.46) / (w * 0.54);
    const ridge = baseY - Math.sin(t * Math.PI) * h * 0.08 - hash2(i, 3, 83) * h * 0.025;
    ctx.lineTo(x, ridge);
    x += 10 + hash2(i, 4, 83) * 12;
    i++;
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawMarchingSoldier(ctx, w * 0.66, h * 0.885, 34, 2);
  drawMarchingSoldier(ctx, w * 0.72, h * 0.89, 30, 5);
}

/** Poster tableau: a couple of smoke columns rising into the fire glow, one
 * large painted soldier on the left, and a small rubble scene lower right. */
function drawWarScene(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  drawSmokeColumn(ctx, w * 0.86, h * 0.82, h * 0.14, 31);
  drawRubble(ctx, w, h);
  drawHeroSoldier(ctx, w, h);
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

  // fire glow: a yellow-white bloom lower-centre-right, behind the lower
  // menu buttons (the original's burning-building backdrop)
  const glow = ctx.createRadialGradient(w * 0.62, h * 0.62, 4, w * 0.62, h * 0.62, w * 0.3);
  glow.addColorStop(0, 'rgba(255,240,176,0.9)');
  glow.addColorStop(0.3, 'rgba(250,180,80,0.75)');
  glow.addColorStop(0.65, 'rgba(232,122,32,0.45)');
  glow.addColorStop(1, 'rgba(232,122,32,0)');
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
