// ============================================================================
// muzzleSnap.ts — where a crew weapon's flash, tracer or mortar lob is DRAWN from. The sim fires
// these from the gunner's position; drawCrewWeapons records the weapon's muzzle for them here and
// effects.ts draws from it. Render-local: the renderer never writes BattleState (multiplayer plan
// §2 D2), so a frame rate or an open view cannot change the sim.
// ============================================================================
import type { Vec2 } from '@/shared/types';

interface Snap { pos: Vec2; facing?: number }

const snaps = new WeakMap<object, Snap>();

/** Records the muzzle an effect is drawn from; the first snap sticks, as the round left then. */
export function snapToMuzzle(effect: object, pos: Vec2, facing?: number): void {
  if (!snaps.has(effect)) snaps.set(effect, { pos: { ...pos }, facing });
}

/** The muzzle recorded for an effect, if any. */
export function muzzleSnap(effect: object): Snap | undefined {
  return snaps.get(effect);
}
