import { PASSENGER_FIRE_MUL } from './transport';
import type {
  AimPoint, BattleEvent, BattleMessage, BattleState, Health, RoundType, Side, Soldier, Team, Vec2, Vehicle, WeaponDef,
} from '@/shared/types';
import type { GameMap, Terrain } from '@/shared/types';
import { AMBUSH_TRIGGER_M, TILE_M, otherSide } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingAngle, facingFromAngle, facingTo, angleTo, turnTowards, wrapAngle } from '@/shared/math';
import { hitChance, penetrates, damageRoll } from './ballistics';
import { tileAt, coverAt, setTile, idx, inBounds } from './map';
import { isPassable } from './path';
import { hasLOS, hasLineOfFire, roundCanReach, eyeHeightM, EYE_VEHICLE_M, VEHICLE_GUN_M } from './los';
import type { LosHeights } from './los';
import { estimateAim, traceRound, traceTracers } from './shotTrace';
import { clearInfantryAim, infantryAimReady, infantryCanAim, infantryDidFire, observeInfantryMotion } from './infantryAim';
import { createSmgBurst, smgBodyFacing, smgHullIntercept, smgMuzzle, smgMuzzleHeight, smgRoundAim } from './smgFire';
import { hastyFireKind, isPanicking, panicFireOpportunity } from './hastyFire';
import { addSmoke } from './smoke';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';
import { coverFrom, omniCoverAt } from './cover';
import { blastExposure, type BlastExposure } from './blastExposure';
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
  gunnerSkill, noteOutOf, shotBlocker, soldierRounds, spotHitMul, vehicleRounds,
} from './aimPoint';
import {
  bowGunner, bowMgUsable, coaxUsable, crewEffects, systemState, expectedArmorMm, isImmobile, mainGunUsable, onBlastNearVehicle, resolveVehicleHit, sightAccuracyMul,
  turretFrozen, vehicleLayout,
} from './vehicleDamage';
import { attackPhase } from './orders';
import {
  fireMissionWait, onMissionRound, crewFeedsAmmo, hasChamberedRound, takeChamberedRound, chamberedRoundType, missionAimPoint,
  missionBracketMul, onMissionShotAtVehicle, behindGunShield, weaponFramePoint,
} from './crewWeapon';
import { observerVisibility } from './spotting';
import { isCrawlingUnderFire } from './hitTheDirt';
import { treesInBlast } from './trees';
import { blastThrowEnd, dismember, isSevereBlast, throwDebris } from './debris';
import { applyBlastDamage } from './structures';
import { dropKit, shedGearInBlast, throwItems } from './items';
import type { Order } from '@/shared/types';

export { hitChance, penetrates };

/** G19 hand-to-hand: bayonet/butt-stroke brawl when opposing infantry collide at
 * building-clearance distance. Modelled as an implicit always-available close weapon:
 * SMG carriers keep their muzzle advantage in a brawl (E08 flavour). */
const MELEE_WEAPON: WeaponDef = {
  id: 'melee', name: 'Hand-to-hand', cls: 'rifle', rangeM: 2, rate: 0.5, burst: 1,
  accuracy: 0.5, lethality: 0.35, suppression: 0.6, penetrationMm: 0, heRadiusM: 0,
  ammo: 9999, reloadS: 0,
};

/** Enemy infantry within this many tiles triggers the melee check. */
const MELEE_RANGE_TILES = 1.5;

/** One swing every few seconds per soldier. */
const MELEE_COOLDOWN_S = 5;

function stepMelee(state: BattleState, rng: Rng, dt: number, track: CombatTrack): void {
  const now = state.time;
  const cooldowns = track.meleeCooldown;
  const infantry = [...state.soldiers.values()].filter(
    (s) => s.vehicleId == null && s.health !== 'dead' && s.health !== 'incapacitated' && s.activity !== 'surrendered',
  );
  for (const a of infantry) {
    if (now < (cooldowns.get(a.id) ?? 0)) continue;
    let victim: Soldier | null = null;
    let bestD = Infinity;
    for (const b of infantry) {
      if (b.side === a.side) continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      if (d <= MELEE_RANGE_TILES && d < bestD) { victim = b; bestD = d; }
    }
    if (!victim) continue;
    cooldowns.set(a.id, now + MELEE_COOLDOWN_S);
    // SMG troops dominate a close brawl; broken men fight poorly
    const aw = WEAPONS[a.weaponId];
    const chance = (MELEE_WEAPON.accuracy ?? 0.5) + (aw?.cls === 'smg' ? 0.2 : 0) - (a.mind.state === 'broken' ? 0.25 : 0);
    if (rng.next() < chance) {
      applyHit(state, victim, MELEE_WEAPON, rng, a.side, a);
      addMessage(state, `Hand-to-hand fighting — ${a.rank}. ${a.name} and ${victim.rank}. ${victim.name} at close quarters.`, 'info');
    }
  }
}

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
  /** G19 hand-to-hand: per-soldier swing cooldown (battle-local; a module-level map would
   * leak stale battle-time stamps into the next battle and silence melee from battle 2 on). */
  meleeCooldown: Map<number, number>;
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
      meleeCooldown: new Map(),
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
  | { kind: 'point'; pos: Vec2; guesstimate?: boolean };

function canGuesstimate(weapon: WeaponDef): boolean {
  return weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg' || weapon.cls === 'tankgun';
}

function areaPoint(state: BattleState, from: Vec2, pos: Vec2, allowObscured: boolean, heights?: LosHeights): Target | null {
  if (hasLOS(state.map, from, pos, heights)) return { kind: 'point', pos };
  return allowObscured && hasLineOfFire(state.map, from, pos, heights) ? { kind: 'point', pos, guesstimate: true } : null;
}

function targetPosOf(target: Target): Vec2 {
  switch (target.kind) {
    case 'soldier': return target.soldier.pos;
    case 'vehicle': return target.vehicle.pos;
    case 'point': return target.pos;
  }
}

