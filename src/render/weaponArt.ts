// ============================================================================
// weaponArt.ts — procedural top-down sprites for crew-served weapons: mortars,
// heavy MGs on tripods / wheeled mounts, towed AT guns and the PTRD AT rifle.
// Everything is generated in code at 10 px per metre (1 unit = 1 px at 1x =
// 0.1 m), lit from the NW with a soft SE cast shadow, like soldierArt.ts and
// vehicleArt.ts.
//
// Method (same idea as soldierArt): each weapon is a short list of shape
// primitives (rects, capsules, discs) authored in the weapon frame — muzzle to
// the north (-y), pivot at the baseplate / tripod head / gun axle. A sprite is
// rasterised directly at the requested scale (1x or 2x) and facing (16 steps):
// each output pixel is inverse-rotated into the weapon frame and the topmost
// primitive covering it decides its colour. Lighting is evaluated in screen
// space (the sun stays NW whatever the facing): rect edges and the rounded
// sides of tubes, barrels and trail legs take a lit or a shadow tone, discs
// are dome-shaded. The cast shadow is every primitive shifted SE by its
// height above the ground, so a mortar tube angled up throws a long shadow
// and a gun shield a broad one, while trail legs barely lift off the ground.
// Primitives flagged `min: 2` add detail that has no room at 1x: MG42 jacket
// slots, sight, traverse handwheel, muzzle-brake baffles, rope handles and
// stencils on crates, rounds visible in an open case, hub bolts.
//
// Variants: 'ready' (set up), 'half' (being set up / packed: bipod or trails
// half open, gun not yet on its tripod) and 'packed' (mortar/MG parts lying
// on the ground, AT gun trails closed for towing by the crew).
// ============================================================================
import type { Season, Side, Vec2 } from '@/shared/types';
import { createCanvas, ctx2d } from '@/render/pixelUtil';

/** 'ready' / 'half' / 'packed' are the three legacy looks. Guns also have one look per step of
 * their crew drill (spec 2026-09-17 §6): 'limbered', 'trailsClosed', 'trailLeftOpen',
 * 'trailRightOpen', 'trailsOpen', 'emplaced', 'recoil', and — code-drawn only — `trail:<l>:<r>` with
 * each leg swung out by l/4 and r/4 (0..4), so a leg is seen travelling with the man who swings it. */
export type WeaponVariant =
  | 'ready' | 'half' | 'packed'
  | 'limbered' | 'trailsClosed' | 'trailLeftOpen' | 'trailRightOpen' | 'trailsOpen' | 'emplaced' | 'recoil'
  | 'baseplate' | 'tube' | 'tripod'
  | `trail:${number}:${number}`;

/** The legacy look nearest to a drill-step look (for weapons that only have the three). */
export function legacyVariant(v: WeaponVariant): 'ready' | 'half' | 'packed' {
  if (v === 'ready' || v === 'half' || v === 'packed') return v;
  if (v === 'limbered' || v === 'trailsClosed') return 'packed';
  if (v === 'trailsOpen' || v === 'emplaced' || v === 'recoil') return 'ready';
  return 'half';
}

/** Trail-swing variant for the code-drawn guns: fractions 0..1 quantised to quarters. */
export function trailVariant(left: number, right: number): WeaponVariant {
  const q = (f: number) => Math.max(0, Math.min(4, Math.round(f * 4)));
  return `trail:${q(left)}:${q(right)}`;
}

interface GunLook { left: number; right: number; towEye: boolean; spades: boolean; dug: boolean; crates: boolean; recoil: number }
function gunLook(v: WeaponVariant): GunLook {
  switch (v) {
    case 'ready': case 'emplaced': return { left: 1, right: 1, towEye: false, spades: true, dug: true, crates: true, recoil: 0 };
    case 'recoil': return { left: 1, right: 1, towEye: false, spades: true, dug: true, crates: true, recoil: 3.2 };
    case 'trailsOpen': return { left: 1, right: 1, towEye: false, spades: true, dug: false, crates: true, recoil: 0 };
    case 'half': return { left: 0.45, right: 0.45, towEye: false, spades: true, dug: false, crates: true, recoil: 0 };
    case 'trailLeftOpen': return { left: 1, right: 0, towEye: false, spades: true, dug: false, crates: false, recoil: 0 };
    case 'trailRightOpen': return { left: 0, right: 1, towEye: false, spades: true, dug: false, crates: false, recoil: 0 };
    case 'trailsClosed': return { left: 0, right: 0, towEye: false, spades: true, dug: false, crates: false, recoil: 0 };
    case 'packed': case 'limbered': return { left: 0, right: 0, towEye: true, spades: false, dug: false, crates: false, recoil: 0 };
    default: {
      const m = /^trail:(\d):(\d)$/.exec(v);
      const l = m ? Number(m[1]) / 4 : 0, r = m ? Number(m[2]) / 4 : 0;
      return { left: l, right: r, towEye: false, spades: true, dug: false, crates: false, recoil: 0 };
    }
  }
}
/** Number of distinct rotations a weapon sprite is built for. */
export const WEAPON_FACINGS = 16;

type ArtKind = 'mortar' | 'lafette' | 'maxim' | 'pak38' | 'pak40' | 'at45' | 'zis3' | 'ptrd';

