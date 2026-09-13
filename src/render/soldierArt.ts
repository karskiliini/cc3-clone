// ============================================================================
// soldierArt.ts — hand-authored pixel-art grids for infantry, at 10 px/metre
// (TILE_PX/TILE_M), mirroring the vehicleArt.ts method: each stance is built
// as a 2D grid of characters (a Grid) by dedicated builder code — every
// character placed is a deliberate pixel (helmet dome, shoulders, weapon,
// boots) — then painted onto a small canvas with a baked drop shadow. This
// replaces the old 12px-grid-scaled-2x soldiers, which read as chunky pawns,
// with small, crisp, top-down figures matching the original's scale.
//
// The north-facing (facing 0, "up") pose is the only one hand-authored per
// stance/frame. Cardinal facings (E/S/W) are exact 90 degree rotations.
// Diagonal facings use a nearest-neighbour 45 degree rotation of the whole
// sprite, then the helmet disc is re-stamped at the rotated centre (rotation
// of a tiny circle degrades into a blocky blob otherwise) so it stays round.
// ============================================================================
import type { Side, Season, Stance, Facing8 } from '@/shared/types';
import { createCanvas, ctx2d, rotate90, rotateSprite } from '@/render/pixelUtil';

// --------------------------------------------------------------- grid -----
type Grid = string[][];

function blank(w: number, h: number, fill = '.'): Grid {
  return Array.from({ length: h }, () => Array<string>(w).fill(fill));
}
function put(g: Grid, x: number, y: number, ch: string): void {
  if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch;
}
function fillRect(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  const h = g.length, w = g[0].length;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) g[y][x] = ch;
  }
}

/** Iterate every pixel within radius `r` of (cx,cy), used both to author the
 * helmet disc into a character grid and to re-stamp it onto a rotated
 * canvas — one shared shape definition for both code paths. */
function forEachDiscPixel(cx: number, cy: number, r: number, cb: (x: number, y: number) => void): void {
  const ri = Math.ceil(r);
  for (let y = -ri; y <= ri; y++) {
    for (let x = -ri; x <= ri; x++) {
      if (Math.sqrt(x * x + y * y) <= r) cb(cx + x, cy + y);
    }
  }
}

/** 4-tone helmet dome: dark rim, mid fill, a lighter NW blob, and a single
 * brightest specular pixel at the NW-most rim pixel. */
function paintHelmet(g: Grid, cx: number, cy: number, r: number): void {
  forEachDiscPixel(cx, cy, r, (x, y) => put(g, x, y, 'O'));
  forEachDiscPixel(cx, cy, Math.max(1, r - 1), (x, y) => put(g, x, y, 'H'));
  forEachDiscPixel(cx - 1, cy - 1, Math.max(1, r - 2.2), (x, y) => put(g, x, y, 'h'));
  put(g, cx - Math.round(r * 0.75), cy - Math.round(r * 0.75), 'P');
}

// -------------------------------------------------------------- palette ---
// Boots and weapon are near-black — the original's small figures still read
// their gear as the darkest thing on the sprite even against dark terrain.
const BOOT = '#171510';
const WEAPON = '#121210';
const STOCK = '#6b4a2e';
const SKIN = '#c9a37c';
const BLOOD = '#5a1a12';
// Round-2 critique: soldiers were too low-contrast against grass/snow. A
// baked 1px silhouette outline plus a mid-grey SE shading tone (winter only,
// so white smocks don't vanish against snow) fixes that without changing the
// authored shapes above.
const OUTLINE_COLOR = 'rgba(30,31,24,0.85)'; // '#1e1f18' @ 85%
// Round-3 contrast pass: a second, softer ring one pixel further out than the
// baked outline above — a dark 40%-alpha halo so the figure separates from
// noisy grass/snow texture even where the terrain happens to be dark too
// (the drop shadow, drawn separately by unitRender.ts under each figure,
// handles the "sits on the ground" cue; this halo handles raw silhouette
// contrast against any background tone).
const HALO_COLOR = 'rgba(8,8,6,0.4)';
const WINTER_SE_SHADE = '#a9aba4';
// wf4: the manual's bright yellow "soldier outline" that friendly winter
// figures carry in ref_cc3_1482 — replaces the dark ring + halo for them.
const FRIENDLY_WINTER_OUTLINE = 'rgba(216,200,96,0.9)';
const FRIENDLY_WINTER_HALO = 'rgba(8,8,6,0.2)';