function tracerKindFor(weapon: WeaponDef): 'bullet' | 'mg' | 'shell' | 'mortar' | 'flame' | 'rocket' {
  if (weapon.cls === 'mortar') return 'mortar';
  if (weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket') return 'shell';
  if (weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg') return 'mg';
  if (weapon.cls === 'flamethrower') return 'flame';
  if (weapon.cls === 'rocket') return 'rocket';
  return 'bullet';
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

function canSoldierFire(s: Soldier, state: BattleState, allowPanic = false): boolean {
  if (s.mind.state === 'broken' || s.mind.state === 'cowering' || (!allowPanic && isPanicking(s))) return false;
  if (s.vehicleId != null) {
    // passengers fire over the sides of a HALTED transport (badly); crews never with their own arms
    if (s.seat !== 'passenger') return false;
    const ride = state.vehicles.get(s.vehicleId);
    if (!ride || Math.abs(ride.speed) > 0.05 || (ride.state !== 'ok' && ride.state !== 'immobilized')) return false;
  }
  if (isStunned(s, state.time) || isDazed(s, state.time)) return false; // dazed: no fire, no reload (sim/daze.ts)
  if (s.pickup?.until != null) return false; // stooping over an item (sim/pickup.ts)
  if (s.carryingMgMount != null) return false;
  if (s.hatch) return false; // climbing through a hatch (sim/vehicleCrew.ts)
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'cowering') return false;
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
  pointAt: (p: Vec2) => Target | null,
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
        // same gunner judgment as the free-target loop: an experienced (>=60) rocket man refuses a
        // lane blocked by vegetation unless desperate; a direct order does not bend physics, the
        // round would burst in the hedge regardless of who ordered it.
        if (weapon.cls === 'atrocket' && shotBlocker(state.map, soldier.pos, v.pos, true)) {
          const st = soldier.mind?.state;
          const desperate = st === 'panicked' || st === 'broken' || st === 'berserk';
          if (!desperate && soldier.experience >= 60) return null;
        }
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
      const held = soldier.aiming?.targetKind === 'soldier' ? cands.find((c) => c.s.id === soldier.aiming!.targetId) : undefined;
      if (held) return { kind: 'soldier', soldier: held.s };
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
  if (AREA_FIRE_CLASSES.has(weapon.cls)) return pointAt(order.target);
  return null;
}

/** Test hook: the target a soldier would engage right now (same rules as stepSoldierCombat). */
export function pickSoldierTargetForTest(state: BattleState, soldier: Soldier): Target | null {
  const weapon = WEAPONS[soldier.weaponId];
  return weapon ? pickTarget(state, soldier, state.teams.get(soldier.teamId), weapon) : null;
}

/** A man crawling on under fire (hitTheDirt.ts) keeps his mind on the move: he takes only a shot
 * that is there — a spotted enemy within CRAWL_FIRE_RANGE_M, with a line of sight from the ground,
 * inside his field of fire (CRAWL_FIELD_RAD of where the fire came from, else of his way ahead).
 * No area fire at beliefs, no hunting. */
export const CRAWL_FIRE_RANGE_M = 150;
export const CRAWL_FIELD_RAD = Math.PI / 3;
function crawlerTarget(state: BattleState, s: Soldier, weapon: WeaponDef): Target | null {
  const rangeM = Math.min(weapon.rangeM, CRAWL_FIRE_RANGE_M);
  const eyeM = eyeHeightM(s.stance);
  const facing = s.mind.threatDir ?? (s.path.length > 0 ? angleTo(s.pos, s.path[s.path.length - 1]) : facingAngle(s.facing));
  const inField = (p: Vec2) => Math.abs(wrapAngle(angleTo(s.pos, p) - facing)) <= CRAWL_FIELD_RAD;
  const ok = (p: Vec2) => dist(s.pos, p) * TILE_M <= rangeM && inField(p) && hasLOS(state.map, s.pos, p, { eyeM });
  const { soldiers, vehicles } = gatherCandidates(state, s.side);
  let best: Target | null = null;
  let bestD = Infinity;
  if (AT_WEAPON_CLASSES.has(weapon.cls)) {
    for (const v of vehicles) {
      const d = dist(s.pos, v.pos);
      if (d < bestD && ok(v.pos) && !isHopelessTarget(state, s, weapon, v)) { bestD = d; best = { kind: 'vehicle', vehicle: v }; }
    }
    if (best) return best;
  }
  for (const e of soldiers) {
    if (e.vehicleId != null) continue;
    const d = dist(s.pos, e.pos);
    if (d < bestD && ok(e.pos)) { bestD = d; best = { kind: 'soldier', soldier: e }; }
  }
  return best;
}

function pickTarget(state: BattleState, soldier: Soldier, team: Team | undefined, weapon: WeaponDef): Target | null {
  const map = state.map;
  if (isCrawlingUnderFire(soldier)) return crawlerTarget(state, soldier, weapon);
  // running upright: his mind is on getting there, no snap shots (he drops and crawls under fire)
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
  const pointAt = (pos: Vec2): Target | null => dist(soldier.pos, pos) * TILE_M <= maxRangeM
    ? areaPoint(state, soldier.pos, pos, canGuesstimate(weapon), { eyeM: firerEyeM }) : null;

  const { soldiers: cands, vehicles: vcands } = gatherCandidates(state, soldier.side);
  const preferVehicles = AT_WEAPON_CLASSES.has(weapon.cls);

  if (order?.type === 'fire' && order.target && order.targetTeamId != null) {
    const picked = pickAttackUnitTarget(state, soldier, weapon, order, inRangeLOS, pointAt);
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
    return pointAt(order.target);
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
      // a rocket deflected or burst in vegetation hits nothing: an experienced gunner refuses the
      // shot through a hedge unless desperate (panicked/broken = nothing left to lose); a green
      // one fires anyway and takes the risk — shotInterdiction then resolves it.
      if (weapon.cls === 'atrocket' && shotBlocker(state.map, soldier.pos, v.pos, true)) {
        const st = soldier.mind?.state;
        const desperate = st === 'panicked' || st === 'broken' || st === 'berserk';
        // deterministic: an experienced gunner (>=60) always waits for a clear lane; mid-grade men
        // are careless about it. Desperation (panicked/broken/berserk) fires regardless.
        if (!desperate && soldier.experience >= 60) continue;
      }
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
      .filter((b) => (b.kind === 'fired' || canGuesstimate(weapon)) && b.confidence > 0.6
        && state.time - b.time <= 30 && pointAt(b.pos))
      .sort((a, b) => dist(soldier.pos, a.pos) - dist(soldier.pos, b.pos))[0];
    if (bestBelief) {
      if (soldier.aiming?.targetKind === 'point' && dist(soldier.aiming.at, bestBelief.pos) < 0.5) {
        return { kind: 'point', pos: bestBelief.pos, guesstimate: canGuesstimate(weapon) };
      }
      const track = getTrack(state);
      const n = (track.beliefFireCounter.get(soldier.id) ?? 0) + 1;
      track.beliefFireCounter.set(soldier.id, n);
      if (n % 3 === 0) return { kind: 'point', pos: bestBelief.pos, guesstimate: canGuesstimate(weapon) };
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
  force?: Health,
  coverOverride?: number,
): void {
  // A soldier who is already incapacitated or dead cannot be hit again: no re-rolled outcome, no
  // repeated kill/casualty message, no double-counted kill (regression: the same "has been killed"
  // message and kill event firing twice for one soldier because later shots kept landing on an
  // already-incapacitated body before it was excluded from targeting).
  if (victim.health === 'dead' || victim.health === 'incapacitated') return;

  // A forced outcome (near-direct lethal blast: combat.ts severe zone) skips the damage roll but
  // keeps every bit of kill bookkeeping — kill event, killer credit, sides[] kills/losses, the
  // casualty-seen stress on teammates and the AAR report.
  const cover = coverOverride ?? coverAt(state.map, victim.pos);
  const result: Health | null = force ?? damageRoll(weapon, cover, rng);
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

/** An exposed man is thrown away from a sufficiently strong burst, up to 15 m (scaled
 * by force; never through a wall, a vehicle, water or off the map — it stops at the last passable
 * point). The original posture and physical shelter attenuate force before throw, stun, daze
 * and the renderer's flight arc. Weak waves cannot lift a man. Survivors in the inner radius
 * land prone and temporarily cannot act; wounded/green men take longer to recover. */
export function applyBlastKnockback(state: BattleState, rng: Rng, s: Soldier, burst: Vec2, weapon: WeaponDef, woundedByIt = false,
  exposure: BlastExposure = blastExposure(state, s, burst), knockdownShare = 0.5): void {
  const radiusTiles = weapon.heRadiusM / TILE_M;
  const d = dist(s.pos, burst);
  const force = blastForce(weapon, d) * exposure.force;
  if (force < 0.22) return;
  const ang = d > 1e-3 ? Math.atan2(s.pos.y - burst.y, s.pos.x - burst.x) : rng.range(0, Math.PI * 2);
  // Quadratic impulse keeps exposed standing men vulnerable without giving every sheltered man
  // the old minimum one-metre throw. The renderer uses this same attenuated force for its arc.
  const throwM = clamp(force * force * 9.5, 0, 15);
  const origin = { x: s.pos.x, y: s.pos.y };
  // the ground trace is shared with corpses, kit and body parts (debris.ts)
  const p = blastThrowEnd(state, origin, ang, throwM);
  s.pos = { x: p.x, y: p.y };
  s.blast = { from: { x: burst.x, y: burst.y }, time: state.time, force, origin };
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  if (d > radiusTiles * knockdownShare) return;
  let stun = rng.range(1.5, 3);
  if (s.health === 'wounded') stun += 0.6;
  if (s.experience < 35) stun += 0.5;
  s.stunnedUntil = Math.max(s.stunnedUntil ?? 0, state.time + Math.min(4, stun * clamp(force / 0.6, 0.4, 1)));
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
    const exposure = blastExposure(state, s, burst);
    dropKit(state, rng, s);
    applyBlastKnockback(state, rng, s, burst, weapon, false, exposure);
    if (exposure.cover < 0.5 && isSevereBlast(weapon, d)) dismember(state, rng, s, burst, blastForce(weapon, d) * exposure.force);
  }
  const forceAt = (dTiles: number): number => blastForce(weapon, dTiles);
  throwItems(state, rng, burst, radiusTiles, forceAt);
  throwDebris(state, rng, burst, radiusTiles, forceAt);
}

export function applyHESplash(state: BattleState, rng: Rng, pos: Vec2, weapon: WeaponDef, shooterSide: Side, from?: Vec2, skipVehicleId?: number,
  blastOptions: { innerLethalM?: number; knockdownShare?: number; directHitId?: number; killer?: Soldier } = {}): void {
  const radiusTiles = weapon.heRadiusM / TILE_M;
  // Perceived shock uses the position and posture at impact, before any throw or casualty.
  for (const s of state.soldiers.values()) {
    if (s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId == null) onExplosionNear(state, s, pos);
  }
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
      const exposure = blastExposure(state, s, pos);
      const healthBefore = s.health;
      const falloff = 1 - d / radiusTiles;
      const inner = blastOptions.innerLethalM != null && d * TILE_M <= blastOptions.innerLethalM;
      const chance = blastOptions.directHitId === s.id ? 1 : clamp((inner ? 1 : falloff * weapon.lethality) * exposure.injury, 0, 1);
      if (rng.chance(chance)) {
        applyHit(state, s, weapon, rng, shooterSide, blastOptions.killer, undefined, exposure.cover);
      } else {
        const amount = weapon.suppression * 30 * falloff * exposure.shock;
        s.suppression = clamp(s.suppression + amount, 0, 100);
        addSuppressionStat(state, shooterSide, amount);
      }
      // a casualty of this burst leaves his kit where he stood, before he (and it) is thrown
      const health = s.health as Health; // applyHit may have changed it
      const down = health === 'dead' || health === 'incapacitated';
      if (down) dropKit(state, rng, s);
      applyBlastKnockback(state, rng, s, pos, weapon, healthBefore !== 'wounded' && health === 'wounded', exposure, blastOptions.knockdownShare);
      shedGearInBlast(state, rng, s, pos, blastForce(weapon, d) * exposure.force);
      // spec 2026-09-17 §8: a severe blast tears the casualty apart
      if (down && exposure.cover < 0.5 && isSevereBlast(weapon, d)) dismember(state, rng, s, pos, blastForce(weapon, d) * exposure.force);
    }
    throwLooseObjects(state, rng, pos, weapon, hitNow);
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
  state.explosions.push({ pos: { ...pos }, radiusM: weapon.heRadiusM, t: 0, kind, weaponId: weapon.id });
  state.events.push({ kind: 'explosion', pos: { ...pos }, side: shooterSide, weaponId: weapon.id });
  leaveCrater(state, pos, weapon);
  treesInBlast(state, rng, pos, weapon);
  applyBlastDamage(state, pos, weapon, { side: shooterSide, from });
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

/** `underHullSizeM`: a vehicle blowing up (sim/vehicleExplosion.ts) leaves a full-size bowl and
 * scorch of this size under its own hull instead of the small scorch of a round bursting on it. */
export function leaveCrater(state: BattleState, pos: Vec2, weapon: WeaponDef, underHullSizeM?: number): void {
  const map: GameMap = state.map;
  const c = underHullSizeM != null ? { sizeM: underHullSizeM, kind: 'shell' as const } : craterForWeapon(weapon);
  if (!c) return;
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  const t = tileAt(map, tx, ty);
  if (!MARKABLE_TERRAIN.has(t)) return;
  let onVehicle = false;
  if (underHullSizeM == null) for (const v of state.vehicles.values()) if (dist(v.pos, pos) < 1.2) { onVehicle = true; break; }
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
  map.dirtyTiles?.push(idx(map, tx, ty));
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

/** Gun shells and AT rockets are real objects in the arena: anything between firer and target
 * can stop them. A tank wreck (knocked-out or burning hull) stops or deflects an AP shell and
 * bursts an AT rocket on the spot; a wooden wall does the same to a rocket while an AP shell
 * punches through. Vegetation (hedge/tall brush) does not stop a shell, but a fin-stabilised
 * rocket deflects or bursts in it — a careful (experienced) gunner refuses the shot unless the
 * situation is desperate; a green one fires anyway and takes the risk. */
/** Test hook + internal: resolves what blocks a straight AT shot (wrecks, walls, vegetation). */
export function shotInterdiction(state: BattleState, rng: Rng, from: Vec2, to: Vec2, weapon: WeaponDef, _skill: number, shooterSide: Side): boolean {
  const atRocket = weapon.cls === 'atrocket';
  const heShell = weapon.cls === 'tankgun' || weapon.cls === 'atgun';
  if (!atRocket && !heShell) return false;

  // 1. Wrecks / hulls in the way: any vehicle (dead or alive) whose hull the straight path
  //    crosses short of the target. Thick armour stops AP shells; everything bursts a rocket.
  for (const v of state.vehicles.values()) {
    if (dist(from, v.pos) <= 1.5 || dist(to, v.pos) <= 1.5) continue; // firer's own / target's hull
    if (segmentPassesHull(from, to, v.pos, VEHICLE_DEFS[v.defId]?.widthM ?? 3)) {
      const impact = { x: v.pos.x, y: v.pos.y };
      state.projectiles.push({
        kind: atRocket ? 'atrocket' : 'shell', weaponId: weapon.id, from: { ...from }, to: impact,
        t0: state.time, flightS: Math.max(0.08, dist(from, impact) * TILE_M / (atRocket ? 80 : 600)),
        dirRad: angleTo(from, impact), arcM: 0, hitKind: 'impact', preResolved: true,
      });
      state.explosions.push({ pos: impact, radiusM: 0, t: 0, kind: 'small' });
      state.sparks.push({ pos: impact, t: 0, kind: 'dust' });
      state.events.push({ kind: 'shot', pos: { ...from }, weaponId: weapon.id, side: shooterSide });
      if (weapon.heRadiusM > 0) applyHESplash(state, rng, impact, weapon, shooterSide, from);
      return true;
    }
  }

  // 2. Terrain on the path: shells pass wood, stop on stone; rockets burst on wood, hedge, fence.
  const block = shotBlocker(state.map, from, to, atRocket);
  if (!block) return false;
  if (block.kind === 'hard' || atRocket) {
    const impact = { x: block.tile.x + 0.5, y: block.tile.y + 0.5 };
    state.projectiles.push({
      kind: atRocket ? 'atrocket' : 'shell', weaponId: weapon.id, from: { ...from }, to: impact,
      t0: state.time, flightS: Math.max(0.08, dist(from, impact) * TILE_M / (atRocket ? 80 : 600)),
      dirRad: angleTo(from, impact), arcM: 0, hitKind: 'impact', preResolved: true,
    });
    state.explosions.push({ pos: impact, radiusM: 0, t: 0, kind: 'small' });
    state.sparks.push({ pos: impact, t: 0, kind: 'dust' });
    if (atRocket && weapon.heRadiusM > 0) applyHESplash(state, rng, impact, weapon, shooterSide, from);
    return true;
  }

  // 3. A shell through a wooden wall punches through without a problem (per the original game);
  //    only wrecks/stone stop it.
  return false;
}

/** Does the segment a->b cross a hull of half-width `hw` (tiles) centred at c, excluding the
 * endpoints' immediate neighbourhood (handled by the caller)? */
function segmentPassesHull(a: Vec2, b: Vec2, c: Vec2, widthM: number): boolean {
  const hw = Math.max(1, widthM / TILE_M / 2) + 0.3;
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 <= 0) return false;
  let t = ((c.x - a.x) * abx + (c.y - a.y) * aby) / len2;
  t = clamp(t, 0.05, 0.95); // keep clear of firer and target
  const px = a.x + abx * t, py = a.y + aby * t;
  const dx = px - c.x, dy = py - c.y;
  return dx * dx + dy * dy <= hw * hw;
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
  const atRocket = weapon.cls === 'atrocket';
  // You cannot shoot through objects without a risk: a wreck (or any live vehicle hull) between
  // firer and target interdicts the shot — AP shells stop or deflect on thick armour, AT rockets
  // burst on impact. Wooden walls pass AP shells but burst a rocket; experience only reduces the
  // risk of firing through vegetation, it never removes the physical block. (Desperate men may
  // still take the shot: the AI/gunner decision lives with the caller; here we resolve physics.)
  const blocked = shotInterdiction(state, rng, shooterPos, vehicle.pos, weapon, shot.skill ?? 0.7, shooterSide);
  if (blocked) return false;
  const pSpot = aim === 'mass' ? p : p * spotHitMul(aim, distM, Math.abs(vehicle.speed) > 0.1, shot.skill ?? 0.7);
  const pAny = aim === 'mass' ? p : pSpot + (p - pSpot) * SPOT_MISS_STILL_HITS;
  const r = rng.next();
  const rw = roundWeapon(weapon, round);
  const shotPath = traceRound(state, rng, shooterPos, vehicle.pos, rw, { eyeM: EYE_VEHICLE_M, targetM: EYE_VEHICLE_M });
  const intercepted = shotPath.blocked || shotPath.deflected;
  if (wantTracer) traceTracers(state, shotPath, kind, !intercepted && r < pAny);
  // the round is in flight (A1, visual): shells at ~600 m/s, rockets at 80 m/s. Damage is
  // resolved at once (the visual catches up); the renderer plays the arrival on landing.
  const projKind: 'shell' | 'atrocket' = weapon.cls === 'atrocket' ? 'atrocket' : 'shell';
  const speed = projKind === 'atrocket' ? 80 : 600;
  const flightS = Math.max(0.08, dist(shooterPos, shotPath.impact) * TILE_M / speed);
  const arrive = state.time + flightS; // the strike shows when the round gets there
  state.projectiles.push({
    kind: projKind, weaponId: weapon.id, from: { ...shooterPos }, to: { ...shotPath.impact },
    t0: state.time, flightS, dirRad: angleTo(shooterPos, shotPath.impact),
    arcM: 0, hitKind: r >= pAny ? 'ricochet' : 'impact', preResolved: true,
  });
  if (intercepted) {
    areaImpact(state, rng, shooterPos, shooterSide, rw, shotPath.impact);
    return false;
  }
  if (r >= pAny) {
    state.sparks.push({ pos: { ...vehicle.pos }, t: arrive, kind: 'dust' });
    onVehicleNearMiss(state, vehicle, weapon, shooterPos);
    return false;
  }

  const res = resolveVehicleHit(state, rng, vehicle, {
    weapon, round, shooterPos, shooterSide, shooterTeamId: shot.shooterTeamId, distM,
    aimPoint: aim !== 'mass' && r < pSpot ? aim : undefined,
  });
  if (!res.penetrated) {
    state.events.push({ kind: 'armorClank', pos: { ...vehicle.pos }, side: shooterSide });
    state.sparks.push({ pos: { ...vehicle.pos }, t: arrive, kind: 'armor' });
  } else {
    state.events.push({ kind: 'penHit', pos: { ...vehicle.pos }, side: shooterSide });
    state.sparks.push({ pos: { ...vehicle.pos }, t: arrive, kind: 'pen' });
  }
  if (vehicle.state !== 'knockedOut' && vehicle.state !== 'burning') {
    onVehicleHit(state, vehicle, weapon, res.penetrated, { ...shooterPos });
  }

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

/** Area rounds act where the traced round actually arrived, never on an unseen target ID. */
function areaImpact(state: BattleState, rng: Rng, from: Vec2, side: Side, weapon: WeaponDef, impact: Vec2, shooter?: Soldier, incidentalHit = false): void {
  if (weapon.heRadiusM > 0) {
    applyHESplash(state, rng, impact, weapon, side, from);
    return;
  }
  for (const s of state.soldiers.values()) {
    if (s.side === side || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    const d = dist(s.pos, impact);
    if (d <= SUPPRESSION_SPLASH_RADIUS_TILES && roundCanReach(state.map, from, s.pos)) {
      const amount = weapon.suppression * 40 * (1 - (s.cover ?? 0) * 0.5);
      s.suppression = clamp(s.suppression + amount, 0, 100);
      addSuppressionStat(state, side, amount);
      if (shooter) onIncomingFire(state, rng, s, shooter, impact, weapon.cls);
      if (incidentalHit && d < 0.35 && rng.chance(weapon.accuracy * (1 - d / 0.35))) applyHit(state, s, weapon, rng, side, shooter);
    } else maybeNoiseStress(s, impact, weapon.cls);
  }
  state.explosions.push({ pos: { ...impact }, radiusM: 0, t: 0, kind: 'small' });
}

function resolveRound(state: BattleState, rng: Rng, shooter: Soldier, weapon: WeaponDef, target: Target, wantTracer: boolean): void {
  const map = state.map;
  if (shooter.aiming?.hasty) {
    const aim = targetPosOf(target), range = dist(shooter.pos, aim);
    const heading = angleTo(shooter.pos, aim) + rng.gauss() * (shooter.aiming.hasty === 'panic' ? 0.12 : 0.045);
    resolveSmallArmsRay(state, rng, shooter, weapon,
      { x: shooter.pos.x + Math.sin(heading) * range, y: shooter.pos.y - Math.cos(heading) * range }, heading);
    return;
  }
  if (target.kind === 'point') {
    const aim = target.guesstimate ? estimateAim(state, rng, shooter.pos, target.pos) : target.pos;
    const shot = traceRound(state, rng, shooter.pos, aim, weapon, { eyeM: eyeHeightM(shooter.stance), targetM: target.guesstimate ? 0.5 : 1.7 });
    if (wantTracer) traceTracers(state, shot, tracerKindFor(weapon));
    areaImpact(state, rng, shooter.pos, shooter.side, weapon, shot.impact, shooter, !!target.guesstimate);
    return;
  }

  if (target.kind === 'vehicle') {
    const vehicle = target.vehicle;
    const distM = dist(shooter.pos, vehicle.pos) * TILE_M;
    const speedMs = Math.abs(vehicle.speed);
    const p = vehicleHitChance(weapon, distM, 0, 'standing', speedMs > 0.1, speedMs) * (shooter.seat === 'passenger' ? PASSENGER_FIRE_MUL : 1) * recoveryFactor(shooter, state.time);
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

  // Gun shield (user rule): small-arms fire NEVER penetrates an in-action AT gun's shield. A
  // crewman in the shield's shadow against frontal fire is simply not hittable — the round
  // strikes the plate and ricochets (the angled plate throws it off). Suppression still lands:
  // the men behind the plate hear it. HE and shells are resolved by their own blast/AT paths.
  if (SMALL_ARMS_CLASSES.has(weapon.cls) && weapon.heRadiusM === 0
    && behindGunShield(state, victim, shooter.pos)) {
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...victim.pos }, t: 0, hit: false, kind: tracerKindFor(weapon) });
    // ricochet off the angled plate: spark at the shield line, thrown to a deflected side
    const team = state.teams.get(victim.teamId);
    const cw = team?.crewWeapon;
    if (cw) {
      const impact = weaponFramePoint(cw.pos, cw.facing, { x: rng.chance(0.5) ? 0.5 : -0.5, y: -0.4 });
      state.sparks.push({ pos: impact, t: 0, kind: 'armor' });
      state.events.push({ kind: 'shieldRicochet', pos: impact, side: shooter.side });
    }
    onIncomingFire(state, rng, victim, shooter, victim.pos, weapon.cls);
    return;
  }

  if (rng.chance(p)) {
    const shot = traceRound(state, rng, shooter.pos, victim.pos, weapon, { eyeM: eyeHeightM(shooter.stance), targetM: eyeHeightM(victim.stance) });
    if (wantTracer) traceTracers(state, shot, tracerKindFor(weapon), !shot.blocked && !shot.deflected);
    if (shot.blocked || shot.deflected) {
      areaImpact(state, rng, shooter.pos, shooter.side, weapon, shot.impact, shooter);
      return;
    }
    if (weapon.heRadiusM > 0 && weapon.cls !== 'flamethrower' && weapon.cls !== 'grenade') {
      // One casualty roll for the direct hit, with the same wave affecting nearby men using
      // their original posture and cover. Do not hit the target once here and again in splash.
      applyHESplash(state, rng, { ...victim.pos }, weapon, shooter.side, shooter.pos, undefined,
        { directHitId: victim.id, killer: shooter });
      return;
    }
    if (SMALL_ARMS_CLASSES.has(weapon.cls)) getTrack(state).smallArmsHit++;
    onIncomingFire(state, rng, victim, shooter, victim.pos, weapon.cls, false);
    applyHit(state, victim, weapon, rng, shooter.side, shooter);
    state.sparks.push({ pos: { ...victim.pos }, t: state.time, kind: 'body' });
  } else {
    const spread = 0.5 + distM / 200;
    const aimed = { x: victim.pos.x + rng.gauss() * spread, y: victim.pos.y + rng.gauss() * spread };
    const shot = traceRound(state, rng, shooter.pos, aimed, weapon, { eyeM: eyeHeightM(shooter.stance), targetM: eyeHeightM(victim.stance) });
    const impact = shot.impact;
    if (wantTracer) traceTracers(state, shot, tracerKindFor(weapon));
    if (shot.blocked || shot.deflected) {
      areaImpact(state, rng, shooter.pos, shooter.side, weapon, impact, shooter);
      return;
    }
    if (weapon.heRadiusM === 0) {
      state.explosions.push({ pos: { ...impact }, radiusM: 0, t: 0, kind: 'small' });
    } else {
      // explosive miss: one splash resolves casualties, knockdown and the crater with every
      // man's ORIGINAL posture and shelter (the old double pass used positions mid-throw)
      applyHESplash(state, rng, impact, weapon, shooter.side, shooter.pos, undefined, { killer: shooter });
      return;
    }
    onIncomingFire(state, rng, victim, shooter, impact, weapon.cls);
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      if (s2.id === victim.id) continue;
      const dTiles = dist(s2.pos, impact);
      // Cover blocks near-miss suppression too: a round that stops at a wall does not
      // pressure the man standing just beyond it (same rule as areaImpact above).
      if (dTiles <= SUPPRESSION_SPLASH_RADIUS_TILES && roundCanReach(map, shooter.pos, s2.pos)) {
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

/** Resolve an SMG or hurried small-arms ray. A sweeping round cannot roll a hit on the originally selected
 * man when its barrel is pointing elsewhere; cover and vegetation also intercept this same ray. */
function resolveSmallArmsRay(state: BattleState, rng: Rng, s: Soldier, weapon: WeaponDef, aim: Vec2, heading: number): void {
  const b = s.smgBurst;
  const from = smgMuzzle(s, heading), range = dist(s.pos, aim);
  const to = { x: from.x + Math.sin(heading) * range, y: from.y - Math.cos(heading) * range };
  const initialHull = smgHullIntercept(state, from, to, s.vehicleId);
  const shot = traceRound(state, rng, from, initialHull?.pos ?? to, weapon, { eyeM: smgMuzzleHeight(s, b?.mode ?? 'aimed'), targetM: 0.8 });
  let hull: ReturnType<typeof smgHullIntercept> = null;
  for (let leg = 1; leg < shot.points.length; leg++) {
    hull = smgHullIntercept(state, shot.points[leg - 1], shot.points[leg], s.vehicleId);
    if (!hull) continue;
    shot.points = [...shot.points.slice(0, leg), { ...hull.pos }]; shot.impact = hull.pos; shot.blocked = true; break;
  }
  const track = getTrack(state); track.smallArmsFired++;
  const contacts: { victim: Soldier; pos: Vec2; along: number; leg: number; distance: number }[] = [];
  for (const victim of state.soldiers.values()) {
    if (victim.side === s.side || victim.health === 'dead' || victim.health === 'incapacitated' || victim.vehicleId != null) continue;
    let closest = Infinity, travelled = 0, nearest = { pos: shot.impact, along: Infinity, leg: 1 };
    for (let leg = 1; leg < shot.points.length; leg++) {
      const a = shot.points[leg - 1], end = shot.points[leg], dx = end.x - a.x, dy = end.y - a.y;
      const length = Math.hypot(dx, dy);
      const alongRay = length > 0 ? ((victim.pos.x - a.x) * dx + (victim.pos.y - a.y) * dy) / (length * length) : 0;
      // A man just behind the intercept is not in the ray, even if he is within the hit radius.
      if (shot.blocked && leg === shot.points.length - 1 && alongRay >= 1) continue;
      const t = clamp(alongRay, 0, 1);
      const p = { x: a.x + dx * t, y: a.y + dy * t }, d = dist(p, victim.pos);
      if (d < closest) { closest = d; nearest = { pos: p, along: travelled + t * length, leg }; }
      travelled += length;
    }
    if (closest <= SUPPRESSION_SPLASH_RADIUS_TILES && roundCanReach(state.map, s.pos, victim.pos)) {
      contacts.push({ victim, ...nearest, distance: closest });
    }
  }
  contacts.sort((a, b) => a.along - b.along);
  let hit = false;
  for (const contact of contacts) {
    const v = contact.victim;
    if (contact.along > dist(from, shot.impact) + 0.5 && !shot.deflected) break;
    const amount = weapon.suppression * (contact.distance < 0.3 ? 30 : 16) * (1 - (v.cover ?? 0) * 0.5);
    v.suppression = clamp(v.suppression + amount, 0, 100);
    addSuppressionStat(state, s.side, amount);
    onIncomingFire(state, rng, v, s, contact.pos, weapon.cls);
    if (contact.distance > 0.3 || hit) continue;
    const cover = coverFrom(state.map, v.pos, angleTo(v.pos, s.pos));
    const accuracy = hitChance(weapon, dist(s.pos, v.pos) * TILE_M, cover, v.stance, s, v.path.length > 0)
      * (b?.mode === 'hip' ? 0.5 : 1) * (b?.uncontrolled ? 0.65 : 1) * (1 - (b?.recoil ?? 0) * 0.25)
      * recoveryFactor(s, state.time) * (s.seat === 'passenger' ? PASSENGER_FIRE_MUL : 1);
    if (!rng.chance(accuracy)) continue;
    applyHit(state, v, weapon, rng, s.side, s); track.smallArmsHit++; hit = true;
    shot.points = [...shot.points.slice(0, contact.leg), { ...contact.pos }]; shot.impact = contact.pos;
    state.sparks.push({ pos: { ...v.pos }, t: state.time, kind: 'body' });
    break;
  }
  traceTracers(state, shot, tracerKindFor(weapon), hit);
  if (hull && !hit) {
    const v = hull.vehicle;
    state.sparks.push({ pos: { ...hull.pos }, t: state.time, kind: 'armor' });
    if (v.side !== s.side && v.state !== 'knockedOut' && v.state !== 'burning') {
      const result = resolveVehicleHit(state, rng, v, { weapon, round: 'ap', shooterPos: s.pos, shooterSide: s.side,
        shooterTeamId: s.teamId, distM: dist(s.pos, v.pos) * TILE_M });
      onVehicleHit(state, v, weapon, result.penetrated, { ...s.pos });
    }
  }
  if (!hit) state.explosions.push({ pos: { ...shot.impact }, radiusM: 0, t: 0, kind: 'small' });
}

/** Returns true while handling an existing trigger hold, including its short recovery. */
function stepSmgBurst(state: BattleState, rng: Rng, s: Soldier, weapon: WeaponDef, team: Team | undefined): boolean {
  const b = s.smgBurst;
  if (!b) return false;
  if (weapon.id !== b.weaponId || s.stance !== b.stance || dist(s.pos, b.from) * TILE_M > 0.3
    || team?.order?.issuedAt !== b.orderAt || team?.order?.type !== b.orderType
    || (s.suppression > 85 && b.hasty !== 'panic') || s.activity === 'reloading' || (s.dodgeUntil != null && state.time < s.dodgeUntil)) {
    s.smgBurst = undefined; clearInfantryAim(s); s.fireTimer = Math.max(s.fireTimer, 0.3); return true;
  }
  // A 10 Hz step can contain two PPSh rounds. Their due times, direction and ammunition are
  // independent; renderer effects are aged from the individual discharge time.
  while (b.fired < b.rounds && b.nextAt <= state.time + 1e-6 && s.ammo > 0) {
    const round = smgRoundAim(s, b, b.fired, rng), at = b.nextAt;
    b.heading = round.heading; b.recoil = round.recoil;
    b.bodyFacing = smgBodyFacing(b.bodyFacing, b.heading, s.stance === 'prone');
    b.lastRoundAt = at; b.fired++; b.nextAt += b.interval;
    s.ammo--; s.lastFiredAt = at; s.facing = facingFromAngle(b.bodyFacing);
    const age = Math.max(0, state.time - at), tracerStart = state.tracers.length;
    resolveSmallArmsRay(state, rng, s, weapon, round.pos, round.heading);
    for (let i = tracerStart; i < state.tracers.length; i++) state.tracers[i].t = age;
    if (state.tracers[tracerStart]) state.tracers[tracerStart].fromHeightM = smgMuzzleHeight(s, b.mode) * 1.3;
    state.flashes.push({ pos: smgMuzzle(s, b.heading), facing: b.heading, t: age, atMuzzle: true, heightM: smgMuzzleHeight(s, b.mode) * 1.3 });
    state.events.push({ kind: 'shot', pos: { ...s.pos }, weaponId: weapon.id, side: s.side, singleRound: true });
    addShots(state, s.side, 1);
  }
  if (state.time >= b.until) { s.smgBurst = undefined; infantryDidFire(s, state.time); }
  return true;
}

function fireBurst(state: BattleState, rng: Rng, soldier: Soldier, weapon: WeaponDef, target: Target): void {
  // guns cycle on their LOADING and LAYING phases (crewWeapon.ts / gunTiming.ts), not on `rate`
  soldier.fireTimer = weapon.cls === 'atgun' && weapon.loadS != null ? 0.5 : 1 / weapon.rate;
  // A hurried return shot is followed by hesitation under heavy fire. Fast presentation must
  // not cancel suppression's reduction in sustained fire rate.
  if (soldier.aiming?.hasty && soldier.suppression >= 55) {
    soldier.fireTimer = Math.max(soldier.fireTimer, 4 + (soldier.suppression - 55) * 0.08);
  }
  if (!isPanicking(soldier) && soldier.activity !== 'moving' && soldier.activity !== 'sneaking' && soldier.activity !== 'movingFast') {
    soldier.activity = 'firing';
  }
  if (weapon.cls === 'smg') {
    const team = state.teams.get(soldier.teamId);
    soldier.smgBurst = createSmgBurst(soldier, weapon, targetPosOf(target), team, state.time, rng);
    stepSmgBurst(state, rng, soldier, weapon, team);
    return;
  }
  soldier.lastFiredAt = state.time;
  const tPos = targetPosOf(target);
  soldier.facing = facingTo(soldier.pos, tPos);
  const flashKind = weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 'shell' as const : undefined;
  // B2: infantry flash sits at the muzzle, not the body centre. The weapon is
  // carried in front of the chest, so offset forward along the facing by a
  // small amount (varies by weapon class).
  const muzzleOffM =
    weapon.cls === 'rifle' ? 0.65 :
    weapon.cls === 'lmg' ? 0.8 :
    weapon.cls === 'hmg' ? 0.9 :
    weapon.cls === 'atgun' ? 1.0 :
    weapon.cls === 'atrocket' ? 0.9 :
    0.55;
  const mx = soldier.pos.x + Math.sin(soldier.facing) * muzzleOffM;
  const my = soldier.pos.y - Math.cos(soldier.facing) * muzzleOffM;
  state.flashes.push({ pos: { x: mx, y: my }, facing: facingAngle(soldier.facing), t: 0, kind: flashKind });
  state.events.push({ kind: 'shot', pos: { ...soldier.pos }, weaponId: weapon.id, side: soldier.side });
  // B2: a rocket launcher vents its backblast — a dust puff behind the firer (opposite his
  // facing), read by the renderer as a flash with no muzzle cone.
  if (weapon.cls === 'atrocket') {
    // B2: a rocket launcher vents its backblast — a dust puff behind the firer (opposite his
    // facing), and the launch whomp for audio.
    const back = facingTo(soldier.pos, tPos) + Math.PI;
    state.sparks.push({
      pos: { x: soldier.pos.x + Math.sin(back) * 1.2, y: soldier.pos.y - Math.cos(back) * 1.2 },
      t: state.time, kind: 'backblast',
    });
    state.events.push({ kind: 'rocketLaunch', pos: { ...soldier.pos }, side: soldier.side, weaponId: weapon.id });
  }

  // Every MG round and every tank/AT shell gets a tracer; small arms (rifle/
  // SMG) show a tracer roughly every 3rd shot, like the original's darting
  // tracer rounds mixed in with the rest of the burst.
  const tracerEvery =
    weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg'
    || weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 1
    : weapon.cls === 'rifle' ? 3
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
  if (!canSoldierFire(soldier, state, true)) { clearInfantryAim(soldier); soldier.smgBurst = undefined; return; }
  const weapon = WEAPONS[soldier.weaponId];
  if (!weapon || weapon.indirect) { clearInfantryAim(soldier); soldier.smgBurst = undefined; return; }
  const team = state.teams.get(soldier.teamId);
  const panic = isPanicking(soldier);
  const panicWindow = panicFireOpportunity(soldier, weapon, state.time, rng);
  if (panic && (!panicWindow || (team?.crewWeapon?.gunnerId === soldier.id && team.crewWeapon.weaponId === soldier.weaponId))) {
    clearInfantryAim(soldier); soldier.smgBurst = undefined; return;
  }
  if (stepSmgBurst(state, rng, soldier, weapon, team)) return;
  const crewAimed = team?.crewWeapon?.gunnerId === soldier.id && team.crewWeapon.weaponId === soldier.weaponId;
  if (!crewAimed) observeInfantryMotion(soldier, state.time);

  if (soldier.activity === 'reloading') {
    clearInfantryAim(soldier);
    soldier.reloadTimer -= dt;
    if (soldier.reloadTimer <= 0) {
      const take = Math.min(weapon.ammo, soldier.ammoReserve);
      soldier.ammo = take;
      soldier.ammoReserve -= take;
      const moveType = team?.order?.type;
      soldier.activity = isPanicking(soldier) ? 'panicked' : soldier.path.length === 0 ? 'idle'
        : moveType === 'sneak' ? 'sneaking' : moveType === 'moveFast' || moveType === 'assault' ? 'movingFast' : 'moving';
    }
    return;
  }

  soldier.fireTimer -= dt;

  // guns and HMGs are fed by their crew's tasks (crewWeapon.ts: `load` takes the round from the
  // ammunition, `feedBelt` a new belt); a gun with a round in the breech can fire its last one
  const crewFed = crewFeedsAmmo(team, soldier);
  if (soldier.ammo <= 0 && !hasChamberedRound(team, soldier)) {
    clearInfantryAim(soldier);
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
  if (!crewAimed && !infantryCanAim(soldier, state.time)) { clearInfantryAim(soldier); return; }

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
  if (soldier.mind.state !== 'berserk' && !panic) {
    // Tried loosening 30%->40% and >85->90 (paired with the suppression-decay change above);
    // harness showed the combination made attacker win rate worse, not better. Reverted to the
    // original spec §6.7 thresholds — the shot-volume gap turned out to be dominated by the AI's
    // move/fire-eligibility split (see ai.ts bounding overwatch), not this throttle.
    // a man who went down on the move (hitTheDirt.ts) and is pinned keeps his head down: the move
    // is his mission, not a firefight from where he lies
    if (soldier.mind.state === 'pinned' && soldier.mind.downAt != null) { clearInfantryAim(soldier); return; }
    if (soldier.mind.state === 'pinned' && !rng.chance(0.3)) return;
    if (soldier.suppression > 85) { clearInfantryAim(soldier); return; }
    if (soldier.suppression > 60 && !rng.chance(0.3)) return;
  }

  const target = pickTarget(state, soldier, team, weapon);
  if (!target) { clearInfantryAim(soldier); return; }
  if (panic && hastyFireKind(soldier, weapon, targetPosOf(target), team) !== 'panic') { clearInfantryAim(soldier); return; }
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
  if (!crewAimed && !infantryAimReady(soldier, weapon, target, team, state.time, rng)) return;
  onFired(state, rng, soldier);
  // the round in the breech decides what the shot does (AP shot does not burst)
  const fired = hasChamberedRound(team, soldier) ? roundWeapon(weapon, chamberedRoundType(team, soldier)) : weapon;
  takeChamberedRound(team, soldier); // already counted out of the ammunition when it was loaded
  fireBurst(state, rng, soldier, fired, target);
  if (!crewAimed) infantryDidFire(soldier, state.time);
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
    if (s.carryingMgMount != null || s.crewTask?.id === 'liftTripod' || s.crewTask?.id === 'placeTripod') continue;
    if (s.smgBurst && state.time < s.smgBurst.until) continue;
    if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'sneaking' || s.activity === 'ambushing') continue;
    if (s.grenades <= 0 || isStunned(s, state.time) || isDazed(s, state.time)) continue;
    const charging = state.teams.get(s.teamId)?.order?.type === 'assault';
    const timer = (track.grenadeTimer.get(s.id) ?? 0) - dt;
    // C4: an assaulting man throws on arrival, not on the cooldown — the whole point of the charge
    if (timer > 0 && !charging) { track.grenadeTimer.set(s.id, timer); continue; }

    const enemy = nearestSpottedEnemy(state, s);
    if (enemy && dist(enemy.pos, s.pos) * TILE_M <= 25 && hasLOS(state.map, s.pos, enemy.pos)) {
      s.grenades--;
      track.grenadeTimer.set(s.id, 1 / 0.1);
      state.events.push({ kind: 'shot', pos: { ...s.pos }, weaponId: 'grenade', side: s.side });
      // ballistic throw (A1/B1): the man winds up (throwAt drives the animation), the grenade
      // flies an arc, and the HE burst fires when it lands — not at throw time
      s.throwAt = state.time;
      const distM = dist(enemy.pos, s.pos) * TILE_M;
      const flightS = 0.8 + Math.min(0.4, distM / 60);
      state.projectiles.push({
        kind: 'grenade', weaponId: grenadeWeapon.id, from: { ...s.pos }, to: { ...enemy.pos },
        t0: state.time, flightS, dirRad: angleTo(s.pos, enemy.pos), arcM: 2 + Math.min(2, distM / 15),
        hitKind: 'impact',
      });
      state.pendingBursts.push({ at: state.time + flightS, pos: { ...enemy.pos }, weaponId: grenadeWeapon.id, side: s.side, shooterId: s.id });
    } else {
      track.grenadeTimer.set(s.id, 1);
    }
  }
}

/** Delayed bursts (A1): grenades, satchels and mortar bombs burst when they land, not when thrown
 * or fired. */
export function stepPendingBursts(state: BattleState, rng: Rng): void {
  if (state.pendingBursts.length === 0) return;
  const due: number[] = [];
  for (let i = 0; i < state.pendingBursts.length; i++) {
    const b = state.pendingBursts[i];
    if (state.time < b.at) continue;
    due.push(i);
    if (b.smoke) {
      addSmoke(state.map, b.pos, 3, 1.0);
      state.explosions.push({ pos: { ...b.pos }, radiusM: 3, t: 0, kind: 'smoke' });
      state.events.push({ kind: 'explosion', pos: { ...b.pos }, side: b.side, weaponId: b.weaponId });
      continue;
    }
    const w = WEAPONS[b.weaponId];
    const shooter = b.shooterId != null ? state.soldiers.get(b.shooterId) : undefined;
    applyHESplash(state, rng, b.pos, w ?? WEAPONS.grenade, b.side, shooter?.pos);
  }
  for (let i = due.length - 1; i >= 0; i--) state.pendingBursts.splice(due[i], 1);
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
  const distM = dist(team.pos, target) * TILE_M;
  const isSmokeOrder = team.order?.type === 'smoke';
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

  // item 020: rocket launchers pace a SALVO — one tube fires every ROCKET_RAIL_S until the racks
  // are empty ("empties in ten seconds"), instead of the mortar's one-round-per-reload cadence
  gunner.fireTimer = weapon.cls === 'rocket' ? ROCKET_RAIL_S : 1 / weapon.rate;
  gunner.ammo--;
  gunner.lastFiredAt = state.time;
  gunner.activity = 'firing';
  state.events.push({ kind: 'shot', pos: { ...gunner.pos }, weaponId: weapon.id, side: gunner.side });

  const isRocket = weapon.cls === 'rocket';
  const tracerKind = isRocket ? 'rocket' : 'mortar';
  const errTiles = sigmaM / TILE_M;
  const impact = { x: target.x + rng.gauss() * errTiles, y: target.y + rng.gauss() * errTiles };
  impact.x = clamp(impact.x, 0.01, state.map.width - 0.01);
  impact.y = clamp(impact.y, 0.01, state.map.height - 0.01);
  // the round is in the air for a few seconds (a rocket faster and flatter): it bursts, or makes
  // its smoke, when it lands
  const flightS = isRocket ? rocketFlightS(distM) : mortarFlightS(dist(gunner.pos, impact) * TILE_M);
  state.projectiles.push({
    kind: 'mortar', weaponId: weapon.id, from: { ...gunner.pos }, to: { ...impact },
    t0: state.time, flightS,
    dirRad: angleTo(gunner.pos, impact), arcM: isRocket ? 22 : 10, hitKind: 'impact', preResolved: false,
  });
  state.pendingBursts.push({ at: state.time + flightS, pos: { ...impact }, weaponId: weapon.id, side: gunner.side, shooterId: gunner.id, smoke: isSmokeOrder || undefined });

  if (isSmokeOrder) {
    const order = team.order!;
    const rec = track.smokeRounds.get(team.id) ?? { count: 0, lastAt: -Infinity };
    state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: tracerKind });
    rec.count++;
    rec.lastAt = state.time;
    track.smokeRounds.set(team.id, rec);
    if (rec.count >= 3) {
      team.order = { type: 'defend', target: order.target, issuedAt: state.time };
    }
    return;
  }

  state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: tracerKind });
  track.mortarRoundsFiredBySide[gunner.side]++;
  addShots(state, gunner.side, 1);
}

/** Seconds a mortar bomb is in the air over `distM` metres (a high lob: 3 s plus 1 s per 60 m). */
export function mortarFlightS(distM: number): number {
  return 3 + distM / 60;
}

/** Seconds a rocket (Nebelwerfer, Katyusha) is in the air over `distM` metres. */
export function rocketFlightS(distM: number): number {
  return 1.2 + distM / 120;
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

function vehicleHitChance(weapon: WeaponDef, distM: number, cover: number, stance: Soldier['stance'], moving: boolean, speedMs = 0): number {
  if (distM > weapon.rangeM) return 0;
  const rf = distM <= 100 ? 1 : Math.pow(100 / distM, 0.8);
  const st = stance === 'standing' ? 1 : stance === 'crouching' ? 0.7 : 0.45;
  // Lead: penalty scales with the target's actual speed (1/(1+v/14)): ~0.56 at an 11 m/s
  // road march, ~0.86 at a slow 2 m/s crawl. The legacy boolean path keeps 0.6 for foot targets.
  const lead = speedMs > 0 ? 1 / (1 + speedMs / 14) : moving ? 0.6 : 1;
  const p = weapon.accuracy * rf * (1 - cover * 0.8) * st * lead;
  return clamp(p, 0.02, 0.95);
}
// ------------------------------------------------------- main gun vs infantry (item 018)
/** Main-gun HE is for real infantry targets, not for one man: a tank's machine guns (coax, bow)
 * engage infantry first; the main gun joins only for (a) a GROUP — several spotted men of the
 * same team clustered within GROUP_RADIUS_TILES of one another — (b) both MGs out of usable
 * ammo, or (c) an MG engagement that has failed to pin the team after MG_ESCALATE_S. Men in
 * strong cover (trench, stone building, bunker interior: omni cover >= STRONG_COVER) are never
 * worth main-gun HE unless (b)/(c) — the MG keeps them suppressed there while an assault or an
 * AT gun does the work. AP is never chosen against infantry (aimPoint.ts already routes soft
 * targets to HE; the gates here keep a lone rifleman from even being laid on). */
export const MG_GROUP_MIN = 3;
export const MG_GROUP_RADIUS_TILES = 6;
/** Trench/bunker/stone-building strength: at or above this omni cover, main-gun HE is wasted. */
export const MG_STRONG_COVER = 0.8;
/** An MG engagement unresolved (the team not pinned) for this long unlocks the main gun. */
export const MG_ESCALATE_S = 20;
/** Pinned: suppression at or above this stops the escalation clock (the MGs did their job). */
export const MG_SUPPRESS_LEVEL = 60;

/** Why the main gun may (or may not) fire at an infantryman. */
export function mainGunAtInfantry(state: BattleState, vehicle: Vehicle, s: Soldier): 'group' | 'mgOut' | 'escalated' | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  // MGs "unusable" covers damage, not just ammo: a destroyed coax mount or a destroyed bow mount
  // both leave the vehicle MG-less (vehicleDamage.ts systemState)
  const mgOut = (!def?.coaxWeaponId || vehicle.coaxAmmo <= 0 || !coaxUsable(vehicle))
    && (!def?.bowWeaponId || (vehicle.bowAmmo ?? BOW_MG_AMMO) <= 0 || !bowMgUsable(vehicle));
  if (mgOut) return 'mgOut';
  // Strong cover for the doctrine: omni cover (trench, bunker interior, stone-building floor) OR
  // the tile is a stone building (the 0.85 value is directional/linear cover only, omniCoverAt
  // sees 0.5) OR the man stands behind an AT gun's shield plate (a casemate crewman).
  const strongCover = omniCoverAt(state.map, s.pos) >= MG_STRONG_COVER
    || tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y)) === 'buildingStone'
    || behindGunShield(state, s, vehicle.pos);
  if (strongCover) return null;
  // group: several spotted living men of this team within GROUP_RADIUS_TILES of the target man
  const team = state.teams.get(s.teamId);
  if (team) {
    let clustered = 0;
    for (const id of team.soldierIds) {
      const m = state.soldiers.get(id);
      if (!m || m.health === 'dead' || m.health === 'incapacitated' || m.activity === 'surrendered') continue;
      if (!state.spotted[vehicle.side].has(id)) continue;
      if (dist(m.pos, s.pos) <= MG_GROUP_RADIUS_TILES) clustered++;
    }
    if (clustered >= MG_GROUP_MIN) return 'group';
  }
  // escalation: the machine guns have worked this team for MG_ESCALATE_S and it is still not pinned
  if (vehicle.mgTargetKey === `t${s.teamId}` && vehicle.mgSince != null
    && state.time - vehicle.mgSince >= MG_ESCALATE_S) {
    let bestSupp = 0;
    if (team) {
      for (const id of team.soldierIds) {
        const m = state.soldiers.get(id);
        if (!m || m.health === 'dead' || m.health === 'incapacitated' || m.activity === 'surrendered') continue;
        if (!state.spotted[vehicle.side].has(id)) continue;
        bestSupp = Math.max(bestSupp, m.suppression);
      }
    }
    if (bestSupp < MG_SUPPRESS_LEVEL) return 'escalated';
  }
  return null;
}

