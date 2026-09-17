import { PASSENGER_FIRE_MUL } from './transport';
import type {
  AimPoint, BattleEvent, BattleMessage, BattleState, Health, RoundType, Side, Soldier, Team, Vec2, Vehicle, WeaponDef,
} from '@/shared/types';
import type { GameMap, Terrain } from '@/shared/types';
import { AMBUSH_TRIGGER_M, TILE_M, otherSide } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingAngle, facingTo, angleTo, turnTowards, wrapAngle } from '@/shared/math';
import { hitChance, penetrates, damageRoll } from './ballistics';
import { tileAt, coverAt, setTile, idx, inBounds } from './map';
import { isPassable } from './path';
import { hasLOS, eyeHeightM, EYE_VEHICLE_M } from './los';
import { addSmoke } from './smoke';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';
import { coverFrom } from './cover';
import { applyDaze, isDazed, recoveryFactor } from './daze';
import { onIncomingFire, onExplosionNear, onOwnWound, onCasualtySeen, onGunnerHit, onFired, isFirstFireFrozen, addStress, onKnockedDown } from './mind';
import { isVehicleReversing, onVehicleHit, onVehicleNearMiss } from './vehicle';
import {
  COARSE_LAY_RAD, FIRE_HALT_GAP_S, FIRE_HALT_MAX_S, FIRE_ON_MOVE_MUL, LAY_TOLERANCE_RAD, READY_RACK_RESTOCK_S, SNAP_SHOT_MIN,
  SNAP_SHOT_MIN_EXPERIENCE, bracketLost, bracketMul, crewShaken, designateS, fineLayS, followUpS, gunArcRad, loadPaceMul,
  timeToFirstShotS, turretTraverseRad, vehicleCommander, vehicleLoadS,
} from './gunTiming';
import { isButtonedUp } from './vehicleVision';
import type { CrewEffects } from './vehicleDamage';
import type { VehicleDef } from '@/shared/types';
import {
  AIM_HOLD_MAX_S, AIMED_MAX_M, SKILL_ACE, SKILL_REGULAR, SPOT_MISS_STILL_HITS, aimLayMul, bestChance, chooseAimPoint, chooseRound,
  gunnerSkill, noteOutOf, soldierRounds, spotHitMul, vehicleRounds,
} from './aimPoint';
import {
  coaxUsable, crewEffects, expectedArmorMm, isImmobile, mainGunUsable, onBlastNearVehicle, resolveVehicleHit, sightAccuracyMul,
  turretFrozen, vehicleLayout,
} from './vehicleDamage';
import { attackPhase } from './orders';
import {
  fireMissionWait, onMissionRound, crewFeedsAmmo, hasChamberedRound, takeChamberedRound, chamberedRoundType, missionAimPoint,
  missionBracketMul, onMissionShotAtVehicle,
} from './crewWeapon';
import { observerVisibility } from './spotting';
import { applyBlastDamage } from './structures';
import { blastThrowEnd, dismember, isSevereBlast, throwDebris } from './debris';
import { dropKit, shedGearInBlast, throwItems } from './items';
import type { Order } from '@/shared/types';

export { hitChance, penetrates };

// ---------------------------------------------------------------- tracking
interface CombatTrack {
  grenadeTimer: Map<number, number>;
  outOfAmmoMessaged: Set<number>;
  smokeRounds: Map<number, { count: number; lastAt: number }>;
  /** small-arms (rifle/smg/lmg/hmg/pistol/coaxmg) rounds fired/landed-as-hits vs soldiers,
   * for the balance harness's "hit rate" metric (see tools/simHarness / test/harness.test.ts). */
  smallArmsFired: number;
  smallArmsHit: number;
  /** Balance round 4 instrumentation (see test/harness.test.ts): total shots fired, suppression
   * points applied to the enemy, and mortar HE rounds fired, all keyed by the FIRING side. */
  shotsFiredBySide: Record<Side, number>;
  suppressionAppliedBySide: Record<Side, number>;
  mortarRoundsFiredBySide: Record<Side, number>;
  /** spec §4: MG/rifle suppressive fire on a `fired` belief happens every 3rd opportunity. */
  beliefFireCounter: Map<number, number>;
}

const tracks = new WeakMap<BattleState, CombatTrack>();

function getTrack(state: BattleState): CombatTrack {
  let t = tracks.get(state);
  if (!t) {
    t = {
      grenadeTimer: new Map(), outOfAmmoMessaged: new Set(), smokeRounds: new Map(),
      smallArmsFired: 0, smallArmsHit: 0,
      shotsFiredBySide: { german: 0, soviet: 0 },
      suppressionAppliedBySide: { german: 0, soviet: 0 },
      mortarRoundsFiredBySide: { german: 0, soviet: 0 },
      beliefFireCounter: new Map(),
    };
    tracks.set(state, t);
  }
  return t;
}

const SMALL_ARMS_CLASSES = new Set(['rifle', 'smg', 'lmg', 'hmg', 'pistol', 'coaxmg']);

/** Small-arms shots-fired/hits vs soldiers so far, for balance analysis (see harness). */
export function getSmallArmsStats(state: BattleState): { fired: number; hit: number } {
  const t = getTrack(state);
  return { fired: t.smallArmsFired, hit: t.smallArmsHit };
}

function addShots(state: BattleState, side: Side, n: number): void {
  getTrack(state).shotsFiredBySide[side] += n;
}

function addSuppressionStat(state: BattleState, side: Side, amount: number): void {
  getTrack(state).suppressionAppliedBySide[side] += amount;
}

/** Balance round 4 instrumentation: cumulative shots fired / suppression applied (to the enemy) /
 * mortar HE rounds fired, by firing side, for the whole battle so far. */
export function getCombatInstrumentation(state: BattleState): {
  shotsFiredBySide: Record<Side, number>;
  suppressionAppliedBySide: Record<Side, number>;
  mortarRoundsFiredBySide: Record<Side, number>;
} {
  const t = getTrack(state);
  return {
    shotsFiredBySide: { ...t.shotsFiredBySide },
    suppressionAppliedBySide: { ...t.suppressionAppliedBySide },
    mortarRoundsFiredBySide: { ...t.mortarRoundsFiredBySide },
  };
}

// ------------------------------------------------------------------ target
export type Target =
  | { kind: 'soldier'; soldier: Soldier }
  | { kind: 'vehicle'; vehicle: Vehicle }
  | { kind: 'point'; pos: Vec2 };

function targetPosOf(target: Target): Vec2 {
  switch (target.kind) {
    case 'soldier': return target.soldier.pos;
    case 'vehicle': return target.vehicle.pos;
    case 'point': return target.pos;
  }
}

function tracerKindFor(weapon: WeaponDef): 'bullet' | 'mg' | 'shell' | 'mortar' {
  if (weapon.cls === 'mortar') return 'mortar';
  if (weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket') return 'shell';
  if (weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg') return 'mg';
  return 'bullet';
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

function canSoldierFire(s: Soldier, state: BattleState): boolean {
  if (s.vehicleId != null) {
    // passengers fire over the sides of a HALTED transport (badly); crews never with their own arms
    if (s.seat !== 'passenger') return false;
    const ride = state.vehicles.get(s.vehicleId);
    if (!ride || Math.abs(ride.speed) > 0.05 || (ride.state !== 'ok' && ride.state !== 'immobilized')) return false;
  }
  if (isStunned(s, state.time) || isDazed(s, state.time)) return false; // dazed: no fire, no reload (sim/daze.ts)
  if (s.pickup?.until != null) return false; // stooping over an item (sim/pickup.ts)
  if (s.hatch) return false; // climbing through a hatch (sim/vehicleCrew.ts)
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'panicked' || s.activity === 'cowering') return false;
  if (isFirstFireFrozen(state, s.id)) return false;
  return !!WEAPONS[s.weaponId];
}

function gatherCandidates(state: BattleState, side: Side): { soldiers: Soldier[]; vehicles: Vehicle[] } {
  const soldiers: Soldier[] = [];
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated') soldiers.push(s);
  }
  const vehicles: Vehicle[] = [];
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    if (v && v.state !== 'knockedOut' && v.state !== 'burning') vehicles.push(v);
  }
  return { soldiers, vehicles };
}

// ------------------------------------------------------- attack-unit targeting
/** Weapons that may put suppressive fire on a last known / unseen position (not single-shot AT). */
/** Attack-unit order: a soldier with no shot at his target still engages enemies this close. */
const SELF_DEFENCE_M = 50;
const AREA_FIRE_CLASSES = new Set(['rifle', 'smg', 'lmg', 'hmg', 'coaxmg', 'mortar', 'tankgun']);
/** MG gunners rotate their bursts across the best few members of the target team. */
const mgSpread = new WeakMap<BattleState, Map<number, number>>();

function exposureScore(state: BattleState, shooterPos: Vec2, victim: Soldier): number {
  const cover = coverFrom(state.map, victim.pos, angleTo(victim.pos, shooterPos));
  const st = victim.stance === 'standing' ? 1 : victim.stance === 'crouching' ? 0.7 : 0.45;
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const dM = dist(shooterPos, victim.pos) * TILE_M;
  return (1 - cover * 0.8) * st * (moving ? 1.2 : 1) / (1 + dM / 100);
}

/** Target selection for a soldier under an attack-unit Fire order: the best member of the target
 * team HE can engage (spotted, in range, LOS from his own position); otherwise suppress the tracked
 * / last known position with an area weapon, or wait. Returns 'free' in the hold phase so normal
 * (defend-like) selection applies. */
function pickAttackUnitTarget(
  state: BattleState, soldier: Soldier, weapon: WeaponDef, order: Order, inRangeLOS: (p: Vec2) => boolean,
): Target | null | 'free' {
  const phase = attackPhase(state, order);
  if (phase === 'hold') return 'free';
  const tgt = state.teams.get(order.targetTeamId!);
  if (!tgt) return 'free';
  if (phase === 'tracking') {
    if (tgt.vehicleId != null) {
      const v = state.vehicles.get(tgt.vehicleId);
      const def = v ? VEHICLE_DEFS[v.defId] : undefined;
      const canHurt = AT_WEAPON_CLASSES.has(weapon.cls)
        || ((weapon.cls === 'rifle' || weapon.cls === 'smg' || weapon.cls === 'lmg' || weapon.cls === 'hmg') && !!def && def.armor.side < 20);
      if (v && canHurt && state.spottedVehicles[soldier.side].has(v.id) && v.state !== 'knockedOut' && inRangeLOS(v.pos)) {
        return { kind: 'vehicle', vehicle: v };
      }
      return null; // no point hosing armour with small arms; wait for a shot
    }
    const cands: { s: Soldier; score: number }[] = [];
    for (const id of tgt.soldierIds) {
      if (!state.spotted[soldier.side].has(id)) continue;
      const e = state.soldiers.get(id);
      if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
      if (!inRangeLOS(e.pos)) continue;
      cands.push({ s: e, score: exposureScore(state, soldier.pos, e) });
    }
    if (cands.length > 0) {
      cands.sort((a, b) => b.score - a.score || a.s.id - b.s.id);
      let i = 0;
      if (weapon.cls === 'lmg' || weapon.cls === 'hmg') {
        let m = mgSpread.get(state);
        if (!m) { m = new Map(); mgSpread.set(state, m); }
        const n = (m.get(soldier.id) ?? 0) + 1;
        m.set(soldier.id, n);
        i = n % Math.min(cands.length, 3);
      }
      return { kind: 'soldier', soldier: cands[i].s };
    }
  }
  // no personal shot at a member (tracking) or target lost (suppress): area fire at the ball
  if (AREA_FIRE_CLASSES.has(weapon.cls) && inRangeLOS(order.target)) return { kind: 'point', pos: order.target };
  return null;
}

