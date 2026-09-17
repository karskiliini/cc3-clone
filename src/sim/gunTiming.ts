// Loading and laying times of guns, and the real turn rates of turrets and hulls.
//
// A gun fires when TWO separate jobs are done: the loader's (LOADING, starts after the shot or a
// change of round type) and the gunner's (LAYING: the commander designates a new target, the turret
// traverses at the vehicle's historical rate, then the fine lay; a follow-up shot on the same
// stationary target needs only a short correction). Both run side by side. Pure functions and
// tables only: sim/combat.ts (vehicles) and sim/crewWeapon.ts (AT guns) hold the state.
// Deterministic: no randomness in here.
import type { BattleState, Soldier, Vec2, Vehicle, VehicleDef, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, wrapAngle } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { crewEffects, isImmobile, seatOccupant, systemState, traverseMul, turretFrozen, vehicleLayout } from './vehicleDamage';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ crew quality
/** Experience anchors of the quality words used by the tables below. */
export const EXP_RECRUIT = 25;
export const EXP_REGULAR = 50;
export const EXP_VETERAN = 75;
export const EXP_HERO = 95;

/** Piecewise-linear multiplier through recruit / regular (1) / veteran / hero. */
function qualityCurve(experience: number, recruit: number, veteran: number, hero: number): number {
  const e = clamp(experience, EXP_RECRUIT, EXP_HERO);
  if (e <= EXP_REGULAR) return recruit + (1 - recruit) * ((e - EXP_RECRUIT) / (EXP_REGULAR - EXP_RECRUIT));
  if (e <= EXP_VETERAN) return 1 + (veteran - 1) * ((e - EXP_REGULAR) / (EXP_VETERAN - EXP_REGULAR));
  return veteran + (hero - veteran) * ((e - EXP_VETERAN) / (EXP_HERO - EXP_VETERAN));
}
/** Loading: recruit x1.35, veteran x0.85, hero x0.75. */
export function loadSkillMul(experience: number): number { return qualityCurve(experience, 1.35, 0.85, 0.75); }
/** Fine lay: recruit x1.5 ... hero x0.75. */
export function laySkillMul(experience: number): number { return qualityCurve(experience, 1.5, 0.85, 0.75); }
/** Traverse: recruit x0.85, veteran x1.1 (they anticipate and start on the commander's call). */
export function traverseSkillMul(experience: number): number { return qualityCurve(experience, 0.85, 1.1, 1.1); }

// ------------------------------------------------------------------ loading
export const LOAD_MOVING_MUL = 1.5;
export const LOAD_CROSS_COUNTRY_MUL = 2;
export const LOAD_LOADER_WOUNDED_MUL = 1.5;
export const LOAD_CRAMPED_TURRET_MUL = 1.25;
export const LOAD_SHAKEN_MUL = 1.3;
export const LOAD_HULL_RACK_MUL = 1.25;
/** An open gun on its wheels: no turret in the way. */
export const LOAD_ATGUN_MUL = 0.9;
/** The ready rack is restocked from the hull racks when the gun has been silent this long. */
export const READY_RACK_RESTOCK_S = 60;

/** Seconds a regular, stationary crew needs to load one round of this gun (`loadS`, by calibre).
 * Weapons without it (test literals, automatic weapons) fall back to their old cycle 1/rate. */
export function weaponLoadS(weapon: WeaponDef): number {
  return weapon.loadS ?? 1 / Math.max(0.01, weapon.rate);
}

/** Is the crew of this vehicle rattled (commander's mind: spec §10.2)? */
export function crewShaken(state: BattleState, v: Vehicle): boolean {
  const c = vehicleCommander(state, v);
  const st = c?.mind?.state;
  return st === 'shaken' || st === 'pinned' || st === 'cowering' || st === 'panicked' || st === 'broken';
}

/** The man in the commander's seat, else any able crewman (the mind the crew shares). */
export function vehicleCommander(state: BattleState, v: Vehicle): Soldier | null {
  const c = seatOccupant(state, v, 'commander');
  if (c) return c;
  const team = state.teams.get(v.teamId);
  if (!team) return null;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId === v.id) return s;
  }
  return null;
}