/** Track the vehicle's MG engagement for the escalation clock: call after every MG burst. */
export function noteMgBurst(state: BattleState, vehicle: Vehicle, soldier: Soldier): void {
  const key = `t${soldier.teamId}`;
  if (vehicle.mgTargetKey !== key) {
    vehicle.mgTargetKey = key;
    vehicle.mgSince = state.time;
  }
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
      // item 038: the target may have ducked behind a bank or driven out of sight since the order
      // was issued; the gun keeps pointing at the ordered (last-known) point instead of going
      // silent — when it re-spots, the vehicle branch takes over again.
      if (v && v.state !== 'knockedOut' && state.spottedVehicles[vehicle.side].has(v.id) && dist(vehicle.pos, v.pos) * TILE_M <= rangeM) return { kind: 'vehicle', vehicle: v };
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
        if (d > rangeM || d >= bestD || !inCoaxMgArc(vehicle, e.pos) || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
        bestD = d; best = e;
      }
      if (best) return best;
    }
  }
  // the free fallback only picks within the coax's field of fire — an MG cannot fire sideways
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[vehicle.side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered' || s.vehicleId != null) continue;
    const d = dist(vehicle.pos, s.pos) * TILE_M;
    if (d > rangeM || d >= bestD || !inCoaxMgArc(vehicle, s.pos) || !hasLOS(state.map, vehicle.pos, s.pos)) continue;
    bestD = d; best = s;
  }
  return best;
}