/** Whose soldier this sprite is, relative to the viewing player. */
export type SoldierOutline = 'friendly' | 'enemy';

interface UniformPalette { u: string; s: string; helmetMid: string; helmetLight: string }
// Round-3: shift German feldgrau slightly bluer and Soviet khaki slightly
// warmer (relative to round 2's tones) so the two sides are distinguishable
// by hue at a glance, not just by value, matching the reference's clearly
// two-toned opposing uniforms.
const GERMAN_SUMMER: UniformPalette = { u: '#626f5e', s: '#485144', helmetMid: '#5a6052', helmetLight: '#737a6c' };
const SOVIET_SUMMER: UniformPalette = { u: '#8f7f44', s: '#695b2e', helmetMid: '#71663a', helmetLight: '#897e4c' };
// wf4: smock lowered below the snow ramp's brightest tones so the figure is
// not a pure-white blob; WINTER_SE_SHADE stays darker than it.
const WINTER_SMOCK = { u: '#c9cac2', s: '#a9aaa2' };
const SOVIET_WINTER_HELMET_MID = '#d0d0c8';

function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => Math.round(v * factor).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
function lightenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => Math.round(v + (255 - v) * factor).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
/** Mix each channel 'amount' of the way toward flat grey — used for the
 * dead-soldier desaturation pass before darkening. */
function desaturateHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const gray = (r + g + b) / 3;
  const f = (v: number) => Math.round(v + (gray - v) * amount).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

function paletteFor(side: Side, season: Season): UniformPalette {
  if (season === 'winter') {
    if (side === 'german') return { u: WINTER_SMOCK.u, s: WINTER_SMOCK.s, helmetMid: GERMAN_SUMMER.helmetMid, helmetLight: GERMAN_SUMMER.helmetLight };
    return { u: WINTER_SMOCK.u, s: WINTER_SMOCK.s, helmetMid: SOVIET_WINTER_HELMET_MID, helmetLight: lightenHex(SOVIET_WINTER_HELMET_MID, 0.35) };
  }
  return side === 'german' ? GERMAN_SUMMER : SOVIET_SUMMER;
}

/** Resolve the character->colour map for one soldier variant. Dead soldiers
 * get every colour desaturated 40% toward grey then darkened 30%.
 *
 * Round-2 contrast pass: the shoulder/torso dark edge ('S') is darkened
 * further than the palette's own dark tone, and the helmet's light tone
 * ('h', and therefore its derived specular) is brightened, so the head reads
 * as a distinct disc and the body silhouette reads as a distinct shape at
 * battle zoom instead of blending into the ground ramp. */
function colorsFor(side: Side, season: Season, dead: boolean, outline: SoldierOutline = 'enemy'): Record<string, string> {
  const pal = paletteFor(side, season);
  let u = pal.u;
  // Round-3 contrast pass: push the shoulder/torso dark edge and the helmet
  // specular ~15% further apart than the round-2 values (0.72 -> 0.61 darken
  // factor on the shoulder edge; 0.22 -> 0.25 and 0.55 -> 0.63 lighten
  // factors on the helmet light tone and its specular pixel) so the head and
  // silhouette edge read as more distinctly lit/shadowed at battle zoom.
  let s = darkenHex(pal.s, 0.61);
  let helmetMid = pal.helmetMid;
  let helmetLight = lightenHex(pal.helmetLight, 0.25);
  let weapon = WEAPON, stock = STOCK, skin = SKIN, boot = BOOT;
  let winterShade = WINTER_SE_SHADE;
  if (dead) {
    // Dead soldiers read clearly darker than the living: heavier desaturate
    // + darken than round 2 (0.4/0.7 -> 0.45/0.55).
    const fix = (hex: string) => darkenHex(desaturateHex(hex, 0.45), 0.55);
    u = fix(u); s = fix(s); helmetMid = fix(helmetMid); helmetLight = fix(helmetLight);
    weapon = fix(weapon); stock = fix(stock); skin = fix(skin); boot = fix(boot);
    winterShade = fix(winterShade);
  }
  const rim = darkenHex(helmetMid, 0.62);
  const specular = lightenHex(helmetLight, 0.63);
  const yellowRing = season === 'winter' && outline === 'friendly' && !dead;
  return {
    O: rim, H: helmetMid, h: helmetLight, P: specular,
    U: u, S: s, V: winterShade,
    W: weapon, K: stock, G: skin,
    b: boot, k: darkenHex(boot, 0.55),
    R: 'rgba(90,26,18,0.7)',
    X: yellowRing ? FRIENDLY_WINTER_OUTLINE : OUTLINE_COLOR,
    Y: yellowRing ? FRIENDLY_WINTER_HALO : HALO_COLOR,
  };
}

