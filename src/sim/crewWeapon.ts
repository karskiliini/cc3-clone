// ============================================================================
// crewWeapon.ts — crew-served weapons (mortars, heavy MGs, AT guns) as objects
// on the map: set-up / packed state, where the weapon physically sits, and the
// gun-crew rules from the soldier-mind spec §11 that concern the weapon itself
// (abandonment, a crewman re-manning it, the next man taking over).
//
// The weapon stays owned by its gunner soldier (`Soldier.weaponId`), so the
// combat code is untouched; this module only
//  - keeps `Team.crewWeapon` (pivot position, facing, phase, timers),
//  - holds a crew in place while it packs up (movement.ts asks `isHeldForPacking`),
//  - and gates firing by pushing the gunner's `fireTimer` forward while the
//    weapon is not ready (moving, packing, setting up, or abandoned).
// Deterministic: no rng, only battle time and soldier state.
// ============================================================================
import type { BattleState, CrewWeaponState, FireMission, Soldier, Team, Vec2, WeaponClass, OrderType } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, facingAngle, turnTowards, wrapAngle } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { findPath } from './path';
import { addMessage } from './messages';
import { formationBaseHeading, rotateOffset } from './spawn';

export type CrewServedClass = 'mortar' | 'hmg' | 'atgun';
const CREW_SERVED = new Set<WeaponClass>(['mortar', 'hmg', 'atgun']);

export const DEFAULT_SETUP_S: Record<CrewServedClass, number> = { mortar: 8, hmg: 5, atgun: 10 };
export const DEFAULT_PACK_S = 3;
/** Seconds for a crewman to re-lay a weapon that was already set up when he left it. */
export const REMAN_S = 2;
/** A gunner further than this (tiles) from his set-up weapon has left it. */
export const MANNED_RADIUS_TILES = 6;
/** A crewman this close (tiles) to an abandoned weapon picks it up again. */
export const REMAN_RADIUS_TILES = 1.5;
/** A calm crewman goes back to an abandoned weapon within this range (40 m, spec §11). */
export const RETURN_RADIUS_TILES = 40 / TILE_M;
/** Traverse rates, rad/s. */
const TRAVERSE: Record<CrewServedClass, number> = { mortar: 1.0, hmg: 2.5, atgun: 0.6 };

const MOVE_ORDERS = new Set<OrderType>(['move', 'moveFast', 'sneak']);

/** Role positions around a set-up weapon, in metres in the weapon frame (x right, y down; the
 * muzzle points to -y) relative to the weapon pivot (baseplate / tripod / gun axle). Shared by the
 * sim (pivot from the gunner's position) and the renderer (where the crew kneel). */
export interface CrewLayout { gunner: Vec2; loader: Vec2; assistant: Vec2 }
export const CREW_LAYOUT: Record<CrewServedClass, CrewLayout> = {
  mortar: { gunner: { x: -1.6, y: -0.4 }, loader: { x: 1.25, y: -1.75 }, assistant: { x: 2.2, y: 2.0 } },
  hmg: { gunner: { x: 0, y: 2.25 }, loader: { x: -1.65, y: 1.2 }, assistant: { x: 1.8, y: 2.5 } },
  atgun: { gunner: { x: -1.05, y: 1.35 }, loader: { x: 0.95, y: 1.85 }, assistant: { x: 2.3, y: 1.7 } },
};

export function crewServedClass(weaponId: string): CrewServedClass | null {
  const w = WEAPONS[weaponId];
  return w && CREW_SERVED.has(w.cls) ? (w.cls as CrewServedClass) : null;
}

function isActive(s: Soldier | undefined): s is Soldier {
  return !!s && s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId == null;
}

function isFleeing(s: Soldier): boolean {
  return s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'surrendered';
}

/** The crew-served weapon a team fields, if any (from its soldiers, dead or alive). */
export function teamCrewWeaponId(state: BattleState, team: Team): string | null {
  if (team.vehicleId != null) return null;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && crewServedClass(s.weaponId)) return s.weaponId;
  }
  return null;
}

/** World (tile) position of a weapon-frame offset given in metres. */
export function weaponFramePoint(pivot: Vec2, facing: number, offM: Vec2): Vec2 {
  const r = rotateOffset({ x: offM.x / TILE_M, y: offM.y / TILE_M }, facing);
  return { x: pivot.x + r.x, y: pivot.y + r.y };
}

