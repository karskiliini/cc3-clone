// ============================================================================
// sprites.ts — all procedural sprites, cached by a key built from arguments.
// Everything here is generated in code (pixel strings + canvas drawing ops).
// Nothing is copied from any existing game.
// ============================================================================
import type { Side, Season, Stance, Facing8, CursorKind } from '@/shared/types';
import { TILE_PX, TILE_M } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { createCanvas, ctx2d, putPixelArt, rotate90, rotateSprite, darken, scaleArt, setArtPixel } from '@/render/pixelUtil';

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
const WEAPON = '#3a3a38';
const STOCK = '#6b4a2c';
const SKIN = '#c9a37c';
const WINTER_SMOCK = '#e0e0d8';
const WINTER_SMOCK_SHADE = '#a9aaa2';
const WINTER_HELMET_COVER = '#d0d0c8';

// u = tunic, s = tunic edge, h = helmet base, hi = helmet highlight.
const SIDE_UNIFORM: Record<Side, { u: string; s: string; h: string; hi: string }> = {
  german: { u: '#6a7256', s: '#4d5440', h: '#555c48', hi: '#7d8570' },
  soviet: { u: '#8b7d4a', s: '#655a33', h: '#6d6540', hi: '#8f875a' },
};

function soldierColors(side: Side, season: Season, dead: boolean): Record<string, string> {
  const base = SIDE_UNIFORM[side];
  let u = base.u, s = base.s;
  let h = base.h, hi = base.hi;
  if (season === 'winter') {
    u = WINTER_SMOCK;
    s = WINTER_SMOCK_SHADE;
    if (side === 'soviet') { h = WINTER_HELMET_COVER; hi = '#e8e8e0'; }
  }
  let weapon = WEAPON, stock = STOCK, skin = SKIN, blood = BLOOD;
  if (dead) {
    u = darkenHex(u, 0.55);
    s = darkenHex(s, 0.55);
    h = darkenHex(h, 0.55);
    hi = darkenHex(hi, 0.55);
    weapon = darkenHex(weapon, 0.7);
    stock = darkenHex(stock, 0.6);
    skin = darkenHex(skin, 0.65);
  }
  const rim = darkenHex(h, 0.6);
  const specular = lightenHex(hi, 0.55);
  return { O: rim, h: hi, H: h, P: specular, U: u, S: s, W: weapon, K: stock, G: skin, B: blood };
}

/** Cheap hex darken used for the small color-map entries above. */
function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => Math.round(v * factor).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

/** Cheap hex lighten (mixes toward white) used for the helmet specular pixel. */
function lightenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => Math.round(v + (255 - v) * factor).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

// Helmet rim color map key 'O' is intentionally set to the darker helmet
// color itself (helmets read darker than the tunic per spec), while the
// highlight lives on 'h' and the flat mid-tone on 'H'.
function helmetColors(colors: Record<string, string>): Record<string, string> {
  return colors;
}

// Base "north" (facing up) art, hand-authored at 12x12 / 8x14 and scaled 2x
// (to 24x24 / 16x28) to match the doubled map scale (10 px/m, TILE_PX 20),
// then hand-touched-up (helmet specular pixel; a dedicated splayed-limb dead
// pose distinct from prone). 'P' = specular highlight pixel (4th helmet tone,
// brightest, placed at the NW rim per the reference screenshots).
const STAND_F0_BASE = [
  '............',
  '....OOO..W..',
  '...OhHHO.W..',
  '...OHHHO.W..',
  '....OOO..W..',
  '...SUUUS.W..',
  '...SUUUSKG..',
  '....UUU.....',
  '...SUUUS....',
  '....US......',
  '....US......',
  '............',
];
const STAND_F1_BASE = [
  '............',
  '....OOO..W..',
  '...OhHHO.W..',
  '...OHHHO.W..',
  '....OOO..W..',
  '...SUUUS.W..',
  '...SUUUSKG..',
  '....UUU.....',
  '...SUUUS....',
  '....SU......',
  '....SU......',
  '............',
];
const CROUCH_F0_BASE = [
  '............',
  '............',
  '............',
  '....OOOOO...',
  '...OhHHHHO..',
  '...OHHHHHO..',
  '...SUUUUUS..',
  '....SUUUS...',
  '....UUUUU...',
  '.....UU.....',
  '............',
  '............',
];
const CROUCH_F1_BASE = [
  '............',
  '............',
  '............',
  '....OOOOO...',
  '...OhHHHHO..',
  '...OHHHHHO..',
  '...SUUUUUS..',
  '....SUUUS...',
  '....UUUUU...',
  '....U.U.....',
  '............',
  '............',
];
// 8 wide x 14 tall, lying along the north-south axis (base orientation, head
// north). Weapon tip pokes 2px beyond the helmet at the top of the canvas.
const PRONE_ART_BASE = [
  '....W...',
  '....W...',
  '..OOOO..',
  '.OhHHHO.',
  '.OHHHHO.',
  '.SSUUSS.',
  '.SUUUUS.',
  'GSUUUSG.',
  '.SUUUUS.',
  '.SUUUUS.',
  '.SUUUUS.',
  '..UUUU..',
  '..UUUU..',
  '..SUUS..',
];
// Dead: distinct splayed-limb pose (no weapon, legs apart, arms out) rather
// than a recolored prone — matches the reference's dead soldiers, which read
// visibly different from a crawling/prone figure.
const DEAD_ART_BASE = [
  '........',
  '..OOOO..',
  '.OhHHHO.',
  '.OHHHHO.',
  '.SSUUSS.',
  'GSUUUUSG',
  '.SUUUUS.',
  '.SUUUUS.',
  '.SUUUUS.',
  '.UU..UU.',
  '.UU..UU.',
  '.U....U.',
  '.U....U.',
  '........',
];

