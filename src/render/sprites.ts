// ============================================================================
// sprites.ts — all procedural sprites, cached by a key built from arguments.
// Everything here is generated in code (pixel strings + canvas drawing ops).
// Nothing is copied from any existing game.
// ============================================================================
import type { Side, Season, Stance, Facing8, CursorKind } from '@/shared/types';
import { TILE_PX, TILE_M } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { createCanvas, ctx2d, putPixelArt, rotate90, rotateSprite, darken } from '@/render/pixelUtil';

const PX_PER_M = TILE_PX / TILE_M; // 5 px/m

// --------------------------------------------------------------- cache -----
const cache = new Map<string, HTMLCanvasElement>();
function cached(key: string, build: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) {
    c = build();
    cache.set(key, c);
  }
  return c;
}

// ============================================================================
// SOLDIERS
// ============================================================================
const OUTLINE = '#1a1a14';
const BLOOD = '#5a1a16';
const WINTER_SMOCK = '#d8d8d2';
const WINTER_SMOCK_SHADE = '#c2c2bc';

const SIDE_UNIFORM: Record<Side, { u: string; s: string; h: string; hi: string }> = {
  german: { u: '#5b6349', s: '#4a5139', h: '#4b5342', hi: '#9a9f94' },
  soviet: { u: '#7a6f3f', s: '#655c34', h: '#66603a', hi: '#8f8760' },
};

function soldierColors(side: Side, season: Season, dead: boolean): Record<string, string> {
  const base = SIDE_UNIFORM[side];
  let u = base.u, s = base.s;
  if (season === 'winter') { u = WINTER_SMOCK; s = WINTER_SMOCK_SHADE; }
  let h = base.h, hi = base.hi, o = OUTLINE;
  if (dead) {
    u = darkenHex(u, 0.55);
    s = darkenHex(s, 0.55);
    h = darkenHex(h, 0.55);
    hi = darkenHex(hi, 0.6);
  }
  return { O: o, H: h, h: hi, U: u, S: s, B: BLOOD };
}

/** Cheap hex darken used for the small color-map entries above. */
function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => Math.round(v * factor).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

// 12x12, base "north" (facing up) orientation.
const STAND_F0 = [
  '....OOOO....',
  '...OHHHHO...',
  '...OHhHHO...',
  '...OHHHHOOW.',
  '..OOSUUSOW..',
  '..OS.UU.SO..',
  '..O..UU..O..',
  '..O..UU..O..',
  '..OSUUUUSO..',
  '..OOSUUSOO..',
  '...O.UU.O...',
  '....OOOO....',
];
const STAND_F1 = [
  '....OOOO....',
  '...OHHHHO...',
  '...OHhHHO...',
  '...OHHHHOOW.',
  '..OOSUUSOW..',
  '..OS.UU.SO..',
  '..O..UU..O..',
  '..O..UU..O..',
  '..OSUUUUSO..',
  '..OOSUUSOO..',
  '..O..UU..O..',
  '...OO..OO...',
];
const CROUCH_F0 = [
  '....OOOO....',
  '...OHHHHO...',
  '..OHhHHHHO..',
  '..OHHHHHHO..',
  '..OOSUUSOO..',
  '..OSUUUUSO..',
  '..O.UUUU.O..',
  '..OOUUUUOO..',
  '...O.UU.O...',
  '...OOOOOO...',
  '............',
  '............',
];
const CROUCH_F1 = [
  '....OOOO....',
  '...OHHHHO...',
  '..OHhHHHHO..',
  '..OHHHHHHO..',
  '..OOSUUSOO..',
  '..OSUUUUSO..',
  '..O.UUUU.O..',
  '..OOUUUUOO..',
  '....O.UU.O..',
  '....OOOOOO..',
  '............',
  '............',
];
// 8 wide x 14 tall, lying along the north-south axis (base orientation).
const PRONE_ART = [
  '..OOOO..',
  '.OHhHHO.',
  '.OHHHHO.',
  '..OSSO..',
  '.OSUUSO.',
  '.OSUUSO.',
  '.OSUUSO.',
  '.OSUUSO.',
  '.OSUUSO.',
  '.OSUUSO.',
  '.OSUUSO.',
  '..OUUO..',
  '..OUUO..',
  '...OO...',
];

function fixWidth(rows: string[], w: number): string[] {
  return rows.map((r) => (r.length === w ? r : r.length < w ? r.padEnd(w, '.') : r.slice(0, w)));
}

