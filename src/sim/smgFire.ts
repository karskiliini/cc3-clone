import type { BattleState, Soldier, Team, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, facingAngle, wrapAngle } from '@/shared/math';
import type { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';

export type SmgBurst = NonNullable<Soldier['smgBurst']>;
export interface SmgHandling { mode: 'aimed' | 'hip'; uncontrolled: boolean }
const DEG = Math.PI / 180;
/** Approximate cyclic rates, distinct from weapon.rate (controlled bursts per second). */
const CYCLIC_RPS: Record<string, number> = { mp40: 500 / 60, ppsh41: 1000 / 60 };

/** A gameplay model of loss of fire discipline, not a clinical prediction of panic. */
export function chooseSmgHandling(s: Soldier, at: Vec2, team: Team | undefined, rng: Rng): SmgHandling {
  const pressure = clamp((Math.max(s.mind.stress, s.mind.fear, s.suppression) - 50) / 45, 0, 1);
  const green = 1 - clamp(s.experience, 0, 100) / 100;
  const uncontrolled = rng.chance(pressure * (0.12 + green * 0.78));
  const rangeM = dist(s.pos, at) * TILE_M;
  const hurried = team?.order?.type === 'assault' || s.activity === 'moving' || s.activity === 'berserk';
  const hipChance = uncontrolled ? 0.75 : hurried ? 0.55 : pressure * 0.35;
  const hip = s.stance !== 'prone' && rangeM <= (uncontrolled ? 60 : 30) && rng.chance(hipChance);
  return { mode: hip ? 'hip' : 'aimed', uncontrolled };
}

export function smgBodyFacing(from: number, heading: number, prone: boolean): number {
  const delta = wrapAngle(heading - from), limit = (prone ? 20 : 40) * DEG;
  return from + Math.sign(delta) * Math.max(0, Math.abs(delta) - limit);
}

export function createSmgBurst(s: Soldier, weapon: WeaponDef, at: Vec2, team: Team | undefined, now: number, rng: Rng): SmgBurst {
  const chosen = s.aiming?.fireMode ? { mode: s.aiming.fireMode, uncontrolled: !!s.aiming.uncontrolled }
    : chooseSmgHandling(s, at, team, rng);
  const mode = s.stance === 'prone' ? 'aimed' : chosen.mode;
  const rangeM = dist(s.pos, at) * TILE_M;
  // The PPSh has a selector; an MP40's short trigger pull is still automatic fire.
  const short = mode === 'aimed' && rangeM >= 75 ? (weapon.id === 'ppsh41' ? 1 : 2) : weapon.burst;
  const interval = 1 / (CYCLIC_RPS[weapon.id] ?? 10), heading = angleTo(s.pos, at);
  const hasty = s.aiming?.hasty;
  const rounds = Math.min(s.ammo, hasty === 'panic' ? Math.ceil(0.65 / interval) : chosen.uncontrolled ? s.ammo : short);
  const area = team?.order?.type === 'fire' && s.aiming?.targetKind === 'point';
  const sweep = (chosen.uncontrolled ? (mode === 'hip' ? 55 : 35) : area ? 7 : mode === 'hip' ? 5 : 0)
    * DEG * (s.stance === 'prone' ? 0.55 : 1);
  return {
    mode, uncontrolled: chosen.uncontrolled, hasty, start: now, until: now + Math.max(0, rounds - 1) * interval + 0.25,
    interval, rounds, fired: 0, nextAt: now, from: { ...s.pos }, stance: s.stance, aim: { ...at },
    bodyFacing: smgBodyFacing(s.aiming?.fromFacing ?? facingAngle(s.facing), heading, s.stance === 'prone'),
    heading, sweep, sweepSign: rng.chance(0.5) ? -1 : 1, recoil: 0, lastRoundAt: -Infinity,
    weaponId: weapon.id, orderAt: team?.order?.issuedAt, orderType: team?.order?.type,
  };
}

/** A continuous traverse plus small handling errors. Each bullet is a straight ray; successive
 * rays form the fan. Long trigger holds climb and become harder to control. */
export function smgRoundAim(s: Soldier, b: SmgBurst, index: number, rng: Rng): { pos: Vec2; heading: number; recoil: number } {
  const progress = b.rounds <= 1 ? 0 : index / (b.rounds - 1);
  const brace = s.stance === 'prone' ? 0.5 : s.stance === 'crouching' ? 0.8 : 1;
  const control = (1.25 - s.experience * 0.007) * (1 + s.fatigue * 0.004) * brace;
  const recoil = clamp((0.25 + Math.min(index, 12) * 0.045) * control * (b.mode === 'hip' ? 1.45 : 1), 0.08, 1);
  // Start on the aim point, sweep across it, then settle on the opposite edge. A short aimed
  // burst at one man has no intentional traverse, only the small recoil/handling component.
  const traverse = b.sweepSign * b.sweep * 0.5 * Math.sin(progress * Math.PI * 1.5);
  const dispersion = (b.mode === 'hip' ? 0.023 : 0.0035) * control * (b.uncontrolled ? 1.7 : 1)
    + (b.hasty === 'panic' ? 0.08 : b.hasty ? 0.025 : 0) * brace;
  const climb = b.sweepSign * recoil * 0.008 * Math.sin(index * 1.3);
  const heading = angleTo(s.pos, b.aim) + traverse + rng.gauss() * dispersion + climb;
  const range = dist(s.pos, b.aim) * (1 + Math.max(0, index - 2) * recoil * 0.003);
  return { heading, recoil, pos: { x: s.pos.x + Math.sin(heading) * range, y: s.pos.y - Math.cos(heading) * range } };
}

export function smgMuzzle(s: Soldier, heading: number): Vec2 {
  // Match the enlarged sprite's barrel reach; hip fire keeps it closer to the body.
  const hip = s.smgBurst?.mode === 'hip';
  const forward = (s.stance === 'prone' ? 1.17 : hip ? 0.74 : 0.88) / TILE_M, right = (hip ? 0.18 : 0.24) / TILE_M;
  return { x: s.pos.x + Math.sin(heading) * forward + Math.cos(heading) * right,
    y: s.pos.y - Math.cos(heading) * forward + Math.sin(heading) * right };
}

export function smgMuzzleHeight(s: Soldier, mode: SmgHandling['mode']): number {
  // Artwork enlarges men by 1.3; ballistics use the corresponding unscaled height.
  return (s.stance === 'prone' ? 0.36 : mode === 'hip' ? (s.stance === 'standing' ? 1.55 : 0.95)
    : s.stance === 'standing' ? 1.86 : 1.26) / 1.3;
}

/** First hull crossed by a straight ray, in its rotated footprint. Wrecks and friendly hulls
 * also stop bullets; the firer's own transport is excluded for fire over the side. */
export function smgHullIntercept(state: BattleState, from: Vec2, to: Vec2, ride: number | null): { vehicle: Vehicle; pos: Vec2; t: number } | null {
  let first: { vehicle: Vehicle; pos: Vec2; t: number } | null = null;
  for (const v of state.vehicles.values()) {
    if (v.id === ride) continue;
    const def = VEHICLE_DEFS[v.defId]; if (!def) continue;
    const c = Math.cos(v.hullFacing), sin = Math.sin(v.hullFacing);
    const local = (p: Vec2) => ({ x: (p.x - v.pos.x) * c + (p.y - v.pos.y) * sin,
      y: (p.x - v.pos.x) * sin - (p.y - v.pos.y) * c });
    const a = local(from), b = local(to), half = { x: def.widthM / TILE_M / 2, y: def.lengthM / TILE_M / 2 };
    let enter = 0, exit = 1;
    for (const axis of ['x', 'y'] as const) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-9) { if (Math.abs(a[axis]) > half[axis]) exit = -1; continue; }
      const t1 = (-half[axis] - a[axis]) / delta, t2 = (half[axis] - a[axis]) / delta;
      enter = Math.max(enter, Math.min(t1, t2)); exit = Math.min(exit, Math.max(t1, t2));
    }
    if (enter > exit + 1e-8 || enter >= (first?.t ?? Infinity)) continue;
    first = { vehicle: v, pos: { x: from.x + (to.x - from.x) * enter, y: from.y + (to.y - from.y) * enter }, t: enter };
  }
  return first;
}
