// ============================================================================
// sprites.ts — all procedural sprites, cached by a key built from arguments.
// Everything here is generated in code (pixel strings + canvas drawing ops).
// Nothing is copied from any existing game.
// ============================================================================
import type { Side, Season, Stance, Facing8, CursorKind } from '@/shared/types';
import { TILE_PX, TILE_M } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { createCanvas, ctx2d, putPixelArt, rotate90, rotateSprite, darken, scaleArt, setArtPixel } from '@/render/pixelUtil';
import { buildVehicleHull, buildVehicleTurret } from '@/render/vehicleArt';

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
const ART_SCALE = 2;
function scaled(art: string[]): string[] {
  return scaleArt(art, ART_SCALE);
}
// Specular pixel: the top-left-most helmet rim pixel, per art layout above.
const STAND_F0 = setArtPixel(scaled(STAND_F0_BASE), 8, 2, 'P');
const STAND_F1 = setArtPixel(scaled(STAND_F1_BASE), 8, 2, 'P');
const STAND_W = STAND_F0[0].length, STAND_H = STAND_F0.length;

// Crouching/prone/dead are hand-authored directly at the new (24x24 / 16x28)
// resolution with canvas path primitives (arc/line/polygon), NOT a 2x
// nearest-neighbour scale of the old 12px grids — a plain upscale left these
// poses as an amorphous blob with no visible head, weapon or limbs at this
// size. Each pose draws its own shadow pass (offset +1,+1, 30% alpha) then a
// full-color pass, mirroring artCanvas's baked drop-shadow technique.
const CROUCH_W = 24, CROUCH_H = 24;
const PRONE_W = 16, PRONE_H = 28;

function fixWidth(rows: string[], w: number): string[] {
  return rows.map((r) => (r.length === w ? r : r.length < w ? r.padEnd(w, '.') : r.slice(0, w)));
}

/** Shared shadow+color double-pass wrapper for the primitive-drawn poses. */
function primitiveCanvas(w: number, h: number, colors: Record<string, string>, draw: (ctx: CanvasRenderingContext2D, c: Record<string, string>) => void): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const shadow: Record<string, string> = {};
  for (const k of Object.keys(colors)) shadow[k] = 'rgba(10,10,8,0.32)';
  ctx.save();
  ctx.translate(1, 1);
  draw(ctx, shadow);
  ctx.restore();
  draw(ctx, colors);
  return c;
}

/** Kneeling silhouette: helmet, hunched torso, one knee down (wide rear leg),
 * one knee forward, and a rifle held at a clear forward-up diagonal — reads
 * as a soldier taking a knee, not a blob, at 1x. `frame` nudges the weapon
 * and front knee for a 2-frame "settling into cover" cycle. */