function artCanvas(art: string[], colors: Record<string, string>, w: number, h: number): HTMLCanvasElement {
  const rows = fixWidth(art, w).slice(0, h);
  while (rows.length < h) rows.push('.'.repeat(w));
  const c = createCanvas(w, h);
  putPixelArt(c, rows, colors);
  return c;
}

function buildSoldierBase(side: Side, season: Season, stance: Stance | 'dead', frame: 0 | 1): HTMLCanvasElement {
  const dead = stance === 'dead';
  const colors = soldierColors(side, season, dead);
  if (stance === 'prone' || dead) {
    const c = artCanvas(PRONE_ART, colors, 8, 14);
    if (dead) {
      const ctx = ctx2d(c);
      ctx.fillStyle = BLOOD;
      ctx.fillRect(3, 6, 1, 1);
      ctx.fillRect(4, 8, 1, 1);
    }
    return c;
  }
  if (stance === 'crouching') return artCanvas(frame === 0 ? CROUCH_F0 : CROUCH_F1, colors, 12, 12);
  return artCanvas(frame === 0 ? STAND_F0 : STAND_F1, colors, 12, 12);
}

function orientSprite(base: HTMLCanvasElement, facing: Facing8): HTMLCanvasElement {
  if (facing % 2 === 0) return rotate90(base, facing / 2);
  return rotateSprite(base, (facing * Math.PI) / 4);
}

export function getSoldierSprite(
  side: Side,
  season: Season,
  stance: Stance | 'dead',
  facing: Facing8,
  frame: 0 | 1,
): HTMLCanvasElement {
  const key = `soldier|${side}|${season}|${stance}|${facing}|${frame}`;
  return cached(key, () => orientSprite(buildSoldierBase(side, season, stance, frame), facing));
}

// ============================================================================
// VEHICLES
// ============================================================================
const DIMENSIONS: Record<string, { lengthM: number; widthM: number }> = {
  pziii_j: { lengthM: 5.5, widthM: 2.9 },
  pziv_f1: { lengthM: 5.9, widthM: 2.9 },
  pziv_h: { lengthM: 5.9, widthM: 2.9 },
  stug_iii_g: { lengthM: 5.4, widthM: 2.9 },
  panther_g: { lengthM: 6.9, widthM: 3.4 },
  tiger_i: { lengthM: 6.3, widthM: 3.6 },
  sdkfz_251: { lengthM: 5.8, widthM: 2.1 },
  marder_iii: { lengthM: 5.8, widthM: 2.2 },
  t26: { lengthM: 4.6, widthM: 2.4 },
  bt7: { lengthM: 5.7, widthM: 2.2 },
  t34_76: { lengthM: 6.7, widthM: 3.0 },
  t34_85: { lengthM: 6.7, widthM: 3.0 },
  kv1: { lengthM: 6.8, widthM: 3.3 },
  is2: { lengthM: 6.8, widthM: 3.1 },
  t70: { lengthM: 4.3, widthM: 2.3 },
  su76: { lengthM: 5.0, widthM: 2.7 },
  su85: { lengthM: 6.1, widthM: 3.0 },
};
let vehicleDims: Record<string, { lengthM: number; widthM: number }> = { ...DIMENSIONS };

/** Allow the game to push real VehicleDef dimensions in once src/data/units is loaded. */
export function setVehicleDims(dims: Record<string, { lengthM: number; widthM: number }>): void {
  vehicleDims = { ...vehicleDims, ...dims };
}

function getDims(defId: string): { lengthM: number; widthM: number } {
  return vehicleDims[defId] ?? { lengthM: 6, widthM: 3 };
}

const NO_TURRET = new Set(['stug_iii_g', 'marder_iii', 'su76', 'su85']);
const GERMAN_IDS = new Set(['pziii_j', 'pziv_f1', 'pziv_h', 'stug_iii_g', 'panther_g', 'tiger_i', 'sdkfz_251', 'marder_iii']);
const EARLY_GERMAN = new Set(['pziii_j', 'pziv_f1', 'sdkfz_251']);
const SOVIET_IDS = new Set(['t26', 'bt7', 't34_76', 't34_85', 'kv1', 'is2', 't70', 'su76', 'su85']);

function vehicleSide(defId: string): Side | null {
  if (GERMAN_IDS.has(defId)) return 'german';
  if (SOVIET_IDS.has(defId)) return 'soviet';
  return null;
}