/** Test hook: the target a soldier would engage right now (same rules as stepSoldierCombat). */
export function pickSoldierTargetForTest(state: BattleState, soldier: Soldier): Target | null {
  const weapon = WEAPONS[soldier.weaponId];
  return weapon ? pickTarget(state, soldier, state.teams.get(soldier.teamId), weapon) : null;
}

function pickTarget(state: BattleState, soldier: Soldier, team: Team | undefined, weapon: WeaponDef): Target | null {
  const map = state.map;
  if (soldier.activity === 'movingFast') return null;

  let maxRangeM = weapon.rangeM;
  if (soldier.activity === 'sneaking') maxRangeM = Math.min(maxRangeM, 20);
  // Balance fix (suspect b follow-up): 60m capped a 'moving' attacker's return fire well short of
  // where the defender (stationary, unrestricted weapon range) could already be hitting them —
  // raised to 100m so an advancing team can shoot back for more of its approach.
  else if (soldier.activity === 'moving') maxRangeM = Math.min(maxRangeM, 100);

  const order = team?.order;
  if (order?.type === 'ambush') maxRangeM = Math.min(maxRangeM, AMBUSH_TRIGGER_M);
  if (order?.type === 'smoke') return null;

  // A firer's sightline starts at his own eye height and ends at the target's silhouette, so a
  // crest between them masks the shot for a prone man where a standing one still has it.
  const firerEyeM = eyeHeightM(soldier.stance);
  const inRangeLOS = (pos: Vec2): boolean => {
    const dM = dist(soldier.pos, pos) * TILE_M;
    if (dM > maxRangeM) return false;
    return hasLOS(map, soldier.pos, pos, { eyeM: firerEyeM });
  };

  const { soldiers: cands, vehicles: vcands } = gatherCandidates(state, soldier.side);
  const preferVehicles = AT_WEAPON_CLASSES.has(weapon.cls);

  if (order?.type === 'fire' && order.target && order.targetTeamId != null) {
    const picked = pickAttackUnitTarget(state, soldier, weapon, order, inRangeLOS);
    if (picked) {
      if (picked !== 'free') return picked;
      // 'hold' phase: watch the last known position but defend against anything that shows up
    } else {
      // No shot at the target unit: he keeps his position and waits, but still defends himself
      // against an enemy at close range (SELF_DEFENCE_M) rather than ignoring it.
      maxRangeM = Math.min(maxRangeM, SELF_DEFENCE_M);
    }
  } else if (order?.type === 'fire' && order.target) {
    const nearPoint = (pos: Vec2) => dist(pos, order.target) <= 3;
    let best: Soldier | Vehicle | null = null;
    let bestD = Infinity;
    let bestIsVehicle = false;
    if (preferVehicles) {
      for (const v of vcands) {
        if (!nearPoint(v.pos) || !inRangeLOS(v.pos)) continue;
        const d = dist(soldier.pos, v.pos);
        if (d < bestD) { bestD = d; best = v; bestIsVehicle = true; }
      }
    }
    if (!best) {
      for (const s2 of cands) {
        if (!nearPoint(s2.pos) || !inRangeLOS(s2.pos)) continue;
        const d = dist(soldier.pos, s2.pos);
        if (d < bestD) { bestD = d; best = s2; bestIsVehicle = false; }
      }
    }
    if (best) return bestIsVehicle ? { kind: 'vehicle', vehicle: best as Vehicle } : { kind: 'soldier', soldier: best as Soldier };
    if (inRangeLOS(order.target)) return { kind: 'point', pos: order.target };
    return null;
  }

  let best: Soldier | Vehicle | null = null;
  let bestD = Infinity;
  let bestIsVehicle = false;
  // armour this gun cannot hurt even at the running gear comes last (requirements A2)
  let hopeless: Vehicle | null = null;
  if (preferVehicles) {
    for (const v of vcands) {
      if (!inRangeLOS(v.pos)) continue;
      const d = dist(soldier.pos, v.pos);
      if (d >= bestD) continue;
      if (isHopelessTarget(state, soldier, weapon, v)) { if (!hopeless || d < dist(soldier.pos, hopeless.pos)) hopeless = v; continue; }
      bestD = d; best = v; bestIsVehicle = true;
    }
  } else if (weapon.cls === 'smg' || weapon.cls === 'rifle') {
    for (const v of vcands) {
      const def = VEHICLE_DEFS[v.defId];
      if (!def || def.armor.side >= 20) continue;
      if (!inRangeLOS(v.pos)) continue;
      const d = dist(soldier.pos, v.pos);
      if (d < bestD) { bestD = d; best = v; bestIsVehicle = true; }
    }
  }
  if (!best) {
    for (const s2 of cands) {
      if (!inRangeLOS(s2.pos)) continue;
      const d = dist(soldier.pos, s2.pos);
      if (d < bestD) { bestD = d; best = s2; bestIsVehicle = false; }
    }
  }
  if (best) return bestIsVehicle ? { kind: 'vehicle', vehicle: best as Vehicle } : { kind: 'soldier', soldier: best as Soldier };
  if (hopeless) return { kind: 'vehicle', vehicle: hopeless };

  // spec §4: with no visible enemy, MG/LMG/rifle can put suppressive fire on a `fired` belief
  // (confidence > 0.6, LOS) every 3rd firing opportunity, to conserve ammo. Ambushers never do this
  // (they hold fire until an enemy is actually seen within 30 m).
  const suppressiveClasses = weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'rifle';
  if (suppressiveClasses && order?.type !== 'ambush') {
    const bestBelief = soldier.mind.beliefs
      .filter((b) => b.kind === 'fired' && b.confidence > 0.6 && inRangeLOS(b.pos))
      .sort((a, b) => dist(soldier.pos, a.pos) - dist(soldier.pos, b.pos))[0];
    if (bestBelief) {
      const track = getTrack(state);
      const n = (track.beliefFireCounter.get(soldier.id) ?? 0) + 1;
      track.beliefFireCounter.set(soldier.id, n);
      if (n % 3 === 0) return { kind: 'point', pos: bestBelief.pos };
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ hits
export function applyHit(
  state: BattleState,
  victim: Soldier,
  weapon: WeaponDef,
  rng: Rng,
  killerSide?: Side,
  killer?: Soldier,
): void {
  // A soldier who is already incapacitated or dead cannot be hit again: no re-rolled outcome, no
  // repeated kill/casualty message, no double-counted kill (regression: the same "has been killed"
  // message and kill event firing twice for one soldier because later shots kept landing on an
  // already-incapacitated body before it was excluded from targeting).
  if (victim.health === 'dead' || victim.health === 'incapacitated') return;

  const cover = coverAt(state.map, victim.pos);
  const result: Health | null = damageRoll(weapon, cover, rng);
  if (!result) return;

  if (result === 'wounded') {
    victim.health = 'wounded';
    victim.morale = clamp(victim.morale - 20, 0, 100);
    return;
  }

  victim.health = result;
  if (result === 'incapacitated') {
    victim.activity = 'incapacitated';
    victim.stance = 'prone';
  } else {
    victim.activity = 'dead';
    state.bloodDecals.push({ ...victim.pos });
  }
  onOwnWound(victim);

  const victimTeamForGunner = state.teams.get(victim.teamId);
  const victimWeapon = WEAPONS[victim.weaponId];
  if (victimTeamForGunner && victimWeapon && (victimWeapon.cls === 'lmg' || victimWeapon.cls === 'hmg')) {
    onGunnerHit(state, victimTeamForGunner);
  }

  const killed = result === 'dead';
  if (victimTeamForGunner) {
    for (const id of victimTeamForGunner.soldierIds) {
      if (id === victim.id) continue;
      const teammate = state.soldiers.get(id);
      if (!teammate || teammate.health === 'dead' || teammate.health === 'incapacitated') continue;
      if (dist(teammate.pos, victim.pos) <= 15 && hasLOS(state.map, teammate.pos, victim.pos)) {
        onCasualtySeen(state, rng, teammate, victim, killed);
      }
    }
  }

  const resolvedKillerSide = killerSide ?? otherSide(victim.side);
  const event: BattleEvent = { kind: 'kill', pos: { ...victim.pos }, side: resolvedKillerSide };
  state.events.push(event);
  if (killer) killer.kills++;
  const killerTeam = killer ? state.teams.get(killer.teamId) : undefined;
  if (killerTeam) killerTeam.kills++;
  state.sides[resolvedKillerSide].kills++;
  state.sides[victim.side].losses++;

  if (victim.side === state.config.playerSide) {
    const victimTeam = state.teams.get(victim.teamId);
    const verb = result === 'dead' ? 'killed' : 'wounded';
    addMessage(state, `${victimTeam?.name ?? 'Report'}\n${victim.rank}. ${victim.name} has been ${verb}.`, 'bad');
  } else {
    reportEnemyKill(state, killerTeam);
  }
}

/** Coalesced "Enemy soldier killed." report: one line per killer team within 5 s; further kills in
 * that window update the same line to "N enemy soldiers killed." instead of spamming the log. */
const killReportAt = new WeakMap<BattleState, Map<number, { at: number; count: number; msg: BattleMessage }>>();
function reportEnemyKill(state: BattleState, killerTeam: Team | undefined): void {
  let m = killReportAt.get(state);
  if (!m) { m = new Map(); killReportAt.set(state, m); }
  const key = killerTeam?.id ?? -1;
  const prev = m.get(key);
  const name = killerTeam?.name ?? 'Report';
  if (prev && state.time - prev.at < 5 && state.messages.includes(prev.msg)) {
    prev.count++;
    prev.msg.text = `${name}\n${prev.count} enemy soldiers killed.`;
    return;
  }
  addMessage(state, `${name}\nEnemy soldier killed.`, 'good');
  m.set(key, { at: state.time, count: 1, msg: state.messages[state.messages.length - 1] });
}

// ------------------------------------------------------------------ blast knockback (§4)

/** True while a blast knock-down keeps this man from moving, firing or throwing. */
export function isStunned(s: Soldier, time: number): boolean {
  return s.stunnedUntil != null && time < s.stunnedUntil;
}

/** Blast force on a man `dTiles` from a burst of `weapon`: falls off linearly to the edge of the
 * HE radius and scales with the size of the explosive (grenade ~0.45, mortar ~1, heavy HE 1.5). */
export function blastForce(weapon: WeaponDef, dTiles: number): number {
  const radiusTiles = weapon.heRadiusM / TILE_M;
  if (radiusTiles <= 0 || dTiles > radiusTiles) return 0;
  return (1 - dTiles / radiusTiles) * clamp(weapon.heRadiusM / 6, 0.4, 1.5);
}

/** Spec 2026-09-17 §4, sim side: an HE burst throws a man 0.5-15 m straight away from it (scaled
 * by force; never through a wall, a vehicle, water or off the map — it stops at the last passable
 * point), records the `blast` for the renderer's ragdoll, and knocks a SURVIVOR inside the inner
 * half of the radius down: prone, path dropped, unable to act for 1.5-4 s (longer when wounded or
 * green) with a stress spike through the mind's own hook. Seeded Rng only. */
export function applyBlastKnockback(state: BattleState, rng: Rng, s: Soldier, burst: Vec2, weapon: WeaponDef, woundedByIt = false): void {
  const radiusTiles = weapon.heRadiusM / TILE_M;
  const d = dist(s.pos, burst);
  const force = blastForce(weapon, d);
  if (force <= 0.05) return;
  const ang = d > 1e-3 ? Math.atan2(s.pos.y - burst.y, s.pos.x - burst.x) : rng.range(0, Math.PI * 2);
  // User request: a big enough, close enough blast throws a man up to 15 m. Quadratic in force, so
  // a grenade at arm's length gives about 5 m, a mortar bomb about 10 m, a heavy shell the full 15 m.
  const throwM = clamp(1 + force * force * 9.5, 1, 15);
  const origin = { x: s.pos.x, y: s.pos.y };
  // the ground trace is shared with corpses, kit and body parts (debris.ts)
  const p = blastThrowEnd(state, origin, ang, throwM);
  s.pos = { x: p.x, y: p.y };
  s.blast = { from: { x: burst.x, y: burst.y }, time: state.time, force, origin };
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  if (d > radiusTiles / 2) return;
  let stun = rng.range(1.5, 3);
  if (s.health === 'wounded') stun += 0.6;
  if (s.experience < 35) stun += 0.5;
  s.stunnedUntil = state.time + Math.min(4, stun);
  // then dazed, then recovering (sim/daze.ts): experience shortens it, a second blast extends it
  applyDaze(state, s, force, woundedByIt);
  s.stance = 'prone';
  s.path = [];
  onKnockedDown(s, force);
}

/** Spec 2026-09-17 §8 / §9: everything loose inside a burst is thrown like the living — the dead
 * and the incapacitated (a severe blast breaks the body up), the kit on the ground, body parts. */
export function throwLooseObjects(state: BattleState, rng: Rng, burst: Vec2, weapon: WeaponDef, skip?: ReadonlySet<number>): void {
  const radiusTiles = weapon.heRadiusM / TILE_M;
  if (radiusTiles <= 0) return;
  for (const s of state.soldiers.values()) {
    if (s.health !== 'dead' && s.health !== 'incapacitated') continue;
    if (s.vehicleId != null || s.dismembered || skip?.has(s.id)) continue;
    if (Math.abs(s.pos.x - burst.x) > radiusTiles || Math.abs(s.pos.y - burst.y) > radiusTiles) continue;
    const d = dist(s.pos, burst);
    if (d > radiusTiles) continue;
    dropKit(state, rng, s);
    applyBlastKnockback(state, rng, s, burst, weapon);
    if (isSevereBlast(weapon, d)) dismember(state, rng, s, burst, blastForce(weapon, d));
  }
  const forceAt = (dTiles: number): number => blastForce(weapon, dTiles);
  throwItems(state, rng, burst, radiusTiles, forceAt);
  throwDebris(state, rng, burst, radiusTiles, forceAt);
}

export function applyHESplash(state: BattleState, rng: Rng, pos: Vec2, weapon: WeaponDef, shooterSide: Side, from?: Vec2, skipVehicleId?: number): void {
  const map = state.map;
  const radiusTiles = weapon.heRadiusM / TILE_M;
  if (radiusTiles > 0) {
    // men this burst gets to act on as living targets; the bodies already lying there are thrown
    // afterwards (throwLooseObjects), so nobody is thrown twice by one burst
    const hitNow = new Set<number>();
    for (const s of state.soldiers.values()) {
      if (s.health === 'dead' || s.health === 'incapacitated') continue;
      // Crew inside a vehicle are protected by its armor; HE splash (including a shell that
      // failed to penetrate the vehicle it hit) must not roll casualties/suppression against
      // them here. What a burst does to a vehicle and the men in it is onBlastNearVehicle below.
      if (s.vehicleId != null) continue;
      const d = dist(s.pos, pos);
      if (d > radiusTiles) continue;
      hitNow.add(s.id);
      const cover = coverAt(map, s.pos);
      const healthBefore = s.health;
      const chance = (1 - d / radiusTiles) * weapon.lethality * (1 - cover * 0.7);
      if (rng.chance(chance)) {
        applyHit(state, s, weapon, rng, shooterSide);
      } else {
        const amount = weapon.suppression * 30;
        s.suppression = clamp(s.suppression + amount, 0, 100);
        addSuppressionStat(state, shooterSide, amount);
      }
      // a casualty of this burst leaves his kit where he stood, before he (and it) is thrown
      const health = s.health as Health; // applyHit may have changed it
      const down = health === 'dead' || health === 'incapacitated';
      if (down) dropKit(state, rng, s);
      applyBlastKnockback(state, rng, s, pos, weapon, healthBefore !== 'wounded' && health === 'wounded');
      shedGearInBlast(state, rng, s, pos, blastForce(weapon, d));
      // spec 2026-09-17 §8: a severe blast tears the casualty apart
      if (down && isSevereBlast(weapon, d)) dismember(state, rng, s, pos, blastForce(weapon, d));
    }
    throwLooseObjects(state, rng, pos, weapon, hitNow);
  }
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    onExplosionNear(state, s, pos);
  }
  // bursts on or beside enemy vehicles: top hits, fragments into open compartments
  if (radiusTiles > 0) {
    for (const v of state.vehicles.values()) {
      if (v.id === skipVehicleId || v.side === shooterSide) continue;
      if (Math.abs(v.pos.x - pos.x) > radiusTiles + 1 || Math.abs(v.pos.y - pos.y) > radiusTiles + 1) continue;
      onBlastNearVehicle(state, rng, v, pos, weapon, shooterSide);
    }
  }

  const kind = weapon.heRadiusM >= 3 ? 'he' : 'small';
  state.explosions.push({ pos: { ...pos }, radiusM: weapon.heRadiusM, t: 0, kind });
  state.events.push({ kind: 'explosion', pos: { ...pos }, side: shooterSide, weaponId: weapon.id });
  leaveCrater(state, pos, weapon);
  applyBlastDamage(state, pos, weapon, { side: shooterSide, from });
}

/** A shell fired flat by a gun crew (AT gun, infantry gun, Panzerfaust) bursts where it lands.
 * resolveRound has already rolled the direct hit and the suppression it causes, so this adds only
 * what an explosion does to the WORLD — the burst effect, the ground mark and the structure damage
 * — never a second casualty roll against the men it has already been resolved against. Without it
 * a gun crew could shell a building all day and never scratch it: applyHESplash is reached only
 * from the vehicle, mortar and grenade paths. */
function heBurstAt(state: BattleState, rng: Rng, pos: Vec2, weapon: WeaponDef, shooter: Soldier): void {
  if (weapon.heRadiusM <= 0 || weapon.cls === 'flamethrower' || weapon.cls === 'grenade') return;
  state.explosions.push({ pos: { ...pos }, radiusM: weapon.heRadiusM, t: 0, kind: weapon.heRadiusM >= 3 ? 'he' : 'small' });
  state.events.push({ kind: 'explosion', pos: { ...pos }, side: shooter.side, weaponId: weapon.id });
  leaveCrater(state, pos, weapon);
  applyBlastDamage(state, pos, weapon, { side: shooter.side, from: shooter.pos });
  // the bodies, kit and parts lying there are part of the world too (spec 2026-09-17 §8 / §9)
  throwLooseObjects(state, rng, pos, weapon);
}

/** Blast mark size by explosive: grenade ~1 m scorched hole, AT rocket a small scorch, mortar
 * ~2.5 m, tank/AT gun HE 2.6-3.8 m by calibre (heRadiusM), heavy (122 mm+) ~5 m. */
export function craterForWeapon(weapon: WeaponDef): { sizeM: number; kind: 'shell' | 'grenade' } | null {
  if (weapon.heRadiusM <= 0 || weapon.cls === 'flamethrower') return null;
  if (weapon.cls === 'grenade') return { sizeM: 1, kind: 'grenade' };
  if (weapon.cls === 'atrocket') return { sizeM: 1.2, kind: 'grenade' };
  if (weapon.cls === 'mortar') return { sizeM: 2.5, kind: 'shell' };
  const r = weapon.heRadiusM;
  return { sizeM: r >= 8 ? 5 : r >= 5 ? 3.8 : r >= 4 ? 3.2 : 2.6, kind: 'shell' };
}

/** Ground a blast leaves a visible mark on (never buildings, water, bridges or inside woods). */
const MARKABLE_TERRAIN = new Set<Terrain>(['open', 'grass', 'tallgrass', 'crops', 'snow', 'mud', 'dirtroad', 'pavedroad', 'crater', 'trench', 'scatteredtrees', 'rubble']);
/** Ground a blast of heRadiusM >= 4 digs a real 'crater' tile into (crater cover, passable — a
 * dirt road tile stays passable as a crater). This tile rule is deliberately the long-standing,
 * balance-tuned one (the AI harness is sensitive to crater cover near assaults); only the
 * VISIBLE mark is sized by weapon. */
const CRATERABLE_TERRAIN = new Set<Terrain>(['open', 'grass', 'tallgrass', 'crops', 'snow', 'mud', 'dirtroad']);

function leaveCrater(state: BattleState, pos: Vec2, weapon: WeaponDef): void {
  const map: GameMap = state.map;
  const c = craterForWeapon(weapon);
  if (!c) return;
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  const t = tileAt(map, tx, ty);
  if (!MARKABLE_TERRAIN.has(t)) return;
  let onVehicle = false;
  for (const v of state.vehicles.values()) if (dist(v.pos, pos) < 1.2) { onVehicle = true; break; }
  // the visible bowl + ejecta must not spill over a wall, roof or river bank: shrink it to fit
  let sizeM = c.sizeM;
  const reach = Math.ceil(sizeM / TILE_M);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const nt = tileAt(map, tx + dx, ty + dy);
      if (nt !== 'buildingStone' && nt !== 'buildingWood' && nt !== 'floor' && nt !== 'water' && nt !== 'bridge') continue;
      // distance (m) from the blast to the nearest edge of that tile, and the rim that fits
      const ex = Math.max(tx + dx - pos.x, 0, pos.x - (tx + dx + 1));
      const ey = Math.max(ty + dy - pos.y, 0, pos.y - (ty + dy + 1));
      sizeM = Math.min(sizeM, Math.hypot(ex, ey) * TILE_M * 0.9);
    }
  }
  sizeM = Math.max(0.8, sizeM);
  const marks = (map.craterMarks ??= []);
  // repeated rounds into the same spot deepen one hole rather than stacking identical marks
  // (a round bursting on a vehicle's hull only scorches the ground under it)
  const kind = onVehicle ? 'grenade' : c.kind;
  if (onVehicle) sizeM = Math.min(sizeM, 1.2);
  if (!marks.some((m) => m.kind === kind && m.sizeM >= sizeM && dist(m, pos) < 0.35)) {
    marks.push({ x: pos.x, y: pos.y, sizeM: Math.round(sizeM * 100) / 100, kind });
  }
  if (weapon.heRadiusM < 4 || !CRATERABLE_TERRAIN.has(t)) return;
  setTile(map, tx, ty, 'crater');
  map.craters.push(idx(map, tx, ty));
}