interface OpBase {
  c: string;
  /** height of the top of the part above the ground, units (for the cast shadow) */
  z: number;
  min?: number;
  max?: number;
  /** 'flat' = one tone; otherwise lit/shadow edges by shape */
  flat?: boolean;
}
interface RectOp extends OpBase { k: 'rect'; x0: number; y0: number; x1: number; y1: number; round?: number }
interface SegOp extends OpBase { k: 'seg'; x0: number; y0: number; x1: number; y1: number; w: number; z1?: number }
interface CircOp extends OpBase { k: 'circ'; cx: number; cy: number; r: number; ri?: number }
type Op = RectOp | SegOp | CircOp;

const rect = (x0: number, y0: number, x1: number, y1: number, c: string, z: number, extra: Partial<RectOp> = {}): RectOp =>
  ({ k: 'rect', x0, y0, x1, y1, c, z, ...extra });
const seg = (x0: number, y0: number, x1: number, y1: number, w: number, c: string, z: number, extra: Partial<SegOp> = {}): SegOp =>
  ({ k: 'seg', x0, y0, x1, y1, w, c, z, ...extra });
const circ = (cx: number, cy: number, r: number, c: string, z: number, extra: Partial<CircOp> = {}): CircOp =>
  ({ k: 'circ', cx, cy, r, c, z, ...extra });

// ---------------------------------------------------------------- palette ---
interface WeaponPalette {
  gun: string;      // painted steel (shields, trails, cradles, tripods)
  gunDark: string;
  steel: string;    // bare/blued steel: tubes, barrels, receivers
  black: string;
  tyre: string;
  ammo: string;     // ammunition tins / cases
  wood: string;
  brass: string;
  bomb: string;
  season: Season;
}
const TYRE = '#1d1d19';
const BLACK = '#171815';
const BRASS = '#a88f48';
const WOOD = '#6c5332';

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function rgbHex(r: number, g: number, b: number): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
function mul(hex: string, k: number): string { const [r, g, b] = hexRgb(hex); return rgbHex(r * k, g * k, b * k); }
function lift(hex: string, k: number): string { const [r, g, b] = hexRgb(hex); return rgbHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k); }

function paletteFor(weaponId: string, side: Side, season: Season): WeaponPalette {
  // German 1941-42 dark grey, German 1943+ guns dark yellow, Soviet olive green.
  // wf19: paint lifted a step so guns separate from the (now brighter) ground like the vehicles do
  let gun = side === 'soviet' ? '#66724a' : weaponId === 'pak40' ? '#a08f5a' : '#6d746f';
  const steel = side === 'soviet' ? '#3b4032' : '#393c36';
  let ammo = side === 'soviet' ? '#4f5738' : '#4a4f40';
  if (season === 'winter') { gun = '#cdd0c6'; ammo = '#b4b7ad'; }
  return { gun, gunDark: mul(gun, 0.72), steel, black: BLACK, tyre: TYRE, ammo, wood: WOOD, brass: BRASS, bomb: '#585b47', season };
}

function artKindOf(weaponId: string): ArtKind | null {
  switch (weaponId) {
    case 'mortar81': case 'mortar82': return 'mortar';
    case 'mg34_hmg': case 'mg42_hmg': return 'lafette';
    case 'maxim': return 'maxim';
    case 'pak38': return 'pak38';
    case 'pak40': return 'pak40';
    case 'm1937_45mm': return 'at45';
    case 'zis3': return 'zis3';
    case 'ptrd': return 'ptrd';
    default: return null;
  }
}

export function hasWeaponArt(weaponId: string): boolean { return artKindOf(weaponId) != null; }

// --------------------------------------------------------------- geometry ---
interface AtSpec {
  trailLen: number; spread: number; trailW: number;
  wheelX: number; wheelHalf: number; wheelW: number; spoked?: boolean;
  shield: 'pak40' | 'pak38' | 'flat45' | 'zis3';
  barrelLen: number; barrelW: number; brake: [number, number] | null; breechY: number;
}
const AT_SPECS: Record<'pak38' | 'pak40' | 'at45' | 'zis3', AtSpec> = {
  pak40: { trailLen: 27, spread: 0.44, trailW: 2.2, wheelX: 9.3, wheelHalf: 4.2, wheelW: 2.6, shield: 'pak40', barrelLen: 26, barrelW: 2.0, brake: [3.6, 3.4], breechY: 7 },
  pak38: { trailLen: 23, spread: 0.42, trailW: 1.8, wheelX: 7.8, wheelHalf: 3.8, wheelW: 2.2, shield: 'pak38', barrelLen: 22, barrelW: 1.6, brake: [2.6, 2.8], breechY: 5.5 },
  at45: { trailLen: 22, spread: 0.4, trailW: 1.8, wheelX: 7.6, wheelHalf: 4.0, wheelW: 1.9, spoked: true, shield: 'flat45', barrelLen: 24, barrelW: 1.4, brake: null, breechY: 5 },
  zis3: { trailLen: 28, spread: 0.46, trailW: 2.2, wheelX: 9.8, wheelHalf: 4.6, wheelW: 2.6, shield: 'zis3', barrelLen: 28, barrelW: 2.0, brake: [3.4, 3.6], breechY: 6.5 },
};