function hullColor(defId: string): { base: string; dark: string; light: string } {
  const side = vehicleSide(defId);
  if (side === 'soviet') return { base: '#4f5b34', dark: '#3d4728', light: '#5f6d40' };
  if (side === 'german') {
    if (EARLY_GERMAN.has(defId)) return { base: '#4c5057', dark: '#3a3d42', light: '#5c6068' };
    return { base: '#a08c5a', dark: '#8a7849', light: '#b09c68' };
  }
  return { base: '#6a6a62', dark: '#54544e', light: '#7a7a70' };
}

function drawTracks(ctx: CanvasRenderingContext2D, w: number, h: number, dark: string, tread: string): void {
  const stripW = Math.max(2, Math.round(w * 0.14));
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, stripW, h);
  ctx.fillRect(w - stripW, 0, stripW, h);
  ctx.fillStyle = tread;
  for (let y = 1; y < h - 1; y += 3) {
    ctx.fillRect(0, y, stripW, 1);
    ctx.fillRect(w - stripW, y + 1, stripW, 1);
  }
}

function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.strokeStyle = '#e8e8e0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 2, cy - 2); ctx.lineTo(cx + 2, cy + 2);
  ctx.moveTo(cx + 2, cy - 2); ctx.lineTo(cx - 2, cy + 2);
  ctx.stroke();
  ctx.strokeRect(cx - 2.5, cy - 2.5, 5, 5);
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = '#c8402c';
  ctx.strokeStyle = '#e8e8e0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const a2 = a + Math.PI / 5;
    const x1 = cx + Math.cos(a) * 3, y1 = cy + Math.sin(a) * 3;
    const x2 = cx + Math.cos(a2) * 1.2, y2 = cy + Math.sin(a2) * 1.2;
    if (i === 0) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function buildHull(defId: string, state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  const { lengthM, widthM } = getDims(defId);
  const w = Math.max(6, Math.round(widthM * PX_PER_M));
  const h = Math.max(10, Math.round(lengthM * PX_PER_M));
  const colors = hullColor(defId);
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const isHalftrack = defId === 'sdkfz_251';

  // Base hull.
  ctx.fillStyle = colors.base;
  ctx.fillRect(1, 1, w - 2, h - 2);

  drawTracks(ctx, w, h, colors.dark, colors.light);

  if (isHalftrack) {
    // Open top hull: only rear half has tracks; front has 2 road wheels.
    ctx.fillStyle = colors.dark;
    ctx.fillRect(Math.round(w * 0.2), 1, Math.round(w * 0.6), Math.round(h * 0.4));
    ctx.fillStyle = colors.base;
    const wheelR = Math.max(1, Math.round(w * 0.14));
    ctx.beginPath(); ctx.arc(Math.round(w * 0.28), Math.round(h * 0.18), wheelR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(Math.round(w * 0.72), Math.round(h * 0.18), wheelR, 0, Math.PI * 2); ctx.fill();
  } else {
    // Glacis: lighter shading toward the front (top, north).
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.18), 1, Math.round(w * 0.64), Math.round(h * 0.22));
    // Engine deck hatches near the rear (bottom).
    const hatchW = Math.max(1, Math.round(w * 0.16));
    const hatchY = h - Math.round(h * 0.16);
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.28), hatchY, hatchW, 2);
    ctx.fillRect(w - Math.round(w * 0.28) - hatchW, hatchY, hatchW, 2);
  }

  // Markings, centred on the hull side.
  const side = vehicleSide(defId);
  if (side === 'german') drawCross(ctx, w / 2, Math.round(h * 0.55));
  else if (side === 'soviet') drawStar(ctx, w / 2, Math.round(h * 0.55));

  // Outline.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (state === 'knockedOut') {
    let out = darken(c, 0.45);
    const octx = ctx2d(out);
    octx.fillStyle = '#100f0c';
    octx.beginPath();
    octx.ellipse(w * 0.55, h * 0.4, Math.max(2, w * 0.22), Math.max(2, h * 0.14), 0.4, 0, Math.PI * 2);
    octx.fill();
    return out;
  }
  return c;
}