function pickVisibleVehicleTarget(state: BattleState, vehicle: Vehicle): Target | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId != null) {
    const picked = pickVehicleAttackTarget(state, vehicle, weapon, order);
    if (picked !== 'free') return picked;
  }
  if (weapon && weapon.penetrationMm > 0) {
    // An infantry team clearly firing at us right now (a man seen shooting within the last 3 s)
    // is engaged first: the answer is HE at the men, even with a tank standing nearby. A target
    // the PLAYER ordered (attack-unit fire) is handled above; a tank in defend/ambush facing
    // enemy armour still goes for the tank (threat ranking below chooses the vehicle target and
    // the loader then picks AP for it). Otherwise: threat ranking by time to first shot.
    let firingTeamId: number | null = null;
    let firingScore = Infinity;
    for (const id of state.spotted[vehicle.side]) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      const d = dist(vehicle.pos, s.pos) * TILE_M;
      if (d > weapon.rangeM) continue;
      if (state.time - s.lastFiredAt < 3) {
        const score = d / 100 + (vehicle.gunLay?.key === `t${s.teamId}` ? -4 : 0);
        if (score < firingScore) { firingScore = score; firingTeamId = s.teamId; }
      }
    }
    if (firingTeamId != null) {
      const hisTeam = state.teams.get(firingTeamId);
      if (hisTeam && !hisTeam.outOfAction) {
        let bestMan: Soldier | null = null;
        let bestD = Infinity;
        for (const mid of hisTeam.soldierIds) {
          const m = state.soldiers.get(mid);
          if (!m || m.health === 'dead' || m.health === 'incapacitated') continue;
          if (!state.spotted[vehicle.side].has(mid)) continue;
          const d = dist(vehicle.pos, m.pos) * TILE_M;
          if (d > weapon.rangeM || d >= bestD) continue;
          bestD = d; bestMan = m;
        }
        // item 018: a lone firing rifleman is an MG target, not a main-gun HE target — only a
        // group (or MGs out / escalation) earns the gun. Otherwise fall through to the vehicle
        // threat ranking (the men are left to the machine guns).
        if (bestMan && mainGunAtInfantry(state, vehicle, bestMan)) return { kind: 'soldier', soldier: bestMan };
      }
    }
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
  if (team?.order?.type === 'fire' && team.order.target && attackPhase(state, team.order) !== 'hold') {
    return { kind: 'point', pos: team.order.target };
  }

  // item 018: the nearest infantryman is not automatically a main-gun target — machine guns
  // first; the gun only fires at him under the doctrine (group / MG out / escalation).
  const inf = pickNearestInfantry(state, vehicle, 300);
  if (inf && mainGunAtInfantry(state, vehicle, inf)) return { kind: 'soldier', soldier: inf };
  // without a main-gun target, hand the men to the machine guns: the coax engages within its
  // field of fire regardless (the coax fire site picks independently); keep the gun silent.
  return null;
}
/** Vehicle area fire draws on an explicit order or the commander's recent knowledge only. */
export function vehicleAreaTarget(state: BattleState, vehicle: Vehicle, rangeM: number, accepts: (p: Vec2) => boolean = () => true): Target | null {
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'ambush' || order?.type === 'smoke') return null;
  if (order?.type === 'fire' && !(order.targetTeamId != null && attackPhase(state, order) === 'hold')) {
    if (dist(vehicle.pos, order.target) * TILE_M > rangeM || !accepts(order.target)) return null;
    return areaPoint(state, vehicle.pos, order.target, true, { eyeM: EYE_VEHICLE_M });
  }
  const commander = vehicleCommander(state, vehicle);
  // item 038: a belief whose line of fire is blocked (hull-down behind a crest) is still a target
  // the commander engages: the tank creeps forward until the gun clears, then fires. Prefer beliefs
  // with a clear gun line when several qualify.
  const belief = commander?.mind.beliefs
    .filter((b) => b.confidence > 0.6 && state.time - b.time <= 30 && dist(vehicle.pos, b.pos) * TILE_M <= rangeM && accepts(b.pos))
    .sort((a, b) => {
      const fa = hasLineOfFire(state.map, vehicle.pos, a.pos, { eyeM: EYE_VEHICLE_M }) ? 1 : 0;
      const fb = hasLineOfFire(state.map, vehicle.pos, b.pos, { eyeM: EYE_VEHICLE_M }) ? 1 : 0;
      return fb - fa || b.confidence - a.confidence || dist(vehicle.pos, a.pos) - dist(vehicle.pos, b.pos);
    })[0];
  return belief ? { kind: 'point', pos: belief.pos, guesstimate: true } : null;
}