function crateOps(x0: number, y0: number, w: number, h: number, pal: WeaponPalette, open: boolean): Op[] {
  const ops: Op[] = [rect(x0, y0, x0 + w, y0 + h, pal.wood, 3)];
  ops.push(rect(x0, y0 + h * 0.5 - 0.25, x0 + w, y0 + h * 0.5 + 0.25, mul(pal.wood, 0.7), 3, { min: 2, flat: true }));
  ops.push(rect(x0 - 0.5, y0 + h * 0.3, x0, y0 + h * 0.7, mul(pal.wood, 0.55), 2, { min: 2, flat: true }));
  ops.push(rect(x0 + w, y0 + h * 0.3, x0 + w + 0.5, y0 + h * 0.7, mul(pal.wood, 0.55), 2, { min: 2, flat: true }));
  if (open) {
    ops.push(rect(x0 + 0.6, y0 + 0.6, x0 + w - 0.6, y0 + h - 0.6, mul(pal.wood, 0.45), 3, { flat: true }));
    for (let i = 0; i < 3; i++) {
      const cx = x0 + 1.4 + i * ((w - 2.8) / 2);
      ops.push(circ(cx, y0 + h * 0.5, 0.75, pal.brass, 3.2, { min: 2 }));
    }
  }
  return ops;
}

function mortarOps(weaponId: string, v: WeaponVariant, pal: WeaponPalette): Op[] {
  const ops: Op[] = [];
  // ammunition: German 3-round tins (grey-green), Soviet wooden boxes
  const soviet = weaponId === 'mortar82';
  const caseC = soviet ? pal.wood : pal.ammo;
  const cases: [number, number, number, number][] = [[4.6, -1.2, 2.4, 4.8], [7.4, -0.6, 2.4, 4.8], [4.8, 4.6, 4.8, 2.3]];
  cases.forEach(([x, y, w, h], i) => {
    ops.push(rect(x, y, x + w, y + h, caseC, 2.4));
    ops.push(rect(x, y + (h > w ? 0.6 : 0), x + (h > w ? w : 0.6), y + (h > w ? 1.1 : h), mul(caseC, 0.65), 2.4, { min: 2, flat: true }));
    if (i === 0 && v !== 'packed') {
      ops.push(rect(x + 0.4, y + 1.6, x + w - 0.4, y + h - 0.4, mul(caseC, 0.45), 2.4, { flat: true }));
      for (let k = 0; k < 3; k++) {
        ops.push(circ(x + w / 2, y + 2.3 + k * 0.95, 0.42, pal.bomb, 2.6, { min: 2 }));
      }
    }
  });
  // baseplate with a raised ring and carrying lugs
  ops.push(circ(0, 0.6, 3.4, pal.steel, 0.7));
  ops.push(circ(0, 0.6, 2.3, mul(pal.steel, 0.75), 0.8, { ri: 1.8, min: 2 }));
  ops.push(rect(-4.0, 0.2, -3.2, 1.0, mul(pal.steel, 0.8), 0.6, { min: 2 }), rect(3.2, 0.2, 4.0, 1.0, mul(pal.steel, 0.8), 0.6, { min: 2 }));
  if (v === 'packed') {
    // tube and folded bipod laid out beside the baseplate
    ops.push(seg(-5.4, -9.5, -5.4, 1.5, 2.0, pal.steel, 1.2));
    ops.push(circ(-5.4, -9.5, 0.9, pal.black, 1.2, { min: 2 }));
    ops.push(seg(-8.3, -8.0, -8.3, 0.5, 1.1, pal.gunDark, 0.9));
    ops.push(seg(-8.3, -8.0, -7.3, -9.0, 0.8, pal.gunDark, 0.9));
    return ops;
  }
  const legSpread = v === 'ready' ? 3.6 : 1.1;
  const legY = v === 'ready' ? -8.8 : -9.4;
  // bipod: two legs from the collar, a cross brace and the elevating screw
  ops.push(seg(0, -6.6, -legSpread, legY, 1.0, pal.gunDark, 6, { z1: 0.3 }));
  ops.push(seg(0, -6.6, legSpread, legY, 1.0, pal.gunDark, 6, { z1: 0.3 }));
  ops.push(circ(-legSpread, legY, 0.6, pal.black, 0.3, { min: 2 }), circ(legSpread, legY, 0.6, pal.black, 0.3, { min: 2 }));
  if (v === 'ready') ops.push(seg(-2.4, -8.1, 2.4, -8.1, 0.7, pal.gunDark, 2));
  // the tube, drawn foreshortened toward the muzzle (angled up ~45 deg)
  ops.push(seg(0, 0.2, 0, -10.4, 2.0, pal.steel, 0.9, { z1: 9 }));
  ops.push(seg(0, -6.6, 0, -8.0, 0.8, mul(pal.steel, 1.25), 5, { min: 2 }));
  ops.push(circ(0, -10.4, 1.05, pal.black, 9));
  ops.push(circ(0, -10.4, 1.05, mul(pal.steel, 1.4), 9, { ri: 0.6, min: 2 }));
  if (v === 'ready') {
    // sight and traverse handwheel
    ops.push(rect(-2.1, -7.3, -0.9, -6.0, '#6f7367', 7, { min: 2 }));
    ops.push(rect(-2.2, -6.3, -1.6, -5.7, pal.black, 7, { min: 2, flat: true }));
    ops.push(circ(1.4, -6.8, 0.75, pal.gunDark, 5, { ri: 0.35, min: 2 }));
  }
  return ops;
}