/** No round this gunner has can get through the plate facing him, and he is not the man (or it is
 * too far, or pointless) to go for the tracks. */
function isHopelessTarget(state: BattleState, soldier: Soldier, weapon: WeaponDef, v: Vehicle): boolean {
  const def = VEHICLE_DEFS[v.defId];
  if (!def || weapon.penetrationMm <= 0) return false;
  const distM = dist(soldier.pos, v.pos) * TILE_M;
  const counts = weapon.rounds ? soldierRounds(state, soldier) : null;
  if (bestChance(weapon, counts, distM, expectedArmorMm(v, def, soldier.pos, 'mass'), state.config.year).chance >= 0.05) return false;
  return gunnerSkill(soldier) < SKILL_REGULAR || distM > AIMED_MAX_M || isImmobile(v);
}

const roundWeapons = new Map<string, WeaponDef>();
/** The weapon as it behaves with `round` loaded: AP and APCR shot do not burst. */
function roundWeapon(weapon: WeaponDef, round: RoundType): WeaponDef {
  if (!weapon.rounds || round === 'he' || round === 'smoke') return weapon;
  const key = `${weapon.id}:${round}`;
  let w = roundWeapons.get(key);
  if (!w) { w = { ...weapon, heRadiusM: 0 }; roundWeapons.set(key, w); }
  return w;
}

interface VehicleShot {
  round?: RoundType;
  aimPoint?: AimPoint;
  /** gunner skill 0..1 (aimed shots) */
  skill?: number;
  shooterTeamId?: number;
}