export function pickVehicleTarget(state: BattleState, vehicle: Vehicle): Target | null {
  const def = VEHICLE_DEFS[vehicle.defId], weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  const order = state.teams.get(vehicle.teamId)?.order;
  // A deliberate area order takes precedence over opportunistic spotted targets.
  if (order?.type === 'fire' && order.targetTeamId == null) return vehicleAreaTarget(state, vehicle, weapon?.rangeM ?? 400);
  const target = pickVisibleVehicleTarget(state, vehicle);
  if (target) {
    const pos = targetPosOf(target);
    if (dist(vehicle.pos, pos) * TILE_M <= (weapon?.rangeM ?? 400)) {
      if (hasLOS(state.map, vehicle.pos, pos, { eyeM: EYE_VEHICLE_M })) return target;
      if (order?.type !== 'ambush') return areaPoint(state, vehicle.pos, pos, true, { eyeM: EYE_VEHICLE_M });
    }
  }
  return vehicleAreaTarget(state, vehicle, weapon?.rangeM ?? 400);
}

/** A new aim point further than this from the lay point is a new target (a whole new lay). */
export const GUN_LAY_NEW_AIM_M = 15;
/** The target jumped this far between two looks: the lay needs a correction. */
export const GUN_LAY_RELAY_M = 10;
/** A lay on a vehicle target the commander still believes is at its last-known spot is kept this
 * long after the target itself is lost from sight (item 038): the gun stays trained, and a re-spot
 * resumes the old lay as a follow-up correction instead of starting from scratch. */
