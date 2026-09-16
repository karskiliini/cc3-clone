// ============================================================================
// sprites.ts — all procedural sprites, cached by a key built from arguments.
// Everything here is generated in code (pixel strings + canvas drawing ops).
// Nothing is copied from any existing game.
// ============================================================================
import type { Side, Season, Stance, Facing8, CursorKind } from '@/shared/types';
import { TILE_PX, TILE_M } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { createCanvas, ctx2d } from '@/render/pixelUtil';
import { buildVehicleHull, buildVehicleTurret } from '@/render/vehicleArt';
import { buildSoldierSprite, type SoldierOutline, type SoldierPose } from '@/render/soldierArt';
import { buildTeamIcon } from '@/render/teamIconArt';
import { buildWeaponSprite, WEAPON_FACINGS, type WeaponVariant } from '@/render/weaponArt';

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

/** Sprite resolutions the unit builders author: 1x for zoom <= 1, 2x
 * (genuinely re-rasterised with extra detail, not doubled pixels) for zoom 2. */
export const UNIT_SPRITE_SCALES = [1, 2] as const;
export type UnitSpriteScale = (typeof UNIT_SPRITE_SCALES)[number];
export function unitSpriteScale(zoom: number): UnitSpriteScale {
  return zoom >= 2 ? 2 : 1;
}

/** Bounded LRU caches for unit sprites, one per scale, so a long session that
 * visits every facing/stance/season at both zooms can't grow without limit
 * and evicting 2x sprites never throws away the hot 1x set (or vice versa). */
class LruCache {
  private map = new Map<string, HTMLCanvasElement>();
  constructor(private readonly cap: number) {}
  get(key: string, build: () => HTMLCanvasElement): HTMLCanvasElement {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const c = build();
    this.map.set(key, c);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
    return c;
  }
  get size(): number { return this.map.size; }
}
// round5-battle.md fix #4 added 6 mental-state/health poses (cowering, panicked, pinned, wary,
// berserk, surrendered, woundedCrawl) on top of the 4 calm stances, growing the per-scale key
// space (pose x frame x facing x outline, one season/side pair active per battle) to a few
// hundred entries. Bumped from 900 so a battle visiting every pose/facing on both sides doesn't
// thrash the LRU; still a small, fixed bound (tiny canvases, no measurable memory impact).
const SOLDIER_CACHE_CAP = 1400;
const VEHICLE_CACHE_CAP = 160;
const soldierCaches: Record<UnitSpriteScale, LruCache> = { 1: new LruCache(SOLDIER_CACHE_CAP), 2: new LruCache(SOLDIER_CACHE_CAP) };
const vehicleCaches: Record<UnitSpriteScale, LruCache> = { 1: new LruCache(VEHICLE_CACHE_CAP), 2: new LruCache(VEHICLE_CACHE_CAP) };

/** Current unit-sprite cache sizes (for the preview page / perf checks). */
export function unitSpriteCacheStats(): Record<string, number> {
  return { soldier1: soldierCaches[1].size, soldier2: soldierCaches[2].size, vehicle1: vehicleCaches[1].size, vehicle2: vehicleCaches[2].size };
}

/** Oriented soldier sprite, square, centred on the soldier. Authored at
 * `scale` px per 1x px: draw at `width * zoom / scale`. */
const SOLDIER_STILL_POSES = new Set<Stance | SoldierPose>(['dead', 'prone', 'pinned', 'cowering', 'surrendered', 'woundedCrawl']);