/** One round at a vehicle: `p` is the chance to hit it at all. An aimed round lands on its spot
 * with the smaller spot chance; most of the rest still hit the vehicle somewhere; every hit goes
 * through the ONE locational damage model (sim/vehicleDamage.ts). */
function fireAtVehicle(
  state: BattleState,
  rng: Rng,
  weapon: WeaponDef,
  shooterPos: Vec2,
  shooterSide: Side,
  vehicle: Vehicle,
  p: number,
  wantTracer: boolean,
  shot: VehicleShot = {},
): boolean {
  const kind = tracerKindFor(weapon);
  const round: RoundType = shot.round ?? 'ap';
  const aim: AimPoint = shot.aimPoint ?? 'mass';
  const distM = dist(shooterPos, vehicle.pos) * TILE_M;
  const pSpot = aim === 'mass' ? p : p * spotHitMul(aim, distM, Math.abs(vehicle.speed) > 0.1, shot.skill ?? 0.7);
  const pAny = aim === 'mass' ? p : pSpot + (p - pSpot) * SPOT_MISS_STILL_HITS;
  const r = rng.next();
  if (r >= pAny) {
    if (wantTracer) state.tracers.push({ from: { ...shooterPos }, to: { ...vehicle.pos }, t: 0, hit: false, kind });
    onVehicleNearMiss(state, vehicle, weapon, shooterPos);
    return false;
  }
  if (wantTracer) state.tracers.push({ from: { ...shooterPos }, to: { ...vehicle.pos }, t: 0, hit: true, kind });

  const res = resolveVehicleHit(state, rng, vehicle, {
    weapon, round, shooterPos, shooterSide, shooterTeamId: shot.shooterTeamId, distM,
    aimPoint: aim !== 'mass' && r < pSpot ? aim : undefined,
  });
  if (!res.penetrated) state.events.push({ kind: 'hit', pos: { ...vehicle.pos }, side: shooterSide });
  if (vehicle.state !== 'knockedOut' && vehicle.state !== 'burning') {
    onVehicleHit(state, vehicle, weapon, res.penetrated, { ...shooterPos });
  }

  const rw = roundWeapon(weapon, round);
  if (rw.heRadiusM > 0) applyHESplash(state, rng, vehicle.pos, rw, shooterSide, undefined, vehicle.id);
  else if (weapon.rounds) state.explosions.push({ pos: { ...vehicle.pos }, radiusM: 0, t: 0, kind: 'small' });
  return true;
}

// -------------------------------------------------------------- firing
// Balance round 4: near-miss suppression radius widened 1 -> 1.5 tiles (3m) so that massed fire
// aimed near a group (not scoring an actual hit) suppresses the whole group, not just whoever
// happens to stand within 2m of the exact impact point — this is what should be making defenders
// stop shooting back under heavy incoming fire even when the attacker's low hit-chance-in-cover
// means they rarely actually kill anyone (see the suppression fire-rate throttle in
// stepSoldierCombat below, which is what actually converts this suppression into fewer shots back).
const SUPPRESSION_SPLASH_RADIUS_TILES = 1.5;

const NOISE_RADIUS_TILES = 100 / TILE_M;

/** Cheap "noise" stress (spec §2) for soldiers of the affected side within 100 m of an impact, using
 * a loop the caller already runs over all soldiers for splash suppression (no extra O(N) scan). */
function maybeNoiseStress(s2: Soldier, impact: Vec2, weaponCls: WeaponDef['cls']): void {
  if (weaponCls === 'rifle' || weaponCls === 'pistol') return; // only MG bursts / guns / explosions count as "noise"
  if (dist(s2.pos, impact) > NOISE_RADIUS_TILES) return;
  addStress(s2.mind, 1 * (1 - (s2.cover ?? 0) * 0.5));
}

function resolveRound(state: BattleState, rng: Rng, shooter: Soldier, weapon: WeaponDef, target: Target, wantTracer: boolean): void {
  const map = state.map;
  if (target.kind === 'point') {
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      const dTiles = dist(s2.pos, target.pos);
      if (dTiles <= SUPPRESSION_SPLASH_RADIUS_TILES) {
        const amount = weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5);
        s2.suppression = clamp(s2.suppression + amount, 0, 100);
        addSuppressionStat(state, shooter.side, amount);
        onIncomingFire(state, rng, s2, shooter, target.pos, weapon.cls);
      } else {
        maybeNoiseStress(s2, target.pos, weapon.cls);
      }
    }
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...target.pos }, t: 0, hit: false, kind: tracerKindFor(weapon) });
    if (weapon.heRadiusM === 0) state.explosions.push({ pos: { ...target.pos }, radiusM: 0, t: 0, kind: 'small' });
    else heBurstAt(state, rng, target.pos, weapon, shooter);
    return;
  }

  if (target.kind === 'vehicle') {
    const vehicle = target.vehicle;
    const distM = dist(shooter.pos, vehicle.pos) * TILE_M;
    const moving = vehicle.speed > 0.1;
    const p = hitChance(weapon, distM, 0, 'standing', shooter, moving) * (shooter.seat === 'passenger' ? PASSENGER_FIRE_MUL : 1) * recoveryFactor(shooter, state.time);
    const team = state.teams.get(shooter.teamId);
    const crewServed = !!team?.crewWeapon && team.crewWeapon.gunnerId === shooter.id;
    const skill = gunnerSkill(shooter);
    // a gun's layer chose his aim point when he laid (crewWeapon.ts); an AT rifleman / rocket man as he fires
    const aimPoint = weapon.penetrationMm <= 0 ? 'mass'
      : crewServed ? missionAimPoint(team, vehicle.id)
        : chooseAimPoint(weapon, null, skill, shooter.pos, vehicle, state.config.year).aimPoint;
    // a gun crew that watched its last round fall corrects the next one (bracketing)
    const bracket = crewServed ? missionBracketMul(team, shooter.pos, vehicle) : 1;
    const hit = fireAtVehicle(state, rng, weapon, shooter.pos, shooter.side, vehicle, Math.min(0.97, p * bracket), wantTracer, {
      round: crewServed ? chamberedRoundType(team, shooter) : 'ap', aimPoint, skill, shooterTeamId: shooter.teamId,
    });
    if (crewServed) onMissionShotAtVehicle(team, hit, shooter.pos, vehicle);
    return;
  }

  const victim = target.soldier;
  const distM = dist(shooter.pos, victim.pos) * TILE_M;
  // Directional cover (spec §9): the protection victim's tile offers against fire arriving FROM
  // the shooter's bearing, not the omni `soldier.cover` (kept only for display).
  const angleFromVictimToShooter = angleTo(victim.pos, shooter.pos);
  const cover = coverFrom(map, victim.pos, angleFromVictimToShooter);
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const p = hitChance(weapon, distM, cover, victim.stance, shooter, moving) * (shooter.seat === 'passenger' ? PASSENGER_FIRE_MUL : 1) * recoveryFactor(shooter, state.time);

  if (SMALL_ARMS_CLASSES.has(weapon.cls)) {
    const t = getTrack(state);
    t.smallArmsFired++;
  }

  if (rng.chance(p)) {
    if (SMALL_ARMS_CLASSES.has(weapon.cls)) getTrack(state).smallArmsHit++;
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...victim.pos }, t: 0, hit: true, kind: tracerKindFor(weapon) });
    onIncomingFire(state, rng, victim, shooter, victim.pos, weapon.cls, false);
    applyHit(state, victim, weapon, rng, shooter.side, shooter);
    heBurstAt(state, rng, victim.pos, weapon, shooter);
  } else {
    const spread = 0.5 + distM / 200;
    const impact = { x: victim.pos.x + rng.gauss() * spread, y: victim.pos.y + rng.gauss() * spread };
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: impact, t: 0, hit: false, kind: tracerKindFor(weapon) });
    if (weapon.heRadiusM === 0) state.explosions.push({ pos: { ...impact }, radiusM: 0, t: 0, kind: 'small' });
    else heBurstAt(state, rng, impact, weapon, shooter);
    onIncomingFire(state, rng, victim, shooter, impact, weapon.cls);
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      if (s2.id === victim.id) continue;
      const dTiles = dist(s2.pos, impact);
      if (dTiles <= SUPPRESSION_SPLASH_RADIUS_TILES) {
        const amount = weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5);
        s2.suppression = clamp(s2.suppression + amount, 0, 100);
        addSuppressionStat(state, shooter.side, amount);
        onIncomingFire(state, rng, s2, shooter, impact, weapon.cls);
      } else {
        maybeNoiseStress(s2, impact, weapon.cls);
      }
    }
    const directAmount = weapon.suppression * 20;
    victim.suppression = clamp(victim.suppression + directAmount, 0, 100);
    addSuppressionStat(state, shooter.side, directAmount);
  }
}

function fireBurst(state: BattleState, rng: Rng, soldier: Soldier, weapon: WeaponDef, target: Target): void {
  // guns cycle on their LOADING and LAYING phases (crewWeapon.ts / gunTiming.ts), not on `rate`
  soldier.fireTimer = weapon.cls === 'atgun' && weapon.loadS != null ? 0.5 : 1 / weapon.rate;
  if (soldier.activity !== 'moving' && soldier.activity !== 'sneaking' && soldier.activity !== 'movingFast') {
    soldier.activity = 'firing';
  }
  soldier.lastFiredAt = state.time;
  const tPos = targetPosOf(target);
  soldier.facing = facingTo(soldier.pos, tPos);
  const flashKind = weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 'shell' as const : undefined;
  state.flashes.push({ pos: { ...soldier.pos }, facing: facingAngle(soldier.facing), t: 0, kind: flashKind });
  state.events.push({ kind: 'shot', pos: { ...soldier.pos }, weaponId: weapon.id, side: soldier.side });

  // Every MG round and every tank/AT shell gets a tracer; small arms (rifle/
  // SMG) show a tracer roughly every 3rd shot, like the original's darting
  // tracer rounds mixed in with the rest of the burst.
  const tracerEvery =
    weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg'
    || weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 1
    : weapon.cls === 'smg' || weapon.cls === 'rifle' ? 3
    : 0;

  let roundsFired = 0;
  for (let i = 0; i < weapon.burst; i++) {
    if (soldier.ammo <= 0) break;
    soldier.ammo--;
    roundsFired++;
    resolveRound(state, rng, soldier, weapon, target, tracerEvery > 0 && i % tracerEvery === 0);
  }
  addShots(state, soldier.side, roundsFired);
}