// ---------------------------------------------------------- stance grids --
interface Built { grid: Grid; helmet: { cx: number; cy: number; r: number } }

/** Standing / walking, north-facing: 6px helmet, 6-wide shoulders, a rifle
 * held forward (north) from the right shoulder with a wood stock and a skin
 * pixel at the grip, and two long alternating legs trailing behind so the
 * figure reads as an elongated striding silhouette along its facing. */
function buildStandingGrid(frame: 0 | 1): Built {
  const W = 20, H = 22;
  const g = blank(W, H);
  const helmet = { cx: 9, cy: 6, r: 3 };
  paintHelmet(g, helmet.cx, helmet.cy, helmet.r);

  // Shoulders: 6px wide x 3 rows, darker edge columns.
  const shY0 = 10, shY1 = 12, shX0 = 6, shX1 = 11;
  fillRect(g, shX0, shY0, shX1, shY1, 'U');
  for (let y = shY0; y <= shY1; y++) { put(g, shX0, y, 'S'); put(g, shX1, y, 'S'); }

  // Weapon: 2px-wide, 9px barrel extending north from the right shoulder,
  // a 2px wood stock at the grip end, and a skin pixel at the hand.
  const wx0 = 12, wx1 = 13;
  fillRect(g, wx0, 0, wx1, 8, 'W');
  fillRect(g, wx0, 9, wx1, 10, 'K');
  put(g, wx0, 11, 'G');

  // Legs: two 2px boots trailing the shoulders, alternating stride per frame.
  const bootY0 = 13;
  const leftLen = frame === 0 ? 8 : 7;
  const rightLen = frame === 0 ? 7 : 8;
  fillRect(g, 6, bootY0, 7, bootY0 + leftLen - 1, 'b');
  fillRect(g, 6, bootY0 + leftLen - 1, 7, bootY0 + leftLen - 1, 'k');
  fillRect(g, 10, bootY0, 11, bootY0 + rightLen - 1, 'b');
  fillRect(g, 10, bootY0 + rightLen - 1, 11, bootY0 + rightLen - 1, 'k');

  return { grid: g, helmet };
}

/** Crouching, north-facing: larger 7px helmet, hunched 7-wide shoulders, a
 * shorter weapon, a short tucked boot and a second bent leg trailing
 * diagonally behind (the kneeling leg), so it reads differently from the
 * straight two-legged standing figure at 1x. */
function buildCrouchingGrid(frame: 0 | 1): Built {
  const W = 18, H = 18;
  const g = blank(W, H);
  const helmet = { cx: 9, cy: 6, r: 3.5 };
  paintHelmet(g, helmet.cx, helmet.cy, helmet.r);

  const shY0 = 9, shY1 = 11, shX0 = 5, shX1 = 11;
  fillRect(g, shX0, shY0, shX1, shY1, 'U');
  for (let y = shY0; y <= shY1; y++) { put(g, shX0, y, 'S'); put(g, shX1, y, 'S'); }

  // Shorter weapon: 5px barrel + 2px stock + grip pixel.
  const wx0 = 12, wx1 = 13;
  fillRect(g, wx0, 2, wx1, 6, 'W');
  fillRect(g, wx0, 7, wx1, 8, 'K');
  put(g, wx0, 9, 'G');

  // One tucked boot, nudged sideways for the settle-into-cover cycle.
  const wob = frame === 1 ? 1 : 0;
  fillRect(g, 8 + wob, 12, 9 + wob, 14, 'b');
  fillRect(g, 8 + wob, 14, 9 + wob, 14, 'k');
  // Kneeling leg: ~4px bent diagonally back and outward from the hip.
  for (let i = 0; i < 4; i++) {
    put(g, 10 + i, 12 + i, 'b');
    put(g, 11 + i, 12 + i, i === 3 ? 'k' : 'b');
  }

  return { grid: g, helmet };
}

/** Shared prone/dead skeleton: helmet at the north end, 2px arm bumps beside
 * it, a torso tapering from 8-wide shoulders to 5-wide hips, and two boots
 * slightly splayed at the south (rear) end. Weapon and arm placement differ
 * between the live prone pose and the dead pose, so those are added by the
 * two callers below. */