export function getSoldierSprite(
  side: Side,
  season: Season,
  stance: SoldierPose,
  facing: Facing8,
  frame: 0 | 1,
  outline: SoldierOutline = 'enemy',
  scale: number = 1,
): HTMLCanvasElement {
  const sc = unitSpriteScale(scale);
  const fr = SOLDIER_STILL_POSES.has(stance) ? 0 : frame;
  const ol = stance === 'dead' ? 'enemy' : outline;
  const key = `${side}|${season === 'winter' ? 'winter' : 'summer'}|${stance}|${facing}|${fr}|${ol}`;
  return soldierCaches[sc].get(key, () => buildSoldierSprite(side, season, stance, facing, fr, ol, sc));
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


/** Hull/turret sprite centred on the vehicle pivot, authored at `scale` px
 * per 1x px (draw at `width * zoom / scale`). Knocked-out/burning variants
 * share the 'knockedOut' art at every scale. */
export function getVehicleSprite(defId: string, part: 'hull' | 'turret', state: 'ok' | 'knockedOut', scale: number = 1): HTMLCanvasElement {
  const sc = unitSpriteScale(scale);
  const key = `${defId}|${part}|${state}`;
  return vehicleCaches[sc].get(key, () => {
    const { lengthM, widthM } = getDims(defId);
    return part === 'hull'
      ? buildVehicleHull(defId, lengthM, widthM, state, sc)
      : buildVehicleTurret(defId, lengthM, widthM, state, sc);
  });
}

// ============================================================================
// CREW-SERVED WEAPONS (mortars, HMGs, AT guns, AT rifles) — art in weaponArt.ts
// ============================================================================
const WEAPON_CACHE_CAP = 240;
const weaponCaches: Record<UnitSpriteScale, LruCache> = { 1: new LruCache(WEAPON_CACHE_CAP), 2: new LruCache(WEAPON_CACHE_CAP) };

/** Weapon sprite rotated to `facingRad` (0 = muzzle north, clockwise; quantised to 16 steps),
 * pivot at the canvas centre, authored at `scale` px per 1x px: draw at `width * zoom / scale`. */
export function getWeaponSprite(
  weaponId: string, variant: WeaponVariant, facingRad: number, side: Side, season: Season, scale: number = 1,
): HTMLCanvasElement {
  const sc = unitSpriteScale(scale);
  const f = ((Math.round((facingRad / (Math.PI * 2)) * WEAPON_FACINGS) % WEAPON_FACINGS) + WEAPON_FACINGS) % WEAPON_FACINGS;
  const winter = season === 'winter';
  const key = `${weaponId}|${variant}|${f}|${side}|${winter ? 'w' : 's'}`;
  return weaponCaches[sc].get(key, () => buildWeaponSprite(weaponId, variant, f, side, winter ? 'winter' : 'summer', sc));
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
// TEAM ICONS — 40x26, transparent bg. Small painted-miniature icons (colour,
// not flat silhouettes), matching the force-pool rows in the original game
// (ref_cc3_1478.png / 1482.png). Actual pixel art lives in teamIconArt.ts;
// this just caches by id.
// ============================================================================
export function getTeamIcon(iconId: string): HTMLCanvasElement {
  return cached(`icon|${iconId}`, () => buildTeamIcon(iconId));
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
// TREES — crowns seen from above, generated PER PIXEL at the requested output
// scale (zoom x size bucket) so a zoom-2 bake gets real leaf-clump detail
// instead of a nearest-neighbour upscale of a 28px sprite, and zoom 0.5 draws a
// genuinely small sprite. Sprite footprint is always TREE_SPRITE_WORLD_PX world
// pixels square; the canvas is ceil(28*scale) px. Shapes: round, lobed,
// elongated (broadleaf clump crowns built from lit sphere "blobs"), conifer
// (star-shaped cone with branch spokes, snow-dusted in winter) and bare (winter
// leafless crown: brown twig stipple ball with radiating branches).
// ============================================================================
export type TreeShape = 'round' | 'lobed' | 'elongated' | 'conifer' | 'bare';
export const TREE_SPRITE_WORLD_PX = 28;
/** Number of distinct layouts per shape (each with its own light/highlight jitter). */
export const TREE_VARIANTS = 8;

type Rgb3 = [number, number, number];
const CROWN_RAMPS: Record<Season, Rgb3[]> = {
  summer: [[20, 30, 14], [34, 52, 22], [54, 78, 32], [92, 116, 46], [150, 168, 78]],
  autumn: [[48, 30, 14], [88, 54, 22], [136, 88, 32], [180, 126, 46], [220, 174, 82]],
  // winter broadleaf (rare — winter woods are mostly bare/conifer): dull olive-brown
  winter: [[40, 36, 26], [60, 54, 38], [84, 76, 54], [112, 102, 76], [146, 136, 108]],
};
const CONIFER_RAMP: Rgb3[] = [[12, 24, 16], [22, 40, 24], [36, 58, 32], [58, 82, 44], [96, 120, 66]];
const BARE_RAMP: Rgb3[] = [[40, 28, 20], [64, 46, 32], [92, 68, 46], [126, 98, 68], [164, 134, 98]];
const SNOW_LIT_RGB: Rgb3 = [236, 240, 244];
const SNOW_SHADE_RGB: Rgb3 = [168, 180, 198];

function rampAt3(r: Rgb3[], t: number): Rgb3 {
  const n = r.length - 1;
  const tt = (t < 0 ? 0 : t > 1 ? 1 : t) * n;
  let i = Math.floor(tt);
  if (i >= n) i = n - 1;
  const f = tt - i, a = r[i], b = r[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Smooth value noise, 0..1 (bilinear over hash2 lattice). */
function vnoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c + (d - c) * fx - a - (b - a) * fx) * fy;
}

interface CrownBlob { x: number; y: number; r: number; z: number }
const SHAPE_IDX: Record<TreeShape, number> = { round: 0, lobed: 1, elongated: 2, conifer: 3, bare: 4 };

function crownBlobs(shape: TreeShape, variant: number): CrownBlob[] {
  const s = 9000 + SHAPE_IDX[shape] * 101;
  const H = (i: number, k: number) => hash2(variant * 31 + i, k, s);
  const blobs: CrownBlob[] = [];
  if (shape === 'round') {
    const R = 9.8 + H(0, 9) * 1.4;
    blobs.push({ x: 0, y: 0, r: R, z: 0 });
    const n = 6 + Math.floor(H(0, 8) * 3);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + H(i, 1) * 0.8;
      const dist = 3.5 + H(i, 2) * 3.8;
      const r = 3.2 + H(i, 3) * 1.8;
      const surf = Math.sqrt(Math.max(0, R * R - dist * dist));
      blobs.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r, z: surf - r * 0.55 });
    }
  } else if (shape === 'lobed') {
    const n = 4 + Math.floor(H(0, 4) * 3);
    blobs.push({ x: 0, y: 0, r: 6.5, z: 1.5 });
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + H(i, 1) * 0.9;
      const dist = 3.8 + H(i, 2) * 2.3;
      blobs.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r: 5.4 + H(i, 3) * 2.2, z: H(i, 5) * 2 });
    }
  } else if (shape === 'elongated') {
    const a = H(0, 5) * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < 3; i++) {
      const t = (i - 1) * 5.2 + (H(i, 6) - 0.5) * 1.2;
      const p = (H(i, 7) - 0.5) * 2.4;
      const r = (i === 1 ? 7.0 : 5.8) + H(i, 3) * 1.1;
      blobs.push({ x: ca * t - sa * p, y: sa * t + ca * p, r, z: H(i, 4) * 1.5 });
    }
    for (let i = 0; i < 3; i++) {
      const t = (H(i, 11) - 0.5) * 10, p = (H(i, 12) - 0.5) * 5;
      blobs.push({ x: ca * t - sa * p, y: sa * t + ca * p, r: 3 + H(i, 13) * 1.5, z: 3 });
    }
  }
  return blobs;
}