function stepSoldierCombat(state: BattleState, rng: Rng, dt: number, soldier: Soldier, track: CombatTrack): void {
  if (!canSoldierFire(soldier, state)) return;
  const weapon = WEAPONS[soldier.weaponId];
  if (!weapon || weapon.indirect) return;
  const team = state.teams.get(soldier.teamId);

  if (soldier.activity === 'reloading') {
    soldier.reloadTimer -= dt;
    if (soldier.reloadTimer <= 0) {
      const take = Math.min(weapon.ammo, soldier.ammoReserve);
      soldier.ammo = take;
      soldier.ammoReserve -= take;
      soldier.activity = 'idle';
    }
    return;
  }

  soldier.fireTimer -= dt;

  // guns and HMGs are fed by their crew's tasks (crewWeapon.ts: `load` takes the round from the
  // ammunition, `feedBelt` a new belt); a gun with a round in the breech can fire its last one
  const crewFed = crewFeedsAmmo(team, soldier);
  if (soldier.ammo <= 0 && !hasChamberedRound(team, soldier)) {
    if (crewFed && soldier.ammoReserve > 0) return;
    if (soldier.ammoReserve > 0) {
      soldier.activity = 'reloading';
      soldier.reloadTimer = weapon.reloadS;
    } else if (!track.outOfAmmoMessaged.has(soldier.id)) {
      track.outOfAmmoMessaged.add(soldier.id);
      addMessage(state, `${team?.name ?? 'A team'} is out of ammo`, 'warn');
      soldier.activity = 'idle';
    }
    return;
  }

  if (soldier.fireTimer > 0) return;

  // Balance round 4: a soldier's OWN suppression should throttle how often they return fire, not
  // just degrade their accuracy (ballistics.ts's shooterFactor already does that). Design brief
  // §6.7: suppression >60 -> pinned ("won't move, may fire"), >85 -> cowering (doesn't fire, and
  // canSoldierFire already excludes 'cowering'). This makes ">60 fires at ~30% rate, >85 not at
  // all" true from the raw suppression VALUE this same tick, instead of waiting a frame for the
  // activity transition in stepMorale (which runs after stepCombat) to catch up.
  // Berserk soldiers ignore suppression entirely (spec §3); everyone else keeps the throttle above,
  // now driven by the mental state (pinned fires at 30%, cowering/panicked already excluded by
  // canSoldierFire) rather than the raw suppression number, which used to race ahead of the state
  // machine by a tick.
  if (soldier.mind.state !== 'berserk') {
    // Tried loosening 30%->40% and >85->90 (paired with the suppression-decay change above);
    // harness showed the combination made attacker win rate worse, not better. Reverted to the
    // original spec §6.7 thresholds — the shot-volume gap turned out to be dominated by the AI's
    // move/fire-eligibility split (see ai.ts bounding overwatch), not this throttle.
    if (soldier.mind.state === 'pinned' && !rng.chance(0.3)) return;
    if (soldier.suppression > 85) return;
    if (soldier.suppression > 60 && !rng.chance(0.3)) return;
  }

  const target = pickTarget(state, soldier, team, weapon);
  if (!target) return;
  // crew-served weapons (HMG / AT gun): lay and load before the first round of a new fire mission
  if (team?.crewWeapon) {
    const wait = fireMissionWait(state, team, soldier, {
      aim: targetPosOf(target),
      targetTeamId: target.kind === 'soldier' ? target.soldier.teamId
        : target.kind === 'vehicle' ? target.vehicle.teamId
          : team.order?.type === 'fire' ? team.order.targetTeamId ?? null : null,
      targetVehicle: target.kind === 'vehicle' ? target.vehicle : null,
      targetMoving: target.kind === 'vehicle' ? Math.abs(target.vehicle.speed) > 0.1
        : target.kind === 'soldier' ? target.soldier.activity === 'moving' || target.soldier.activity === 'movingFast' : false,
    });
    if (wait > 0) { soldier.fireTimer = Math.min(wait, 0.5); return; }
  }
  onFired(state, rng, soldier);
  // the round in the breech decides what the shot does (AP shot does not burst)
  const fired = hasChamberedRound(team, soldier) ? roundWeapon(weapon, chamberedRoundType(team, soldier)) : weapon;
  takeChamberedRound(team, soldier); // already counted out of the ammunition when it was loaded
  fireBurst(state, rng, soldier, fired, target);
  onMissionRound(state, team, soldier);
}

// ------------------------------------------------------------------ grenades
function nearestSpottedEnemy(state: BattleState, s: Soldier): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[s.side]) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const d = dist(e.pos, s.pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function stepGrenades(state: BattleState, rng: Rng, dt: number, track: CombatTrack): void {
  const grenadeWeapon = WEAPONS.grenade;
  if (!grenadeWeapon) return;
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated') continue;
    if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'sneaking' || s.activity === 'ambushing') continue;
    if (s.grenades <= 0 || isStunned(s, state.time) || isDazed(s, state.time)) continue;
    const timer = (track.grenadeTimer.get(s.id) ?? 0) - dt;
    if (timer > 0) { track.grenadeTimer.set(s.id, timer); continue; }

    const enemy = nearestSpottedEnemy(state, s);
    if (enemy && dist(enemy.pos, s.pos) * TILE_M <= 25 && hasLOS(state.map, s.pos, enemy.pos)) {
      s.grenades--;
      track.grenadeTimer.set(s.id, 1 / 0.1);
      state.events.push({ kind: 'shot', pos: { ...s.pos }, weaponId: 'grenade', side: s.side });
      applyHESplash(state, rng, enemy.pos, grenadeWeapon, s.side);
    } else {
      track.grenadeTimer.set(s.id, 1);
    }
  }
}

// ------------------------------------------------------------------- mortars
// Indirect fire (manual: "Mortars, rockets: can fire over obstacles via indirect fire; LOS not
// required, though LOS improves accuracy"). A mortar fires at
//  (a) an ordered point anywhere between its minimum and maximum range, seen or not;
//  (b) an attack-unit target while any soldier of its side spots that team (the aim follows it),
//      then its last known position for the suppression period;
//  (c) with no fire order: a spotted enemy cluster, else a strong belief held by the gunner or the
//      team leader (suppression).
// Dispersion depends on who observes the fall of shot, re-evaluated for every round:
//  1. 'spotted': a friendly soldier sees the impact area AND enemy soldiers his side has spotted
//     within MORTAR_SPOTTED_AREA_M of the aim point, which he himself can see: walks in to x1.0;
//  2. 'area': someone sees the impact area but no spotted enemy there: x1.6, walks in to x1.4;
//  3. 'none': nobody sees it: x2.5, no walk-in.
// The best spotter's distance and state scale the tier's multiplier; a spotter from outside the
// mortar team costs a correction delay before the first round. A tier change restarts walk-in.

/** Gaussian sigma of a mortar round (metres) before observation multipliers. */
export function mortarBaseDispersionM(distM: number): number {
  return 3 + distM / 100;
}
export type MortarObservation = 'spotted' | 'area' | 'none';
/** Multiplier per round fired in the current tier (the last entry repeats). */
export const MORTAR_TIER_WALK: Record<MortarObservation, readonly number[]> = {
  spotted: [1.6, 1.3, 1.1, 1.0],
  area: [1.6, 1.5, 1.4],
  none: [2.5],
};
/** Spotter correction delay before the first round (seconds) by his experience: 4 green, 2 veteran.
 * None when the mortar crew itself spots. */
export const MORTAR_SPOTTER_DELAY_S: [number, number] = [2, 4];
/** Spotted enemies this close to the aim point make it a spotted target. */
export const MORTAR_SPOTTED_AREA_M = 25;
/** Spotter distance scaling: x1.0 up to NEAR, rising linearly to x1.25 at MAX; beyond MAX not a spotter. */
export const MORTAR_SPOTTER_NEAR_M = 150;
export const MORTAR_SPOTTER_MAX_M = 600;
export const MORTAR_SPOTTER_FAR_MUL = 1.25;
export const MORTAR_SPOTTER_SHAKEN_MUL = 1.15;
export const MORTAR_SPOTTER_PINNED_MUL = 1.3;
/** Belief suppression (c): only beliefs this confident, fired on every 2nd opportunity. */
const MORTAR_BELIEF_CONFIDENCE = 0.6;

/** Sigma (metres) of a mortar round: range, observation tier, rounds already fired in that tier,
 * and the spotter quality multiplier (distance/state; 1 for unobserved fire). */
export function mortarDispersionM(distM: number, obs: MortarObservation, roundsInTier: number, spotterMul = 1): number {
  const walk = MORTAR_TIER_WALK[obs];
  const m = walk[Math.min(Math.max(0, roundsInTier), walk.length - 1)];
  return mortarBaseDispersionM(distM) * m * (obs === 'none' ? 1 : spotterMul);
}

/** Can this soldier act as a spotter at all (alive, on foot, not cowering/panicked/fleeing)? */
function canSpot(s: Soldier | undefined): s is Soldier {
  if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) return false;
  if (s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'surrendered' || s.activity === 'cowering') return false;
  const st = s.mind?.state;
  return st !== 'panicked' && st !== 'cowering' && st !== 'broken';
}

/** Spotter quality multiplier from distance to the aim point and his state. */
export function spotterQualityMul(s: Soldier, aim: Vec2): number {
  const dM = dist(s.pos, aim) * TILE_M;
  const far = clamp((dM - MORTAR_SPOTTER_NEAR_M) / (MORTAR_SPOTTER_MAX_M - MORTAR_SPOTTER_NEAR_M), 0, 1);
  let m = 1 + (MORTAR_SPOTTER_FAR_MUL - 1) * far;
  if (s.mind?.state === 'pinned' || s.activity === 'pinned') m *= MORTAR_SPOTTER_PINNED_MUL;
  else if (s.mind?.state === 'shaken') m *= MORTAR_SPOTTER_SHAKEN_MUL;
  return m;
}

export interface MortarObservationResult {
  obs: MortarObservation;
  spotter: Soldier | null;
  /** spotter quality multiplier (1 when unobserved) */
  mul: number;
  /** the spotter belongs to the mortar team (no correction delay) */
  own: boolean;
}

/** Observation of the impact area at `aim` for `team`'s mortar right now (same LOS/visibility rules as
 * spotting.ts). Best tier wins; within it the best spotter: team leader and command teams first,
 * then highest experience, then nearest to the aim point. */
export function mortarObservation(state: BattleState, team: Team, aim: Vec2): MortarObservationResult {
  const areaTiles = MORTAR_SPOTTED_AREA_M / TILE_M;
  const enemiesNear: Soldier[] = [];
  for (const id of state.spotted[team.side]) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.vehicleId != null) continue;
    if (dist(e.pos, aim) <= areaTiles) enemiesNear.push(e);
  }
  let best: Soldier | null = null;
  let bestTier = 0; // 2 spotted, 1 area
  let bestKey: [number, number, number] = [0, 0, 0];
  for (const s of state.soldiers.values()) {
    if (s.side !== team.side || !canSpot(s) || isDazed(s, state.time)) continue;
    const observer = { pos: s.pos, soldier: s };
    if (observerVisibility(state, observer, aim, MORTAR_SPOTTER_MAX_M) <= 0) continue;
    let tier = 1;
    for (const e of enemiesNear) {
      if (observerVisibility(state, observer, e.pos, MORTAR_SPOTTER_MAX_M) > 0) { tier = 2; break; }
    }
    const sTeam = state.teams.get(s.teamId);
    const priority = (s.teamId === team.id && s.id === team.leaderId) || sTeam?.type === 'command' ? 1 : 0;
    const key: [number, number, number] = [priority, s.experience, -dist(s.pos, aim)];
    const better = !best || tier > bestTier
      || (tier === bestTier && (key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))));
    if (better) { best = s; bestTier = tier; bestKey = key; }
  }
  if (!best) return { obs: 'none', spotter: null, mul: 1, own: false };
  return { obs: bestTier === 2 ? 'spotted' : 'area', spotter: best, mul: spotterQualityMul(best, aim), own: best.teamId === team.id };
}

/** Rounds fired in the current observation tier, per mission (a tier change restarts walk-in). */
const tierWalk = new WeakMap<object, { tier: MortarObservation; rounds: number }>();

/** Test/HUD hook: the observation tier of the team's last mortar round and rounds fired in it. */
export function mortarWalkState(team: Team): { tier: MortarObservation; rounds: number } | null {
  return tierWalk.get(team.crewWeapon?.mission ?? team) ?? null;
}

function findEnemyCluster(state: BattleState, side: Side): Soldier | null {
  const ids = Array.from(state.spotted[side]);
  let best: Soldier | null = null;
  let bestCount = 0;
  for (const id of ids) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead') continue;
    let count = 0;
    for (const id2 of ids) {
      const s2 = state.soldiers.get(id2);
      if (!s2 || s2.health === 'dead') continue;
      if (dist(s.pos, s2.pos) <= 5) count++;
    }
    if (count > bestCount) { bestCount = count; best = s; }
  }
  // Tried lowering this to 2 (more mortar targets on spread-out defenses); harness showed it made
  // the attacker win rate slightly worse (31%->27%), so reverted to the original threshold.
  return bestCount >= 3 ? best : null;
}