function lafetteOps(weaponId: string, v: WeaponVariant, pal: WeaponPalette): Op[] {
  const ops: Op[] = [];
  const tripod = pal.season === 'winter' ? pal.gun : '#474b44';
  // ammunition tins
  ops.push(rect(-7.2, -1.4, -3.6, 2.4, pal.ammo, 2.6), rect(-7.4, 3.0, -3.8, 6.8, pal.ammo, 2.6));
  ops.push(rect(-6.3, -1.4, -4.5, -0.9, lift(pal.ammo, 0.3), 2.8, { min: 2 }), rect(-6.5, 3.0, -4.7, 3.5, lift(pal.ammo, 0.3), 2.8, { min: 2 }));
  const gunX = v === 'ready' ? 0 : 4.8;
  const gunZ = v === 'ready' ? 5 : 1.2;
  if (v === 'packed') {
    ops.push(seg(0, -6.5, 0, 8.2, 1.9, tripod, 1.2));
    ops.push(seg(-0.9, -6.5, -0.9, 6.0, 0.7, mul(tripod, 0.7), 1.2, { min: 2 }));
  } else {
    ops.push(seg(0, 2, 0, 8.6, 1.1, tripod, 3, { z1: 0.3 }), circ(0, 8.9, 0.85, mul(tripod, 0.7), 0.3));
    ops.push(seg(0, -0.5, -4.8, -5.3, 1.0, tripod, 3, { z1: 0.3 }), circ(-4.9, -5.4, 0.75, mul(tripod, 0.7), 0.3));
    ops.push(seg(0, -0.5, 4.8, -5.3, 1.0, tripod, 3, { z1: 0.3 }), circ(4.9, -5.4, 0.75, mul(tripod, 0.7), 0.3));
    ops.push(rect(-1.4, -1.8, 1.4, 3.4, tripod, 3.5));
    ops.push(seg(-2.0, 3.6, 2.0, 3.6, 0.6, pal.black, 3.2, { min: 2 }));
  }
  // the gun (on the cradle when ready, lying beside the tripod otherwise)
  const g = gunX;
  const jacket = '#2b2d2c';
  ops.push(rect(g - 0.95, -9.6, g + 0.95, -2.2, jacket, gunZ));
  if (weaponId === 'mg42_hmg') {
    for (let y = -9.0; y < -3.0; y += 1.5) ops.push(rect(g - 0.45, y, g + 0.45, y + 0.8, '#0f100f', gunZ, { min: 2, flat: true }));
  } else {
    for (let y = -8.8; y < -3.0; y += 1.2) ops.push(circ(g, y, 0.3, '#0f100f', gunZ, { min: 2 }));
  }
  ops.push(seg(g, -11.3, g, -9.6, 0.8, pal.black, gunZ));
  ops.push(rect(g - 1.15, -2.2, g + 1.15, 3.0, '#1f201f', gunZ + 0.3));
  ops.push(rect(g - 0.9, -1.7, g + 0.9, 0.5, '#383a38', gunZ + 0.4, { min: 2 }));
  ops.push(seg(g, 3.0, g, 7.2, 1.7, '#1b1b19', gunZ - 0.4));
  if (v === 'ready') {
    // belt from the left-hand tin into the feed tray, rounds glinting at 2x
    ops.push(seg(-3.6, 0.6, -1.1, -0.4, 1.3, pal.brass, 2.2));
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4;
      ops.push(seg(-3.6 + 2.5 * t, 0.6 - t, -3.6 + 2.5 * t, 0.6 - t, 0.35, '#5e4e22', 2.3, { min: 2, flat: true }));
    }
  }
  return ops;
}

function maximOps(v: WeaponVariant, pal: WeaponPalette): Op[] {
  const ops: Op[] = [];
  if (v !== 'packed') {
    ops.push(rect(4.4, -1.2, 8.0, 3.2, pal.wood, 2.4), rect(4.4, 0.8, 8.0, 1.2, mul(pal.wood, 0.65), 2.4, { min: 2, flat: true }));
  }
  // trail with its handle, axle and two small wheels
  ops.push(seg(0, 2.4, 0, 9.6, 1.5, pal.gun, 1.8, { z1: 0.5 }));
  ops.push(seg(-1.9, 9.6, 1.9, 9.6, 0.8, pal.gunDark, 0.8));
  ops.push(seg(-3.8, 2.2, 3.8, 2.2, 0.9, pal.steel, 2));
  for (const sx of [-1, 1]) {
    ops.push(rect(sx * 4.05 - 0.6, 0.1, sx * 4.05 + 0.6, 4.3, pal.tyre, 3, { round: 0.5 }));
    ops.push(circ(sx * 4.05, 2.2, 0.5, pal.gun, 3.2, { min: 2 }));
  }
  // receiver + spade grips, fluted water jacket, muzzle
  ops.push(rect(-1.6, -2.2, 1.6, 2.6, '#2e3129', 5.5));
  ops.push(seg(-1.1, 2.6, -1.5, 3.9, 0.7, pal.black, 5), seg(1.1, 2.6, 1.5, 3.9, 0.7, pal.black, 5));
  const jacket = pal.season === 'winter' ? '#b9bcb2' : '#4b5336';
  ops.push(rect(-1.45, -10.6, 1.45, -2.2, jacket, 6));
  ops.push(rect(-0.75, -10.2, -0.45, -2.6, mul(jacket, 0.7), 6, { min: 2, flat: true }), rect(0.45, -10.2, 0.75, -2.6, mul(jacket, 0.7), 6, { min: 2, flat: true }));
  ops.push(circ(0, -9.2, 0.55, '#6d705a', 6.2, { min: 2 }));
  ops.push(seg(0, -12.3, 0, -10.6, 0.9, pal.black, 6));
  // shield across the gun
  ops.push(rect(-4.5, -3.4, 4.5, -2.2, pal.gun, 7.5));
  ops.push(rect(-0.5, -3.4, 0.5, -3.0, pal.black, 7.6, { min: 2, flat: true }));
  if (v === 'ready') ops.push(seg(1.6, -0.2, 4.4, 0.8, 1.1, pal.brass, 2.2));
  return ops;
}