/** Weapon pivot for a gunner at `gunnerPos` serving a weapon that faces `facing`. */
export function pivotFromGunner(cls: CrewServedClass, gunnerPos: Vec2, facing: number): Vec2 {
  const r = rotateOffset({ x: CREW_LAYOUT[cls].gunner.x / TILE_M, y: CREW_LAYOUT[cls].gunner.y / TILE_M }, facing);
  return { x: gunnerPos.x - r.x, y: gunnerPos.y - r.y };
}

/** Set-up time for this weapon and gunner: veterans are quicker (x0.8 at 100 experience, x1.2 raw). */
export function setupTimeS(weaponId: string, experience: number): number {
  const w = WEAPONS[weaponId];
  const cls = crewServedClass(weaponId);
  const base = w?.setupS ?? (cls ? DEFAULT_SETUP_S[cls] : 0);
  return base * clamp(1.2 - experience / 250, 0.8, 1.2);
}

export function packTimeS(weaponId: string): number {
  return WEAPONS[weaponId]?.packS ?? DEFAULT_PACK_S;
}

/** Where the weapon should point: the gunner's current target, the team's fire/defend/ambush
 * facing, the gunner's sense of the threat, or (fallback) his own facing. */
function desiredFacing(state: BattleState, team: Team, gunner: Soldier, fallback: number): number {
  const from = gunner.pos;
  if (gunner.targetSoldierId != null) {
    const t = state.soldiers.get(gunner.targetSoldierId);
    if (t && t.health !== 'dead') return angleTo(from, t.pos);
  }
  if (gunner.targetVehicleId != null) {
    const v = state.vehicles.get(gunner.targetVehicleId);
    if (v) return angleTo(from, v.pos);
  }
  if (gunner.targetPoint) return angleTo(from, gunner.targetPoint);
  const ord = team.order;
  if (ord && ord.type === 'fire') return angleTo(from, ord.target);
  if (ord && (ord.type === 'defend' || ord.type === 'ambush')) return facingAngle(team.facing);
  if (gunner.mind.threatDir != null) return gunner.mind.threatDir;
  return fallback;
}

function isOrderedMove(team: Team, gunner: Soldier, cw: CrewWeaponState): boolean {
  if (gunner.path.length === 0 || isFleeing(gunner)) return false;
  const ord = team.order;
  return !!ord && MOVE_ORDERS.has(ord.type) && ord.issuedAt >= cw.setAt;
}

function startSetup(state: BattleState, cw: CrewWeaponState, seconds: number): void {
  cw.phase = seconds > 0 ? 'settingUp' : 'ready';
  cw.timer = Math.max(0, seconds);
  cw.phaseTotal = Math.max(0, seconds);
  cw.setAt = state.time;
}

function abandon(state: BattleState, team: Team, cw: CrewWeaponState, why: 'fled' | 'fell'): void {
  if (cw.abandoned) return;
  cw.abandoned = true;
  cw.abandonedAt = state.time;
  if (cw.phase === 'packing' || cw.phase === 'settingUp') {
    // half-assembled: leave it lying as it is; a returning crew starts the drill again
    cw.phase = cw.phase === 'packing' ? 'packed' : cw.phase;
  }
  if (why === 'fled' && team.side === state.config.playerSide && cw.phase !== 'packed') {
    addMessage(state, `${team.name}\nThe crew abandons the gun!`, 'warn');
  }
}

/** Create the state for a team that has a crew-served weapon but no record yet. */
function initCrewWeapon(state: BattleState, team: Team, gunner: Soldier, cls: CrewServedClass): CrewWeaponState {
  const moving = gunner.path.length > 0;
  const facing = state.time <= 0.15 && team.order == null
    ? formationBaseHeading(state.map, team.side)
    : desiredFacing(state, team, gunner, facingAngle(gunner.facing));
  const cw: CrewWeaponState = {
    weaponId: gunner.weaponId,
    pos: moving ? { ...gunner.pos } : pivotFromGunner(cls, gunner.pos, facing),
    facing,
    phase: moving ? 'packed' : 'ready',
    timer: 0,
    phaseTotal: 0,
    gunnerId: gunner.id,
    abandoned: false,
    abandonedAt: 0,
    setAt: moving ? -1 : state.time,
  };
  team.crewWeapon = cw;
  return cw;
}