export const GUN_LAY_BELIEF_KEEP_S = 30;
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
  const clear = hasLOS(state.map, vehicle.pos, tPos, { eyeM: EYE_VEHICLE_M });
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

// ------------------------------------------------- vehicle-mounted rocket artillery (item 020)
/** Seconds between two rail launches in one salvo: a BM-13 empties its eight rails in about 4 s. */
export const ROCKET_RAIL_S = 0.5;
/** Minimum pause before the out-of-arc warning is said again (seconds). */
const ROCKET_ARC_WARN_S = 12;

/** Where a vehicle-mounted rocket launcher should strike now: the ordered fire point, else the
 * densest spotted enemy cluster (indirect fire needs no LOS, but it needs something to shoot at). */
function vehicleRocketAim(state: BattleState, vehicle: Vehicle): Vec2 | null {
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'ambush') return null; // hold fire on mere suspicion
  if (order?.type === 'fire' && order.target && attackPhase(state, order) !== 'hold') return order.target;
  const cluster = findEnemyCluster(state, vehicle.side);
  return cluster ? cluster.pos : null;
}

/** One step of a vehicle-mounted rocket launcher (BM-13, SdKfz 251/1 Wurfrahmen). The rails slew
 * within their mount arc only — the whole vehicle is aimed by driving, so a launcher parked facing
 * away from its target cannot engage and the crew says so. A salvo walks one rail every
 * ROCKET_RAIL_S, then reloadS passes before the next salvo; rounds are area HE with mortar-style
 * observation-tier dispersion (no LOS is needed, the splash lands where the map is not in the way). */