const ART_SCALE = 2;
function scaled(art: string[]): string[] {
  return scaleArt(art, ART_SCALE);
}
// Specular pixel: the top-left-most helmet rim pixel, per art layout above.
const STAND_F0 = setArtPixel(scaled(STAND_F0_BASE), 8, 2, 'P');
const STAND_F1 = setArtPixel(scaled(STAND_F1_BASE), 8, 2, 'P');
const CROUCH_F0 = setArtPixel(scaled(CROUCH_F0_BASE), 8, 6, 'P');
const CROUCH_F1 = setArtPixel(scaled(CROUCH_F1_BASE), 8, 6, 'P');
const PRONE_ART = setArtPixel(scaled(PRONE_ART_BASE), 4, 4, 'P');
const DEAD_ART = setArtPixel(scaled(DEAD_ART_BASE), 4, 2, 'P');
const STAND_W = STAND_F0[0].length, STAND_H = STAND_F0.length;
const CROUCH_W = CROUCH_F0[0].length, CROUCH_H = CROUCH_F0.length;
const PRONE_W = PRONE_ART[0].length, PRONE_H = PRONE_ART.length;

function fixWidth(rows: string[], w: number): string[] {
  return rows.map((r) => (r.length === w ? r : r.length < w ? r.padEnd(w, '.') : r.slice(0, w)));
}

/** Paint pixel art onto a fresh canvas with a soft 30%-alpha drop shadow baked
 * in, offset (+1,+1) from the figure — cheaper and more consistent than an
 * outline around the whole silhouette. */
function artCanvas(art: string[], colors: Record<string, string>, w: number, h: number): HTMLCanvasElement {
  const rows = fixWidth(art, w).slice(0, h);
  while (rows.length < h) rows.push('.'.repeat(w));
  const c = createCanvas(w, h);
  const shadowColors: Record<string, string> = {};
  for (const k of Object.keys(colors)) shadowColors[k] = 'rgba(10,10,8,0.3)';
  putPixelArt(c, rows, shadowColors, 1, 1);
  putPixelArt(c, rows, colors, 0, 0);
  return c;
}