function buildCrown(variant: number, season: Season, scale: number, shape: TreeShape): HTMLCanvasElement {
  const S = Math.max(4, Math.ceil(TREE_SPRITE_WORLD_PX * scale));
  const c = createCanvas(S, S);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(S, S);
  const data = img.data;
  const half = TREE_SPRITE_WORLD_PX / 2;
  const hs = 9000 + SHAPE_IDX[shape] * 101 + variant * 7;
  // per-variant light direction jitter around NW and highlight strength
  const la = -2.36 + (hash2(variant, 1, hs) - 0.5) * 0.9;
  let Lx = Math.cos(la) * 0.72, Ly = Math.sin(la) * 0.72, Lz = 0.7;
  const ln = Math.hypot(Lx, Ly, Lz); Lx /= ln; Ly /= ln; Lz /= ln;
  const hiStr = 0.7 + hash2(variant, 2, hs) * 0.55;
  const winter = season === 'winter';

  if (shape === 'conifer') {
    const nb = 9 + Math.floor(hash2(variant, 3, hs) * 5);
    const rot = hash2(variant, 4, hs) * Math.PI * 2;
    const R = 11.5 + hash2(variant, 5, hs) * 1.5;
    for (let j = 0; j < S; j++) {
      const v = (j + 0.5) / scale - half;
      for (let i = 0; i < S; i++) {
        const u = (i + 0.5) / scale - half;
        const d = Math.hypot(u, v);
        if (d > R) continue;
        const th = Math.atan2(v, u);
        const ph = (th - rot) * nb / 2;
        const spoke = Math.abs(Math.cos(ph));
        const rTh = R * (0.76 + 0.24 * Math.sqrt(spoke)) * (0.9 + 0.2 * vnoise(th * 3 + 10, variant, hs));
        if (d >= rTh) continue;
        const q = d / rTh;
        const tang = Math.sin(ph * 2) * 0.55;
        let nx = Math.cos(th) * 0.75 - Math.sin(th) * tang, ny = Math.sin(th) * 0.75 + Math.cos(th) * tang;
        const nz = 0.62;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl;
        let lam = (nx * Lx + ny * Ly + (nz / nl) * Lz);
        lam = lam < 0 ? 0 : lam > 1 ? 1 : lam;
        const needles = vnoise(d * 1.4, th * nb * 2.2, hs + 31);
        let t = 0.05 + 0.62 * lam * hiStr + 0.18 * (1 - q) + 0.3 * (needles - 0.5) - 0.2 * q * q * q;
        if (hash2(i, j, hs + Math.round(scale * 100)) < 0.08) t -= 0.18;
        let col = rampAt3(CONIFER_RAMP, t);
        if (winter) {
          const sn = vnoise(u * 0.9 + 50, v * 0.9, hs + 41);
          const snowAmt = (sn - 0.52) * 3.2 + (lam - 0.45) * 1.1 + (1 - q) * 0.25;
          if (snowAmt > 0.25) {
            const k = Math.min(1, (snowAmt - 0.25) * 2.5) * 0.92;
            const sc = lam > 0.55 ? SNOW_LIT_RGB : SNOW_SHADE_RGB;
            col = [col[0] + (sc[0] - col[0]) * k, col[1] + (sc[1] - col[1]) * k, col[2] + (sc[2] - col[2]) * k];
          }
        }
        const o = (j * S + i) * 4;
        const aa = Math.min(1, (rTh - d) * scale * 0.9);
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255 * aa;
      }
    }
  } else if (shape === 'bare') {
    const R = 10.5 + hash2(variant, 5, hs) * 1.8;
    const nsp = 6 + Math.floor(hash2(variant, 6, hs) * 5);
    const spokes: number[] = [];
    for (let k = 0; k < nsp; k++) spokes.push((k / nsp) * Math.PI * 2 + hash2(variant, 20 + k, hs) * 0.7);
    const pxSeed = hs + Math.round(scale * 100) * 13;
    for (let j = 0; j < S; j++) {
      const v = (j + 0.5) / scale - half;
      for (let i = 0; i < S; i++) {
        const u = (i + 0.5) / scale - half;
        const d = Math.hypot(u, v);
        if (d > R * 1.1) continue;
        const th = Math.atan2(v, u);
        const q = d / (R * (0.88 + 0.22 * vnoise(th * 2.5 + 7, variant, hs + 3)));
        if (q >= 1) continue;
        let branch = false;
        if (q < 0.92) {
          for (let k = 0; k < nsp; k++) {
            const da = th - spokes[k];
            const cs = Math.cos(da);
            if (cs <= 0) continue;
            const wob = (vnoise(d * 0.5, k * 5, hs + 9) - 0.5) * 1.6;
            if (Math.abs(d * Math.sin(da) + wob * (d / R)) < 0.18 + 0.3 * (1 - q)) { branch = true; break; }
          }
        }
        const clump = vnoise(u * 0.45 + 30, v * 0.45, hs + 5);
        const dens = Math.pow(1 - q, 0.4) * (0.5 + 0.5 * clump);
        const hp = hash2(i, j, pxSeed);
        const filled = hp < dens * 0.95;
        const o = (j * S + i) * 4;
        const nxs = u / R, nys = v / R;
        const lam = 0.5 - 0.65 * (nxs * Lx + nys * Ly) / 0.72;
        if (branch) {
          const col = rampAt3(BARE_RAMP, 0.08 + 0.25 * lam);
          data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
        } else if (filled) {
          let t = 0.12 + 0.62 * lam * hiStr + (hash2(i, j, pxSeed + 1) - 0.5) * 0.45 - 0.2 * q;
          if (hp < dens * 0.25) t -= 0.2;
          const col = rampAt3(BARE_RAMP, t);
          data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255 * (q > 0.75 ? 0.75 : 1);
        } else if (q < 0.7) {
          // faint twig haze so the crown core reads as a mass, not a sieve
          const col = BARE_RAMP[1];
          data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255 * 0.45 * (1 - q / 0.7);
        }
      }
    }
  } else {
    const blobs = crownBlobs(shape, variant);
    let maxH = 1;
    for (const b of blobs) maxH = Math.max(maxH, b.z + b.r);
    const ramp = CROWN_RAMPS[season];
    const pxSeed = hs + Math.round(scale * 100) * 13;
    for (let j = 0; j < S; j++) {
      const v = (j + 0.5) / scale - half;
      for (let i = 0; i < S; i++) {
        const u = (i + 0.5) / scale - half;
        // leafy ragged silhouette: coherent ~1.5 world-px noise on the blob distance
        const leaf = vnoise(u * 0.75 + variant * 3.1, v * 0.75, hs + 11);
        const wob = (leaf - 0.5) * 0.42 + (hash2(i, j, pxSeed + 2) - 0.5) * 0.1;
        let best = -1e9, nx = 0, ny = 0, nz = 1, edge = 1, er = 1;
        for (let k = 0; k < blobs.length; k++) {
          const b = blobs[k];
          const du = u - b.x, dv = v - b.y;
          const dd = (du * du + dv * dv) / (b.r * b.r) + wob;
          if (dd >= 1) continue;
          const sq = Math.sqrt(1 - dd);
          const h = b.z + b.r * sq;
          if (h > best) { best = h; nx = du / b.r; ny = dv / b.r; nz = sq; edge = dd; er = b.r; }
        }
        if (best < -1e8) continue;
        let lam = nx * Lx + ny * Ly + nz * Lz;
        lam = lam < 0 ? 0 : lam > 1 ? 1 : lam;
        const ao = best / maxH;
        const clump = vnoise(u * 0.55 + 20, v * 0.55, hs + 17);
        const fine = vnoise(u * 1.3, v * 1.3 + 40, hs + 23);
        let t = 0.02 + 0.62 * lam * lam * hiStr + 0.22 * ao + 0.3 * (clump - 0.5) + 0.22 * (fine - 0.5) - 0.22 * edge * edge * edge;
        if (fine < 0.2 && clump < 0.5) t -= 0.2; // dark gaps between leaf clusters
        if (hash2(i, j, pxSeed) < 0.05) t += lam > 0.5 ? 0.18 : -0.15; // sparkle / pinholes
        const col = rampAt3(ramp, t);
        const o = (j * S + i) * 4;
        const aa = Math.min(1, (1 - edge) * er * scale * 0.5 + 0.15);
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255 * aa;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Cached tree crown sprite. `scale` is output pixels per world pixel (bake zoom x size bucket);
 * the canvas is ceil(28*scale) square and represents a 28x28 world-pixel footprint. The legacy
 * 2-arg call (`getTreeSprite(v, season)`) returns a round crown at 1x. */
export function getTreeSprite(variant: number, season: Season, scale = 1, shape: TreeShape = 'round'): HTMLCanvasElement {
  const v = ((variant % TREE_VARIANTS) + TREE_VARIANTS) % TREE_VARIANTS;
  return cached(`tree|${shape}|${v}|${season}|${Math.round(scale * 1000)}`, () => buildCrown(v, season, scale, shape));
}

/** Soft radial cast-shadow blob for trees (32 world px square at `scale`), black or cold
 * blue-grey for snow. Drawn stretched/rotated with smoothing on. */
export function getTreeShadowSprite(scale: number, tint: 'dark' | 'blue'): HTMLCanvasElement {
  return cached(`treeShadow|${tint}|${Math.round(scale * 1000)}`, () => {
    const S = Math.max(4, Math.ceil(32 * scale));
    const c = createCanvas(S, S);
    const ctx = c.getContext('2d')!;
    const r = S / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    const rgb = tint === 'blue' ? '52,66,98' : '10,12,6';
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(0.5, `rgba(${rgb},0.85)`);
    g.addColorStop(0.8, `rgba(${rgb},0.35)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return c;
  });
}