function atGunOps(spec: AtSpec, v: WeaponVariant, pal: WeaponPalette): Op[] {
  const ops: Op[] = [];
  const L = spec.trailLen;
  const look = gunLook(v);
  // ammunition crates beside the right trail (set down once the trails are out)
  if (look.crates) {
    ops.push(...crateOps(spec.wheelX + 2.5, 7, 5, 3.6, pal, true));
    ops.push(...crateOps(spec.wheelX + 3.0, 11.4, 5, 3.6, pal, false));
  }
  // split trails: each leg at its own angle (closed for towing, swung out by a crewman)
  for (const sx of [-1, 1]) {
    const a = spec.spread * (sx < 0 ? look.left : look.right);
    const rx = sx * 1.4, ry = 1.5;
    const ex = rx + sx * Math.sin(a) * L, ey = ry + Math.cos(a) * L;
    ops.push(seg(rx, ry, ex, ey, spec.trailW, pal.gun, 2.2, { z1: 0.5 }));
    ops.push(seg(rx + sx * Math.sin(a) * L * 0.72, ry + Math.cos(a) * L * 0.72, ex, ey, spec.trailW * 0.45, mul(pal.gun, 0.8), 1, { min: 2 }));
    if (look.spades) {
      // spade across the trail end; dug in = seated in a little heap of turned earth
      const px = Math.cos(a), py = -sx * Math.sin(a);
      if (look.dug) ops.push(circ(ex + sx * Math.sin(a) * 1.1, ey + Math.cos(a) * 1.1, 2.0, pal.season === 'winter' ? '#8d8a80' : '#4d402b', 0.4, { flat: true }));
      ops.push(seg(ex - px * 1.9, ey - py * 1.9, ex + px * 1.9, ey + py * 1.9, 1.3, look.dug ? mul(pal.gunDark, 0.8) : pal.gunDark, 1));
      // carrying handle part-way along the trail
      const hx = rx + sx * Math.sin(a) * L * 0.55, hy = ry + Math.cos(a) * L * 0.55;
      ops.push(seg(hx - px * 1.5, hy - py * 1.5, hx + px * 1.5, hy + py * 1.5, 0.5, pal.black, 1.6, { min: 2 }));
    }
  }
  if (look.towEye) {
    ops.push(seg(0, L + 1.2, 0, L + 3.0, 0.9, pal.gunDark, 1.4));
    ops.push(circ(0, L + 3.0, 0.9, pal.black, 1.4, { ri: 0.4 }));
  }
  // axle, wheels
  ops.push(seg(-spec.wheelX, 0, spec.wheelX, 0, 1.6, pal.steel, 3));
  for (const sx of [-1, 1]) {
    const cx = sx * spec.wheelX;
    ops.push(rect(cx - spec.wheelW / 2, -spec.wheelHalf, cx + spec.wheelW / 2, spec.wheelHalf, pal.tyre, 5, { round: 1.1 }));
    if (spec.spoked) {
      for (let k = -2; k <= 2; k++) ops.push(rect(cx - spec.wheelW / 2 + 0.3, k * 1.4 - 0.25, cx + spec.wheelW / 2 - 0.3, k * 1.4 + 0.25, pal.gun, 5.2, { min: 2, flat: true }));
    }
    ops.push(circ(cx, 0, 1.2, pal.gun, 5.5));
    ops.push(circ(cx, 0, 0.35, pal.black, 5.6, { min: 2 }));
  }
  // cradle + recuperator, breech (the barrel and breech slide back in the cradle on recoil)
  const rc = look.recoil;
  ops.push(rect(-1.7, -6.5, 1.7, spec.breechY + 1, pal.gun, 8));
  ops.push(rect(-0.8, -6.5, 0.8, -0.5, lift(pal.gun, 0.12), 8.2, { min: 2 }));
  ops.push(rect(-2.2, spec.breechY - 3.2 + rc, 2.2, spec.breechY + 1.6 + rc, mul(pal.steel, 1.15), 9));
  ops.push(seg(2.2, spec.breechY - 0.5 + rc, 3.4, spec.breechY + 0.6 + rc, 0.6, pal.black, 9, { min: 2 }));
  if (rc > 0) ops.push(rect(-1.0, spec.breechY + 1.6 + rc, 1.0, spec.breechY + 2.4 + rc, BLACK, 8.8, { flat: true })); // open breech
  // shield
  const gc = pal.gun;
  switch (spec.shield) {
    case 'pak40':
      ops.push(seg(-11, -1.0, -1.9, -3.2, 1.2, gc, 11), seg(1.9, -3.2, 11, -1.0, 1.2, gc, 11));
      ops.push(seg(-11, -1.0, -11.6, 0.6, 1.0, gc, 9), seg(11, -1.0, 11.6, 0.6, 1.0, gc, 9));
      break;
    case 'pak38':
      ops.push(seg(-9.4, -1.3, -1.6, -2.6, 0.9, gc, 10), seg(1.6, -2.6, 9.4, -1.3, 0.9, gc, 10));
      ops.push(seg(-9.4, -2.6, -1.6, -3.9, 0.8, lift(gc, 0.1), 10.5), seg(1.6, -3.9, 9.4, -2.6, 0.8, lift(gc, 0.1), 10.5));
      break;
    case 'flat45':
      ops.push(seg(-8.9, -2.2, -1.4, -2.2, 1.0, gc, 10), seg(1.4, -2.2, 8.9, -2.2, 1.0, gc, 10));
      ops.push(seg(-8.9, -2.2, -9.6, -0.4, 0.9, gc, 9), seg(8.9, -2.2, 9.6, -0.4, 0.9, gc, 9));
      break;
    case 'zis3':
      ops.push(seg(-10.6, -2.0, -1.8, -2.9, 1.2, gc, 11), seg(1.8, -2.9, 10.6, -2.0, 1.2, gc, 11));
      ops.push(rect(-3.8, -4.4, 3.8, -3.5, lift(gc, 0.08), 11.5));
      break;
  }
  // barrel + muzzle brake
  const bl0 = spec.barrelLen - rc;
  ops.push(seg(0, -3 + rc, 0, -bl0, spec.barrelW, mul(pal.gun, 0.92), 9));
  if (spec.brake) {
    const [bl, bw] = spec.brake;
    ops.push(rect(-bw / 2, -bl0 - bl, bw / 2, -bl0, pal.gunDark, 9));
    ops.push(rect(-bw / 2, -bl0 - bl * 0.66, bw / 2, -bl0 - bl * 0.52, BLACK, 9.1, { min: 2, flat: true }));
    ops.push(rect(-bw / 2, -bl0 - bl * 0.34, bw / 2, -bl0 - bl * 0.2, BLACK, 9.1, { min: 2, flat: true }));
  } else {
    ops.push(circ(0, -bl0, spec.barrelW * 0.62, mul(pal.gun, 0.8), 9));
  }
  return ops;
}