/** Deploy-screen / pre-battle view of a team's weapon: the stored state, or a set-up weapon at its
 * gunner facing the deploy heading. Pure (never writes the state). */
export function crewWeaponView(state: BattleState, team: Team): CrewWeaponState | null {
  if (team.crewWeapon) return team.crewWeapon;
  const weaponId = teamCrewWeaponId(state, team);
  if (!weaponId) return null;
  const cls = crewServedClass(weaponId)!;
  let gunner: Soldier | undefined;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.weaponId === weaponId) { gunner = s; break; }
  }
  if (!gunner) return null;
  const facing = formationBaseHeading(state.map, team.side);
  return {
    weaponId, pos: pivotFromGunner(cls, gunner.pos, facing), facing, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: gunner.id, abandoned: gunner.health === 'dead', abandonedAt: 0, setAt: 0,
  };
}

/** Takeover delay for the next crewman (spec §11: 2-6 s, longer for the inexperienced). */
function takeoverDelayS(s: Soldier): number {
  return 6 - 4 * clamp(s.experience / 100, 0, 1);
}

function isReturnCandidate(s: Soldier): boolean {
  if (isFleeing(s) || s.activity === 'cowering' || s.activity === 'pinned' || s.activity === 'hiding') return false;
  const st = s.mind.state;
  return st === 'calm' || st === 'alert' || st === 'wary';
}

/** Soldiers of the team a gunner could be: alive, on foot, not running away. */
function crewCandidates(state: BattleState, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (isActive(s) && !isFleeing(s)) out.push(s);
  }
  return out;
}

function stepAbandoned(state: BattleState, team: Team, cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier | undefined): void {
  const crew = gunner ? (isFleeing(gunner) ? [] : [gunner]) : crewCandidates(state, team);
  // someone back at the weapon re-mans it
  for (const s of crew) {
    if (dist(s.pos, cw.pos) > REMAN_RADIUS_TILES + (cls === 'atgun' ? 1 : 0)) continue;
    if (s.path.length > 0 && !(team.order && MOVE_ORDERS.has(team.order.type) && team.order.issuedAt > cw.abandonedAt)) continue;
    if (!gunner && state.time < cw.abandonedAt + takeoverDelayS(s)) continue;
    const old = state.soldiers.get(cw.gunnerId);
    if (old && old.id !== s.id) {
      s.weaponId = cw.weaponId;
      s.ammo = old.ammo;
      s.ammoReserve = old.ammoReserve;
      s.reloadTimer = 0;
      s.fireTimer = Math.max(s.fireTimer, 0);
      old.ammo = 0;
      old.ammoReserve = 0;
    }
    cw.gunnerId = s.id;
    cw.abandoned = false;
    if (team.side === state.config.playerSide) {
      addMessage(state, `${team.name}\n${s.rank}. ${s.name} mans the gun.`, 'info');
    }
    startSetup(state, cw, cw.phase === 'packed' ? setupTimeS(cw.weaponId, s.experience) : REMAN_S);
    return;
  }
  // a calm crewman walks back to it (checked once a second)
  if (Math.round(state.time * 10) % 10 !== 0) return;
  const ord = team.order;
  if (ord && MOVE_ORDERS.has(ord.type) && ord.issuedAt > cw.abandonedAt) return; // sent elsewhere
  let best: Soldier | null = null;
  let bestD = RETURN_RADIUS_TILES;
  for (const s of crew) {
    if (s.path.length > 0 || !isReturnCandidate(s)) continue;
    const d = dist(s.pos, cw.pos);
    if (d <= bestD) { bestD = d; best = s; }
  }
  if (!best) return;
  const path = findPath(state.map, best.pos, cw.pos, 'infantry');
  if (path.length === 0) return;
  best.path = path;
  best.activity = 'moving';
  best.stance = 'crouching';
}

