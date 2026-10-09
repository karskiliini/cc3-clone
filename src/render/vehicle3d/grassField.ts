// ============================================================================
// The 3D tall grass around vehicles (spec 2026-10-08-3d-tall-grass): which
// blades stand where (a world-anchored hashed field, so nothing pops as a
// hull moves), how hulls and wakes bend them, and how a patch fades into the
// painted field. Pure; tested in Node. World metres: x east, z south.
// Compass directions: 0 = north, clockwise.
// ============================================================================
import { hash2 } from '@/shared/rng';
import { BLADES, type SeasonKey, type TallGrowth } from '@/render/grassFx';

/** one blade per cell: 25 per m² */
export const CELL_M = 0.2;
/** a patch reaches this far (m) outside the hull; its outer FADE_M thins into the painted field */
export const PATCH_PAD_M = 5;
export const FADE_M = 2.5;
/** a standing hull pushes blades over within this distance (m) of its sides */
export const PUSH_M = 1.0;
/** ...and a moving bow this far ahead of it */
export const BOW_PUSH_M = 2.0;
/** behind a moving tail, flat this far (m): the wake stamps come every 0.7 m */
export const WAKE_GAP_M = 0.9;
export const MAX_BLADES = 40000;
const TAU = Math.PI * 2;

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
    widthM: wheat ? 0.025 : 0.04 + 0.02 * w,
    // tip offset (1 - cos a) / a: 0.15..0.30 for grass, <= 0.08 for wheat
    restAngle: wheat ? 0.16 * w : 0.3 + 0.32 * w,
    restDir: hash2(cx, cz, 706) * TAU,
    // mostly the darker tones, as the 2D fringe: the light ones are the rare sunlit tips
    colour: parseInt(tones[Math.min(tones.length - 1, Math.floor(c * c * tones.length))].slice(1), 16),
  };
}