function buildTurret(defId: string, state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  if (NO_TURRET.has(defId)) return createCanvas(1, 1);
  const { lengthM, widthM } = getDims(defId);
  const hullW = Math.max(6, Math.round(widthM * PX_PER_M));
  const hullH = Math.max(10, Math.round(lengthM * PX_PER_M));
  const tw = Math.max(5, Math.round(hullW * 0.62));
  const barrelLen = Math.max(4, Math.round(hullH * 0.6));
  const th = Math.max(6, Math.round(hullH * 0.34)) + barrelLen;
  const c = createCanvas(tw, th);
  const ctx = ctx2d(c);
  const colors = hullColor(defId);
  const bodyH = th - barrelLen;
  const bodyCy = th - bodyH / 2;

  // Barrel, extending "north" from the turret body toward the top of the canvas.
  ctx.strokeStyle = colors.dark;
  ctx.lineWidth = Math.max(1, Math.round(tw * 0.14));
  ctx.beginPath();
  ctx.moveTo(tw / 2, th - bodyH * 0.4);
  ctx.lineTo(tw / 2, 0);
  ctx.stroke();

  // Turret body (oval).
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse(tw / 2, bodyCy, tw / 2 - 0.5, bodyH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Cupola.
  ctx.fillStyle = colors.light;
  ctx.beginPath();
  ctx.arc(tw / 2 + tw * 0.18, bodyCy + bodyH * 0.15, Math.max(1, tw * 0.14), 0, Math.PI * 2);
  ctx.fill();

  if (state === 'knockedOut') return darken(c, 0.45);
  return c;
}

export function getVehicleSprite(defId: string, part: 'hull' | 'turret', state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  const key = `vehicle|${defId}|${part}|${state}`;
  return cached(key, () => (part === 'hull' ? buildHull(defId, state) : buildTurret(defId, state)));
}

// ============================================================================
// FLAGS
// ============================================================================
export function getFlagSprite(owner: Side | null): HTMLCanvasElement {
  const key = `flag|${owner ?? 'neutral'}`;
  return cached(key, () => {
    const c = createCanvas(10, 14);
    const ctx = ctx2d(c);
    ctx.fillStyle = '#3a3020';
    ctx.fillRect(1, 1, 1, 12);
    const fx = 2, fy = 1, fw = 8, fh = 6;
    if (owner === 'german') {
      ctx.fillStyle = '#100f0c'; ctx.fillRect(fx, fy, fw, 2);
      ctx.fillStyle = '#e8e8e0'; ctx.fillRect(fx, fy + 2, fw, 2);
      ctx.fillStyle = '#c8402c'; ctx.fillRect(fx, fy + 4, fw, 2);
      ctx.fillStyle = '#100f0c';
      ctx.fillRect(fx + 3, fy + 2, 2, 2);
      ctx.fillRect(fx + 2, fy + 3, 4, 1);
    } else if (owner === 'soviet') {
      ctx.fillStyle = '#c8402c'; ctx.fillRect(fx, fy, fw, fh);
      ctx.fillStyle = '#e0c04a'; ctx.fillRect(fx + 1, fy + 2, 2, 2);
    } else {
      ctx.fillStyle = '#e8e8e0'; ctx.fillRect(fx, fy, fw, fh);
      ctx.strokeStyle = '#8a8a82'; ctx.lineWidth = 1; ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
    }
    ctx.strokeStyle = OUTLINE;
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
    return c;
  });
}

// ============================================================================
// TEAM ICONS — 12x12, transparent bg, gray/white glyph with dark outline.
// ============================================================================
const ICON_FILL = '#d8d8d2';
const ICON_OUTLINE = '#1a1a14';

function iconStroke(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = ICON_OUTLINE;
  ctx.lineWidth = 1;
}

function buildIcon(id: string): HTMLCanvasElement {
  const c = createCanvas(12, 12);
  const ctx = ctx2d(c);
  ctx.fillStyle = ICON_FILL;
  iconStroke(ctx);
  switch (id) {
    case 'rifle':
      ctx.beginPath(); ctx.moveTo(2, 9); ctx.lineTo(10, 3); ctx.stroke();
      ctx.fillRect(2, 8, 2, 2); // stock
      ctx.fillRect(8, 2, 1, 2); // barrel tip
      break;
    case 'smg':
      ctx.beginPath(); ctx.moveTo(3, 8); ctx.lineTo(9, 4); ctx.stroke();
      ctx.fillRect(3, 7, 2, 2);
      ctx.fillRect(6, 5, 1, 3); // magazine
      break;
    case 'mg':
      ctx.beginPath(); ctx.moveTo(2, 8); ctx.lineTo(10, 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4, 10); ctx.lineTo(6, 8); ctx.moveTo(8, 10); ctx.lineTo(6, 8); ctx.stroke(); // bipod
      break;
    case 'mortar':
      ctx.beginPath(); ctx.moveTo(4, 10); ctx.lineTo(8, 2); ctx.lineTo(9, 3); ctx.lineTo(5, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillRect(2, 9, 6, 2); // baseplate
      break;
    case 'atgun':
      ctx.fillRect(2, 8, 3, 3); // shield
      ctx.beginPath(); ctx.moveTo(4, 8); ctx.lineTo(10, 3); ctx.stroke();
      break;
    case 'sniper':
      ctx.beginPath(); ctx.moveTo(2, 9); ctx.lineTo(10, 3); ctx.stroke();
      ctx.beginPath(); ctx.arc(6, 5, 1.6, 0, Math.PI * 2); ctx.stroke(); // scope
      break;
    case 'atteam':
      ctx.fillRect(2, 6, 8, 2);
      ctx.beginPath(); ctx.moveTo(9, 5); ctx.lineTo(11, 7); ctx.lineTo(9, 9); ctx.closePath(); ctx.fill();
      break;
    case 'tank':
      ctx.fillRect(2, 3, 8, 6); // hull
      ctx.strokeRect(2.5, 3.5, 7, 5);
      ctx.beginPath(); ctx.arc(6, 6, 1.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // turret
      ctx.beginPath(); ctx.moveTo(6, 6); ctx.lineTo(6, 1); ctx.stroke(); // barrel
      break;
    case 'spg':
      ctx.fillRect(2, 3, 8, 6);
      ctx.strokeRect(2.5, 3.5, 7, 5);
      ctx.beginPath(); ctx.moveTo(6, 3); ctx.lineTo(6, 0.5); ctx.stroke();
      break;
    case 'halftrack':
      ctx.fillRect(2, 4, 8, 5);
      ctx.strokeRect(2.5, 4.5, 7, 4);
      ctx.beginPath(); ctx.arc(4, 9, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(8, 9, 1.2, 0, Math.PI * 2); ctx.fill();
      break;
    case 'command':
      drawStarIcon(ctx, 6, 6, 4);
      break;
    case 'engineer':
      ctx.beginPath(); ctx.moveTo(2, 3); ctx.lineTo(9, 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(9, 3); ctx.lineTo(2, 10); ctx.stroke();
      break;
    default:
      ctx.strokeRect(2.5, 2.5, 7, 7);
  }
  return c;
}

function drawStarIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const a2 = a + Math.PI / 5;
    const x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
    const x2 = cx + Math.cos(a2) * (r * 0.42), y2 = cy + Math.sin(a2) * (r * 0.42);
    if (i === 0) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

export function getTeamIcon(iconId: string): HTMLCanvasElement {
  return cached(`icon|${iconId}`, () => buildIcon(iconId));
}

// ============================================================================
// CURSORS — 16x16, hotspot at (0,0) except crosshair (8,8).
// ============================================================================
function buildCursor(kind: CursorKind): HTMLCanvasElement {
  const c = createCanvas(16, 16);
  const ctx = ctx2d(c);
  ctx.lineWidth = 1;
  switch (kind) {
    case 'arrow': {
      const pts: [number, number][] = [[0, 0], [0, 12], [3, 9], [5, 14], [7, 13], [5, 8], [10, 8]];
      ctx.fillStyle = '#f0f0ec';
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'crosshair': {
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(8, 5);
      ctx.moveTo(8, 11); ctx.lineTo(8, 16);
      ctx.moveTo(0, 8); ctx.lineTo(5, 8);
      ctx.moveTo(11, 8); ctx.lineTo(16, 8);
      ctx.stroke();
      ctx.strokeStyle = '#f0f0ec';
      ctx.beginPath();
      ctx.moveTo(8, 1); ctx.lineTo(8, 5);
      ctx.moveTo(8, 11); ctx.lineTo(8, 15);
      ctx.moveTo(1, 8); ctx.lineTo(5, 8);
      ctx.moveTo(11, 8); ctx.lineTo(15, 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(8, 8, 1, 0, Math.PI * 2);
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
      break;
    }
    case 'hand': {
      ctx.fillStyle = '#f0f0ec';
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(3, 2); ctx.lineTo(3, 10); ctx.lineTo(1, 12); ctx.lineTo(1, 14); ctx.lineTo(9, 14);
      ctx.lineTo(11, 12); ctx.lineTo(11, 6); ctx.lineTo(9, 5); ctx.lineTo(9, 3); ctx.lineTo(7, 2);
      ctx.lineTo(7, 1); ctx.lineTo(5, 1); ctx.lineTo(5, 2); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(5, 4); ctx.lineTo(5, 9); ctx.moveTo(7, 4); ctx.lineTo(7, 9); ctx.moveTo(9, 5); ctx.lineTo(9, 9);
      ctx.stroke();
      break;
    }
    case 'no': {
      ctx.strokeStyle = '#c8402c';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(8, 8, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4, 4); ctx.lineTo(12, 12); ctx.stroke();
      break;
    }
    case 'move': {
      ctx.fillStyle = '#f0f0ec';
      ctx.strokeStyle = OUTLINE;
      const arrow = (dx: number, dy: number) => {
        ctx.save();
        ctx.translate(8, 8);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.beginPath();
        ctx.moveTo(7, 0); ctx.lineTo(3, -3); ctx.lineTo(3, 3); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      };
      arrow(1, 0); arrow(-1, 0); arrow(0, 1); arrow(0, -1);
      ctx.beginPath(); ctx.moveTo(2, 8); ctx.lineTo(14, 8); ctx.moveTo(8, 2); ctx.lineTo(8, 14); ctx.stroke();
      break;
    }
    case 'wait': {
      ctx.fillStyle = '#f0f0ec';
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(3, 2); ctx.lineTo(13, 2); ctx.lineTo(13, 3); ctx.lineTo(8, 8); ctx.lineTo(13, 13); ctx.lineTo(13, 14);
      ctx.lineTo(3, 14); ctx.lineTo(3, 13); ctx.lineTo(8, 8); ctx.lineTo(3, 3); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(4, 4, 8, 1);
      ctx.fillRect(4, 11, 8, 1);
      break;
    }
  }
  return c;
}

export function getCursorSprite(kind: CursorKind): HTMLCanvasElement {
  return cached(`cursor|${kind}`, () => buildCursor(kind));
}

// ============================================================================
// SMOKE PUFF
// ============================================================================
export function getSmokePuff(size: number): HTMLCanvasElement {
  return cached(`smoke|${size}`, () => {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d')!; // keep smoothing on: this is a soft radial blob, not pixel art
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(190,190,185,0.65)');
    grad.addColorStop(0.6, 'rgba(160,160,155,0.35)');
    grad.addColorStop(1, 'rgba(140,140,135,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
    return c;
  });
}

// ============================================================================
// TREES — 14x14 canopy with shadow, 4 variants x season.
// ============================================================================
const TREE_COLORS: Record<Season, { canopy: string[]; hi: string; branch: string }> = {
  summer: { canopy: ['#2f4a26', '#355230', '#2a4020'], hi: '#5a7a48', branch: '#4a3a24' },
  autumn: { canopy: ['#8a5a26', '#a06e2a', '#c08a2c'], hi: '#d8a840', branch: '#5a3f20' },
  winter: { canopy: ['#5a5850', '#635f56', '#4e4c46'], hi: '#8a8880', branch: '#4a4640' },
};

function buildTree(variant: number, season: Season): HTMLCanvasElement {
  const c = createCanvas(14, 14);
  const ctx = ctx2d(c);
  const colors = TREE_COLORS[season];
  const cx = 7, cy = 6;

  // Shadow, offset below-right.
  ctx.fillStyle = 'rgba(20,20,16,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx + 2, cy + 3, 5, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  if (season === 'winter') {
    // Bare branches: a few sparse dark strokes over a thin crown.
    ctx.strokeStyle = colors.branch;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (hash2(variant, i, 7) - 0.5) * 2.2;
      const len = 3 + hash2(variant, i, 11) * 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 2);
      ctx.lineTo(cx + Math.cos(a) * len, cy + 2 + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.fillStyle = colors.canopy[0];
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  // Irregular canopy blob: several overlapping circles seeded per-variant.
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + hash2(variant, i, 1) * 0.6;
    const dist = 1.5 + hash2(variant, i, 2) * 2;
    const rad = 2.5 + hash2(variant, i, 3) * 1.8;
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist * 0.8;
    ctx.fillStyle = colors.canopy[i % colors.canopy.length];
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = colors.canopy[0];
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // Two highlight pixels.
  ctx.fillStyle = colors.hi;
  ctx.fillRect(cx - 2, cy - 3, 1, 1);
  ctx.fillRect(cx + 1, cy - 2, 1, 1);

  ctx.strokeStyle = 'rgba(20,20,16,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.7, 0, Math.PI * 2);
  ctx.stroke();
  return c;
}

export function getTreeSprite(variant: number, season: Season): HTMLCanvasElement {
  return cached(`tree|${variant}|${season}`, () => buildTree(variant, season));
}
