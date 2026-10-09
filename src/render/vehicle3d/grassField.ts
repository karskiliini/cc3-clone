// ============================================================================
// The 3D tall grass around vehicles (spec 2026-10-08-3d-tall-grass): which
// blades stand where (a world-anchored hashed field, so nothing pops as a
// hull moves), how hulls and wakes bend them, and how a patch fades into the
// painted field. Pure; tested in Node. World metres: x east, z south.
// Compass directions: 0 = north, clockwise.
// ============================================================================
import { hash2 } from '@/shared/rng';
import { BLADES, type SeasonKey, type TallGrowth } from '@/render/grassFx';
import type { Crush } from '@/render/grassCrush';

/** one blade per cell: 25 per m² */
export const CELL_M = 0.2;
/** a patch reaches this far (m) outside the hull; its outer FADE_M thins into the painted field */
export const PATCH_PAD_M = 5;
export const FADE_M = 4.5;
/** a standing hull pushes blades over within this distance (m) of its sides */
export const PUSH_M = 1.0;
/** ...and a moving bow this far ahead of it */
export const BOW_PUSH_M = 2.0;
/** behind a moving tail, flat this far (m): the wake stamps come every 0.7 m */
export const WAKE_GAP_M = 0.9;
export const MAX_BLADES = 40000;

export type BladeKind = 'grass' | 'wheat';
export type GrowthAt = (xM: number, zM: number) => TallGrowth | null;

export interface Blade {
  kind: BladeKind;
  xM: number;
  zM: number;
  heightM: number;
  widthM: number;
  /** the blade's own curve: arc angle (rad) and the compass direction it bends toward */
  restAngle: number;
  restDir: number;
  /** 0xRRGGBB */
  colour: number;
}

/** The blade of field cell (cx, cz), or null where nothing tall grows. */
export function bladeAt(cx: number, cz: number, growthAt: GrowthAt, season: SeasonKey): Blade | null {
  const xM = (cx + hash2(cx, cz, 701)) * CELL_M, zM = (cz + hash2(cx, cz, 702)) * CELL_M;
  const growth = growthAt(xM, zM);
  if (!growth) return null;
  const h = hash2(cx, cz, 703), w = hash2(cx, cz, 704), c = hash2(cx, cz, 705);
  const wheat = growth === 'crops';
  const tones = BLADES[season][growth].up;
  return {
    kind: wheat ? 'wheat' : 'grass', xM, zM,
    heightM: wheat ? 1.0 + 0.2 * h : 0.6 + 0.3 * h,
    widthM: wheat ? 0.025 : 0.08 + 0.04 * w,
    // tip offset (1 - cos a) / a: 0.29..0.43 for grass, <= 0.08 for wheat
    restAngle: wheat ? 0.16 * w : 0.6 + 0.3 * w,
    restDir: Math.PI / 4 + (hash2(cx, cz, 706) - 0.5) * 0.6,
    // mostly the darker tones, as the 2D fringe: the light ones are the rare sunlit tips
    colour: parseInt(tones[Math.min(tones.length - 1, Math.floor(c * c * tones.length))].slice(1), 16),
  };
}

/** A vehicle the field grows round: its centre, compass facing, half extents and signed speed (m/s, < 0 reversing). */
export interface HullPatch { id: number; xM: number; zM: number; facing: number; halfLenM: number; halfWidM: number; speedMs: number }

/** A point in the hull's frame: lx right, ly forward, d its distance outside the hull rectangle
 * (0 inside), away the unit vector pointing from the nearest hull edge to it (0 inside). */
export function hullLocal(h: HullPatch, xM: number, zM: number): { lx: number; ly: number; d: number; awayX: number; awayZ: number } {
  const fx = Math.sin(h.facing), fz = -Math.cos(h.facing), rx = Math.cos(h.facing), rz = Math.sin(h.facing);
  const px = xM - h.xM, pz = zM - h.zM;
  const lx = px * rx + pz * rz, ly = px * fx + pz * fz;
  const ex = Math.max(Math.abs(lx) - h.halfWidM, 0), ey = Math.max(Math.abs(ly) - h.halfLenM, 0);
  const d = Math.hypot(ex, ey);
  if (d === 0) return { lx, ly, d, awayX: 0, awayZ: 0 };
  const sx = (Math.sign(lx) * ex) / d, sy = (Math.sign(ly) * ey) / d;
  return { lx, ly, d, awayX: sx * rx + sy * fx, awayZ: sx * rz + sy * fz };
}

/** How much of a blade at d metres outside the hull survives: 1 out to PATCH_PAD_M - FADE_M, then smoothly to 0. */
export function patchFade(d: number): number {
  if (d <= PATCH_PAD_M - FADE_M) return 1;
  if (d >= PATCH_PAD_M) return 0;
  const t = (PATCH_PAD_M - d) / FADE_M;
  return t * t * (3 - 2 * t);
}

export type CrushAt = (xM: number, zM: number) => Crush | null;

/** A blade's pose: it bends toward (dirX, dirZ) into an arc of `angle` rad; heightScale squashes it toward the ground. */
export interface Bend { dirX: number; dirZ: number; angle: number; heightScale: number }

/** lying down: the arc's tip runs along the ground */
export const FLAT = Math.PI / 2;
const UNDER_PAD_M = 0.15;
const PUSH_MAX_RAD = (70 * Math.PI) / 180;
const BOW_SPEED_MS = 0.3;
const WAKE_SPEED_MS = 1e-4;