function ptrdOps(pal: WeaponPalette): Op[] {
  return [
    seg(0, -2, -2.9, -4.3, 0.6, pal.black, 2, { z1: 0.2 }), seg(0, -2, 2.9, -4.3, 0.6, pal.black, 2, { z1: 0.2 }),
    seg(0, -13, 0, 4, 1.0, '#2b2c28', 2.5),
    rect(-0.95, -15.2, 0.95, -13, '#1f201d', 2.5),
    rect(-0.85, 3, 0.85, 8.5, '#232420', 2.6),
    seg(0, 8.5, 0, 13.4, 1.3, '#30312c', 2.2),
    rect(-1.1, 9.0, 0.2, 12.0, pal.wood, 2.4, { min: 2 }),
    rect(-1.35, 13.2, 1.35, 14.4, '#3e2c1b', 2.2),
    rect(-0.3, -1.2, 0.3, 1.6, '#4a4b44', 2.8, { min: 2 }),
  ];
}

interface Geometry { ops: Op[]; extent: number }

const ART_SCALE: Record<ArtKind, number> = { mortar: 1.5, lafette: 1.35, maxim: 1.2, pak38: 1, pak40: 1, at45: 1, zis3: 1, ptrd: 1.1 };

function scaleOp(o: Op, k: number): Op {
  switch (o.k) {
    case 'rect': return { ...o, x0: o.x0 * k, y0: o.y0 * k, x1: o.x1 * k, y1: o.y1 * k, round: o.round != null ? o.round * k : undefined };
    case 'seg': return { ...o, x0: o.x0 * k, y0: o.y0 * k, x1: o.x1 * k, y1: o.y1 * k, w: o.w * k };
    case 'circ': return { ...o, cx: o.cx * k, cy: o.cy * k, r: o.r * k, ri: o.ri != null ? o.ri * k : undefined };
  }
}

function geometryFor(weaponId: string, variant: WeaponVariant, pal: WeaponPalette): Geometry {
  const kind = artKindOf(weaponId);
  let ops: Op[] = [];
  switch (kind) {
    case 'mortar': ops = mortarOps(weaponId, legacyVariant(variant), pal); break;
    case 'lafette': ops = lafetteOps(weaponId, legacyVariant(variant), pal); break;
    case 'maxim': ops = maximOps(legacyVariant(variant), pal); break;
    case 'pak38': case 'pak40': case 'at45': case 'zis3': ops = atGunOps(AT_SPECS[kind], variant, pal); break;
    case 'ptrd': ops = ptrdOps(pal); break;
    default: ops = [];
  }
  // mortars and MGs are read at a glance next to the (deliberately bold) soldiers: draw them a
  // little larger than life, the way the soldiers themselves are
  const k = ART_SCALE[kind ?? 'ptrd'];
  if (k !== 1) ops = ops.map((o) => scaleOp(o, k));
  let extent = 1;
  for (const o of ops) {
    if (o.k === 'circ') extent = Math.max(extent, Math.hypot(o.cx, o.cy) + o.r);
    else if (o.k === 'seg') extent = Math.max(extent, Math.hypot(o.x0, o.y0) + o.w / 2, Math.hypot(o.x1, o.y1) + o.w / 2);
    else extent = Math.max(extent, Math.hypot(o.x0, o.y0), Math.hypot(o.x1, o.y0), Math.hypot(o.x0, o.y1), Math.hypot(o.x1, o.y1));
  }
  return { ops, extent };
}