function buildSoldierBase(side: Side, season: Season, stance: Stance | 'dead', frame: 0 | 1): HTMLCanvasElement {
  const dead = stance === 'dead';
  const colors = helmetColors(soldierColors(side, season, dead));
  if (dead) {
    const c = artCanvas(DEAD_ART, colors, PRONE_W, PRONE_H);
    const ctx = ctx2d(c);
    ctx.fillStyle = colors.B;
    ctx.fillRect(PRONE_W / 2 - 3, PRONE_H * 0.58, 6, 2);
    ctx.fillRect(PRONE_W / 2 - 2, PRONE_H * 0.68, 4, 2);
    return c;
  }
  if (stance === 'prone') return artCanvas(PRONE_ART, colors, PRONE_W, PRONE_H);
  if (stance === 'crouching') return artCanvas(frame === 0 ? CROUCH_F0 : CROUCH_F1, colors, CROUCH_W, CROUCH_H);
  return artCanvas(frame === 0 ? STAND_F0 : STAND_F1, colors, STAND_W, STAND_H);
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
// Dimensions must mirror src/data/units.ts VEHICLE_DEFS exactly (setVehicleDims
// pushes the real values in at startup; this table is the fallback/default).
const DIMENSIONS: Record<string, { lengthM: number; widthM: number }> = {
  pz3j: { lengthM: 5.6, widthM: 2.9 },
  pz4f1: { lengthM: 5.9, widthM: 2.9 },
  pz4gh: { lengthM: 5.9, widthM: 2.9 },
  stug3g: { lengthM: 5.4, widthM: 2.9 },
  panther: { lengthM: 6.9, widthM: 3.4 },
  tiger: { lengthM: 6.3, widthM: 3.6 },
  sdkfz251: { lengthM: 5.8, widthM: 2.1 },
  marder3: { lengthM: 4.65, widthM: 2.95 },
  t26: { lengthM: 4.6, widthM: 2.4 },
  bt7: { lengthM: 5.7, widthM: 2.3 },
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

type Family = 'boxy' | 'sloped' | 'casemate' | 'halftrack';
interface VehProfile {
  family: Family;
  barrelFrac: number;
  muzzleBrake?: boolean;
  mantletW?: number;
  skirts?: boolean;
  cupola?: boolean;
  fuelDrums?: boolean;
  wideTracks?: boolean;
  turretWFrac?: number;
  bustleFrac?: number;
}

const VEH_PROFILE: Record<string, VehProfile> = {
  pz3j: { family: 'boxy', barrelFrac: 0.45, cupola: true },
  pz4f1: { family: 'boxy', barrelFrac: 0.3, cupola: true },
  pz4gh: { family: 'boxy', barrelFrac: 0.55, muzzleBrake: true, cupola: true, skirts: true },
  stug3g: { family: 'casemate', barrelFrac: 0 },
  panther: { family: 'sloped', barrelFrac: 0.65, mantletW: 3, cupola: true },
  tiger: { family: 'boxy', barrelFrac: 0.6, muzzleBrake: true, cupola: true, wideTracks: true, turretWFrac: 0.5 },
  sdkfz251: { family: 'halftrack', barrelFrac: 0 },
  marder3: { family: 'casemate', barrelFrac: 0 },
  t26: { family: 'sloped', barrelFrac: 0.4, turretWFrac: 0.42 },
  bt7: { family: 'sloped', barrelFrac: 0.45, wideTracks: true },
  t34_76: { family: 'sloped', barrelFrac: 0.55 },
  t34_85: { family: 'sloped', barrelFrac: 0.6, bustleFrac: 0.16, turretWFrac: 0.62 },
  kv1: { family: 'boxy', barrelFrac: 0.5, fuelDrums: true, cupola: true },
  is2: { family: 'sloped', barrelFrac: 0.75, muzzleBrake: true, cupola: true },
  t70: { family: 'boxy', barrelFrac: 0.4, turretWFrac: 0.4 },
  su76: { family: 'casemate', barrelFrac: 0 },
  su85: { family: 'casemate', barrelFrac: 0 },
};
const DEFAULT_PROFILE: VehProfile = { family: 'boxy', barrelFrac: 0.5 };

const NO_TURRET = new Set(['stug3g', 'marder3', 'su76', 'su85', 'sdkfz251']);
const GERMAN_IDS = new Set(['pz3j', 'pz4f1', 'pz4gh', 'stug3g', 'panther', 'tiger', 'sdkfz251', 'marder3']);
const EARLY_GERMAN = new Set(['pz3j', 'pz4f1', 'sdkfz251', 'marder3']);
const SOVIET_IDS = new Set(['t26', 'bt7', 't34_76', 't34_85', 'kv1', 'is2', 't70', 'su76', 'su85']);

function vehicleSide(defId: string): Side | null {
  if (GERMAN_IDS.has(defId)) return 'german';
  if (SOVIET_IDS.has(defId)) return 'soviet';
  return null;
}

function profileOf(defId: string): VehProfile {
  return VEH_PROFILE[defId] ?? DEFAULT_PROFILE;
}

function hullColor(defId: string): { base: string; dark: string; light: string } {
  const side = vehicleSide(defId);
  if (side === 'soviet') return { base: '#55613a', dark: '#3d4728', light: '#66734a' };
  if (side === 'german') {
    if (EARLY_GERMAN.has(defId)) return { base: '#4f545c', dark: '#3a3d42', light: '#5f6570' };
    return { base: '#a4905e', dark: '#8a7849', light: '#b8a473' };
  }
  return { base: '#6a6a62', dark: '#54544e', light: '#7a7a70' };
}

function drawTracks(ctx: CanvasRenderingContext2D, w: number, h: number, dark: string, light: string, wide: boolean): void {
  const stripW = Math.max(2, Math.round(w * (wide ? 0.22 : 0.16)));
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, stripW, h);
  ctx.fillRect(w - stripW, 0, stripW, h);
  // Alternating tread dashes.
  ctx.fillStyle = light;
  for (let y = 0; y < h; y += 2) {
    ctx.fillRect(0, y, stripW, 1);
    ctx.fillRect(w - stripW, y + 1, stripW, 1);
  }
  // Round road-wheel dots, 3-5 per side depending on hull length.
  const wheelCount = Math.max(3, Math.min(5, Math.round(h / (wide ? 9 : 7))));
  const r = Math.max(1, stripW * 0.32);
  ctx.fillStyle = light;
  for (let i = 0; i < wheelCount; i++) {
    const cy = (i + 0.5) * (h / wheelCount);
    ctx.beginPath(); ctx.arc(stripW / 2, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(w - stripW / 2, cy, r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawEngineDeck(ctx: CanvasRenderingContext2D, w: number, h: number, colors: { dark: string; light: string }): void {
  const y0 = h - Math.round(h * 0.24);
  ctx.strokeStyle = colors.dark;
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const y = y0 + i * 2;
    if (y >= h - 1) break;
    ctx.beginPath();
    ctx.moveTo(Math.round(w * 0.22), y);
    ctx.lineTo(Math.round(w * 0.78), y);
    ctx.stroke();
  }
  const hatchW = Math.max(1, Math.round(w * 0.18));
  ctx.fillStyle = colors.light;
  ctx.fillRect(Math.round(w / 2 - hatchW / 2), h - Math.round(h * 0.09), hatchW, Math.max(1, Math.round(h * 0.05)));
}

function drawCamoBands(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = '#6c7a4a';
  ctx.lineWidth = Math.max(1, Math.round(w * 0.16));
  ctx.beginPath(); ctx.moveTo(w * 0.08, h * 0.28); ctx.lineTo(w * 0.55, h * 0.02); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w * 0.18, h * 0.78); ctx.lineTo(w * 0.88, h * 0.42); ctx.stroke();
  ctx.restore();
}

function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = '#100f0c';
  ctx.fillRect(cx - 2, cy - 0.5, 4, 1);
  ctx.fillRect(cx - 0.5, cy - 2, 1, 4);
  ctx.strokeStyle = '#e8e8e0';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(cx - 2.5, cy - 2.5, 5, 5);
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = '#c8402c';
  ctx.strokeStyle = '#e8e8e0';
  ctx.lineWidth = 0.6;
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
  const profile = profileOf(defId);
  const colors = hullColor(defId);
  const side = vehicleSide(defId);
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);

  ctx.fillStyle = colors.base;
  ctx.fillRect(1, 1, w - 2, h - 2);

  drawTracks(ctx, w, h, colors.dark, colors.light, !!profile.wideTracks);

  if (profile.family === 'halftrack') {
    // Open-top compartment: rear tracks (already drawn), 2 front road wheels,
    // and a darker interior with a couple of lighter seat pixels.
    ctx.fillStyle = colors.dark;
    ctx.fillRect(Math.round(w * 0.18), 1, Math.round(w * 0.64), Math.round(h * 0.44));
    ctx.fillStyle = colors.base;
    const wheelR = Math.max(1, Math.round(w * 0.16));
    ctx.beginPath(); ctx.arc(Math.round(w * 0.28), Math.round(h * 0.16), wheelR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(Math.round(w * 0.72), Math.round(h * 0.16), wheelR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.3), Math.round(h * 0.24), 1, 1);
    ctx.fillRect(Math.round(w * 0.5), Math.round(h * 0.24), 1, 1);
    ctx.fillRect(Math.round(w * 0.68), Math.round(h * 0.24), 1, 1);
  } else if (profile.family === 'casemate') {
    // Low, open-top (or lightly armoured) superstructure with the gun poking
    // out the front; no turret sprite is drawn for this family.
    const boxH = Math.round(h * 0.5);
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.16), 1, Math.round(w * 0.68), boxH);
    ctx.strokeStyle = colors.dark;
    ctx.strokeRect(Math.round(w * 0.16) + 0.5, 1.5, Math.round(w * 0.68) - 1, boxH - 1);
    const bLen = Math.max(2, Math.round(h * 0.4));
    ctx.strokeStyle = colors.dark;
    ctx.lineWidth = Math.max(1, Math.round(w * 0.09));
    ctx.beginPath();
    ctx.moveTo(w / 2, 3);
    ctx.lineTo(w / 2, -bLen);
    ctx.stroke();
    drawEngineDeck(ctx, w, h, colors);
  } else {
    const glacisH = Math.round(h * 0.22);
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.14), 1, Math.round(w * 0.72), glacisH);
    if (profile.family === 'sloped') {
      ctx.fillStyle = colors.dark;
      ctx.beginPath(); ctx.moveTo(1, 1); ctx.lineTo(1, glacisH + 1); ctx.lineTo(Math.round(w * 0.14), 1); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(w - 1, 1); ctx.lineTo(w - 1, glacisH + 1); ctx.lineTo(w - Math.round(w * 0.14), 1); ctx.closePath(); ctx.fill();
    }
    drawEngineDeck(ctx, w, h, colors);
  }

  if (profile.skirts) {
    ctx.strokeStyle = colors.light;
    ctx.lineWidth = 1;
    const sx = Math.max(2, Math.round(w * 0.16));
    ctx.beginPath();
    ctx.moveTo(sx, 2); ctx.lineTo(sx, h - 2);
    ctx.moveTo(w - sx, 2); ctx.lineTo(w - sx, h - 2);
    ctx.stroke();
  }
  if (profile.fuelDrums) {
    ctx.fillStyle = colors.light;
    ctx.fillRect(Math.round(w * 0.26), h - Math.round(h * 0.16), 2, 3);
    ctx.fillRect(Math.round(w * 0.6), h - Math.round(h * 0.16), 2, 3);
    ctx.strokeStyle = colors.dark;
    ctx.strokeRect(Math.round(w * 0.26) + 0.5, h - Math.round(h * 0.16) + 0.5, 1, 2);
    ctx.strokeRect(Math.round(w * 0.6) + 0.5, h - Math.round(h * 0.16) + 0.5, 1, 2);
  }

  if (side === 'german' && !EARLY_GERMAN.has(defId)) drawCamoBands(ctx, w, h);

  if (side === 'german') { drawCross(ctx, w * 0.28, h * 0.44); drawCross(ctx, w / 2, h * 0.88); }
  else if (side === 'soviet') drawStar(ctx, w * 0.72, h * 0.44);

  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (state === 'knockedOut') {
    const out = darken(c, 0.45);
    const octx = ctx2d(out);
    octx.fillStyle = '#0c0b09';
    octx.fillRect(Math.round(w * 0.35), Math.round(h * 0.35), Math.max(3, Math.round(w * 0.3)), Math.max(3, Math.round(h * 0.2)));
    return out;
  }
  return c;
}