function stepTeamWeapon(state: BattleState, team: Team, dt: number): void {
  let cw = team.crewWeapon;
  const weaponId = cw?.weaponId ?? teamCrewWeaponId(state, team);
  if (!weaponId) return;
  const cls = crewServedClass(weaponId);
  if (!cls) return;
  let gunner = cw ? state.soldiers.get(cw.gunnerId) : undefined;
  if (!cw) {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (isActive(s) && s.weaponId === weaponId) { gunner = s; break; }
    }
    if (!gunner) return;
    cw = initCrewWeapon(state, team, gunner, cls);
  }

  if (!isActive(gunner) || cw.abandoned || isFleeing(gunner)) clearMission(cw);
  if (!isActive(gunner)) {
    // gunner down: the weapon lies where it is until the next man takes it over
    if (!cw.abandoned) {
      const fallen = gunner as Soldier | undefined;
      if (fallen && cw.phase === 'packed') cw.pos = { ...fallen.pos };
      abandon(state, team, cw, 'fell');
    }
    stepAbandoned(state, team, cw, cls, undefined);
    return;
  }

  if (cw.abandoned) {
    stepAbandoned(state, team, cw, cls, gunner);
    gateFire(cw, gunner, dt);
    return;
  }

  if (isFleeing(gunner)) {
    // running away: drop it right here
    if (cw.phase === 'packed') cw.pos = { ...gunner.pos };
    abandon(state, team, cw, 'fled');
    gateFire(cw, gunner, dt);
    return;
  }

  const orderedMove = isOrderedMove(team, gunner, cw);
  switch (cw.phase) {
    case 'ready':
    case 'settingUp': {
      if (orderedMove) {
        const progress = cw.phase === 'ready' ? 1 : 1 - cw.timer / Math.max(1e-6, cw.phaseTotal);
        const t = packTimeS(weaponId) * progress;
        cw.phase = 'packing';
        cw.timer = t;
        cw.phaseTotal = packTimeS(weaponId);
        if (t <= 0) { cw.phase = 'packed'; cw.pos = { ...gunner.pos }; }
        break;
      }
      if (dist(gunner.pos, cw.pos) > MANNED_RADIUS_TILES) {
        abandon(state, team, cw, 'fled');
        break;
      }
      if (cw.phase === 'settingUp') {
        cw.timer -= dt;
        if (cw.timer <= 0) { cw.timer = 0; cw.phase = 'ready'; }
      } else {
        const want = desiredFacing(state, team, gunner, cw.facing);
        cw.facing = turnTowards(cw.facing, want, TRAVERSE[cls] * dt);
      }
      break;
    }
    case 'packing': {
      if (!orderedMove) {
        // the move was cancelled while packing: finish setting up again from where they were
        const packedFrac = 1 - cw.timer / Math.max(1e-6, cw.phaseTotal);
        startSetup(state, cw, setupTimeS(weaponId, gunner.experience) * packedFrac);
        break;
      }
      cw.timer -= dt;
      if (cw.timer <= 0) {
        cw.timer = 0;
        cw.phase = 'packed';
        cw.pos = { ...gunner.pos };
        cw.facing = facingAngle(gunner.facing);
      }
      break;
    }
    case 'packed': {
      cw.pos = { ...gunner.pos };
      if (gunner.path.length > 0) {
        cw.facing = facingAngle(gunner.facing);
        break;
      }
      const facing = desiredFacing(state, team, gunner, facingAngle(gunner.facing));
      cw.facing = facing;
      cw.pos = pivotFromGunner(cls, gunner.pos, facing);
      startSetup(state, cw, setupTimeS(weaponId, gunner.experience));
      break;
    }
  }
  stepMission(cw, gunner, cls, dt);
  gateFire(cw, gunner, dt);
}

/** Keep the gunner's fire timer above zero for this step's combat pass unless the weapon is set up
 * and manned (combat decrements `fireTimer` by dt and fires only at <= 0). */
function gateFire(cw: CrewWeaponState, gunner: Soldier, dt: number): void {
  if (!cw.abandoned && cw.phase === 'ready' && gunner.id === cw.gunnerId) return;
  if (gunner.weaponId !== cw.weaponId) return;
  const wait = cw.phase === 'settingUp' && !cw.abandoned ? cw.timer : 0;
  gunner.fireTimer = Math.max(gunner.fireTimer, wait + dt + 1e-3);
}