/** Muzzle position in metres in the weapon frame (for flashes, the mortar puff, recoil). */
export function weaponMuzzleM(weaponId: string): Vec2 {
  const kind = artKindOf(weaponId);
  switch (kind) {
    case 'mortar': return { x: 0, y: -1.04 * ART_SCALE.mortar };
    case 'lafette': return { x: 0, y: -1.13 * ART_SCALE.lafette };
    case 'maxim': return { x: 0, y: -1.23 * ART_SCALE.maxim };
    case 'ptrd': return { x: 0, y: -1.52 * ART_SCALE.ptrd };
    case 'pak38': case 'pak40': case 'at45': case 'zis3': {
      const s = AT_SPECS[kind];
      return { x: 0, y: -(s.barrelLen + (s.brake ? s.brake[0] : 0)) / 10 };
    }
    default: return { x: 0, y: -1 };
  }
}

/** AT guns: distance (m) from the axle to the towing eye of the closed trails. 0 for other weapons. */
export function weaponTowLengthM(weaponId: string): number {
  const kind = artKindOf(weaponId);
  if (kind === 'pak38' || kind === 'pak40' || kind === 'at45' || kind === 'zis3') return (AT_SPECS[kind].trailLen + 3) / 10;
  return 0;
}

// -------------------------------------------------------------- rasterise ---
const SQRT1_2 = Math.SQRT1_2;
interface Sampler { s: number; pix: number; cos: number; sin: number }

/** How much a weapon-frame normal faces the NW light once rotated to screen space. */
function lightOf(sm: Sampler, nx: number, ny: number): number {
  const sx = nx * sm.cos - ny * sm.sin;
  const sy = nx * sm.sin + ny * sm.cos;
  return -(sx + sy) * SQRT1_2;
}

type Tone = 0 | 1 | 2; // 0 shadow, 1 mid, 2 lit
function toneOf(l: number): Tone { return l > 0.3 ? 2 : l < -0.3 ? 0 : 1; }

