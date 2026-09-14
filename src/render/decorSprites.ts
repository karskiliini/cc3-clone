// ============================================================================
// decorSprites.ts — small procedural sprites for purely visual map dressing
// (DecorItem/DecorKind from shared/types). Cached by kind+variant, drawn onto
// baked terrain chunks by terrainRender.ts's drawDecor().
// ============================================================================
import type { DecorKind, Season } from '@/shared/types';
import { createCanvas, ctx2d } from '@/render/pixelUtil';
import { hash2 } from '@/shared/rng';
import { paintCrater, paintFoxhole, craterExtentPx, foxholeExtentPx, type CraterDraw } from '@/render/craterArt';

const cache = new Map<string, HTMLCanvasElement>();
function cached(key: string, build: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) { c = build(); cache.set(key, c); }
  return c;
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function buildHaystack(variant: number): HTMLCanvasElement {
  const c = createCanvas(8, 8);
  const ctx = ctx2d(c);
  px(ctx, 1, 6, 6, 1, 'rgba(20,16,8,0.35)'); // shadow/base
  ctx.fillStyle = '#8a6f2a';
  ctx.beginPath();
  ctx.ellipse(4, 4, 3.2, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a68638';
  ctx.beginPath();
  ctx.ellipse(3.4, 3, 2, 1.6, 0, 0, Math.PI * 2);
  ctx.fill();
  px(ctx, 2, 6, 4, 1, '#5f4a1e');
  return c;
}

function buildWell(): HTMLCanvasElement {
  const c = createCanvas(4, 5);
  const ctx = ctx2d(c);
  px(ctx, 0, 4, 4, 1, 'rgba(20,16,8,0.3)');
  px(ctx, 0, 1, 4, 3, '#8a8a82');
  px(ctx, 1, 2, 2, 2, '#26241f');
  px(ctx, 0, 1, 4, 1, '#a4a49a');
  px(ctx, 0, 0, 4, 1, '#5f4226'); // roof
  return c;
}

function buildCart(): HTMLCanvasElement {
  const c = createCanvas(7, 5);
  const ctx = ctx2d(c);
  px(ctx, 1, 1, 5, 2, '#6b4a28');
  px(ctx, 1, 1, 5, 1, '#7d5a32');
  ctx.fillStyle = '#2c2418';
  ctx.beginPath(); ctx.arc(2, 3.5, 1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(5, 3.5, 1, 0, Math.PI * 2); ctx.fill();
  return c;
}

/** Soft 3-tone lobed green blob, sized with a transparent margin so its shadow (drawn separately
 * in drawDecorItem) never visually fuses with the fill into a near-black square at small scale. */
function buildBush(): HTMLCanvasElement {
  const c = createCanvas(8, 8);
  const ctx = ctx2d(c);
  // base lobe (mid green, never near-black)
  ctx.fillStyle = '#5a7a3c';
  ctx.beginPath(); ctx.ellipse(4, 4.6, 2.6, 2.1, 0, 0, Math.PI * 2); ctx.fill();
  // a couple of secondary lobes for a bumpy, non-perfect-ellipse silhouette
  ctx.beginPath(); ctx.ellipse(2.4, 3.6, 1.6, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(5.6, 3.9, 1.6, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  // mid highlight lobe
  ctx.fillStyle = '#7fa356';
  ctx.beginPath(); ctx.ellipse(3.3, 3.1, 1.4, 1.1, 0, 0, Math.PI * 2); ctx.fill();
  // small rim-light fleck, near-white but low alpha so it reads as a highlight, not a hole
  ctx.fillStyle = 'rgba(226,232,190,0.55)';
  ctx.beginPath(); ctx.ellipse(2.7, 2.4, 0.6, 0.45, 0, 0, Math.PI * 2); ctx.fill();
  return c;
}

function buildStump(): HTMLCanvasElement {
  const c = createCanvas(3, 3);
  const ctx = ctx2d(c);
  px(ctx, 0, 0, 3, 3, '#5a4126');
  px(ctx, 0, 0, 3, 1, '#8a6f42');
  px(ctx, 2, 1, 1, 2, '#3a2a18');
  return c;
}

function buildPole(): HTMLCanvasElement {
  const c = createCanvas(3, 6);
  const ctx = ctx2d(c);
  px(ctx, 1, 0, 1, 5, '#3a3228');
  px(ctx, 0, 0, 3, 1, '#2c2620'); // cross-arm
  px(ctx, 2, 4, 1, 1, 'rgba(0,0,0,0.3)'); // shadow
  return c;
}

/** Tram overhead-wire support: a taller pole with a crossbar and insulator studs, plus a short
 * stub of wire either side so a row of these (via decorLine) reads as a continuous line down the
 * street rather than invisible dots. */
function buildTramwire(): HTMLCanvasElement {
  const c = createCanvas(9, 8);
  const ctx = ctx2d(c);
  px(ctx, 3, 7, 3, 1, 'rgba(0,0,0,0.3)'); // shadow
  px(ctx, 3, 0, 1, 7, '#2a261f'); // pole
  px(ctx, 2, 0, 3, 1, '#1c1913'); // crossbar
  px(ctx, 2, 1, 1, 1, '#4a4238'); // insulator
  px(ctx, 4, 1, 1, 1, '#4a4238');
  ctx.strokeStyle = 'rgba(20,18,14,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 1.5); ctx.lineTo(9, 1.5);
  ctx.stroke();
  return c;
}

function buildRocks(): HTMLCanvasElement {
  const c = createCanvas(4, 3);
  const ctx = ctx2d(c);
  px(ctx, 0, 1, 1, 1, '#8a8a82');
  px(ctx, 1, 0, 1, 2, '#9a9a90');
  px(ctx, 2, 1, 2, 1, '#7a7a70');
  px(ctx, 3, 2, 1, 1, '#6a6a60');
  return c;
}

function buildLog(): HTMLCanvasElement {
  const c = createCanvas(5, 2);
  const ctx = ctx2d(c);
  px(ctx, 0, 0, 5, 2, '#5a4128');
  px(ctx, 0, 0, 5, 1, '#6f5334');
  px(ctx, 0, 0, 1, 2, '#4a3a26');
  px(ctx, 4, 0, 1, 2, '#4a3a26');
  return c;
}

/** A small old shell hole (1.3-2.2 m by variant), drawn with the shared height-field earthwork
 * art (craterArt.ts) so a stand-alone sprite matches the craters baked into terrain chunks. */
function buildShellhole(variant: number, season: Season): HTMLCanvasElement {
  const c: CraterDraw = { x: 0, y: 0, diameterM: 1.3 + (variant % 3) * 0.45, kind: 'shell', old: true, seed: 4471 + variant * 31 };
  const r = Math.ceil(craterExtentPx(c));
  const canvas = createCanvas(r * 2, r * 2);
  paintCrater(ctx2d(canvas), c, season, -r, -r, 1);
  return canvas;
}

/** A 1-2 man foxhole facing south (variant bit 0 = 2-man, bits 1-2 = parapet). */
function buildFoxhole(variant: number, season: Season): HTMLCanvasElement {
  const r = Math.ceil(foxholeExtentPx());
  const canvas = createCanvas(r * 2, r * 2);
  paintFoxhole(ctx2d(canvas), { x: 0, y: 0, angle: Math.PI / 2, variant: (variant >> 1) % 3, men: variant & 1 ? 2 : 1, seed: 90 + variant }, season, -r, -r, 1);
  return canvas;
}

function buildGrave(): HTMLCanvasElement {
  const c = createCanvas(3, 4);
  const ctx = ctx2d(c);
  px(ctx, 1, 1, 1, 3, '#5a4530');
  px(ctx, 0, 1, 3, 1, '#6f5638');
  return c;
}

function buildSign(): HTMLCanvasElement {
  const c = createCanvas(4, 4);
  const ctx = ctx2d(c);
  px(ctx, 1, 1, 1, 3, '#4a3a24');
  px(ctx, 0, 0, 4, 2, '#d8d2b8');
  px(ctx, 0, 0, 4, 1, '#c4be9e');
  return c;
}

function buildBarrel(): HTMLCanvasElement {
  const c = createCanvas(3, 3);
  const ctx = ctx2d(c);
  px(ctx, 0, 0, 3, 3, '#3a3a38');
  px(ctx, 0, 0, 3, 1, '#4c4c48');
  px(ctx, 0, 1, 3, 1, '#28281f');
  return c;
}

function buildCrate(): HTMLCanvasElement {
  const c = createCanvas(3, 3);
  const ctx = ctx2d(c);
  px(ctx, 0, 0, 3, 3, '#8a713f');
  px(ctx, 0, 0, 3, 1, '#a08a52');
  px(ctx, 0, 2, 3, 1, '#6a5530');
  return c;
}

function buildWreck(): HTMLCanvasElement {
  const c = createCanvas(8, 4);
  const ctx = ctx2d(c);
  px(ctx, 1, 1, 6, 2, '#2c2a26');
  px(ctx, 0, 2, 8, 1, '#1a1815');
  px(ctx, 2, 0, 3, 1, '#3a352e');
  ctx.fillStyle = '#c8602c';
  ctx.globalAlpha = 0.5;
  px(ctx, 4, 0, 1, 1, '#c8602c');
  ctx.globalAlpha = 1;
  return c;
}

function buildWoodpile(): HTMLCanvasElement {
  const c = createCanvas(5, 3);
  const ctx = ctx2d(c);
  px(ctx, 0, 1, 5, 2, '#5a4128');
  px(ctx, 0, 0, 5, 1, '#6f5334');
  px(ctx, 1, 1, 1, 2, '#4a3a26');
  px(ctx, 3, 1, 1, 2, '#4a3a26');
  return c;
}

function buildPuddle(): HTMLCanvasElement {
  const c = createCanvas(6, 4);
  const ctx = ctx2d(c);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#3a4650';
  ctx.beginPath(); ctx.ellipse(3, 2, 2.8, 1.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#8fa8b4';
  ctx.beginPath(); ctx.ellipse(2.3, 1.5, 0.8, 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  return c;
}

function buildFlowers(variant: number): HTMLCanvasElement {
  const c = createCanvas(3, 3);
  const ctx = ctx2d(c);
  const colors = ['#e8e4c8', '#e0c84a', '#e8e4c8'];
  px(ctx, 0, 1, 1, 1, colors[variant % colors.length]);
  px(ctx, 2, 0, 1, 1, colors[(variant + 1) % colors.length]);
  px(ctx, 1, 2, 1, 1, colors[(variant + 2) % colors.length]);
  return c;
}

function build(kind: DecorKind, variant: number, season: Season): HTMLCanvasElement {
  switch (kind) {
    case 'haystack': return buildHaystack(variant);
    case 'well': return buildWell();
    case 'cart': return buildCart();
    case 'bush': return buildBush();
    case 'stump': return buildStump();
    case 'pole': return buildPole();
    case 'rocks': return buildRocks();
    case 'log': return buildLog();
    case 'shellhole': return buildShellhole(variant, season);
    case 'grave': return buildGrave();
    case 'sign': return buildSign();
    case 'barrel': return buildBarrel();
    case 'crate': return buildCrate();
    case 'wreck': return buildWreck();
    case 'woodpile': return buildWoodpile();
    case 'puddle': return buildPuddle();
    case 'flowers': return buildFlowers(variant);
    case 'tramwire': return buildTramwire();
    case 'foxhole': return buildFoxhole(variant, season);
    default: return createCanvas(1, 1);
  }
}

/** Cached small decor sprite (transparent canvas), keyed by kind+variant(+season for the
 * season-sensitive kinds). */
export function getDecorSprite(kind: DecorKind, variant = 0, season: Season = 'summer'): HTMLCanvasElement {
  return cached(`decor|${kind}|${variant}|${season}`, () => build(kind, variant, season));
}

/** True if this decor kind casts a visible 1px dark shadow when drawn. */
export function decorHasShadow(kind: DecorKind): boolean {
  return kind !== 'tramwire' && kind !== 'puddle' && kind !== 'shellhole' && kind !== 'foxhole';
}

/** Draw one decor item centred at world pixel (cx, cy) with its shadow. */
export function drawDecorItem(ctx: CanvasRenderingContext2D, kind: DecorKind, cx: number, cy: number, variant = 0, season: Season = 'summer'): void {
  const sprite = getDecorSprite(kind, variant, season);
  const dx = Math.round(cx - sprite.width / 2);
  const dy = Math.round(cy - sprite.height / 2);
  if (decorHasShadow(kind)) {
    // a soft, translucent ellipse matching the sprite's rough footprint rather than an opaque
    // full-bbox rect — a full-bbox near-black shadow behind small sprites (bush, flowers, rocks)
    // used to visually fuse with the fill into one solid near-black square at small scale.
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#141008';
    ctx.beginPath();
    ctx.ellipse(dx + sprite.width / 2 + 1, dy + sprite.height / 2 + 1, sprite.width / 2.4, sprite.height / 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(sprite, dx, dy);
}

/** Deterministic 0..1 hash helper re-exported for terrainRender's decor placement jitter. */
export function decorHash(x: number, y: number, seed: number): number {
  return hash2(x, y, seed);
}