/** Advance every crew-served weapon one sim step. Called at the start of stepMovement. */
export function stepCrewWeapons(state: BattleState, dt: number): void {
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    stepTeamWeapon(state, team, dt);
  }
}

/** True while this soldier's team is packing its weapon: the crew stays put until it is packed. */
export function isHeldForPacking(state: BattleState, s: Soldier): boolean {
  const team = state.teams.get(s.teamId);
  const cw = team?.crewWeapon;
  if (!cw || cw.phase !== 'packing' || cw.abandoned) return false;
  return !isFleeing(s);
}

/** Team status override for the HUD ('Setting up' while the crew assembles the weapon, 'Aiming' /
 * 'Loading' while it prepares a fire mission). */
export function crewWeaponStatus(team: Team): 'Setting up' | 'Aiming' | 'Loading' | null {
  const cw = team.crewWeapon;
  if (!cw || cw.abandoned) return null;
  if (cw.phase === 'settingUp') return 'Setting up';
  if (cw.phase === 'ready' && cw.firePhase === 'aiming') return 'Aiming';
  if (cw.phase === 'ready' && cw.firePhase === 'loading') return 'Loading';
  return null;
}

// ------------------------------------------------------------------ fire missions
// Every new fire mission of a crew-served weapon goes through lay (aim) -> load -> fire before the
// first round; later rounds on the same target only need the load time (on top of the weapon's
// normal rate of fire); a new aim point more than MISSION_NEW_AIM_M away starts a new lay; a
// tracked team that moves more than MISSION_RELAY_M from the lay point costs a short re-lay.

/** A new aim point further than this from the current lay point starts a new mission. */
export const MISSION_NEW_AIM_M = 15;
/** A tracked target that has moved further than this from the lay point needs a re-lay correction. */
export const MISSION_RELAY_M = 10;
/** Mortar lay time at zero / at maximum range (seconds, average crew). */
export const MORTAR_LAY_S: [number, number] = [6, 10];
/** AT gun traverse-and-lay: this much for no traverse, up to the max for a half-turn. */
export const ATGUN_LAY_S: [number, number] = [1.5, 4];
export const HMG_LAY_S = 2;
/** Load time per round. HMGs are belt fed: no separate load phase. */
export const LOAD_S: Record<CrewServedClass, number> = { mortar: 2, hmg: 0, atgun: 3.5 };
/** Re-lay correction on a moving tracked target (seconds, average crew). */
export const RELAY_S = 1.5;

/** Crew-drill speed factor: green crews slower (x1.2), veterans faster (x0.8). */
export function crewDrillFactor(experience: number): number {
  return clamp(1.2 - experience / 250, 0.8, 1.2);
}

/** Lay (aim) time for a new mission. `distM` is the range to the aim point, `traverseRad` the angle
 * the weapon must turn from its current facing. */
export function layTimeS(weaponId: string, experience: number, distM: number, traverseRad: number): number {
  const cls = crewServedClass(weaponId);
  if (!cls) return 0;
  const f = crewDrillFactor(experience);
  if (cls === 'mortar') {
    const range = WEAPONS[weaponId]?.rangeM ?? 1000;
    return (MORTAR_LAY_S[0] + (MORTAR_LAY_S[1] - MORTAR_LAY_S[0]) * clamp(distM / range, 0, 1)) * f;
  }
  if (cls === 'atgun') {
    return (ATGUN_LAY_S[0] + (ATGUN_LAY_S[1] - ATGUN_LAY_S[0]) * clamp(Math.abs(traverseRad) / Math.PI, 0, 1)) * f;
  }
  return HMG_LAY_S * f;
}

export function loadTimeS(weaponId: string, experience: number): number {
  const cls = crewServedClass(weaponId);
  return cls ? LOAD_S[cls] * crewDrillFactor(experience) : 0;
}

function clearMission(cw: CrewWeaponState): void {
  cw.mission = undefined;
  cw.firePhase = undefined;
}

/** Crews that are not in a state to work the gun abort the mission. */
function canWorkGun(s: Soldier): boolean {
  return !isFleeing(s) && s.activity !== 'cowering' && s.activity !== 'routed';
}