/** How the hulls and the wakes bend a blade (strongest wins): under a hull flat; in a moving hull's
 * wake gap or on crushed ground flat along the travel; beside a hull pushed away from it (ahead of
 * a moving bow, forward); otherwise its own curve. */
export function bendBlade(b: Blade, hulls: readonly HullPatch[], crush: CrushAt | null): Bend {
  const local = hulls.map((h) => hullLocal(h, b.xM, b.zM));
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i], l = local[i];
    const s = Math.sign(h.speedMs), fx = Math.sin(h.facing), fz = -Math.cos(h.facing);
    if (Math.abs(l.lx) <= h.halfWidM + UNDER_PAD_M && Math.abs(l.ly) <= h.halfLenM + UNDER_PAD_M) {
      return { dirX: fx, dirZ: fz, angle: FLAT, heightScale: 0.08 };
    }
    // the stretch the tail has just left and the next wake stamp has not yet reached
    if (Math.abs(h.speedMs) > WAKE_SPEED_MS && Math.abs(l.lx) <= h.halfWidM) {
      const behind = -s * l.ly - h.halfLenM;
      if (behind > 0 && behind <= WAKE_GAP_M) return { dirX: s * fx, dirZ: s * fz, angle: FLAT, heightScale: 0.12 };
    }
  }
  const c = crush?.(b.xM, b.zM);
  if (c && c.level >= 0.5) return { dirX: Math.sin(c.dirRad), dirZ: -Math.cos(c.dirRad), angle: FLAT, heightScale: 0.12 };
  let best: Bend = { dirX: Math.sin(b.restDir), dirZ: -Math.cos(b.restDir), angle: b.restAngle, heightScale: 1 };
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i], l = local[i];
    const s = Math.sign(h.speedMs);
    const ahead = Math.abs(h.speedMs) > BOW_SPEED_MS && s * l.ly > h.halfLenM && Math.abs(l.lx) <= h.halfWidM + 0.3;
    const reach = ahead ? BOW_PUSH_M : PUSH_M;
    if (l.d <= 0 || l.d >= reach) continue;
    const angle = PUSH_MAX_RAD * (1 - l.d / reach) ** 2;
    if (angle <= best.angle) continue;
    best = ahead
      ? { dirX: s * Math.sin(h.facing), dirZ: -s * Math.cos(h.facing), angle, heightScale: 1 }
      : { dirX: l.awayX, dirZ: l.awayZ, angle, heightScale: 1 };
  }
  return best;
}

/** One blade as drawn this frame: where it stands, how it bends, how much of it survives the patch fade. */
export interface BladeInst extends Blade, Bend { fade: number }

/** The blades of every hull's patch, nearest to the view centre first. A patch that would overrun
 * the budget is dropped whole (its vehicle keeps the 2D fringe). Cells shared by two patches grow
 * one blade, bent by every hull near it. */
export function bladesFor(
  hulls: readonly HullPatch[], growthAt: GrowthAt, crush: CrushAt | null, season: SeasonKey,
  viewXM: number, viewZM: number, budget = MAX_BLADES,
): { blades: BladeInst[]; dropped: number[] } {
  const reach = (h: HullPatch): number => Math.hypot(h.halfLenM, h.halfWidM) + PATCH_PAD_M;
  const dist = (h: HullPatch): number => Math.hypot(h.xM - viewXM, h.zM - viewZM);
  const order = [...hulls].sort((a, b) => dist(a) - dist(b) || a.id - b.id);
  const blades: BladeInst[] = [], dropped: number[] = [];
  const seen = new Set<number>();
  for (const h of order) {
    const near = hulls.filter((o) => Math.hypot(o.xM - h.xM, o.zM - h.zM) <= reach(h) + reach(o));
    const r = reach(h);
    const cx0 = Math.floor((h.xM - r) / CELL_M), cx1 = Math.floor((h.xM + r) / CELL_M);
    const cz0 = Math.floor((h.zM - r) / CELL_M), cz1 = Math.floor((h.zM + r) / CELL_M);
    const mine: BladeInst[] = [], keys: number[] = [];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx * 100000 + cz;
        if (seen.has(key)) continue;
        if (hullLocal(h, (cx + 0.5) * CELL_M, (cz + 0.5) * CELL_M).d >= PATCH_PAD_M + CELL_M) continue;
        const b = bladeAt(cx, cz, growthAt, season);
        if (!b || hullLocal(h, b.xM, b.zM).d >= PATCH_PAD_M) continue;
        let fade = 0;
        for (const o of near) fade = Math.max(fade, patchFade(hullLocal(o, b.xM, b.zM).d));
        if (fade <= 0) continue;
        mine.push({ ...b, ...bendBlade(b, near, crush), fade });
        keys.push(key);
      }
    }
    if (blades.length + mine.length > budget) { dropped.push(h.id); continue; }
    for (const k of keys) seen.add(k);
    for (const b of mine) blades.push(b);
  }
  return { blades, dropped };
}

/** The vehicles whose 2D fringe the 3D grass replaces this frame: none if the GL draw failed. */
export function grassHandOver(patchIds: readonly number[], dropped: readonly number[], drewOk: boolean): Set<number> {
  return drewOk ? new Set(patchIds.filter((id) => !dropped.includes(id))) : new Set();
}