function buildProneSkeleton(): Built {
  const W = 12, H = 24;
  const g = blank(W, H);
  const cx = 6;
  const helmet = { cx, cy: 9, r: 3 };
  paintHelmet(g, helmet.cx, helmet.cy, helmet.r);

  // Torso/back tapering from 8-wide (shoulders) to 5-wide (hips).
  for (let y = 13; y <= 20; y++) {
    const t = (y - 13) / 7;
    const hw = 4 - t * 1.5;
    const x0 = Math.round(cx - hw), x1 = Math.round(cx + hw);
    fillRect(g, x0, y, x1, y, 'U');
    put(g, x0, y, 'S');
    put(g, x1, y, 'S');
  }

  // Boots: two 2px dark blocks, splayed slightly wider than the hip taper.
  fillRect(g, 3, 21, 4, 22, 'b');
  fillRect(g, 3, 22, 4, 22, 'k');
  fillRect(g, 7, 21, 8, 22, 'b');
  fillRect(g, 7, 22, 8, 22, 'k');

  return { grid: g, helmet };
}

/** Prone (live): weapon extends 6px beyond the helmet along the facing
 * (north), and both arm bumps sit symmetrically beside the helmet. */
function buildProneGrid(): Built {
  const built = buildProneSkeleton();
  const g = built.grid;
  const cx = built.helmet.cx;
  fillRect(g, cx - 1, 0, cx, 5, 'W');
  fillRect(g, cx - 3, 10, cx - 2, 11, 'U');
  fillRect(g, cx + 2, 10, cx + 3, 11, 'U');
  return built;
}

/** Dead: one arm flung out sideways (asymmetric), the weapon dropped 3px to
 * the side rather than held centred, and a 4px irregular blood splat under
 * the torso. */
function buildDeadGrid(): Built {
  const built = buildProneSkeleton();
  const g = built.grid;
  const cx = built.helmet.cx;
  // Weapon dropped, offset 3px to the side of where it would be held.
  fillRect(g, cx + 2, 0, cx + 3, 5, 'W');
  // One arm tucked normally, the other flung out wide to the side.
  fillRect(g, cx - 3, 10, cx - 2, 11, 'U');
  fillRect(g, cx + 3, 9, cx + 5, 10, 'U');
  // Irregular blood splat under the torso.
  put(g, cx - 1, 15, 'R');
  put(g, cx, 15, 'R');
  put(g, cx, 16, 'R');
  put(g, cx + 1, 16, 'R');
  return built;
}

/** Mid-grey SE shading for winter smocks: half of each uniform ('U') cell,
 * split along the sprite's own NW/SE diagonal, is recoloured to a distinct
 * shade tone so a white-clad figure keeps volume/contrast against snow
 * instead of dissolving into a flat white blob (compare ref_cc3_1482.png,
 * where the white-clad figures still read clearly against snow). */
function applyWinterShading(grid: Grid): void {
  const h = grid.length, w = grid[0].length;
  const refX = w / 2, refY = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] !== 'U') continue;
      if (x - refX + (y - refY) >= 0) grid[y][x] = 'V';
    }
  }
}

/** Expand a grid by two empty rings on every side: mark every background
 * cell touching a filled cell as the baked 1px silhouette outline ('X'),
 * then mark every remaining background cell touching *that* ring (or the
 * figure) as a second, softer 1px halo ('Y') one pixel further out. Together
 * these separate the figure from noisy ground/snow texture at battle zoom —
 * the halo is a round-3 addition on top of round 2's single outline ring, so
 * the silhouette still reads even where the ground happens to be as dark as
 * the outline itself. */
function addOutline(grid: Grid): Grid {
  const h = grid.length, w = grid[0].length;
  const off = 2;
  const nw = w + off * 2, nh = h + off * 2;
  const out = blank(nw, nh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y + off][x + off] = grid[y][x];
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < nw && y < nh && out[y][x] !== '.';
  const withOutline = out.map((row) => row.slice());
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      if (out[y][x] !== '.') continue;
      if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) withOutline[y][x] = 'X';
    }
  }
  const filledOrOutline = (x: number, y: number) => x >= 0 && y >= 0 && x < nw && y < nh && withOutline[y][x] !== '.';
  const withHalo = withOutline.map((row) => row.slice());
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      if (withOutline[y][x] !== '.') continue;
      if (filledOrOutline(x - 1, y) || filledOrOutline(x + 1, y) || filledOrOutline(x, y - 1) || filledOrOutline(x, y + 1)) withHalo[y][x] = 'Y';
    }
  }
  return withHalo;
}