function stepMission(cw: CrewWeaponState, gunner: Soldier, cls: CrewServedClass, dt: number): void {
  const m = cw.mission;
  if (!m) return;
  if (cw.phase !== 'ready' || cw.abandoned || !canWorkGun(gunner)) { clearMission(cw); return; }
  if (cw.firePhase === 'ready') return;
  m.timer -= dt;
  if (m.timer > 0) return;
  if (cw.firePhase === 'aiming') {
    const load = LOAD_S[cls] * crewDrillFactor(gunner.experience);
    if (load > 0 && !m.loaded) { cw.firePhase = 'loading'; m.loaded = true; m.timer += load; if (m.timer > 0) return; }
  }
  m.timer = 0;
  cw.firePhase = 'ready';
}

export interface FireRequest {
  /** where the round is going */
  aim: Vec2;
  /** team being engaged/tracked, or null for a point target */
  targetTeamId: number | null;
  /** extra seconds before the first round of a new mission (e.g. a spotter's correction by radio) */
  extraFirstRoundDelayS?: number;
}

/** Called by combat when the gunner of a crew-served weapon wants to fire at `req.aim`. Starts a new
 * mission (lay + load) or a re-lay correction as needed and returns the seconds still to wait, or 0
 * when the round may be fired now. Soldiers who do not serve a crew weapon always get 0. */
export function fireMissionWait(state: BattleState, team: Team | undefined, gunner: Soldier, req: FireRequest): number {
  const cw = team?.crewWeapon;
  if (!cw || cw.gunnerId !== gunner.id || gunner.weaponId !== cw.weaponId) return 0;
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return 0;
  if (cw.phase !== 'ready' || cw.abandoned || !canWorkGun(gunner)) { clearMission(cw); return 1; }
  const m = cw.mission;
  const movedM = m ? dist(m.layAim, req.aim) * TILE_M : Infinity;
  const sameTrack = !!m && m.targetTeamId != null && m.targetTeamId === req.targetTeamId;
  if (!m || (!sameTrack && movedM > MISSION_NEW_AIM_M)) {
    const distM = dist(gunner.pos, req.aim) * TILE_M;
    const traverse = wrapAngle(angleTo(cw.pos, req.aim) - cw.facing);
    const lay = layTimeS(cw.weaponId, gunner.experience, distM, traverse) + (req.extraFirstRoundDelayS ?? 0);
    const mission: FireMission = {
      layAim: { x: req.aim.x, y: req.aim.y }, targetTeamId: req.targetTeamId, timer: lay, rounds: 0, loaded: false, startedAt: state.time,
    };
    cw.mission = mission;
    cw.firePhase = 'aiming';
    return missionRemaining(cw, cls, gunner);
  }
  if (sameTrack && movedM > MISSION_RELAY_M) {
    // tracked target moved: small correction, keeps the mission (and its walk-in)
    m.layAim = { x: req.aim.x, y: req.aim.y };
    if (cw.firePhase === 'ready') {
      cw.firePhase = 'aiming';
      m.timer = RELAY_S * crewDrillFactor(gunner.experience);
    } else {
      m.timer += RELAY_S * crewDrillFactor(gunner.experience);
    }
  } else if (!sameTrack && req.targetTeamId !== m.targetTeamId) {
    m.targetTeamId = req.targetTeamId; // a nearby target of another team: same lay, now tracking it
  }
  return cw.firePhase === 'ready' ? 0 : missionRemaining(cw, cls, gunner);
}

function missionRemaining(cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier): number {
  const m = cw.mission!;
  if (cw.firePhase === 'aiming' && !m.loaded) return m.timer + LOAD_S[cls] * crewDrillFactor(gunner.experience);
  return Math.max(0, m.timer);
}

/** Called by combat after a crew-served weapon fired a round: counts it and starts loading the next. */
export function onMissionRound(team: Team | undefined, gunner: Soldier): void {
  const cw = team?.crewWeapon;
  if (!cw || cw.gunnerId !== gunner.id || !cw.mission) return;
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return;
  cw.mission.rounds++;
  const load = LOAD_S[cls] * crewDrillFactor(gunner.experience);
  if (load > 0) { cw.firePhase = 'loading'; cw.mission.timer = load; } else cw.firePhase = 'ready';
}

/** Rounds already fired on the team's current mission (0 when none). */
export function missionRounds(team: Team | undefined): number {
  return team?.crewWeapon?.mission?.rounds ?? 0;
}