function buildTurret(defId: string, state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  if (NO_TURRET.has(defId)) return createCanvas(1, 1);
  const { lengthM, widthM } = getDims(defId);
  const hullW = Math.max(6, Math.round(widthM * PX_PER_M));
  const hullH = Math.max(10, Math.round(lengthM * PX_PER_M));
  const profile = profileOf(defId);
  const colors = hullColor(defId);
  const side = vehicleSide(defId);
  const tw = Math.max(5, Math.round(hullW * (profile.turretWFrac ?? 0.62)));
  const barrelLen = Math.max(3, Math.round(hullH * profile.barrelFrac));
  const bustle = profile.bustleFrac ? Math.round(hullH * profile.bustleFrac) : 0;
  const bodyH = Math.max(6, Math.round(hullH * 0.32)) + bustle;
  const th = bodyH + barrelLen;
  const c = createCanvas(tw, th);
  const ctx = ctx2d(c);
  const bodyCy = th - bodyH / 2;

  // Barrel, extending "north" from the turret body toward the top of the canvas.
  ctx.strokeStyle = colors.dark;
  ctx.lineWidth = Math.max(1, Math.round(tw * 0.13));
  ctx.beginPath();
  ctx.moveTo(tw / 2, th - bodyH * 0.4);
  ctx.lineTo(tw / 2, 0);
  ctx.stroke();

  if (profile.muzzleBrake) {
    ctx.fillStyle = colors.dark;
    ctx.fillRect(tw / 2 - 1, 0, 2, 2);
  }

  // Turret body (oval).
  ctx.fillStyle = colors.base;
  ctx.beginPath();
  ctx.ellipse(tw / 2, bodyCy, tw / 2 - 0.5, bodyH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (profile.mantletW) {
    ctx.fillStyle = colors.light;
    ctx.fillRect(tw / 2 - profile.mantletW / 2, th - bodyH * 0.62, profile.mantletW, Math.max(2, bodyH * 0.32));
    ctx.strokeStyle = OUTLINE;
    ctx.strokeRect(tw / 2 - profile.mantletW / 2 + 0.5, th - bodyH * 0.62 + 0.5, profile.mantletW - 1, Math.max(1, bodyH * 0.32 - 1));
  }

  if (profile.cupola) {
    ctx.fillStyle = colors.light;
    ctx.beginPath();
    ctx.arc(tw / 2 + tw * 0.18, bodyCy + bodyH * 0.15, Math.max(1, tw * 0.14), 0, Math.PI * 2);
    ctx.fill();
  }

  if (side === 'german' && !EARLY_GERMAN.has(defId)) drawCamoBands(ctx, tw, th);
  if (side === 'german') drawCross(ctx, tw / 2, bodyCy);
  else if (side === 'soviet') drawStar(ctx, tw / 2, bodyCy - bodyH * 0.1);

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
    const c = createCanvas(12, 18);
    const ctx = ctx2d(c);
    // Pole shadow, then pole.
    ctx.fillStyle = 'rgba(10,10,8,0.3)';
    ctx.fillRect(2, 1, 1, 15);
    ctx.fillStyle = '#3a3020';
    ctx.fillRect(1, 1, 1, 15);
    const fx = 2, fy = 1, fw = 9, fh = 8;
    if (owner === 'german') {
      ctx.fillStyle = '#100f0c'; ctx.fillRect(fx, fy, fw, 3);
      ctx.fillStyle = '#e8e8e0'; ctx.fillRect(fx, fy + 3, fw, 2);
      ctx.fillStyle = '#c8402c'; ctx.fillRect(fx, fy + 5, fw, 3);
      ctx.fillStyle = '#100f0c';
      ctx.fillRect(fx + 3, fy + 3, 3, 2);
      ctx.fillRect(fx + 2, fy + 3.5, 5, 1);
    } else if (owner === 'soviet') {
      ctx.fillStyle = '#c8402c'; ctx.fillRect(fx, fy, fw, fh);
      ctx.fillStyle = '#e0c04a'; ctx.fillRect(fx + 1, fy + 3, 3, 3);
    } else {
      ctx.fillStyle = '#e8e8e0'; ctx.fillRect(fx, fy, fw, fh);
      ctx.strokeStyle = '#8a8a82'; ctx.lineWidth = 1; ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
    }
    // Waving notch cut from the trailing edge.
    ctx.clearRect(fx + fw - 1, fy + fh / 2 - 1, 1, 2);
    ctx.strokeStyle = OUTLINE;
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
    return c;
  });
}