// --------------------------------------------------------- canvas compose -
// Room for the baked outline ring + halo ring (2px) without clipping. The
// drop shadow is no longer baked into this canvas — it's drawn separately by
// unitRender.ts, under each figure, so it can be positioned/composited in
// screen space independent of the sprite's own rotation.
const PAD = 3;

function gridToCanvas(grid: Grid, colors: Record<string, string>): HTMLCanvasElement {
  const w = grid[0].length, h = grid.length;
  const expanded = addOutline(grid);
  const ew = expanded[0].length, eh = expanded.length;
  const c = createCanvas(w + PAD * 2, h + PAD * 2);
  const ctx = ctx2d(c);
  // The expanded grid's (0,0) is the original grid's (-2,-2) (outline ring +
  // halo ring), so it lands at canvas (PAD-2, PAD-2) to keep the original
  // grid's (0,0) at (PAD, PAD) — the convention `buildSoldierArt`'s
  // helmet-offset math below relies on.
  const base = PAD - 2;
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      const ch = expanded[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = colors[ch] ?? '#ff00ff';
      ctx.fillRect(base + x, base + y, 1, 1);
    }
  }
  return c;
}

export interface SoldierArt {
  canvas: HTMLCanvasElement;
  helmet: { cx: number; cy: number; r: number };
  helmetColors: { rim: string; mid: string; light: string; specular: string };
}

/** Build the north-facing (facing 0, "up") pixel art for one soldier
 * variant. Cached by the caller (sprites.ts) keyed on the same arguments. */
export function buildSoldierArt(side: Side, season: Season, stance: Stance | 'dead', frame: 0 | 1, outline: SoldierOutline = 'enemy'): SoldierArt {
  const dead = stance === 'dead';
  const colors = colorsFor(side, season, dead, outline);
  const built = dead ? buildDeadGrid()
    : stance === 'prone' ? buildProneGrid()
    : stance === 'crouching' ? buildCrouchingGrid(frame)
    : buildStandingGrid(frame);
  if (season === 'winter') applyWinterShading(built.grid);
  const canvas = gridToCanvas(built.grid, colors);
  return {
    canvas,
    helmet: { cx: built.helmet.cx + PAD, cy: built.helmet.cy + PAD, r: built.helmet.r },
    helmetColors: { rim: colors.O, mid: colors.H, light: colors.h, specular: colors.P },
  };
}

/** Re-stamp the helmet disc at its rotated position, in the same layered
 * rim/mid/light/specular tones as paintHelmet, so a 45 degree nearest-
 * neighbour rotation doesn't leave the head looking like a jagged blob. */
function restampHelmet(canvas: HTMLCanvasElement, art: SoldierArt, facing: Facing8): void {
  const w = canvas.width, h = canvas.height;
  const centre = { x: w / 2 - 0.5, y: h / 2 - 0.5 };
  const dx = art.helmet.cx - centre.x, dy = art.helmet.cy - centre.y;
  const rad = (facing * Math.PI) / 4;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = Math.round(centre.x + dx * cos - dy * sin);
  const cy = Math.round(centre.y + dx * sin + dy * cos);
  const ctx = ctx2d(canvas);
  const r = art.helmet.r;
  forEachDiscPixel(cx, cy, r, (x, y) => { ctx.fillStyle = art.helmetColors.rim; ctx.fillRect(x, y, 1, 1); });
  forEachDiscPixel(cx, cy, Math.max(1, r - 1), (x, y) => { ctx.fillStyle = art.helmetColors.mid; ctx.fillRect(x, y, 1, 1); });
  forEachDiscPixel(cx - 1, cy - 1, Math.max(1, r - 2.2), (x, y) => { ctx.fillStyle = art.helmetColors.light; ctx.fillRect(x, y, 1, 1); });
  ctx.fillStyle = art.helmetColors.specular;
  ctx.fillRect(cx - Math.round(r * 0.75), cy - Math.round(r * 0.75), 1, 1);
}

/** Orient the north-facing art to the given facing: exact 90 degree
 * rotations for the cardinals, a 45 degree nearest-neighbour rotation plus
 * a helmet re-stamp for the diagonals. */
export function orientSoldierArt(art: SoldierArt, facing: Facing8): HTMLCanvasElement {
  if (facing % 2 === 0) return rotate90(art.canvas, facing / 2);
  const rotated = rotateSprite(art.canvas, (facing * Math.PI) / 4);
  restampHelmet(rotated, art, facing);
  return rotated;
}