function findGunner(state: BattleState, team: Team): Soldier | null {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (w && w.indirect) return s;
  }
  return null;
}

function inMortarRange(gunner: Soldier, weapon: WeaponDef, p: Vec2): boolean {
  const dM = dist(gunner.pos, p) * TILE_M;
  return dM >= (weapon.minRangeM ?? 0) && dM <= weapon.rangeM;
}

/** Strongest belief (gunner's or team leader's) worth suppressing, in range. */
function mortarBeliefTarget(state: BattleState, team: Team, gunner: Soldier, weapon: WeaponDef): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = 0;
  const leader = state.soldiers.get(team.leaderId);
  for (const s of [gunner, leader]) {
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    for (const b of s.mind.beliefs) {
      if (b.confidence < MORTAR_BELIEF_CONFIDENCE || !inMortarRange(gunner, weapon, b.pos)) continue;
      const score = b.confidence * Math.max(1, b.count);
      if (score > bestScore) { bestScore = score; best = b.pos; }
    }
  }
  return best;
}

/** AI hook: a belief of this mortar team's gunner or leader worth an area fire mission, or null. */
export function mortarBeliefAimFor(state: BattleState, team: Team): Vec2 | null {
  const gunner = findGunner(state, team);
  const weapon = gunner ? WEAPONS[gunner.weaponId] : undefined;
  return gunner && weapon ? mortarBeliefTarget(state, team, gunner, weapon) : null;
}

export interface MortarAim { pos: Vec2; trackedTeamId: number | null; kind: 'ordered' | 'tracked' | 'lastKnown' | 'cluster' | 'belief' | 'smoke' }

/** Where this mortar would fire right now (null = hold fire). Pure except for the belief throttle. */
export function pickMortarAim(state: BattleState, team: Team, gunner: Soldier, weapon: WeaponDef, track?: CombatTrack): MortarAim | null {
  const order = team.order;
  if (order?.type === 'smoke') {
    if (!weapon.smoke) return null;
    return inMortarRange(gunner, weapon, order.target) ? { pos: order.target, trackedTeamId: null, kind: 'smoke' } : null;
  }
  if (order?.type === 'fire' && order.target) {
    if (order.targetTeamId == null) {
      return inMortarRange(gunner, weapon, order.target) ? { pos: order.target, trackedTeamId: null, kind: 'ordered' } : null;
    }
    const phase = attackPhase(state, order);
    if (phase !== 'hold') {
      // tracking: the side spots the team (stepAttackOrders keeps order.target on it);
      // suppress: its last known position
      if (!inMortarRange(gunner, weapon, order.target)) return null;
      return { pos: order.target, trackedTeamId: order.targetTeamId, kind: phase === 'tracking' ? 'tracked' : 'lastKnown' };
    }
  }
  const cluster = findEnemyCluster(state, team.side);
  if (cluster && inMortarRange(gunner, weapon, cluster.pos)) {
    return { pos: cluster.pos, trackedTeamId: cluster.teamId, kind: 'cluster' };
  }
  if (order?.type === 'ambush') return null; // ambushers hold fire on mere suspicion
  const belief = mortarBeliefTarget(state, team, gunner, weapon);
  if (!belief) return null;
  if (track) {
    const n = (track.beliefFireCounter.get(gunner.id) ?? 0) + 1;
    track.beliefFireCounter.set(gunner.id, n);
    if (n % 2 !== 0) { gunner.fireTimer = 1 / weapon.rate; return null; }
  }
  return { pos: belief, trackedTeamId: null, kind: 'belief' };
}

function stepMortarTeam(state: BattleState, rng: Rng, dt: number, team: Team, track: CombatTrack): void {
  const gunner = findGunner(state, team);
  if (!gunner) return;
  const weapon = WEAPONS[gunner.weaponId];
  if (!weapon) return;
  // soldier-mind rules: panicked / cowering / frozen crews do not work the mortar
  if (!canSoldierFire(gunner, state)) return;

  gunner.fireTimer -= dt;
  if (gunner.ammo <= 0) {
    if (gunner.ammoReserve > 0 && gunner.activity !== 'reloading') {
      gunner.activity = 'reloading';
      gunner.reloadTimer = weapon.reloadS;
    }
    if (gunner.activity === 'reloading') {
      gunner.reloadTimer -= dt;
      if (gunner.reloadTimer <= 0) {
        const take = Math.min(weapon.ammo, gunner.ammoReserve);
        gunner.ammo = take;
        gunner.ammoReserve -= take;
        gunner.activity = 'idle';
      }
    }
    return;
  }
  if (gunner.fireTimer > 0) return;

  const aim = pickMortarAim(state, team, gunner, weapon, track);
  if (!aim) return;
  const target = aim.pos;
  const isSmokeOrder = aim.kind === 'smoke';
  const distM = dist(gunner.pos, target) * TILE_M;

  const { obs, spotter, mul, own } = mortarObservation(state, team, target);
  const extraDelay = obs !== 'none' && spotter && !own
    ? MORTAR_SPOTTER_DELAY_S[1] - (MORTAR_SPOTTER_DELAY_S[1] - MORTAR_SPOTTER_DELAY_S[0]) * clamp(spotter.experience / 100, 0, 1)
    : 0;
  const wait = fireMissionWait(state, team, gunner, { aim: target, targetTeamId: aim.trackedTeamId, extraFirstRoundDelayS: extraDelay });
  if (wait > 0) { gunner.fireTimer = Math.min(wait, 0.5); return; }

  const walkKey: object = team.crewWeapon?.mission ?? team;
  let walk = tierWalk.get(walkKey);
  if (!walk || walk.tier !== obs) { walk = { tier: obs, rounds: 0 }; tierWalk.set(walkKey, walk); }
  const sigmaM = mortarDispersionM(distM, obs, walk.rounds, mul);
  walk.rounds++;
  onMissionRound(state, team, gunner);

  gunner.fireTimer = 1 / weapon.rate;
  gunner.ammo--;
  gunner.lastFiredAt = state.time;
  gunner.activity = 'firing';
  state.events.push({ kind: 'shot', pos: { ...gunner.pos }, weaponId: weapon.id, side: gunner.side });

  const errTiles = sigmaM / TILE_M;
  const impact = { x: target.x + rng.gauss() * errTiles, y: target.y + rng.gauss() * errTiles };
  impact.x = clamp(impact.x, 0.01, state.map.width - 0.01);
  impact.y = clamp(impact.y, 0.01, state.map.height - 0.01);

  if (isSmokeOrder) {
    const order = team.order!;
    const rec = track.smokeRounds.get(team.id) ?? { count: 0, lastAt: -Infinity };
    state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: 'mortar' });
    addSmoke(state.map, impact, 3, 1.0);
    state.explosions.push({ pos: { ...impact }, radiusM: 3, t: 0, kind: 'smoke' });
    state.events.push({ kind: 'explosion', pos: { ...impact }, side: gunner.side, weaponId: weapon.id });
    rec.count++;
    rec.lastAt = state.time;
    track.smokeRounds.set(team.id, rec);
    if (rec.count >= 3) {
      team.order = { type: 'defend', target: order.target, issuedAt: state.time };
    }
    return;
  }

  state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: 'mortar' });
  track.mortarRoundsFiredBySide[gunner.side]++;
  addShots(state, gunner.side, 1);
  applyHESplash(state, rng, impact, weapon, gunner.side);
}

// ------------------------------------------------------------------- smoke
function stepSmokeOrders(state: BattleState): void {
  for (const team of state.teams.values()) {
    if (!team.order || team.order.type !== 'smoke') continue;
    if (team.vehicleId != null) continue; // vehicles handle their own smoke
    if (findGunner(state, team)) continue; // mortar teams handled in stepMortarTeam
    const target = team.order.target;
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      if (dist(s.pos, target) * TILE_M <= 30) {
        addSmoke(state.map, target, 2, 0.9);
        state.events.push({ kind: 'explosion', pos: { ...target }, side: team.side });
        team.order = { type: 'defend', target, issuedAt: state.time };
        break;
      }
    }
  }
}

// ----------------------------------------------------------------- vehicles
/** Taking the wrong round out of a tank gun's breech (seconds; the reload follows). */
export const VEHICLE_UNLOAD_S = 2;

function vehicleHitChance(weapon: WeaponDef, distM: number, cover: number, stance: Soldier['stance'], moving: boolean): number {
  if (distM > weapon.rangeM) return 0;
  const rf = distM <= 100 ? 1 : Math.pow(100 / distM, 0.8);
  const st = stance === 'standing' ? 1 : stance === 'crouching' ? 0.7 : 0.45;
  const p = weapon.accuracy * rf * (1 - cover * 0.8) * st * (moving ? 0.6 : 1);
  return clamp(p, 0.02, 0.95);
}

function pickNearestInfantry(state: BattleState, vehicle: Vehicle, rangeM: number): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[vehicle.side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(vehicle.pos, s.pos) * TILE_M;
    if (d > rangeM) continue;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Main-gun target for a vehicle on an attack-unit Fire order: AP at the target vehicle, HE at the
 * best visible member of a target infantry team, HE on the tracked/last known position otherwise. */
function pickVehicleAttackTarget(state: BattleState, vehicle: Vehicle, weapon: WeaponDef | null, order: Order): Target | null | 'free' {
  const phase = attackPhase(state, order);
  if (phase === 'hold') return 'free';
  const tgt = state.teams.get(order.targetTeamId!);
  if (!tgt) return 'free';
  const rangeM = weapon ? weapon.rangeM : 400;
  if (phase === 'tracking') {
    if (tgt.vehicleId != null) {
      const v = state.vehicles.get(tgt.vehicleId);
      if (v && v.state !== 'knockedOut' && state.spottedVehicles[vehicle.side].has(v.id) && dist(vehicle.pos, v.pos) * TILE_M <= rangeM) return { kind: 'vehicle', vehicle: v };
      return null;
    }
    let best: Soldier | null = null;
    let bestScore = -Infinity;
    for (const id of tgt.soldierIds) {
      if (!state.spotted[vehicle.side].has(id)) continue;
      const e = state.soldiers.get(id);
      if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
      if (dist(vehicle.pos, e.pos) * TILE_M > rangeM || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
      const sc = exposureScore(state, vehicle.pos, e);
      if (sc > bestScore) { bestScore = sc; best = e; }
    }
    if (best) return { kind: 'soldier', soldier: best };
  }
  if (weapon && weapon.heRadiusM > 0 && dist(vehicle.pos, order.target) * TILE_M <= rangeM) return { kind: 'point', pos: order.target };
  return null;
}

/** Coax MG target: members of an attack-unit target infantry team first, else nearest spotted. */
function pickCoaxTarget(state: BattleState, vehicle: Vehicle, rangeM: number): Soldier | null {
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId != null && attackPhase(state, order) === 'tracking') {
    const tgt = state.teams.get(order.targetTeamId);
    if (tgt && tgt.vehicleId == null) {
      let best: Soldier | null = null;
      let bestD = Infinity;
      for (const id of tgt.soldierIds) {
        if (!state.spotted[vehicle.side].has(id)) continue;
        const e = state.soldiers.get(id);
        if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
        const d = dist(vehicle.pos, e.pos) * TILE_M;
        if (d > rangeM || d >= bestD || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
        bestD = d; best = e;
      }
      if (best) return best;
    }
  }
  return pickNearestInfantry(state, vehicle, rangeM);
}

function pickVehicleTarget(state: BattleState, vehicle: Vehicle): Target | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId != null) {
    const picked = pickVehicleAttackTarget(state, vehicle, weapon, order);
    if (picked !== 'free') return picked;
  }

  if (weapon && weapon.penetrationMm > 0) {
    // threat ranking by TIME TO FIRST SHOT: the enemy we can lay on soonest and who can lay on us
    // soonest comes first (a duel is decided by who lays first); the target already being laid on
    // is kept unless another is clearly more urgent; range breaks ties
    let best: Vehicle | null = null;
    let bestScore = Infinity;
    for (const id of state.spottedVehicles[vehicle.side]) {
      const v = state.vehicles.get(id);
      if (!v || v.state === 'knockedOut') continue;
      const d = dist(vehicle.pos, v.pos) * TILE_M;
      if (d > weapon.rangeM) continue;
      const dead = v.state === 'burning' || v.state === 'abandoned';
      const ours = Math.min(60, timeToFirstShotS(state, vehicle, v.pos, Math.abs(v.speed) > 0.1));
      const theirs = dead ? 60 : Math.min(60, timeToFirstShotS(state, v, vehicle.pos, Math.abs(vehicle.speed) > 0.1));
      let score = ours + 0.5 * theirs + d / 100;
      if (vehicle.gunLay?.key === `v${v.id}`) score -= 4;
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best) return { kind: 'vehicle', vehicle: best };
  }

  const team = state.teams.get(vehicle.teamId);
  if (team?.order?.type === 'fire' && team.order.target) {
    return { kind: 'point', pos: team.order.target };
  }

  const inf = pickNearestInfantry(state, vehicle, 300);
  if (inf) return { kind: 'soldier', soldier: inf };
  return null;
}