// ============================================================================
// TEAM ICONS — 40x26, transparent bg. Side-view silhouettes (dark grey with a
// thin white highlight edge so they read on the dark-maroon HUD panel), per
// the force-pool rows in the original game (ref_cc3_1478.png / 1482.png).
// ============================================================================
const ICON_W = 40, ICON_H = 26;
const ICON_FILL = '#302f2a';
const ICON_EDGE = '#eceae2';
const ICON_GROUND = 22; // baseline y that figures/vehicles stand on

function iconPath(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = ICON_FILL;
  ctx.fill();
  ctx.strokeStyle = ICON_EDGE;
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

/** A small side-view soldier silhouette: helmet, tunic, two legs, standing on
 * `groundY` with its horizontal centre at `x`. `armForward` extends a thin
 * weapon line toward +x; `crouch` shortens/bends the pose for prone/MG use. */
function drawManSide(ctx: CanvasRenderingContext2D, x: number, groundY: number, opts: { crouch?: boolean; prone?: boolean } = {}): void {
  const { crouch, prone } = opts;
  if (prone) {
    // Lying flat, facing +x: helmet bump, long low body.
    const y = groundY - 2;
    iconPath(ctx, [[x - 5, y], [x - 5, y - 2], [x - 2, y - 3.5], [x + 6, y - 2.5], [x + 7, y - 1.5], [x + 7, y]]);
    return;
  }
  const bodyTop = groundY - (crouch ? 8 : 12);
  const bodyBot = groundY - (crouch ? 3 : 4);
  // Helmet: small dome above the body.
  ctx.fillStyle = ICON_FILL;
  ctx.strokeStyle = ICON_EDGE;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(x, bodyTop - 1.6, 2.1, Math.PI, 0);
  ctx.lineTo(x + 2.1, bodyTop + 0.4);
  ctx.lineTo(x - 2.1, bodyTop + 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Tunic (slightly tapered torso).
  iconPath(ctx, [[x - 1.8, bodyTop], [x + 1.8, bodyTop], [x + 2.4, bodyBot], [x - 2.4, bodyBot]]);
  // Legs: a walking stride, one forward one back.
  iconPath(ctx, [[x - 2.2, bodyBot - 0.5], [x - 0.4, bodyBot - 0.5], [x - 1.6, groundY], [x - 3.2, groundY]]);
  iconPath(ctx, [[x + 0.4, bodyBot - 0.5], [x + 2.2, bodyBot - 0.5], [x + 3.4, groundY], [x + 1.8, groundY]]);
}

function drawWeaponLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w = 1.3): void {
  ctx.strokeStyle = ICON_FILL;
  ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.strokeStyle = ICON_EDGE;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

function drawTankSide(ctx: CanvasRenderingContext2D, cx: number, groundY: number, hasTurret: boolean): void {
  const hullW = 26, hullH = 7, hullX = cx - hullW / 2, hullY = groundY - hullH;
  iconPath(ctx, [[hullX, hullY], [hullX + hullW, hullY], [hullX + hullW, groundY], [hullX, groundY]]);
  // Road wheels along the bottom of the hull.
  ctx.fillStyle = ICON_EDGE;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(hullX + 3 + i * ((hullW - 6) / 4), groundY - 1.2, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (hasTurret) {
    const tw = 11, th = 5;
    iconPath(ctx, [[cx - tw / 2, hullY - th], [cx + tw / 2 - 2, hullY - th], [cx + tw / 2, hullY], [cx - tw / 2, hullY]]);
    drawWeaponLine(ctx, cx + tw / 2 - 2, hullY - th + 1.5, hullX + hullW + 6, hullY - th - 1, 1.6);
  } else {
    // Casemate: superstructure biased to the front, gun straight out.
    const bw = 13, bh = 6;
    iconPath(ctx, [[hullX + 3, hullY - bh], [hullX + 3 + bw, hullY - bh + 1], [hullX + 3 + bw, hullY], [hullX + 3, hullY]]);
    drawWeaponLine(ctx, hullX + 3 + bw, hullY - bh + 2, hullX + hullW + 7, hullY - bh + 1.5, 1.6);
  }
}

function buildIcon(id: string): HTMLCanvasElement {
  const c = createCanvas(ICON_W, ICON_H);
  const ctx = ctx2d(c);
  const gy = ICON_GROUND;
  switch (id) {
    case 'rifle':
      drawManSide(ctx, 10, gy); drawWeaponLine(ctx, 12, gy - 13, 20, gy - 17);
      drawManSide(ctx, 21, gy); drawWeaponLine(ctx, 23, gy - 13, 31, gy - 17);
      drawManSide(ctx, 32, gy); drawWeaponLine(ctx, 34, gy - 13, 40, gy - 16);
      break;
    case 'smg':
      drawManSide(ctx, 11, gy); drawWeaponLine(ctx, 13, gy - 12, 19, gy - 14, 1.8);
      drawManSide(ctx, 24, gy); drawWeaponLine(ctx, 26, gy - 12, 32, gy - 14, 1.8);
      break;
    case 'mg':
      drawManSide(ctx, 14, gy, { crouch: true });
      drawWeaponLine(ctx, 16, gy - 9, 30, gy - 10, 1.6);
      // Bipod legs under the muzzle.
      drawWeaponLine(ctx, 28, gy - 10, 26, gy - 2, 1);
      drawWeaponLine(ctx, 28, gy - 10, 31, gy - 2, 1);
      break;
    case 'mortar': {
      const bx = 14;
      drawWeaponLine(ctx, bx, gy, bx + 10, gy - 16, 2.4);
      iconPath(ctx, [[bx - 4, gy], [bx + 6, gy], [bx + 4, gy - 2], [bx - 2, gy - 2]]); // baseplate
      drawManSide(ctx, 27, gy, { crouch: true });
      break;
    }
    case 'atgun':
      iconPath(ctx, [[10, gy - 8], [14, gy - 8], [14, gy - 1], [10, gy - 1]]); // shield
      ctx.fillStyle = ICON_EDGE; ctx.fillRect(11, gy - 6, 2, 4);
      drawWeaponLine(ctx, 14, gy - 6, 30, gy - 10, 1.8);
      ctx.fillStyle = ICON_FILL; ctx.strokeStyle = ICON_EDGE; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(12, gy, 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      drawManSide(ctx, 22, gy, { crouch: true });
      break;
    case 'sniper':
      drawManSide(ctx, 20, gy, { prone: true });
      drawWeaponLine(ctx, 22, gy - 4, 34, gy - 6, 1.4);
      break;
    case 'atteam':
      drawManSide(ctx, 12, gy, { crouch: true });
      drawWeaponLine(ctx, 14, gy - 9, 34, gy - 11, 2.6); // rocket tube on the shoulder
      iconPath(ctx, [[33, gy - 13], [37, gy - 11], [33, gy - 9]]); // warhead tip
      break;
    case 'tank':
      drawTankSide(ctx, ICON_W / 2, gy, true);
      break;
    case 'spg':
      drawTankSide(ctx, ICON_W / 2, gy, false);
      break;
    case 'halftrack': {
      const hullX = 6, hullW = 28, hullY = gy - 7;
      iconPath(ctx, [[hullX, gy - 2], [hullX, hullY], [hullX + 8, hullY - 3], [hullX + hullW, hullY - 3], [hullX + hullW, gy]]);
      ctx.fillStyle = ICON_EDGE;
      // Two rows of tiny helmets in the open crew compartment.
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(hullX + 12 + i * 5, hullY - 4, 1, 0, Math.PI * 2); ctx.fill(); }
      // Front road wheel + rear tracks.
      ctx.beginPath(); ctx.arc(hullX + 4, gy - 1.5, 2, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(hullX + 18 + i * 4, gy - 1.2, 1, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'command':
      drawManSide(ctx, 18, gy);
      drawWeaponLine(ctx, 20, gy - 13, 25, gy - 20, 1.4); // raised arm
      break;
    case 'engineer':
      drawManSide(ctx, 18, gy, { crouch: true });
      drawWeaponLine(ctx, 20, gy - 9, 28, gy - 15, 1.6); // shovel handle
      iconPath(ctx, [[27, gy - 17], [31, gy - 16], [29, gy - 12]]); // shovel blade
      break;
    default:
      ctx.strokeStyle = ICON_EDGE;
      ctx.strokeRect(4.5, 4.5, ICON_W - 9, ICON_H - 9);
  }
  return c;
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
      // Classic 11px arrow silhouette, white fill, black outline.
      const pts: [number, number][] = [[0, 0], [0, 11], [3, 8], [5, 12], [7, 11], [5, 7], [9, 7]];
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
      // 15px crosshair with a 3px centre gap.
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(7.5, 0.5); ctx.lineTo(7.5, 6);
      ctx.moveTo(7.5, 9); ctx.lineTo(7.5, 14.5);
      ctx.moveTo(0.5, 7.5); ctx.lineTo(6, 7.5);
      ctx.moveTo(9, 7.5); ctx.lineTo(14.5, 7.5);
      ctx.stroke();
      ctx.strokeStyle = '#f0f0ec';
      ctx.beginPath();
      ctx.moveTo(7.5, 1); ctx.lineTo(7.5, 6);
      ctx.moveTo(7.5, 9); ctx.lineTo(7.5, 14);
      ctx.moveTo(1, 7.5); ctx.lineTo(6, 7.5);
      ctx.moveTo(9, 7.5); ctx.lineTo(14, 7.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(7.5, 7.5, 1, 0, Math.PI * 2);
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
// TREES — 28x28 canopy with shadow (summer/autumn), 18-26px bare "starburst"
// scrub (winter), 4 variants x season, matching the doubled map scale.
// ============================================================================
const TREE_COLORS: Record<Season, { canopy: string[]; hi: string; branch: string }> = {
  summer: { canopy: ['#2f4a26', '#355230', '#2a4020'], hi: '#5a7a48', branch: '#4a3a24' },
  autumn: { canopy: ['#8a5a26', '#a06e2a', '#c08a2c'], hi: '#d8a840', branch: '#5a3f20' },
  winter: { canopy: ['#6a6156', '#736a5e', '#5c554c'], hi: '#9a9184', branch: '#5c5248' },
};

function buildTree(variant: number, season: Season): HTMLCanvasElement {
  const c = createCanvas(28, 28);
  const ctx = ctx2d(c);
  const colors = TREE_COLORS[season];
  const cx = 14, cy = 13;

  // Shadow, offset below-right.
  ctx.fillStyle = 'rgba(20,20,16,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx + 3, cy + 6, 9, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  if (season === 'winter') {
    // Bare leafless scrub: 6-10 thin branches radiating from a dark centre,
    // each with a couple of thinner twigs branching off partway along.
    const branchCount = 6 + Math.floor(hash2(variant, 0, 3) * 5); // 6-10
    ctx.strokeStyle = colors.branch;
    for (let i = 0; i < branchCount; i++) {
      const a = (i / branchCount) * Math.PI * 2 + hash2(variant, i, 7) * 0.5;
      const len = 9 + hash2(variant, i, 11) * 4; // 9-13 (18-26 span across)
      const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len * 0.9;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // A couple of shorter twigs off the main branch.
      const mx = cx + (ex - cx) * 0.6, my = cy + (ey - cy) * 0.6;
      const ta = a + 0.6, tb = a - 0.6, tl = len * 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, my); ctx.lineTo(mx + Math.cos(ta) * tl, my + Math.sin(ta) * tl * 0.9);
      ctx.moveTo(mx, my); ctx.lineTo(mx + Math.cos(tb) * tl, my + Math.sin(tb) * tl * 0.9);
      ctx.stroke();
    }
    ctx.fillStyle = colors.branch;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  // Irregular lobed canopy: several overlapping circles seeded per-variant.
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + hash2(variant, i, 1) * 0.6;
    const dist = 3 + hash2(variant, i, 2) * 4;
    const rad = 5 + hash2(variant, i, 3) * 3.2;
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist * 0.8;
    ctx.fillStyle = colors.canopy[i % colors.canopy.length];
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = colors.canopy[0];
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fill();

  // NW highlight blob (light 3rd tone) plus a couple of bright fleck pixels.
  ctx.fillStyle = colors.hi;
  ctx.beginPath();
  ctx.arc(cx - 4, cy - 5, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 5, cy - 7, 1, 1);
  ctx.fillRect(cx - 1, cy - 8, 1, 1);

  ctx.strokeStyle = 'rgba(20,20,16,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 9.4, 0, Math.PI * 2);
  ctx.stroke();
  return c;
}

export function getTreeSprite(variant: number, season: Season): HTMLCanvasElement {
  return cached(`tree|${variant}|${season}`, () => buildTree(variant, season));
}