function stepVehicleRockets(state: BattleState, rng: Rng, dt: number, vehicle: Vehicle, def: VehicleDef, weapon: WeaponDef, crew: CrewEffects, track: CombatTrack): void {
  const aim = vehicleRocketAim(state, vehicle);
  if (!aim) {
    vehicle.gunState = vehicle.mainAmmo > 0 ? 'ready' : undefined;
    return;
  }
  const distM = dist(vehicle.pos, aim) * TILE_M;
  if (distM < (weapon.minRangeM ?? 0) || distM > weapon.rangeM) {
    vehicle.gunState = vehicle.mainAmmo > 0 ? 'ready' : undefined;
    return;
  }
  const desired = angleTo(vehicle.pos, aim);
  if (Math.abs(wrapAngle(desired - vehicle.hullFacing)) > gunArcRad(def)) {
    if (state.time - (vehicle.rocketArcWarnAt ?? -Infinity) > ROCKET_ARC_WARN_S) {
      vehicle.rocketArcWarnAt = state.time;
      const team = state.teams.get(vehicle.teamId);
      if (team?.side === state.config.playerSide) {
        addMessage(state, `${def.name}\nLaunch rails cannot reach that bearing.`, 'warn');
      }
    }
    vehicle.gunState = 'laying';
    return;
  }
  // the rack traverses within its arc at the mount's real rate
  const arc = gunArcRad(def);
  const rate = turretTraverseRad(def, vehicle, crew.gunner?.experience ?? 0);
  vehicle.turretFacing = wrapAngle(vehicle.hullFacing + clamp(wrapAngle(vehicle.turretFacing - vehicle.hullFacing), -arc, arc));
  const err = wrapAngle(desired - vehicle.turretFacing);
  vehicle.turretFacing = wrapAngle(vehicle.turretFacing + clamp(err, -rate * dt, rate * dt));
  const aimed = Math.abs(wrapAngle(desired - vehicle.turretFacing)) <= LAY_TOLERANCE_RAD;
  const moving = Math.abs(vehicle.speed) > 0.1;
  vehicle.gunState = vehicle.mainFireTimer > 0 ? 'loading' : aimed ? (moving ? 'laying' : 'ready') : 'laying';
  if (!aimed || vehicle.mainFireTimer > 0 || moving) return;

  if ((vehicle.rocketSalvoLeft ?? 0) <= 0) {
    const salvo = Math.min(weapon.burst ?? 1, vehicle.mainAmmo);
    if (salvo <= 0) return;
    vehicle.rocketSalvoLeft = salvo;
    vehicle.rocketSalvoTimer = 0;
  }
  vehicle.rocketSalvoTimer = (vehicle.rocketSalvoTimer ?? 0) - dt;
  if (vehicle.rocketSalvoTimer > 0) return;
  vehicle.rocketSalvoTimer = ROCKET_RAIL_S;
  vehicle.rocketSalvoLeft = (vehicle.rocketSalvoLeft ?? 1) - 1;
  vehicle.mainAmmo--;
  vehicle.lastMainShotAt = state.time;
  state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: weapon.id, side: vehicle.side });
  state.flashes.push({ pos: { ...vehicle.pos }, facing: vehicle.turretFacing, t: 0, kind: 'shell' });
  addShots(state, vehicle.side, 1);

  const team = state.teams.get(vehicle.teamId);
  const obs = team ? mortarObservation(state, team, aim) : { obs: 'spotted' as const, mul: 1, own: true };
  const walkKey: object = team ?? weapon;
  let walk = tierWalk.get(walkKey);
  if (!walk || walk.tier !== obs.obs) { walk = { tier: obs.obs, rounds: 0 }; tierWalk.set(walkKey, walk); }
  const sigmaM = mortarDispersionM(distM, obs.obs, walk.rounds, obs.mul);
  walk.rounds++;
  const errTiles = sigmaM / TILE_M;
  const impact = {
    x: clamp(aim.x + rng.gauss() * errTiles, 0.01, state.map.width - 0.01),
    y: clamp(aim.y + rng.gauss() * errTiles, 0.01, state.map.height - 0.01),
  };
  state.tracers.push({ from: { ...vehicle.pos }, to: impact, t: 0, hit: true, kind: 'rocket' });
  state.projectiles.push({
    kind: 'mortar', weaponId: weapon.id, from: { ...vehicle.pos }, to: { ...impact },
    t0: state.time, flightS: 1.2 + distM / 120, dirRad: angleTo(vehicle.pos, impact), arcM: 22,
    hitKind: 'impact', preResolved: false,
  });
  track.mortarRoundsFiredBySide[vehicle.side]++;
  // the round flies on its own; the HE burst lands when it lands (the grenade pattern)
  state.pendingBursts.push({
    at: state.time + 1.2 + distM / 120, pos: { ...impact }, weaponId: weapon.id, side: vehicle.side,
  });
  if ((vehicle.rocketSalvoLeft ?? 0) <= 0) {
    vehicle.rocketSalvoLeft = undefined;
    vehicle.rocketSalvoTimer = undefined;
    vehicle.mainFireTimer = weapon.reloadS;
    vehicle.loadTotalS = weapon.reloadS;
    vehicle.loadProgress = 0;
  }
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
  if (vehicle.bowFireTimer != null && vehicle.bowFireTimer > 0) vehicle.bowFireTimer -= dt;

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

  const target = mainWeapon?.indirect ? null : pickVehicleTarget(state, vehicle);

  if (mainWeapon?.indirect && gunWorks) {
    // item 020: rocket launchers never fire direct main-gun shots — indirect salvos only
    stepVehicleRockets(state, rng, dt, vehicle, def, mainWeapon, crew, track);
  } else if (target && mainWeapon && gunWorks && (vehicle.mainAmmo > 0 || vehicle.loadedRound)) {
    const weapon = mainWeapon;
    const gunner = crew.gunner!;
    const tPos = targetPosOf(target);
    const desired = angleTo(vehicle.pos, tPos);
    const distM = dist(vehicle.pos, tPos) * TILE_M;
    const estimated = target.kind === 'point' && target.guesstimate;
    // item 038: the commander's eye (2.2 m) and the main gun's muzzle (1.5 m) sit at different
    // heights, so a tank in defilade behind a crest can SEE a target it cannot shoot from. The
    // eye's line gates the lay/designate; the muzzle's gates the fire and the hull-down creep.
    const los = estimated ? hasLineOfFire(state.map, vehicle.pos, tPos, { eyeM: EYE_VEHICLE_M }) : gunLos(state, vehicle, tPos);
    const gunLine = hasLineOfFire(state.map, vehicle.pos, tPos, { eyeM: VEHICLE_GUN_M });
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

    // item 038: hull-down creep — the gun sits below the crest (the gun line is blocked) while
    // the commander's eye still sees the target. The tank creeps forward until the gun clears.
    if (!gunLine && (target.kind === 'vehicle' || target.kind === 'point') && !ownMoving && !reversing
      && mainGunUsable(vehicle) && los) {
      vehicle.creepForGun = true;
      vehicle.creepAim = { ...tPos };
      vehicle.creepUntil = state.time + 10;
    }
    const loaded = !!vehicle.loadedRound && vehicle.mainFireTimer <= 0;
    // (a turret comes round while the vehicle drives; a casemate or a jammed turret needs the halt to turn the hull)
    const gunComesRound = def.hasTurret && !turretFrozen(vehicle);
    if (vehicle.path.length > 0 && !reversing && los && gunLine && designated && (facingDiff <= COARSE_LAY_RAD * 2 || !gunComesRound)
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

    if (loaded && laid && designated && !hold && sightMul > 0 && facingDiff <= LAY_TOLERANCE_RAD && los && gunLine && (!ownMoving || fireOnMove)) {
      const round = vehicle.loadedRound!;
      const fired = roundWeapon(weapon, round);
      const moveMul = ownMoving ? FIRE_ON_MOVE_MUL : 1;
      vehicle.loadedRound = undefined;
      vehicle.lastMainShotAt = state.time;
      addShots(state, vehicle.side, 1);
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: weapon.id, side: vehicle.side });
      state.flashes.push({ pos: { ...vehicle.pos }, facing: facingRef, t: 0, kind: 'shell' });

      if (target.kind === 'vehicle') {
        const speedMs = Math.abs(target.vehicle.speed);
        const p = Math.min(0.97, vehicleHitChance(weapon, distM, 0, 'standing', speedMs > 0.1, speedMs) * crew.gunnerMul * sightMul * bracketMul(lay.misses) * layMul * moveMul);
        const hit = fireAtVehicle(state, rng, weapon, vehicle.pos, vehicle.side, target.vehicle, p, true, { round, aimPoint: aim, skill, shooterTeamId: vehicle.teamId });
        // bracketing: the fall of a missed round is observed and corrected for
        if (!hit) { lay.misses = Math.min(2, (lay.misses ?? 0) + 1); lay.bracketFrom ??= { ...vehicle.pos }; lay.bracketAt ??= { ...tPos }; }
      } else {
        // a round fired on the move lands wide of a point target
        const at = estimated ? estimateAim(state, rng, vehicle.pos, tPos) : { ...tPos };
        if (ownMoving) { const r = (4 + rng.next() * 10) / TILE_M, a = rng.next() * Math.PI * 2; at.x += Math.sin(a) * r; at.y -= Math.cos(a) * r; }
        const shot = traceRound(state, rng, vehicle.pos, at, fired, { eyeM: VEHICLE_GUN_M, targetM: estimated ? 0.5 : 1.7 });
        traceTracers(state, shot, tracerKindFor(fired), !shot.blocked && !shot.deflected);
        areaImpact(state, rng, vehicle.pos, vehicle.side, fired, shot.impact, gunner);
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
    // nothing to shoot at: the lay is kept a few seconds (a target lost from sight for a moment).
    // item 038: when the commander still believes the target is where the gun last pointed (a
    // fresh sighting, within the 30 s belief horizon) the lay is kept so a re-spot resumes the
    // old lay (a cheap follow-up correction) instead of throwing the aim away.
    const lay = vehicle.gunLay;
    if (lay) {
      lay.lostAt ??= state.time;
      let keepS = GUN_LAY_KEEP_S;
      if (lay.key.startsWith('v')) {
        const cmd = vehicleCommander(state, vehicle);
        if (cmd?.mind.beliefs.some((b) => dist(b.pos, lay.aim) <= 6 && state.time - b.time <= 30)) keepS = GUN_LAY_BELIEF_KEEP_S;
      }
      if (state.time - lay.lostAt > keepS || !gunWorks) { vehicle.gunLay = undefined; vehicle.layProgress = undefined; }
    }
    vehicle.gunState = mainWeapon && gunWorks ? (vehicle.loadedRound && vehicle.mainFireTimer > 0 ? 'loading' : 'ready') : undefined;
    vehicle.fireHaltSince = undefined;
  }

  if (def.coaxWeaponId && vehicle.coaxAmmo > 0 && coaxUsable(vehicle) && (crew.gunner || crew.commanderUp)) {
    const coax = WEAPONS[def.coaxWeaponId];
    const mgTarget = pickVehicleMgTarget(state, vehicle, 400, pickCoaxTarget(state, vehicle, 400));
    const infTarget = mgTarget?.kind === 'soldier' ? mgTarget.soldier : null;
    const mgBearing = mgTarget ? angleTo(vehicle.pos, targetPosOf(mgTarget)) : vehicle.turretFacing;
    // The coax shares the gun mounting. With no usable main-gun mission, the MG gunner still
    // traverses it at the vehicle's real rate; an active main-gun lay retains priority.
    if (mgTarget && (!target || !mainWeapon || !gunWorks || (vehicle.mainAmmo <= 0 && !vehicle.loadedRound)) && !turretFrozen(vehicle)) {
      const goal = def.hasTurret ? mgBearing : vehicle.hullFacing + clamp(wrapAngle(mgBearing - vehicle.hullFacing), -gunArcRad(def), gunArcRad(def));
      vehicle.turretFacing = turnTowards(vehicle.turretFacing, goal, turretTraverseRad(def, vehicle, crew.gunner?.experience ?? 50) * dt);
    }
    if (mgTarget && vehicle.coaxFireTimer <= 0 && Math.abs(wrapAngle(mgBearing - vehicle.turretFacing)) <= COARSE_LAY_RAD) {
      vehicle.coaxFireTimer = 1 / coax.rate;
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: coax.id, side: vehicle.side });
      let coaxRounds = 0;
      for (let i = 0; i < coax.burst && vehicle.coaxAmmo > 0; i++) {
        vehicle.coaxAmmo--;
        coaxRounds++;
        // gun shield (user rule): small arms never penetrate an AT gun's plate — the shielded
        // crewman is not hittable; the burst sparks off the angled plate instead
        if (infTarget && behindGunShield(state, infTarget, vehicle.pos)) {
          state.tracers.push({ from: { ...vehicle.pos }, to: { ...infTarget.pos }, t: 0, hit: false, kind: 'bullet' });
          const team = state.teams.get(infTarget.teamId);
          const cw = team?.crewWeapon;
          if (cw) {
            const impact = weaponFramePoint(cw.pos, cw.facing, { x: rng.chance(0.5) ? 0.5 : -0.5, y: -0.4 });
            state.sparks.push({ pos: impact, t: 0, kind: 'armor' });
            state.events.push({ kind: 'shieldRicochet', pos: impact, side: vehicle.side });
          }
        } else {
          fireVehicleMgRound(state, rng, vehicle, crew.gunner ?? vehicleCommander(state, vehicle), vehicle.pos, coax, mgTarget);
        }
      }
      addShots(state, vehicle.side, coaxRounds);
      // escalation clock (item 018): each burst keeps the engagement on the current team
      if (infTarget) noteMgBurst(state, vehicle, infTarget);
    }
  }

  stepBowMg(state, rng, vehicle, def);
}