function drawCrouchSoldier(ctx: CanvasRenderingContext2D, colors: Record<string, string>, frame: 0 | 1): void {
  const hx = 12, hy = 8; // helmet centre
  const wob = frame === 1 ? 1 : 0;
  // Rear leg: flat, kneeling down to one side (wide base).
  ctx.fillStyle = colors.U;
  ctx.beginPath();
  ctx.moveTo(hx - 5, hy + 10); ctx.lineTo(hx + 1, hy + 10); ctx.lineTo(hx - 1, hy + 15); ctx.lineTo(hx - 8, hy + 15);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = colors.S; ctx.lineWidth = 1; ctx.stroke();
  // Forward leg: bent knee up.
  ctx.fillStyle = colors.U;
  ctx.beginPath();
  ctx.moveTo(hx, hy + 10); ctx.lineTo(hx + 6, hy + 10); ctx.lineTo(hx + 8 + wob, hy + 15); ctx.lineTo(hx + 2, hy + 15);
  ctx.closePath(); ctx.fill();
  ctx.stroke();
  // Torso: hunched forward, tapering to the hips.
  ctx.fillStyle = colors.U;
  ctx.beginPath();
  ctx.moveTo(hx - 4, hy + 2); ctx.lineTo(hx + 3, hy + 2); ctx.lineTo(hx + 5, hy + 11); ctx.lineTo(hx - 5, hy + 11);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = colors.S; ctx.stroke();
  // Helmet: 4-tone dome (rim / mid / light / NW specular).
  ctx.fillStyle = colors.O;
  ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.H;
  ctx.beginPath(); ctx.arc(hx + 0.3, hy + 0.4, 3.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.h;
  ctx.beginPath(); ctx.arc(hx - 1.2, hy - 1.1, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.P;
  ctx.fillRect(hx - 2.6, hy - 2.6, 1, 1);
  // Rifle: bold forward-up diagonal from the hands past the shoulder, with a
  // wood stock block at the hand end so facing/weapon are unambiguous at 1x.
  ctx.strokeStyle = colors.W;
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(hx + 4, hy + 5); ctx.lineTo(hx + 12 - wob, hy - 7); ctx.stroke();
  ctx.fillStyle = colors.K;
  ctx.fillRect(hx + 2, hy + 4, 3, 2);
  // Flesh fleck at the hands.
  ctx.fillStyle = colors.G;
  ctx.fillRect(hx + 4, hy + 4, 1, 1);
}

/** Elongated prone silhouette lying along the north-south axis: helmet at the
 * head end, arms/shoulders, tapering hip-to-boot body, and a rifle line that
 * pokes clearly beyond the head at a shallow (not straight-vertical) angle. */
function drawProneSoldier(ctx: CanvasRenderingContext2D, colors: Record<string, string>): void {
  const cx = 8;
  // Legs: two boots, slightly splayed, at the tail end.
  ctx.fillStyle = colors.U;
  ctx.fillRect(cx - 3, 21, 2, 6);
  ctx.fillRect(cx + 1, 21, 2, 6);
  ctx.strokeStyle = colors.S; ctx.lineWidth = 1;
  ctx.strokeRect(cx - 3.5, 20.5, 2.5, 6.5);
  ctx.strokeRect(cx + 0.5, 20.5, 2.5, 6.5);
  // Body: tapered torso/hip mass.
  ctx.fillStyle = colors.U;
  ctx.beginPath();
  ctx.moveTo(cx - 4, 9); ctx.lineTo(cx + 4, 9); ctx.lineTo(cx + 3.5, 21); ctx.lineTo(cx - 3.5, 21);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = colors.S; ctx.stroke();
  // Arms extended forward toward the weapon hand.
  ctx.fillStyle = colors.U;
  ctx.fillRect(cx - 6, 9, 3, 2);
  ctx.fillRect(cx + 3, 9, 3, 2);
  // Head/helmet at the north end.
  const hy = 6;
  ctx.fillStyle = colors.O;
  ctx.beginPath(); ctx.arc(cx, hy, 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.H;
  ctx.beginPath(); ctx.arc(cx + 0.3, hy + 0.3, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.h;
  ctx.beginPath(); ctx.arc(cx - 1, hy - 1, 1.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.P;
  ctx.fillRect(cx - 2.2, hy - 2.2, 1, 1);
  // Rifle: shallow-angle line extending clearly beyond the head/body outline.
  ctx.strokeStyle = colors.W;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(cx + 4, 10); ctx.lineTo(cx + 6, -3); ctx.stroke();
  ctx.fillStyle = colors.K;
  ctx.fillRect(cx + 3, 8, 2, 3);
  ctx.fillStyle = colors.G;
  ctx.fillRect(cx + 4, 9, 1, 1);
}

/** Dead: splayed-limb corpse with the weapon dropped beside the body (not
 * held), distinct from the prone pose at a glance. Blood pool painted by the
 * caller (buildSoldierBase) so it sits on top of the darkened palette. */
function drawDeadSoldier(ctx: CanvasRenderingContext2D, colors: Record<string, string>): void {
  const cx = 8;
  // Dropped rifle, lying at an angle beside the body, disconnected from the hands.
  ctx.strokeStyle = colors.W;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(cx + 4, 10); ctx.lineTo(cx + 7, 22); ctx.stroke();
  ctx.fillStyle = colors.K;
  ctx.fillRect(cx + 6, 20, 2, 3);
  // Splayed legs, diverging from the hips at an angle (not parallel).
  ctx.fillStyle = colors.U;
  ctx.beginPath(); ctx.moveTo(cx - 3, 18); ctx.lineTo(cx, 18); ctx.lineTo(cx - 5, 27); ctx.lineTo(cx - 7, 27); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx, 18); ctx.lineTo(cx + 3, 18); ctx.lineTo(cx + 6, 26); ctx.lineTo(cx + 3, 26); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = colors.S; ctx.lineWidth = 1; ctx.stroke();
  // Torso, slightly twisted.
  ctx.fillStyle = colors.U;
  ctx.beginPath();
  ctx.moveTo(cx - 4, 9); ctx.lineTo(cx + 3, 8); ctx.lineTo(cx + 4, 19); ctx.lineTo(cx - 5, 19);
  ctx.closePath(); ctx.fill();
  ctx.stroke();
  // One arm flung out to the side, one bent under the body.
  ctx.fillStyle = colors.U;
  ctx.fillRect(cx - 8, 10, 4, 2);
  ctx.fillStyle = colors.G;
  ctx.fillRect(cx - 9, 10, 1, 2);
  // Head, lolled to one side (offset from the body centre-line).
  const hx = cx - 3, hy = 6;
  ctx.fillStyle = colors.O;
  ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.H;
  ctx.beginPath(); ctx.arc(hx + 0.3, hy + 0.3, 2.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.G;
  ctx.fillRect(hx + 1, hy + 1, 1, 1);
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
    const c = primitiveCanvas(PRONE_W, PRONE_H, colors, (ctx, cs) => drawDeadSoldier(ctx, cs));
    const ctx = ctx2d(c);
    ctx.fillStyle = colors.B;
    ctx.beginPath();
    ctx.ellipse(PRONE_W / 2 - 1, PRONE_H * 0.58, 3.4, 2.2, 0.3, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }
  if (stance === 'prone') return primitiveCanvas(PRONE_W, PRONE_H, colors, (ctx, cs) => drawProneSoldier(ctx, cs));
  if (stance === 'crouching') return primitiveCanvas(CROUCH_W, CROUCH_H, colors, (ctx, cs) => drawCrouchSoldier(ctx, cs, frame));
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


export function getVehicleSprite(defId: string, part: 'hull' | 'turret', state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  const key = `vehicle|${defId}|${part}|${state}`;
  return cached(key, () => {
    const { lengthM, widthM } = getDims(defId);
    return part === 'hull'
      ? buildVehicleHull(defId, lengthM, widthM, state)
      : buildVehicleTurret(defId, lengthM, widthM, state);
  });
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
  // Dense mottled brown/tan scrub clump (not skeletal branch-lines) so
  // winter trees stay solidly visible against snow terrain.
  winter: { canopy: ['#8a7a5c', '#6b5f45', '#7c6e51'], hi: '#a89878', branch: '#5c5248' },
};

/** Irregular lobed canopy: several overlapping circles seeded per-variant,
 * unified with a base fill and a per-lobe wobble outline. Shared by
 * summer/autumn foliage and the winter mottled-scrub clump. */
function drawClumpCanopy(ctx: CanvasRenderingContext2D, cx: number, cy: number, variant: number, colors: { canopy: string[]; hi: string }, baseR: number): void {
  const lobes: { x: number; y: number; rad: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + hash2(variant, i, 1) * 0.6;
    const dist = 3 + hash2(variant, i, 2) * 4;
    const rad = 5 + hash2(variant, i, 3) * 3.2;
    lobes.push({ x: cx + Math.cos(ang) * dist, y: cy + Math.sin(ang) * dist * 0.8, rad });
  }
  for (let i = 0; i < lobes.length; i++) {
    ctx.fillStyle = colors.canopy[i % colors.canopy.length];
    ctx.beginPath();
    ctx.arc(lobes[i].x, lobes[i].y, lobes[i].rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = colors.canopy[0];
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
  ctx.fill();

  // NW highlight fleck (light 3rd tone) — small, not a big overpowering blob.
  ctx.fillStyle = colors.hi;
  ctx.beginPath();
  ctx.arc(cx - 3.5, cy - 4.5, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 4, cy - 7, 1, 1);
  ctx.fillRect(cx - 1, cy - 8, 1, 1);

  // Per-lobe dark edge — a light overall wobble outline instead of one
  // perfect circle, so the canopy silhouette reads as clumpy, not geometric.
  ctx.strokeStyle = 'rgba(20,20,16,0.35)';
  ctx.lineWidth = 1;
  for (const lobe of lobes) {
    ctx.beginPath();
    ctx.arc(lobe.x, lobe.y, lobe.rad, 0, Math.PI * 2);
    ctx.stroke();
  }
}

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

  drawClumpCanopy(ctx, cx, cy, variant, colors, 6.5);

  if (season === 'winter') {
    // A dusting of snow flecks on top of the mottled canopy so it still
    // reads as "winter" without collapsing back into thin skeletal lines.
    ctx.fillStyle = '#eef0ef';
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + hash2(variant, i, 21) * 0.8;
      const dist = 2 + hash2(variant, i, 22) * 6;
      ctx.fillRect(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist * 0.8 - 2, 1, 1);
    }
  }
  return c;
}

export function getTreeSprite(variant: number, season: Season): HTMLCanvasElement {
  return cached(`tree|${variant}|${season}`, () => buildTree(variant, season));
}