/** Multiplier on the loader's working time RIGHT NOW (motion and nerves change while he works). */
export function loadPaceMul(state: BattleState, v: Vehicle, onRoad: boolean): number {
  let m = 1;
  if (Math.abs(v.speed) > 0.1) m *= onRoad ? LOAD_MOVING_MUL : LOAD_CROSS_COUNTRY_MUL;
  if (crewShaken(state, v)) m *= LOAD_SHAKEN_MUL;
  return m;
}

/** Seconds the next round takes to load in this vehicle, standing still and calm: calibre, the
 * loader's skill and health, a dead loader (`reloadMul` from crewEffects: the commander loads,
 * x1.8), the cramped two-man turret, and the hull racks once the ready rack is empty. */
export function vehicleLoadS(state: BattleState, v: Vehicle, def: VehicleDef, weapon: WeaponDef, reloadMul: number, gunner: Soldier | null): number {
  const loader = seatOccupant(state, v, 'loader') ?? vehicleCommander(state, v) ?? gunner;
  let t = weaponLoadS(weapon) * reloadMul * loadSkillMul(loader?.experience ?? EXP_REGULAR);
  if (loader && loader.health === 'wounded') t *= LOAD_LOADER_WOUNDED_MUL;
  if (def.hasTurret && vehicleLayout(def).twoManTurret) t *= LOAD_CRAMPED_TURRET_MUL;
  if (def.readyRack != null && (v.readyRackUsed ?? 0) >= def.readyRack) t *= LOAD_HULL_RACK_MUL;
  return t;
}

// ------------------------------------------------------------------ laying
/** Fine lay of a regular gunner: 4 s up to 200 m, +1 s per further 200 m. */
export function fineLayBaseS(distM: number): number { return 4 + Math.max(0, distM - 200) / 200; }
export const LAY_MOVING_TARGET_MUL = 1.5;
export const LAY_SHAKEN_MUL = 1.4;
export const LAY_DAMAGED_SIGHT_MUL = 1.5;
/** Follow-up on the same stationary target: a correction only, 1.5 (hero) to 2.5 s (recruit). */
export const FOLLOW_UP_S: [number, number] = [1.5, 2.5];
export function followUpLayS(experience: number): number { return clamp(2 * laySkillMul(experience), FOLLOW_UP_S[0], FOLLOW_UP_S[1]); }
/** The commander spots and designates a new target: 1 s (veteran) to 3 s (recruit); doubled when he
 * is buttoned up under fire or is the gunner himself. */
export function designateS(commanderExperience: number, doubled: boolean): number {
  const e = clamp(commanderExperience, EXP_RECRUIT, EXP_VETERAN);
  return (3 - (2 * (e - EXP_RECRUIT)) / (EXP_VETERAN - EXP_RECRUIT)) * (doubled ? 2 : 1);
}
/** The gun may fire only within this of the line to the target. */
export const LAY_TOLERANCE_RAD = 2 * DEG;
/** The fine lay starts when the coarse traverse has brought the gun this close. */
export const COARSE_LAY_RAD = 5 * DEG;

export interface FineLayInput { distM: number; experience: number; targetMoving: boolean; aimMul: number; shaken: boolean; sightDamaged: boolean }
/** Seconds of fine lay on a NEW target. */
export function fineLayS(i: FineLayInput): number {
  return fineLayBaseS(i.distM) * (i.targetMoving ? LAY_MOVING_TARGET_MUL : 1) * laySkillMul(i.experience) * i.aimMul
    * (i.shaken ? LAY_SHAKEN_MUL : 1) * (i.sightDamaged ? LAY_DAMAGED_SIGHT_MUL : 1);
}
/** Seconds of lay for the NEXT round on the same target: a correction when it stands still; a
 * target that keeps moving has to be tracked and laid again (half a fine lay, at least the correction). */