/** A new aim point further than this from the lay point is a new target (a whole new lay). */
export const GUN_LAY_NEW_AIM_M = 15;
/** The target jumped this far between two looks: the lay needs a correction. */
export const GUN_LAY_RELAY_M = 10;
/** A lay is kept this long after its target is lost from sight. */
export const GUN_LAY_KEEP_S = 4;

/** The loader starts on a round: `mainFireTimer` holds what is left of `loadTotalS`. */
function startMainGunLoad(state: BattleState, vehicle: Vehicle, def: VehicleDef, weapon: WeaponDef, crew: CrewEffects, extraS: number): void {
  // a gun silent for a while has had its ready rack restocked from the hull
  if (vehicle.lastMainShotAt != null && state.time - vehicle.lastMainShotAt > READY_RACK_RESTOCK_S) vehicle.readyRackUsed = 0;
  const total = vehicleLoadS(state, vehicle, def, weapon, crew.reloadMul, crew.gunner) + extraS;
  vehicle.readyRackUsed = (vehicle.readyRackUsed ?? 0) + 1;
  vehicle.mainFireTimer = total;
  vehicle.loadTotalS = total;
  vehicle.loadProgress = 0;
}

/** The gunner's line of sight to what he is laying on, looked at afresh every GUN_LOS_EVERY_S (and
 * at once when either end has moved a tile); the shot itself always checks the line again. */
const GUN_LOS_EVERY_S = 0.5;
const gunLosCache = new WeakMap<Vehicle, { until: number; fx: number; fy: number; tx: number; ty: number; clear: boolean }>();
function gunLos(state: BattleState, vehicle: Vehicle, tPos: Vec2): boolean {
  const fx = Math.floor(vehicle.pos.x), fy = Math.floor(vehicle.pos.y), tx = Math.floor(tPos.x), ty = Math.floor(tPos.y);
  const c = gunLosCache.get(vehicle);
  if (c && state.time < c.until && state.time >= c.until - GUN_LOS_EVERY_S - 1e-6 && c.fx === fx && c.fy === fy && c.tx === tx && c.ty === ty) return c.clear;
  const clear = hasLOS(state.map, vehicle.pos, tPos);
  gunLosCache.set(vehicle, { until: state.time + GUN_LOS_EVERY_S, fx, fy, tx, ty, clear });
  return clear;
}

/** A vehicle under way halts for an aimed shot unless it has just given one up. */
function canHaltToFire(state: BattleState, vehicle: Vehicle): boolean {
  return !(vehicle.noFireHaltUntil != null && state.time < vehicle.noFireHaltUntil);
}

/** Is `enemy` about to put a round into `me` before my own fine lay (`myFineLeftS`) is done? */
function aboutToFireAt(enemy: Vehicle, me: Vehicle, myFineLeftS: number): boolean {
  const lay = enemy.gunLay;
  if (!lay || lay.key !== `v${me.id}` || !enemy.loadedRound) return false;
  const left = Math.max(enemy.mainFireTimer, lay.designateLeftS + lay.fineLeftS);
  return left <= 2 && left < myFineLeftS;
}

