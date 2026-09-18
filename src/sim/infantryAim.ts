import type { Soldier, Team, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, facingAngle, facingFromAngle, wrapAngle } from '@/shared/math';
import type { Target } from './combat';
import type { Rng } from '@/shared/rng';
import { chooseSmgHandling, smgBodyFacing } from './smgFire';
import { hastyFireKind } from './hastyFire';

type Aim = NonNullable<Soldier['aiming']>;
interface Memory { lastPos: Vec2; movedAt: number; walkUntil: number; shot?: Aim; shotAt: number }
const memories = new WeakMap<Soldier, Memory>();
function memory(s: Soldier): Memory {
  let m = memories.get(s);
  if (!m) { m = { lastPos: { ...s.pos }, movedAt: -Infinity, walkUntil: -Infinity, shotAt: -Infinity }; memories.set(s, m); }
  return m;
}
function advancing(s: Soldier): boolean {
  return s.path.length > 0 && (s.activity === 'moving' || s.activity === 'sneaking' || s.activity === 'movingFast');
}
function identity(target: Target): { at: Vec2; kind: Aim['targetKind']; id?: number } {
  if (target.kind === 'soldier') return { at: target.soldier.pos, kind: target.kind, id: target.soldier.id };
  if (target.kind === 'vehicle') return { at: target.vehicle.pos, kind: target.kind, id: target.vehicle.id };
  return { at: target.pos, kind: target.kind };
}
function sameTarget(a: Aim, t: ReturnType<typeof identity>): boolean {
  return a.targetKind === t.kind && a.targetId === t.id && dist(a.at, t.at) * TILE_M < (t.kind === 'point' ? 1.5 : 4);
}

export function observeInfantryMotion(s: Soldier, now: number): void {
  const m = memory(s);
  if (dist(m.lastPos, s.pos) * TILE_M > 0.02 || (advancing(s) && !s.aiming)) m.movedAt = now;
  m.lastPos = { ...s.pos };
}

export function clearInfantryAim(s: Soldier): void {
  s.aiming = undefined;
  const m = memories.get(s);
  if (m) m.shot = undefined;
}

/** A man on a movement order covers another short bound between aimed shots. */
export function infantryCanAim(s: Soldier, now: number): boolean {
  return !advancing(s) || now >= memory(s).walkUntil;
}

/** Deliberate game-time acquisition/settling, separate from the weapon's mechanical cycle.
 * These are gameplay timings, varying with range, handling, training and current condition. */
function aimSeconds(s: Soldier, weapon: WeaponDef, at: Vec2, now: number, followUp: boolean, hip = false): number {
  const light = weapon.cls === 'smg' || weapon.cls === 'pistol';
  const mg = weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg';
  const heavy = weapon.cls === 'atrifle' || weapon.cls === 'atrocket' || weapon.cls === 'atgun';
  const range = Math.min(1.6, dist(s.pos, at) * TILE_M * 0.004);
  const turn = Math.abs(wrapAngle(angleTo(s.pos, at) - facingAngle(s.facing))) / Math.PI;
  const base = followUp ? (light ? 0.6 : mg ? 0.85 : heavy ? 1.5 : 0.95)
    : (light ? 0.8 : mg ? 2.1 : heavy ? 3 : 1.8) + turn + (weapon.id.includes('scoped') ? 1.2 : 0);
  const settle = !followUp && now - memory(s).movedAt < 1 ? 0.8 : 0;
  const skill = 1.3 - clamp(s.experience, 0, 100) * 0.006;
  const condition = 1 + s.fatigue * 0.008 + s.suppression * 0.008 + (s.health === 'wounded' ? 0.35 : 0);
  return Math.max(0.5, (base + range * (followUp ? 0.3 : 1) + settle) * skill * condition * (hip ? 0.6 : 1));
}

export function infantryAimReady(s: Soldier, weapon: WeaponDef, target: Target, team: Team | undefined, now: number, rng?: Rng): boolean {
  const t = identity(target), m = memory(s);
  let aim = s.aiming;
  if (!aim || !sameTarget(aim, t) || aim.weaponId !== weapon.id || aim.stance !== s.stance
    || dist(aim.from, s.pos) * TILE_M > 0.3 || aim.orderAt !== team?.order?.issuedAt || aim.orderType !== team?.order?.type) {
    const followUp = !!m.shot && now - m.shotAt < 8 && sameTarget(m.shot, t)
      && m.shot.weaponId === weapon.id && m.shot.stance === s.stance && dist(m.shot.from, s.pos) * TILE_M <= 0.3;
    const handling = weapon.cls === 'smg' && rng ? chooseSmgHandling(s, t.at, team, rng) : undefined;
    const hasty = hastyFireKind(s, weapon, t.at, team);
    const turnS = Math.abs(wrapAngle(angleTo(s.pos, t.at) - facingAngle(s.facing))) / Math.PI * 0.6;
    const duration = hasty ? (hasty === 'panic' ? 0.18 : weapon.cls === 'lmg' ? 0.5 : 0.3) + turnS
      : aimSeconds(s, weapon, t.at, now, followUp, handling?.mode === 'hip');
    aim = s.aiming = {
      startedAt: now, readyAt: now + duration, fromFacing: facingAngle(s.facing),
      from: { ...s.pos }, at: { ...t.at }, targetKind: t.kind, targetId: t.id, weaponId: weapon.id,
      stance: s.stance, orderAt: team?.order?.issuedAt, orderType: team?.order?.type,
      fireMode: handling?.mode, uncontrolled: handling?.uncontrolled, hasty,
    };
  }
  aim.at = { ...t.at };
  const progress = clamp((now - aim.startedAt) / Math.min(1.2, aim.readyAt - aim.startedAt), 0, 1);
  const turn = progress * progress * (3 - 2 * progress);
  const heading = aim.fromFacing + wrapAngle(angleTo(s.pos, aim.at) - aim.fromFacing) * turn;
  s.facing = facingFromAngle(weapon.cls === 'smg' ? smgBodyFacing(aim.fromFacing, heading, s.stance === 'prone') : heading);
  return now >= aim.readyAt;
}

export function infantryDidFire(s: Soldier, now: number): void {
  const m = memory(s);
  if (s.aiming) m.shot = s.aiming;
  m.shotAt = now;
  m.walkUntil = advancing(s) ? now + 3 : now;
  s.aiming = undefined;
}