export function followUpS(i: FineLayInput): number {
  const c = followUpLayS(i.experience) * (i.shaken ? LAY_SHAKEN_MUL : 1) * (i.sightDamaged ? LAY_DAMAGED_SIGHT_MUL : 1);
  return i.targetMoving ? Math.max(c, 0.5 * fineLayS(i)) : c;
}

// ------------------------------------------------------------------ bracketing, snap shots, fire on the move
/** Each observed miss on the same target: +15% hit chance, up to +30%; lost when either party moves ~10 m. */
export const BRACKET_STEP = 0.15;
export const BRACKET_MAX = 0.30;
export const BRACKET_LOST_M = 10;
export function bracketMul(misses: number | undefined): number { return 1 + Math.min(BRACKET_MAX, BRACKET_STEP * (misses ?? 0)); }
/** Has either party moved too far for the observed fall of shot to mean anything? */
export function bracketLost(b: { bracketFrom?: Vec2; bracketAt?: Vec2 }, from: Vec2, at: Vec2): boolean {
  if (!b.bracketFrom || !b.bracketAt) return false;
  return dist(b.bracketFrom, from) * TILE_M > BRACKET_LOST_M || dist(b.bracketAt, at) * TILE_M > BRACKET_LOST_M;
}
/** A veteran under immediate threat may fire before the fine lay is complete: hit chance x lay progress, never below this. */
export const SNAP_SHOT_MIN = 0.35;
export const SNAP_SHOT_MIN_EXPERIENCE = 70;
/** Firing the main gun from a moving vehicle. */
export const FIRE_ON_MOVE_MUL = 0.25;
/** A short halt lasts at most this long; then the vehicle drives on at least `FIRE_HALT_GAP_S`. */
export const FIRE_HALT_MAX_S = 20;
export const FIRE_HALT_GAP_S = 8;

// ------------------------------------------------------------------ turn rates
/** Hull turn in place, rad/s. Every real vehicle carries its own `hullTurnDegS`; ONLY VehicleDef
 * literals without it (tests) fall back to the legacy `turnRateRad` (or 20 deg/s, a medium tank). */
export function hullTurnRad(def: VehicleDef): number {
  return def.hullTurnDegS != null ? def.hullTurnDegS * DEG : def.turnRateRad ?? 20 * DEG;
}
/** Soft ground (mud, snow, tall crops) slows a hull turn. */
export const SOFT_GROUND_TURN_MUL = 0.7;
export function isSoftGround(terrain: string): boolean { return terrain === 'mud' || terrain === 'snow' || terrain === 'crops' || terrain === 'tallgrass'; }

/** Powered traverse needs the engine: dead, or damaged in an immobilised vehicle, means the handwheel. */
export function onHandTraverse(v: Vehicle): boolean {
  const e = systemState(v, 'engine');
  return e === 'destroyed' || (e === 'damaged' && isImmobile(v));
}
/** Turret (or casemate gun) traverse right now, rad/s: the vehicle's historical rate, the hand rate
 * without engine power, a jammed ring (x0.4), the gunner's quality. Literals without the figure
 * (tests) fall back to their hull rate. */
export function turretTraverseRad(def: VehicleDef, v: Vehicle, gunnerExperience = EXP_REGULAR): number {
  if (turretFrozen(v)) return 0;
  const degS = def.turretTraverseDegS != null
    ? (onHandTraverse(v) ? def.turretTraverseHandDegS ?? def.turretTraverseDegS : def.turretTraverseDegS)
    : hullTurnRad(def) / DEG;
  return degS * DEG * traverseMul(v) * traverseSkillMul(gunnerExperience);
}
/** Half-arc of the gun relative to the hull: all round for a turret, `gunArcDeg` for a casemate. */
export function gunArcRad(def: VehicleDef): number { return def.hasTurret ? Math.PI : (def.gunArcDeg ?? 10) * DEG; }

