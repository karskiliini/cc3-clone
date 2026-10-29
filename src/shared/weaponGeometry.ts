import type { Vec2 } from './types';
/** Blender weapon geometry, metres from the axle/baseplate; +y is aft in the sim. */
export const MUZZLE_FWD_M: Readonly<Record<string, number>> = {
  mortar81: 0.99, mortar82: 0.99, mg34_hmg: 1.425, mg42_hmg: 1.425, maxim: 1.296,
  pak38: 2.71, pak40: 3.31, m1937_45mm: 2.0, zis3: 3.19, ptrd: 1.86,
};
export function crewMuzzleOffset(weaponId: string): Vec2 { return { x: 0, y: -(MUZZLE_FWD_M[weaponId] ?? 1) }; }