function stepVehicleCombat(state: BattleState, rng: Rng, dt: number, vehicle: Vehicle, track: CombatTrack): void {
  if (vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned') return;
  const team = state.teams.get(vehicle.teamId);
  const crewAlive = team
    ? team.soldierIds.some((id) => {
      const s = state.soldiers.get(id);
      return s && s.health !== 'dead' && s.health !== 'incapacitated';
    })
    : false;
  if (!crewAlive) return;

  const def = VEHICLE_DEFS[vehicle.defId];
  if (!def) return;

  // LOADING (the loader's job): motion and nerves slow him while he works
  if (vehicle.mainFireTimer > 0) {
    const here = tileAt(state.map, Math.floor(vehicle.pos.x), Math.floor(vehicle.pos.y));
    const onRoad = here === 'dirtroad' || here === 'pavedroad' || here === 'bridge';
    vehicle.mainFireTimer = Math.max(0, vehicle.mainFireTimer - dt / loadPaceMul(state, vehicle, onRoad));
  }
  if (vehicle.loadTotalS != null) vehicle.loadProgress = vehicle.loadTotalS > 0 ? clamp(1 - vehicle.mainFireTimer / vehicle.loadTotalS, 0, 1) : 1;
  vehicle.coaxFireTimer -= dt;

  const crew = crewEffects(state, vehicle);
  const mainWeapon = def.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  const gunWorks = !!mainWeapon && mainGunUsable(vehicle) && !!crew.gunner;

  // smoke order for vehicles: smoke rounds if the gun carries them, else HE on the spot; vehicles
  // without a gun (or whose weapon has no round types) use their smoke dischargers as before
  if (team?.order?.type === 'smoke') {
    const rec = track.smokeRounds.get(vehicle.teamId) ?? { count: 0, lastAt: -Infinity };
    if (state.time - rec.lastAt >= 4 && rec.count < 3) {
      let round: RoundType = 'smoke';
      if (mainWeapon?.rounds && gunWorks) {
        const counts = vehicleRounds(state, vehicle);
        if (vehicle.loadedRound) { counts[vehicle.loadedRound]++; vehicle.mainAmmo++; vehicle.loadedRound = undefined; }
        const pick = chooseRound(mainWeapon, counts, { kind: 'smoke' });
        if (!pick) { team.order = { type: 'defend', target: team.order.target, issuedAt: state.time }; return; }
        round = pick;
        counts[round]--; vehicle.mainAmmo--;
        if (counts[round] === 0) noteOutOf(state, team.id, round);
        addShots(state, vehicle.side, 1);
        state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: mainWeapon.id, side: vehicle.side });
      }
      if (round === 'smoke') {
        addSmoke(state.map, team.order.target, 3, 1.0);
        state.explosions.push({ pos: { ...team.order.target }, radiusM: 3, t: 0, kind: 'smoke' });
      } else if (mainWeapon) {
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...team.order.target }, t: 0, hit: true, kind: 'shell' });
        applyHESplash(state, rng, team.order.target, roundWeapon(mainWeapon, round), vehicle.side, vehicle.pos);
      }
      rec.count++;
      rec.lastAt = state.time;
      track.smokeRounds.set(vehicle.teamId, rec);
      if (rec.count >= 3) team.order = { type: 'defend', target: team.order.target, issuedAt: state.time };
    }
    return;
  }

  const target = pickVehicleTarget(state, vehicle);

  if (target && mainWeapon && gunWorks && (vehicle.mainAmmo > 0 || vehicle.loadedRound)) {
    const weapon = mainWeapon;
    const gunner = crew.gunner!;
    const tPos = targetPosOf(target);
    const desired = angleTo(vehicle.pos, tPos);
    const distM = dist(vehicle.pos, tPos) * TILE_M;
    const los = gunLos(state, vehicle, tPos);
    const reversing = isVehicleReversing(state, vehicle);
    const ownMoving = Math.abs(vehicle.speed) > 0.1;

    // ---- the round: chosen when it is loaded; the wrong one for a new target has to come out
    const targetKey = target.kind === 'vehicle' ? target.vehicle.id : -1;
    const counts = vehicleRounds(state, vehicle);
    const skill = gunnerSkill(gunner);
    let aim: AimPoint = 'mass';
    let hold = false;
    if (target.kind === 'vehicle') {
      const have = vehicle.loadedRound ? { ...counts, [vehicle.loadedRound]: counts[vehicle.loadedRound] + 1 } : counts;
      const choice = chooseAimPoint(weapon, weapon.rounds ? have : null, skill, vehicle.pos, target.vehicle, state.config.year);
      aim = choice.aimPoint;
      hold = choice.hold;
      if (vehicle.aimVehicleId !== targetKey) vehicle.aimHoldUntil = undefined;
      vehicle.aimVehicleId = targetKey;
      vehicle.aimPoint = aim;
    } else { vehicle.aimPoint = undefined; vehicle.aimVehicleId = undefined; vehicle.aimHoldUntil = undefined; }
    const tdef = target.kind === 'vehicle' ? VEHICLE_DEFS[target.vehicle.defId] : undefined;
    const roundTarget = target.kind === 'vehicle'
      ? { kind: 'vehicle' as const, distM, armorMm: tdef ? expectedArmorMm(target.vehicle, tdef, vehicle.pos, aim, skill > SKILL_ACE) : 9999 }
      : { kind: 'soft' as const };
    let unloadS = 0;
    if (vehicle.loadedRound && weapon.rounds) {
      const have = { ...counts, [vehicle.loadedRound]: counts[vehicle.loadedRound] + 1 };
      const want = chooseRound(weapon, have, roundTarget);
      if (want && want !== vehicle.loadedRound && counts[want] > 0) {
        // out with it, then a whole new load (LOADING starts again on a change of round type)
        counts[vehicle.loadedRound]++; vehicle.mainAmmo++;
        vehicle.loadedRound = undefined;
        unloadS = VEHICLE_UNLOAD_S * crew.reloadMul;
      }
    }
    if (!vehicle.loadedRound) {
      const want = chooseRound(weapon, counts, roundTarget);
      if (want) {
        counts[want]--; vehicle.mainAmmo--;
        vehicle.loadedRound = want;
        if (counts[want] === 0 && weapon.rounds && team) noteOutOf(state, team.id, want);
        // a crew goes into battle with a round up the spout: only the very first one is free
        if (vehicle.loadTotalS != null || vehicle.lastMainShotAt != null || unloadS > 0) startMainGunLoad(state, vehicle, def, weapon, crew, unloadS);
        else { vehicle.loadTotalS = 0; vehicle.readyRackUsed = (vehicle.readyRackUsed ?? 0) + 1; }
      }
    }

    // ---- LAYING (the gunner's job, side by side with the loader's): designation of a new target,
    // traverse at the vehicle's real rate, fine lay; a follow-up needs only a correction
    const targetMoving = target.kind === 'vehicle' ? Math.abs(target.vehicle.speed) > 0.1
      : target.kind === 'soldier' ? target.soldier.activity === 'moving' || target.soldier.activity === 'movingFast' : false;
    const layIn = {
      distM, experience: gunner.experience, targetMoving, aimMul: aimLayMul(aim),
      shaken: crewShaken(state, vehicle), sightDamaged: vehicle.damage?.sight === 'damaged',
    };
    const layKey = target.kind === 'vehicle' ? `v${target.vehicle.id}` : target.kind === 'soldier' ? `t${target.soldier.teamId}` : 'p';
    let lay = vehicle.gunLay;
    const jumpM = lay ? dist(lay.aim, tPos) * TILE_M : Infinity;
    if (!lay || (lay.key !== layKey && (target.kind === 'vehicle' || lay.key.startsWith('v') || jumpM > GUN_LAY_NEW_AIM_M)) || (lay.key === layKey && layKey === 'p' && jumpM > GUN_LAY_NEW_AIM_M)) {
      const cmd = vehicleCommander(state, vehicle);
      const lone = vehicleLayout(def).twoManTurret || !cmd || cmd.id === gunner.id;
      const dS = designateS(cmd?.experience ?? gunner.experience, lone || (!vehicleLayout(def).openTop && isButtonedUp(state, cmd!))) + crew.retargetS;
      const fS = fineLayS(layIn);
      lay = { key: layKey, aim: { ...tPos }, designateLeftS: dS, fineLeftS: fS, totalS: dS + fS };
      vehicle.gunLay = lay;
      vehicle.layProgress = 0;
    } else {
      if (jumpM > GUN_LAY_RELAY_M) {
        // another man of the same lot, some way off: a correction, not a new lay
        if (lay.fineLeftS <= 0) { lay.fineLeftS = followUpS(layIn); lay.totalS = lay.fineLeftS; lay.followUp = true; vehicle.layProgress = 0; }
        lay.misses = 0; lay.bracketFrom = undefined; lay.bracketAt = undefined;
      }
      lay.key = layKey;
      lay.aim = { ...tPos };
    }
    lay.lostAt = undefined;
    if (bracketLost(lay, vehicle.pos, tPos)) { lay.misses = 0; lay.bracketFrom = undefined; lay.bracketAt = undefined; }

    // the turret (or the casemate's gun within its arc) comes round at its limited rate, once the
    // commander has called the target; a frozen turret is laid by turning the hull (vehicle.ts)
    const designated = lay.designateLeftS <= 0;
    if (!designated) { if (los) lay.designateLeftS = Math.max(0, lay.designateLeftS - dt); }
    else if (!turretFrozen(vehicle)) {
      const rate = turretTraverseRad(def, vehicle, gunner.experience);
      if (def.hasTurret) vehicle.turretFacing = turnTowards(vehicle.turretFacing, desired, rate * dt);
      else {
        const arc = gunArcRad(def);
        const rel = clamp(wrapAngle(desired - vehicle.hullFacing), -arc, arc);
        const cur = clamp(wrapAngle(vehicle.turretFacing - vehicle.hullFacing), -arc, arc);
        vehicle.turretFacing = wrapAngle(vehicle.hullFacing + cur + clamp(rel - cur, -rate * dt, rate * dt));
      }
    }
    const facingRef = vehicle.turretFacing;
    const facingDiff = Math.abs(wrapAngle(desired - facingRef));
    // only a halted vehicle is laid properly; one backing out of trouble shoots on the move
    const fireOnMove = ownMoving && (reversing || vehicle.path.length === 0 || !canHaltToFire(state, vehicle));
    if (designated && los && facingDiff <= COARSE_LAY_RAD && lay.fineLeftS > 0 && (!ownMoving || fireOnMove)) {
      lay.fineLeftS = Math.max(0, lay.fineLeftS - dt);
    }
    vehicle.layProgress = Math.max(vehicle.layProgress ?? 0, clamp(1 - (lay.designateLeftS + lay.fineLeftS) / Math.max(1e-6, lay.totalS), 0, 1));

    // short halt: a vehicle under way stops for the fine lay and the shot, then drives on
    const loaded = !!vehicle.loadedRound && vehicle.mainFireTimer <= 0;
    // (a turret comes round while the vehicle drives; a casemate or a jammed turret needs the halt to turn the hull)
    const gunComesRound = def.hasTurret && !turretFrozen(vehicle);
    if (vehicle.path.length > 0 && !reversing && los && designated && (facingDiff <= COARSE_LAY_RAD * 2 || !gunComesRound)
      && !!vehicle.loadedRound && vehicle.mainFireTimer <= 1 && canHaltToFire(state, vehicle)) {
      if (vehicle.fireHaltSince == null) vehicle.fireHaltSince = state.time;
      if (state.time - vehicle.fireHaltSince > FIRE_HALT_MAX_S) { vehicle.fireHaltSince = undefined; vehicle.noFireHaltUntil = state.time + FIRE_HALT_GAP_S; vehicle.fireHaltUntil = undefined; }
      else vehicle.fireHaltUntil = state.time + 0.35;
    } else if (vehicle.fireHaltSince != null && !(vehicle.fireHaltUntil != null && state.time < vehicle.fireHaltUntil)) vehicle.fireHaltSince = undefined;

    if (hold) {
      if (vehicle.aimHoldUntil == null) vehicle.aimHoldUntil = state.time + AIM_HOLD_MAX_S;
      if (state.time >= vehicle.aimHoldUntil) hold = false;
    }
    const sightMul = sightAccuracyMul(vehicle, distM);
    // snap shot: a veteran about to be fired at does not finish his lay
    let layMul = 1;
    let laid = lay.fineLeftS <= 0;
    if (!laid && designated && loaded && target.kind === 'vehicle' && gunner.experience >= SNAP_SHOT_MIN_EXPERIENCE
      && aboutToFireAt(target.vehicle, vehicle, lay.fineLeftS)) {
      const fineTotal = Math.max(1e-6, lay.followUp ? lay.totalS : fineLayS(layIn));
      layMul = Math.max(SNAP_SHOT_MIN, clamp(1 - lay.fineLeftS / fineTotal, 0, 1));
      laid = true;
    }
    vehicle.gunState = !loaded ? 'loading' : laid && facingDiff <= LAY_TOLERANCE_RAD ? 'ready' : 'laying';

    if (loaded && laid && designated && !hold && sightMul > 0 && facingDiff <= LAY_TOLERANCE_RAD && los && (!ownMoving || fireOnMove) && hasLOS(state.map, vehicle.pos, tPos)) {
      const round = vehicle.loadedRound!;
      const fired = roundWeapon(weapon, round);
      const moveMul = ownMoving ? FIRE_ON_MOVE_MUL : 1;
      vehicle.loadedRound = undefined;
      vehicle.lastMainShotAt = state.time;
      addShots(state, vehicle.side, 1);
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: weapon.id, side: vehicle.side });
      state.flashes.push({ pos: { ...vehicle.pos }, facing: facingRef, t: 0, kind: 'shell' });

      if (target.kind === 'vehicle') {
        const moving = target.vehicle.speed > 0.1;
        const p = Math.min(0.97, vehicleHitChance(weapon, distM, 0, 'standing', moving) * crew.gunnerMul * sightMul * bracketMul(lay.misses) * layMul * moveMul);
        const hit = fireAtVehicle(state, rng, weapon, vehicle.pos, vehicle.side, target.vehicle, p, true, { round, aimPoint: aim, skill, shooterTeamId: vehicle.teamId });
        // bracketing: the fall of a missed round is observed and corrected for
        if (!hit) { lay.misses = Math.min(2, (lay.misses ?? 0) + 1); lay.bracketFrom ??= { ...vehicle.pos }; lay.bracketAt ??= { ...tPos }; }
      } else {
        // a round fired on the move lands wide of a point target
        const at = { ...tPos };
        if (ownMoving) { const r = (4 + rng.next() * 10) / TILE_M, a = rng.next() * Math.PI * 2; at.x += Math.sin(a) * r; at.y -= Math.cos(a) * r; }
        state.tracers.push({ from: { ...vehicle.pos }, to: at, t: 0, hit: true, kind: 'shell' });
        if (fired.heRadiusM > 0) applyHESplash(state, rng, at, fired, vehicle.side, vehicle.pos);
      }
      // the loader rams the next round for the same kind of target straight away
      const next = chooseRound(weapon, counts, roundTarget);
      if (next) {
        counts[next]--; vehicle.mainAmmo--;
        vehicle.loadedRound = next;
        if (counts[next] === 0 && weapon.rounds && team) noteOutOf(state, team.id, next);
        startMainGunLoad(state, vehicle, def, weapon, crew, 0);
      }
      // the next round on this target needs only a correction (a moving one has to be tracked again)
      lay.followUp = true;
      lay.designateLeftS = 0;
      lay.fineLeftS = followUpS(layIn);
      lay.totalS = lay.fineLeftS;
      vehicle.layProgress = 0;
      vehicle.gunState = vehicle.loadedRound ? 'loading' : 'laying';
      // move on
      if (vehicle.fireHaltSince != null) { vehicle.fireHaltSince = undefined; vehicle.fireHaltUntil = undefined; }
    }
  } else {
    // nothing to shoot at: the lay is kept a few seconds (a target lost from sight for a moment)
    const lay = vehicle.gunLay;
    if (lay) {
      lay.lostAt ??= state.time;
      if (state.time - lay.lostAt > GUN_LAY_KEEP_S || !gunWorks) { vehicle.gunLay = undefined; vehicle.layProgress = undefined; }
    }
    vehicle.gunState = mainWeapon && gunWorks ? (vehicle.loadedRound && vehicle.mainFireTimer > 0 ? 'loading' : 'ready') : undefined;
    vehicle.fireHaltSince = undefined;
  }

  if (def.coaxWeaponId && vehicle.coaxAmmo > 0 && coaxUsable(vehicle) && (crew.gunner || crew.commanderUp)) {
    const coax = WEAPONS[def.coaxWeaponId];
    const infTarget = pickCoaxTarget(state, vehicle, 400);
    if (infTarget && vehicle.coaxFireTimer <= 0 && hasLOS(state.map, vehicle.pos, infTarget.pos)) {
      vehicle.coaxFireTimer = 1 / coax.rate;
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: coax.id, side: vehicle.side });
      let coaxRounds = 0;
      for (let i = 0; i < coax.burst && vehicle.coaxAmmo > 0; i++) {
        vehicle.coaxAmmo--;
        coaxRounds++;
        const distM = dist(vehicle.pos, infTarget.pos) * TILE_M;
        const cover = coverAt(state.map, infTarget.pos);
        const moving = infTarget.activity === 'moving' || infTarget.activity === 'movingFast';
        const p = vehicleHitChance(coax, distM, cover, infTarget.stance, moving);
        const hit = rng.chance(p);
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...infTarget.pos }, t: 0, hit, kind: 'bullet' });
        if (hit) {
          applyHit(state, infTarget, coax, rng, vehicle.side);
        } else {
          // Balance round 4: a vehicle coax MG missing should still suppress nearby infantry —
          // this was previously a silent miss with no suppression at all, understating how
          // dangerous a tank's coax MG is to infantry pinned in the open near it.
          for (const s2 of state.soldiers.values()) {
            if (s2.side === vehicle.side || s2.health === 'dead' || s2.health === 'incapacitated') continue;
            if (dist(s2.pos, infTarget.pos) > SUPPRESSION_SPLASH_RADIUS_TILES) continue;
            const amount = coax.suppression * 35 * (1 - (s2.cover ?? 0) * 0.5);
            s2.suppression = clamp(s2.suppression + amount, 0, 100);
            addSuppressionStat(state, vehicle.side, amount);
          }
        }
      }
      addShots(state, vehicle.side, coaxRounds);
    }
  }
}

// ------------------------------------------------------------------- main
export function stepCombat(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  for (const soldier of state.soldiers.values()) {
    stepSoldierCombat(state, rng, dt, soldier, track);
  }

  stepGrenades(state, rng, dt, track);

  for (const team of state.teams.values()) {
    if (team.vehicleId == null) stepMortarTeam(state, rng, dt, team, track);
  }

  stepSmokeOrders(state);

  for (const vehicle of state.vehicles.values()) {
    stepVehicleCombat(state, rng, dt, vehicle, track);
  }
}