/** A slow turret is helped by the hull: when the turret alone would need longer than this. */
export const HULL_ASSIST_MIN_S = 5;
/** Should a standing vehicle swing its HULL toward `bearing` (absolute, rad)? Casemates: whenever the
 * target is outside the gun arc. Turreted tanks: when the turret alone needs more than
 * HULL_ASSIST_MIN_S (a Tiger starts its hull turning at once; a T-34 just swings the turret). */
export function wantsHullTurn(def: VehicleDef, v: Vehicle, bearing: number, gunnerExperience = EXP_REGULAR): boolean {
  if (!def.hasTurret || turretFrozen(v)) return Math.abs(wrapAngle(bearing - v.hullFacing)) > gunArcRad(def) * 0.9;
  const rate = turretTraverseRad(def, v, gunnerExperience);
  const off = Math.abs(wrapAngle(bearing - v.turretFacing));
  if (off <= COARSE_LAY_RAD * 2) return false;
  return rate <= 1e-6 || off / rate > HULL_ASSIST_MIN_S;
}

// ------------------------------------------------------------------ time to first shot
/** Seconds (estimate) until `v` can put its first aimed round on `targetPos`: what is left of the
 * load, the commander's call, the traverse at the real rate (hull and turret together when the hull
 * helps; the hull alone for a casemate outside its arc) and the fine lay. Used by the crews' threat
 * ranking / cover decisions (mind spec §10) and the target choice. Infinity without a usable gun. */
export function timeToFirstShotS(state: BattleState, v: Vehicle, targetPos: Vec2, targetMoving = false): number {
  const def = VEHICLE_DEFS[v.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!def || !weapon || systemState(v, 'mainGun') === 'destroyed') return Infinity;
  const gunner = seatOccupant(state, v, 'gunner') ?? vehicleCommander(state, v);
  if (!gunner) return Infinity;
  const exp = gunner.experience;
  const bearing = angleTo(v.pos, targetPos);
  const distM = dist(v.pos, targetPos) * TILE_M;
  const lay = v.gunLay;
  const sameTarget = !!lay && dist(lay.aim, targetPos) * TILE_M <= BRACKET_LOST_M;
  const shaken = crewShaken(state, v);
  const sightDamaged = systemState(v, 'sight') === 'damaged';
  const cmd = vehicleCommander(state, v);
  const layS = sameTarget
    ? lay!.designateLeftS + lay!.fineLeftS
    : designateS(cmd?.experience ?? EXP_REGULAR, vehicleLayout(def).twoManTurret) + fineLayS({ distM, experience: exp, targetMoving, aimMul: 1, shaken, sightDamaged });
  const canTurnHull = !isImmobile(v) && def.turnRadiusM == null;
  const hullRate = canTurnHull ? hullTurnRad(def) : 0;
  let traverseS: number;
  if (def.hasTurret && !turretFrozen(v)) {
    const off = Math.abs(wrapAngle(bearing - v.turretFacing));
    const tr = turretTraverseRad(def, v, exp);
    const rate = tr + (wantsHullTurn(def, v, bearing, exp) && v.path.length === 0 ? hullRate : 0);
    traverseS = rate > 1e-6 ? off / rate : Infinity;
  } else {
    const off = Math.abs(wrapAngle(bearing - v.hullFacing));
    const outside = Math.max(0, off - gunArcRad(def));
    traverseS = (outside > 0 ? (hullRate > 1e-6 ? outside / hullRate : Infinity) : 0) + Math.min(off, gunArcRad(def)) / Math.max(1e-6, turretTraverseRad(def, v, exp) || 5 * DEG);
  }
  const loadLeft = v.loadedRound ? Math.max(0, v.mainFireTimer) : weaponLoadS(weapon);
  return Math.max(loadLeft, traverseS + layS);
}

/** Seconds per round on a target already laid on (loading against the follow-up correction). */
export function cycleTimeS(state: BattleState, v: Vehicle): number {
  const def = VEHICLE_DEFS[v.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!def || !weapon) return Infinity;
  return vehicleLoadS(state, v, def, weapon, crewEffects(state, v).reloadMul, seatOccupant(state, v, 'gunner'));
}