// ------------------------------------------------------------------- bow MG
function pickVehicleMgTarget(state: BattleState, vehicle: Vehicle, rangeM: number, visible: Soldier | null, accepts: (p: Vec2) => boolean = () => true): Target | null {
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId == null) return vehicleAreaTarget(state, vehicle, rangeM, accepts);
  if (visible) {
    if (hasLOS(state.map, vehicle.pos, visible.pos, { eyeM: EYE_VEHICLE_M })) return { kind: 'soldier', soldier: visible };
    if (order?.type !== 'ambush') return areaPoint(state, vehicle.pos, visible.pos, true, { eyeM: EYE_VEHICLE_M });
  }
  // An MG cannot damage the closed tank an attack-unit order is tracking.
  if (order?.targetTeamId != null && state.teams.get(order.targetTeamId)?.vehicleId != null) return null;
  return vehicleAreaTarget(state, vehicle, rangeM, accepts);
}

function fireVehicleMgRound(
  state: BattleState, rng: Rng, vehicle: Vehicle, gunner: Soldier | null | undefined,
  muzzle: Vec2, weapon: WeaponDef, target: Target, skillMul = 1, tracerKind: 'mg' | 'bullet' = 'mg',
): void {
  const victim = target.kind === 'soldier' ? target.soldier : null;
  const aim = target.kind === 'point' && target.guesstimate ? estimateAim(state, rng, muzzle, target.pos) : targetPosOf(target);
  const hit = victim ? rng.chance(vehicleHitChance(weapon, dist(muzzle, aim) * TILE_M, coverAt(state.map, aim), victim.stance,
    victim.activity === 'moving' || victim.activity === 'movingFast') * skillMul) : false;
  const shot = traceRound(state, rng, muzzle, aim, weapon, { eyeM: EYE_VEHICLE_M, targetM: victim ? eyeHeightM(victim.stance) : 0.5 });
  const landed = hit && !shot.blocked && !shot.deflected;
  traceTracers(state, shot, tracerKind, landed);
  if (landed && victim) applyHit(state, victim, weapon, rng, vehicle.side);
  else areaImpact(state, rng, muzzle, vehicle.side, weapon, shot.impact, gunner ?? undefined, target.kind === 'point' && !!target.guesstimate);
}

/** Half-width of the bow MG's field of fire either side of the HULL facing. */
export const BOW_MG_HALF_ARC_RAD = (15 * Math.PI) / 180;
/** Like the coax it engages out to here. */
export const BOW_MG_RANGE_M = 400;
export const BOW_MG_AMMO = 250;
/** A damaged ball mount jams and binds. */
export const BOW_MG_DAMAGED_MUL = 0.6;
/** Fired on the move it is for keeping heads down: half as likely to hit (misses still suppress). */
export const BOW_MG_MOVING_MUL = 0.5;

/** Is `p` inside the bow MG's arc and range? */
export function inBowMgArc(vehicle: Vehicle, p: Vec2): boolean {
  if (dist(vehicle.pos, p) * TILE_M > BOW_MG_RANGE_M) return false;
  return Math.abs(wrapAngle(angleTo(vehicle.pos, p) - vehicle.hullFacing)) <= BOW_MG_HALF_ARC_RAD;
}

/** Half-width of the coax MG's field of fire either side of the TURRET facing (turreted vehicles:
 * the coax fires where the gun points; casemates: along the hull axis within the gun's arc). */
export const COAX_MG_HALF_ARC_RAD = (30 * Math.PI) / 180;

/** Is `p` inside the coax MG's field of fire? */
export function inCoaxMgArc(vehicle: Vehicle, p: Vec2): boolean {
  const def = VEHICLE_DEFS[vehicle.defId];
  if (!def) return false;
  const bearing = def.hasTurret ? vehicle.turretFacing : vehicle.hullFacing;
  const half = def.hasTurret ? COAX_MG_HALF_ARC_RAD : gunArcRad(def) * 0.9;
  return Math.abs(wrapAngle(angleTo(vehicle.pos, p) - bearing)) <= half;
}

/** Nearest spotted enemy on foot ahead of the hull with a line of fire (infantry only). */
function pickBowMgTarget(state: BattleState, vehicle: Vehicle): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[vehicle.side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered' || s.vehicleId != null) continue;
    const d = dist(vehicle.pos, s.pos);
    if (d >= bestD || !inBowMgArc(vehicle, s.pos) || !hasLOS(state.map, vehicle.pos, s.pos)) continue;
    bestD = d; best = s;
  }
  return best;
}

/** The hull MG (`VehicleDef.bowWeaponId`): worked by the radio operator / bow gunner at his seat,
 * at infantry only, through a narrow arc along the hull — it bears where the HULL points, whatever
 * the turret is doing. Silent when he is dead or has taken another seat, or the mount is destroyed.
 * Mirrors the coax: bursts on its own timer, misses suppress. */
/** Test hook: the bow-MG step is private to stepVehicleCombat. */
export const stepBowMgForTest = stepBowMg;
function stepBowMg(state: BattleState, rng: Rng, vehicle: Vehicle, def: VehicleDef): void {
  if (!def.bowWeaponId || (vehicle.bowFireTimer ?? 0) > 0) return;
  const mg = WEAPONS[def.bowWeaponId];
  if (!mg || !bowMgUsable(vehicle)) return;
  vehicle.bowAmmo ??= BOW_MG_AMMO;
  if (vehicle.bowAmmo <= 0) return;
  const gunner = bowGunner(state, vehicle);
  if (!gunner) return;
  const target = pickVehicleMgTarget(state, vehicle, BOW_MG_RANGE_M, pickBowMgTarget(state, vehicle), (p) => inBowMgArc(vehicle, p));
  if (!target || !inBowMgArc(vehicle, targetPosOf(target))) return;
  const shieldVictim = target.kind === 'soldier' ? target.soldier : null;
  vehicle.bowFireTimer = 1 / mg.rate;
  // the muzzle is in the bow plate
  const fx = Math.sin(vehicle.hullFacing), fy = -Math.cos(vehicle.hullFacing);
  const muzzle = { x: vehicle.pos.x + (fx * def.lengthM * 0.4) / TILE_M, y: vehicle.pos.y + (fy * def.lengthM * 0.4) / TILE_M };
  state.events.push({ kind: 'shot', pos: { ...muzzle }, weaponId: mg.id, side: vehicle.side });
  const skillMul = clamp(0.7 + gunner.experience / 200, 0.7, 1.2) * (systemState(vehicle, 'bowMg') === 'damaged' ? BOW_MG_DAMAGED_MUL : 1);
  let rounds = 0;
  for (let i = 0; i < mg.burst && vehicle.bowAmmo > 0; i++) {
    vehicle.bowAmmo--;
    rounds++;
    // gun shield (user rule): small arms never penetrate an AT gun's plate
    if (shieldVictim && behindGunShield(state, shieldVictim, vehicle.pos)) {
      state.tracers.push({ from: { ...muzzle }, to: { ...shieldVictim.pos }, t: 0, hit: false, kind: 'bullet' });
      const team = state.teams.get(shieldVictim.teamId);
      const cw = team?.crewWeapon;
      if (cw) {
        const impact = weaponFramePoint(cw.pos, cw.facing, { x: rng.chance(0.5) ? 0.5 : -0.5, y: -0.4 });
        state.sparks.push({ pos: impact, t: 0, kind: 'armor' });
        state.events.push({ kind: 'shieldRicochet', pos: impact, side: vehicle.side });
      }
      continue;
    }
    fireVehicleMgRound(state, rng, vehicle, gunner, muzzle, mg, target,
      skillMul * (Math.abs(vehicle.speed) > 0.5 ? BOW_MG_MOVING_MUL : 1), 'bullet');
  }
  addShots(state, vehicle.side, rounds);
  // escalation clock (item 018): the bow MG counts as the same engagement
  if (shieldVictim) noteMgBurst(state, vehicle, shieldVictim);
}

// ------------------------------------------------------------------- main
export function stepCombat(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  for (const soldier of state.soldiers.values()) {
    stepSoldierCombat(state, rng, dt, soldier, track);
  }

  stepGrenades(state, rng, dt, track);

  stepMelee(state, rng, dt, track);
  for (const team of state.teams.values()) {
    if (team.vehicleId == null) stepMortarTeam(state, rng, dt, team, track);
  }

  stepSmokeOrders(state);

  for (const vehicle of state.vehicles.values()) {
    stepVehicleCombat(state, rng, dt, vehicle, track);
  }
}
