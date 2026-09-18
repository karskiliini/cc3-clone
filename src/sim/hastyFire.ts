import type { Soldier, Team, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import type { Rng } from '@/shared/rng';

export type HastyFire = 'assault' | 'pressure' | 'panic';
const HANDHELD = new Set(['rifle', 'pistol', 'smg', 'lmg']);
export function isPanicking(s: Soldier): boolean { return s.mind.state === 'panicked' || s.activity === 'panicked'; }
export function hastyFireKind(s: Soldier, w: WeaponDef, at: Vec2, team?: Team): HastyFire | undefined {
  if (!HANDHELD.has(w.cls) || w.id.includes('scoped')
    || (team?.crewWeapon?.gunnerId === s.id && team.crewWeapon.weaponId === s.weaponId)) return;
  const range = dist(s.pos, at) * TILE_M;
  if (isPanicking(s)) return range <= 80 ? 'panic' : undefined;
  if (team?.order?.type === 'assault' && range <= 80) return 'assault';
  if (range <= 120 && s.suppression >= 55 && team?.order?.type !== 'ambush' && team?.order?.type !== 'sneak') return 'pressure';
}
export function hastyAccuracy(s: Soldier): number {
  const kind = s.smgBurst?.hasty ?? s.aiming?.hasty;
  return kind === 'panic' ? 0.12 : kind ? 0.4 : 1;
}

const panicWindows = new WeakMap<Soldier, { next: number; until: number }>();
/** Rare, time-bounded opportunities, rolled on battle time rather than each frame. Full panic
 * interrupts the previous aimed action; it does not turn the fleeing soldier into steady fire. */
export function panicFireOpportunity(s: Soldier, w: WeaponDef, now: number, rng: Rng): boolean {
  if (!isPanicking(s)) { panicWindows.delete(s); return false; }
  if (!HANDHELD.has(w.cls) || w.id.includes('scoped') || s.vehicleId != null) return false;
  let window = panicWindows.get(s);
  if (!window) { window = { next: now + 0.5, until: -Infinity }; panicWindows.set(s, window); }
  if (now >= window.next) {
    window.next = now + 3;
    window.until = rng.chance(0.2) ? now + 1.25 : -Infinity;
  }
  return now < window.until;
}