function coverOp(op: Op, gx: number, gy: number, sm: Sampler): Tone | -1 {
  switch (op.k) {
    case 'rect': {
      if (gx < op.x0 || gx >= op.x1 || gy < op.y0 || gy >= op.y1) return -1;
      const dl = gx - op.x0, dr = op.x1 - gx, dt = gy - op.y0, db = op.y1 - gy;
      if (op.round) {
        const r = op.round;
        const cx = dl < r ? op.x0 + r : dr < r ? op.x1 - r : NaN;
        const cy = dt < r ? op.y0 + r : db < r ? op.y1 - r : NaN;
        if (!Number.isNaN(cx) && !Number.isNaN(cy) && Math.hypot(gx - cx, gy - cy) > r) return -1;
      }
      if (op.flat) return 1;
      let best = Math.min(dl, dr), nx = dl < dr ? -1 : 1, ny = 0;
      if (Math.min(dt, db) < best) { best = Math.min(dt, db); nx = 0; ny = dt < db ? -1 : 1; }
      if (best >= sm.pix * 1.01) return 1;
      return toneOf(lightOf(sm, nx, ny));
    }
    case 'seg': {
      const vx = op.x1 - op.x0, vy = op.y1 - op.y0;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 0 ? ((gx - op.x0) * vx + (gy - op.y0) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = gx - (op.x0 + vx * t), dy = gy - (op.y0 + vy * t);
      const hw = op.w * 0.5;
      const d2 = dx * dx + dy * dy;
      if (d2 > hw * hw) return -1;
      if (op.flat || len2 === 0) return 1;
      const len = Math.sqrt(len2);
      const px = -vy / len, py = vx / len;
      const across = (dx * px + dy * py) / Math.max(hw, 1e-6); // -1..1 across the tube
      const l = lightOf(sm, px, py) * across;
      if (op.w * sm.s < 2.5) return l > 0.25 ? 2 : l < -0.25 ? 0 : 1;
      return l > 0.4 ? 2 : l < -0.4 ? 0 : 1;
    }
    case 'circ': {
      const dx = gx - op.cx, dy = gy - op.cy;
      const d = Math.hypot(dx, dy);
      if (d > op.r || (op.ri != null && d < op.ri)) return -1;
      if (op.flat) return 1;
      const nd = d / op.r;
      if (nd < 0.45) return 1;
      return toneOf(lightOf(sm, dx / Math.max(d, 1e-6), dy / Math.max(d, 1e-6)) * nd);
    }
  }
}

/** Shift an op by a weapon-frame vector per unit of height (for the cast shadow). */
function shadowOp(op: Op, ux: number, uy: number): Op {
  const k = (z: number) => 0.6 + z * 0.42;
  switch (op.k) {
    case 'rect': { const s = k(op.z); return { ...op, x0: op.x0 + ux * s, x1: op.x1 + ux * s, y0: op.y0 + uy * s, y1: op.y1 + uy * s }; }
    case 'circ': { const s = k(op.z); return { ...op, cx: op.cx + ux * s, cy: op.cy + uy * s }; }
    case 'seg': {
      const s0 = k(op.z), s1 = k(op.z1 ?? op.z);
      return { ...op, x0: op.x0 + ux * s0, y0: op.y0 + uy * s0, x1: op.x1 + ux * s1, y1: op.y1 + uy * s1 };
    }
  }
}

function parseRgb(hex: string): [number, number, number] { return hexRgb(hex); }

/** Build one weapon sprite: square canvas, weapon pivot at the exact centre, authored at `scale`
 * px per 1x px (draw at `width * zoom / scale`), rotated to facing index `facing16` (0 = muzzle
 * north, clockwise, 16 steps). Cached by sprites.ts. */
export function buildWeaponSprite(
  weaponId: string, variant: WeaponVariant, facing16: number, side: Side, season: Season, scale = 1,
): HTMLCanvasElement {
  const s = scale >= 2 ? 2 : 1;
  const pal = paletteFor(weaponId, side, season);
  const geo = geometryFor(weaponId, variant, pal);
  const ops = geo.ops.filter((o) => (o.min == null || s >= o.min) && (o.max == null || s <= o.max));
  const ang = ((((facing16 % WEAPON_FACINGS) + WEAPON_FACINGS) % WEAPON_FACINGS) * Math.PI * 2) / WEAPON_FACINGS;
  let cos = Math.cos(ang), sin = Math.sin(ang);
  if (facing16 % 4 === 0) { cos = Math.round(cos); sin = Math.round(sin); }
  const sm: Sampler = { s, pix: 1 / s, cos, sin };
  // screen SE (+x,+y) shadow direction, expressed in the weapon frame
  const ssx = 0.75, ssy = 0.66;
  const ux = ssx * cos + ssy * sin, uy = -ssx * sin + ssy * cos;
  const shadowOps = ops.map((o) => shadowOp(o, ux, uy));
  let maxZ = 0;
  for (const o of ops) maxZ = Math.max(maxZ, o.z, o.k === 'seg' ? (o.z1 ?? 0) : 0);
  const half = Math.ceil((geo.extent + 0.6 + maxZ * 0.42 + 2) * s);
  const n = half * 2;
  const body = new Int16Array(n * n).fill(-1);
  const tone = new Uint8Array(n * n);
  const shadow = new Uint8Array(n * n);
  const limit2 = (geo.extent + 1.5) * (geo.extent + 1.5);
  const shLimit = geo.extent + 1.5 + maxZ * 0.5 + 1;
  for (let py = 0; py < n; py++) {
    const sy = (py + 0.5 - half) / s;
    for (let px = 0; px < n; px++) {
      const sx = (px + 0.5 - half) / s;
      const gx = sx * cos + sy * sin;
      const gy = -sx * sin + sy * cos;
      const i = py * n + px;
      if (gx * gx + gy * gy <= limit2) {
        for (let k = ops.length - 1; k >= 0; k--) {
          const t = coverOp(ops[k], gx, gy, sm);
          if (t >= 0) { body[i] = k; tone[i] = t; break; }
        }
      }
      if (body[i] < 0 && gx * gx + gy * gy <= shLimit * shLimit) {
        for (let k = 0; k < shadowOps.length; k++) {
          if (coverOp(shadowOps[k], gx, gy, sm) >= 0) { shadow[i] = 1; break; }
        }
      }
    }
  }
  const c = createCanvas(n, n);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(n, n);
  const d = img.data;
  const put = (i: number, r: number, g: number, b: number, a: number) => { const o = i * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a; };
  const colorCache = new Map<string, [number, number, number]>();
  const toneColor = (hex: string, t: Tone): [number, number, number] => {
    const key = hex + t;
    let v = colorCache.get(key);
    if (!v) {
      // wf19: a wider lit/shade swing — the lit edge of a dark barrel must flash light so the
      // weapon's line (its facing) reads at 1x; shaded faces go deeper for volume.
      v = parseRgb(t === 2 ? lift(hex, 0.38) : t === 0 ? mul(hex, 0.58) : hex);
      colorCache.set(key, v);
    }
    return v;
  };
  const isBody = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && body[y * n + x] >= 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const k = body[i];
      if (k >= 0) {
        const [r, g, b] = toneColor(ops[k].c, tone[i] as Tone);
        put(i, r, g, b, 255);
        continue;
      }
      // thin dark outline ring hugging the silhouette
      // (wf19: directional like the soldiers' — a hairline on the lit NW side, a crisp dark
      // contact edge on the SE side, so the piece sits on the ground instead of being boxed in)
      const w = isBody(x - 1, y), e = isBody(x + 1, y), no = isBody(x, y - 1), so = isBody(x, y + 1);
      if (w || e || no || so) {
        const litSide = (e || so) && !w && !no;
        put(i, 16, 16, 12, litSide ? 84 : 214);
        continue;
      }
      if (shadow[i]) {
        const edge = !(x > 0 && shadow[i - 1]) || !(x < n - 1 && shadow[i + 1]) || !(y > 0 && shadow[i - n]) || !(y < n - 1 && shadow[i + n]);
        put(i, 6, 8, 12, edge ? 64 : 122);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
