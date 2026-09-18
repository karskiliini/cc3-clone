import type { BattleState, Soldier, Team, Vec2, Vehicle, VehicleDef, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist, turnTowards, vadd, vnorm, vscale, vsub, wrapAngle } from '@/shared/math';
import { idx, inBounds, setTile, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { hasLOS, losTrace } from './los';
import { gradeSpeedMul, GRADE_UPHILL_VEHICLE } from './movement';
import { findPath, isPassable } from './path';
import { addStress, addOrMergeBelief } from './mind';
import { bestRoundAgainst } from './ballistics';
import {
  bailOut, crewEffects, damageSpeedMul, isImmobile, mainGunUsable, stepCrewSeats, stepVehicleDamage, trackPullRad, turretFrozen,
} from './vehicleDamage';
import { cookOffLive, stepCookOff, stepFragmentLandings } from './vehicleExplosion';
import { vehicleRounds } from './aimPoint';
import {
  COARSE_LAY_RAD, SOFT_GROUND_TURN_MUL, cycleTimeS, gunArcRad, hullTurnRad, isSoftGround, timeToFirstShotS, turretTraverseRad, wantsHullTurn,
} from './gunTiming';
import { addMessage } from './messages';
import { crushTile } from './structures';
import { treeCrushByVehicle } from './trees';
import { stepVehicleCrews } from './vehicleCrew';
import { stepTransport, transportHolds } from './transport';
import { isDazed } from './daze';

const HEADING_ALIGN_RAD = 0.35;
/** Tracked vehicles: beyond this heading error they stop and pivot; beyond SHARP_TURN_RAD they
 * keep rolling at no more than 40% of their current maximum speed. */
const PIVOT_RAD = (45 * Math.PI) / 180;
const SHARP_TURN_RAD = (30 * Math.PI) / 180;
export const SHARP_TURN_SPEED_MUL = 0.4;
/** Below this heading error a tracked vehicle is lined up and steers straight at the waypoint;
 * above it, it travels along its own heading while turning (no sideways slip). */
export const TRACK_STRAIGHT_RAD = (4 * Math.PI) / 180;
/** An intermediate waypoint counts as passed within this distance (an arc never hits it exactly). */
export const WAYPOINT_REACH_TILES = 0.75;
/** Wheel-steered halftrack: beyond this heading error it backs up in a K-turn, until within K_TURN_DONE. */
const K_TURN_RAD = (100 * Math.PI) / 180;
const K_TURN_DONE_RAD = (35 * Math.PI) / 180;
const K_TURN_SPEED_MUL = 0.35;
/** Laying the gun with the hull when the turret is stuck: this share of the hull's turn rate. */
export const FROZEN_TURRET_HULL_LAY = 0.5;
const frozenRel = new WeakMap<Vehicle, number>();
const BURN_TO_KO_S = 30;
const DEG30 = (30 * Math.PI) / 180;

// ============================================================================
// Crew psychology + automatic cover-seeking for vehicles (spec §10-10.2).
// Crews share the commander's SoldierMind (reused verbatim: threatDir/
// threatLevel/beliefs/state/stress/fear all mean the same thing for a tank
// crew as for an infantryman, just fed by vehicle-specific triggers).
// ============================================================================

function pickCommander(state: BattleState, team: Team): Soldier | null {
  const leader = state.soldiers.get(team.leaderId);
  if (leader && leader.health !== 'dead' && leader.health !== 'incapacitated') return leader;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated') return s;
  }
  return null;
}


type StressCategory = 'smallArms' | 'atRifle' | 'bounced';

function categorizeVehicleHit(weapon: WeaponDef, isHalftrack: boolean): { category: StressCategory; atAlarm: boolean } {
  const cls = weapon.cls;
  if (cls === 'tankgun' || cls === 'atgun' || cls === 'atrocket') return { category: 'bounced', atAlarm: true };
  if (cls === 'atrifle') return { category: 'atRifle', atAlarm: isHalftrack };
  const isHmg = cls === 'hmg';
  return { category: 'smallArms', atAlarm: isHalftrack && isHmg };
}


/** Called by combat.ts whenever a round lands on a vehicle (hit or shell-stopped-by-armour), for
 * the AT-hit alarm (spec §10b) and non-penetrating crew stress (spec §10.2). */
export function onVehicleHit(
  state: BattleState, vehicle: Vehicle, weapon: WeaponDef, penetrated: boolean, shooterPos: Vec2 | null,
): void {
  const team = state.teams.get(vehicle.teamId);
  if (!team) return;
  const commander = pickCommander(state, team);
  if (!commander) return;
  const def = VEHICLE_DEFS[vehicle.defId];
  const isHalftrack = def?.kind === 'halftrack';
  const { category, atAlarm } = categorizeVehicleHit(weapon, isHalftrack);
  const mind = commander.mind;

  if (atAlarm) {
    mind.threatLevel = 1;
    if (shooterPos) {
      mind.threatDir = angleTo(vehicle.pos, shooterPos);
      addOrMergeBelief(mind, shooterPos, 'fired', 0.9, 1, state.time);
    }
  }

  if (!penetrated) {
    const base = category === 'smallArms' ? 1.5 : category === 'atRifle' ? 6 : 12;
    const mult = 1.4 - commander.experience / 100;
    addStress(mind, base * mult);
    // spec §10.2: small arms alone never raise threatLevel above 0.3.
    if (category === 'smallArms' && !atAlarm) mind.threatLevel = Math.min(mind.threatLevel, 0.3);
  }

}

/** True for weapons whose passing round alarms a vehicle crew (tank guns, AT guns/rockets/rifles). */
function isAtWeapon(weapon: WeaponDef): boolean {
  const c = weapon.cls;
  return c === 'tankgun' || c === 'atgun' || c === 'atrocket' || c === 'atrifle';
}


interface NearMissRecord { pos: Vec2; weapon: WeaponDef; at: number }
const nearMisses = new WeakMap<BattleState, Map<number, NearMissRecord>>();
const NEAR_MISS_MEMORY_S = 15;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}


function alarmCrewNearMiss(state: BattleState, v: Vehicle, weapon: WeaponDef, shooterPos: Vec2): void {
  if (v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') return;
  const team = state.teams.get(v.teamId);
  if (!team) return;
  const commander = pickCommander(state, team);
  if (!commander) return;
  const mind = commander.mind;
  mind.threatLevel = Math.max(mind.threatLevel, 0.8);
  // Toward the shooter if the crew can see the muzzle; otherwise back along the tracer's line,
  // which points the same way but gives no pinpointed position (no belief).
  mind.threatDir = angleTo(v.pos, shooterPos);
  if (hasLOS(state.map, v.pos, shooterPos)) addOrMergeBelief(mind, shooterPos, 'fired', 0.6, 1, state.time);
  addStress(mind, 4);
  let m = nearMisses.get(state);
  if (!m) { m = new Map(); nearMisses.set(state, m); }
  m.set(v.id, { pos: { ...shooterPos }, weapon, at: state.time });
}


/** Spec §10(c): an AT round that misses (passes close by) alarms the crew of the target vehicle and
 * of any friendly vehicle within 3 tiles of the round's flight line, so a crew can reverse to cover
 * before the killing shot instead of only after a hit. Called by combat.ts's miss branch. */
export function onVehicleNearMiss(state: BattleState, vehicle: Vehicle, weapon: WeaponDef, shooterPos: Vec2): void {
  const isHalftrack = VEHICLE_DEFS[vehicle.defId]?.kind === 'halftrack';
  if (!isAtWeapon(weapon) && !categorizeVehicleHit(weapon, isHalftrack).atAlarm) return;
  alarmCrewNearMiss(state, vehicle, weapon, shooterPos);
  for (const other of state.vehicles.values()) {
    if (other.id === vehicle.id || other.side !== vehicle.side) continue;
    if (distToSegment(other.pos, shooterPos, vehicle.pos) <= 3) alarmCrewNearMiss(state, other, weapon, shooterPos);
  }
}
interface ArmorThreat {
  pos: Vec2; distM: number; weapon: WeaponDef; theirArmor: number | null;
  /** seconds until it can put its first aimed round into us, and its seconds per round after that */
  firstShotS: number; cycleS: number;
  vehicle?: Vehicle;
}

/** A spotted AT gun / rocket / rifle team: assumed laid on us within this, then its loading time. */
const INFANTRY_AT_FIRST_SHOT_S = 5;
/** The crew weighs what each side can do within this many seconds (spec §10: who lays first). */
export const DUEL_HORIZON_S = 20;
/** Rounds a gun gets off within the horizon: the first after `firstShotS`, then one per `cycleS`. */
export function shotsWithin(firstShotS: number, cycleS: number, horizonS = DUEL_HORIZON_S): number {
  if (!(firstShotS <= horizonS)) return 0;
  return 1 + Math.floor((horizonS - firstShotS) / Math.max(1, cycleS));
}


function gatherArmorThreats(state: BattleState, v: Vehicle): ArmorThreat[] {
  const out: ArmorThreat[] = [];
  for (const id of state.spottedVehicles[v.side]) {
    const ev = state.vehicles.get(id);
    if (!ev || ev.state === 'knockedOut') continue;
    const edef = VEHICLE_DEFS[ev.defId];
    if (!edef || (edef.kind !== 'tank' && edef.kind !== 'spg')) continue;
    const distM = dist(v.pos, ev.pos) * TILE_M;
    if (distM > 400) continue;
    const weapon = edef.mainWeaponId ? WEAPONS[edef.mainWeaponId] : undefined;
    if (!weapon) continue;
    out.push({
      pos: { ...ev.pos }, distM, weapon, theirArmor: edef.armor.front, vehicle: ev,
      firstShotS: timeToFirstShotS(state, ev, v.pos, Math.abs(v.speed) > 0.1), cycleS: cycleTimeS(state, ev),
    });
  }
  for (const id of state.spotted[v.side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (!w || (w.cls !== 'atgun' && w.cls !== 'atrocket' && w.cls !== 'atrifle')) continue;
    const distM = dist(v.pos, s.pos) * TILE_M;
    if (distM > 400) continue;
    out.push({ pos: { ...s.pos }, distM, weapon: w, theirArmor: null, firstShotS: INFANTRY_AT_FIRST_SHOT_S, cycleS: Math.max(w.loadS ?? 0, w.reloadS, 4) });
  }
  return out;
}



interface ReverseTrack {
  target: Vec2 | null;
  route: Vec2[];
  backing: boolean;
  fleeingSince: number | null;
  cooldownUntil: number;
  searchAfter?: number;
}
const reverseTracks = new WeakMap<BattleState, Map<number, ReverseTrack>>();
function getReverseTrack(state: BattleState, vehicleId: number): ReverseTrack {
  let m = reverseTracks.get(state);
  if (!m) { m = new Map(); reverseTracks.set(state, m); }
  let t = m.get(vehicleId);
  if (!t) { t = { target: null, route: [], backing: false, fleeingSince: null, cooldownUntil: -Infinity }; m.set(vehicleId, t); }
  return t;
}



/** Cover for a vehicle (spec §10): a tile within 12 tiles whose LOS toward the threat is blocked,
 * within 4 tiles, by a building/stonewall/woods. */
const BLOCKING_TERRAIN = new Set(['buildingStone', 'buildingWood', 'stonewall', 'woods']);
function findVehicleCoverRoute(state: BattleState, v: Vehicle, threatPos: Vec2): { target: Vec2; route: Vec2[] } | null {
  const map = state.map;
  const cx = Math.floor(v.pos.x), cy = Math.floor(v.pos.y);
  const candidates: { target: Vec2; distance: number }[] = [];
  for (let dy = -12; dy <= 12; dy++) {
    for (let dx = -12; dx <= 12; dx++) {
      if (dx * dx + dy * dy > 144) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!inBounds(map, tx, ty)) continue;
      if (!isPassable(map, tx, ty, 'vehicle')) continue;
      const tile = { x: tx + 0.5, y: ty + 0.5 };
      const trace = losTrace(map, tile, threatPos);
      if (trace.clear) continue;
      if (!trace.blockedAt || dist(tile, trace.blockedAt) > 4) continue;
      const blockTerrain = tileAt(map, Math.floor(trace.blockedAt.x), Math.floor(trace.blockedAt.y));
      if (!BLOCKING_TERRAIN.has(blockTerrain)) continue;
      candidates.push({ target: tile, distance: dist(v.pos, tile) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const { target, distance } of candidates) {
    if (distance < 0.5) return { target, route: [] };
    // Cover is local: bound route work, and reject partial A* paths into unreachable pockets.
    const route = findPath(map, v.pos, target, 'vehicle', 2000);
    const end = route.at(-1);
    if (end && dist(end, target) < 0.5) return { target, route };
  }
  return null;
}


function stepOneVehicleMind(state: BattleState, rng: Rng, dt: number, v: Vehicle, team: Team, commander: Soldier): void {
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return;
  const mind = commander.mind;
  mind.threatLevel = Math.max(0, mind.threatLevel - 0.1 * dt);

  const threats = gatherArmorThreats(state, v);
  let top: ArmorThreat | null = null;
  let topDanger = 0;
  // danger = the BEST round the enemy gun can fire at that range (AP, or APCR once issued): a KV-1
  // respects a PaK 38 at 200 m and shrugs at it at 600 m (requirements A4)
  const year = state.config.year;
  // ... weighted by TIME TO FIRST SHOT: of two guns that can hurt us the one that will fire first
  // is the one to face (a Tiger still swinging its turret round is less urgent than a laid PaK)
  let topUrgency = -1;
  for (const th of threats) {
    const d = bestRoundAgainst(th.weapon, th.distM, def.armor.front, year).chance;
    const urgency = d * (1 - (1 - d) ** shotsWithin(th.firstShotS, th.cycleS)) + d * 1e-3;
    if (urgency > topUrgency || !top) { topUrgency = urgency; topDanger = d; top = th; }
  }
  // Belief-only threat (spec §10c): an unseen AT shooter that just sent a round past us. Danger is
  // estimated from the weapon that fired, so a near miss alone can start a reverse to cover.
  if (!top) {
    const nm = nearMisses.get(state)?.get(v.id);
    if (nm && state.time - nm.at <= NEAR_MISS_MEMORY_S) {
      const distM = dist(v.pos, nm.pos) * TILE_M;
      top = { pos: { ...nm.pos }, distM, weapon: nm.weapon, theirArmor: null, firstShotS: INFANTRY_AT_FIRST_SHOT_S, cycleS: Math.max(nm.weapon.loadS ?? 0, nm.weapon.reloadS, 4) };
      topDanger = bestRoundAgainst(nm.weapon, distM, def.armor.front, year).chance;
    }
  }
  if (top && threats.length > 0) {
    mind.threatLevel = Math.max(mind.threatLevel, 0.7);
    mind.threatDir = angleTo(v.pos, top.pos);
    addOrMergeBelief(mind, top.pos, 'seen', 0.9, 1, state.time);
  } else if (mind.beliefs.length > 0) {
    // still alarmed via a recent hit-belief (spec §10b/c) even with no live sighting this tick.
    const strongest = mind.beliefs.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    mind.threatDir = angleTo(v.pos, strongest.pos);
  }

  // ---- crew fear state from non-penetrating hit stress (spec §10.2) ----
  mind.fear = clamp01to100(mind.stress * (1.25 - commander.experience / 200 - mind.motivation / 400) - (commander.morale - 50) / 5);
  if (commander.experience >= 70) {
    // "experience >= 70 crews never panic from non-penetrating hits" (spec §11/§10.2).
    mind.state = mind.fear > 40 && mind.threatLevel > 0.5 ? 'shaken' : mind.fear > 10 ? 'alert' : 'calm';
  } else if (mind.fear > 90 && commander.experience < 40) {
    mind.state = 'panicked';
  } else if (mind.fear > 70 && commander.experience < 50) {
    mind.state = 'cowering';
  } else if (mind.fear > 40) {
    mind.state = 'shaken';
  } else if (mind.fear > 10) {
    mind.state = 'alert';
  } else {
    mind.state = 'calm';
  }

  const track = getReverseTrack(state, v.id);

  // ---- danger assessment + flee decision (spec §10, §10.1) ----
  let fleeThreshold = 0.15;
  if (commander.mind.trait === 'reckless') fleeThreshold = 0.35;
  else if (commander.mind.trait === 'cautious') fleeThreshold = 0.1;

  let shouldFlee = !!top && topDanger >= fleeThreshold;
  if (shouldFlee && top && top.theirArmor != null && def.mainWeaponId) {
    const ourWeapon = WEAPONS[def.mainWeaponId];
    if (ourWeapon) {
      const ours = vehicleRounds(state, v);
      // "only seek cover when our kill chance against it is lower than its chance against us": each
      // side's chance over the rounds it can get off in the next DUEL_HORIZON_S, the first of them
      // after its TIME TO FIRST SHOT (load, call, traverse at the real rate, lay). With both guns
      // laid this is the old two-shot comparison; a slow turret still coming round loses the duel.
      const ourP = mainGunUsable(v) ? bestRoundAgainst(ourWeapon, top.distM, top.theirArmor, year, ours).chance : 0;
      const ourShots = Math.min(2, shotsWithin(timeToFirstShotS(state, v, top.pos, !!top.vehicle && Math.abs(top.vehicle.speed) > 0.1), cycleTimeS(state, v)));
      const theirShots = Math.max(1, Math.min(2, shotsWithin(top.firstShotS, top.cycleS)));
      shouldFlee = 1 - (1 - ourP) ** ourShots < 1 - (1 - topDanger) ** theirShots;
    }
  }
  // a tank whose main gun is gone has no business in front of anything that can hurt it
  if (top && def.mainWeaponId && !mainGunUsable(v) && topDanger > 0.02) shouldFlee = true;
  // panicked crews flee regardless (driver bails/reverses blind, spec §10.2).
  if (mind.state === 'panicked') shouldFlee = true;

  // Balance fix (suspect d): an unbounded flee/reverse cycle could keep pulling a tank out of the
  // fight indefinitely whenever ANY armor threat lingered (e.g. a spotted AT gun it can't easily
  // silence), taking it out of the attacker's/defender's line for the whole battle. Cap continuous
  // reversing at 20s, then force a 10s cooldown during which the vehicle must re-engage from
  // wherever it ended up (even if the threat is still live) before it's allowed to flee again.
  if (shouldFlee && state.time < track.cooldownUntil) shouldFlee = false;
  if (shouldFlee) {
    if (track.fleeingSince === null) track.fleeingSince = state.time;
    else if (state.time - track.fleeingSince >= 20) {
      shouldFlee = false;
      track.fleeingSince = null;
      track.cooldownUntil = state.time + 10;
    }
  } else {
    track.fleeingSince = null;
  }

  if (!shouldFlee || !top) {
    track.target = null;
    track.route = [];
    return;
  }

  if (isImmobile(v)) {
    // crew bails: vehicle abandoned, crew become panicked infantry (spec §10.2).
    bailOut(state, v, team, 'abandoned', 'Crew bails out!', { cause: 'panic' });
    return;
  }
  if (!crewEffects(state, v).canDrive) { track.target = null; return; } // nobody at the controls

  if (!track.target && state.time >= (track.searchAfter ?? -Infinity)) {
    const found = findVehicleCoverRoute(state, v, top.pos);
    track.target = found?.target ?? null;
    track.route = found?.route ?? [];
    if (track.target) {
      const first = track.route[0];
      // Preserve frontal armour only when cover already lies along the rearward driving line.
      // Side cover requires a forward manoeuvre, rather than translating sideways under the hull.
      track.backing = !!first
        && Math.abs(wrapAngle(angleTo(v.pos, first) + Math.PI - v.hullFacing)) <= DEG30
        && Math.abs(wrapAngle(angleTo(v.pos, top.pos) - v.hullFacing)) <= DEG30;
    }
    // nothing to hide behind: it stands where it is, so look again in a moment, not every step
    if (!track.target) track.searchAfter = state.time + 2;
  }
  if (track.target) {
    driveToCover(state, rng, dt, v, def, top.pos, track);
  }
}


function clamp01to100(x: number): number { return x < 0 ? 0 : x > 100 ? 100 : x; }

/** Cover uses a real route and the hull's driving axis. Large turns pivot first; smaller ones
 * drive a tightening arc. Reverse is deliberate and signed, never a sideways vector to cover. */
function driveToCover(state: BattleState, rng: Rng, dt: number, v: Vehicle, def: VehicleDef, threatPos: Vec2, track: ReverseTrack): void {
  const route = track.route;
  while (route.length > 0 && dist(v.pos, route[0]) < (route.length > 1 ? 0.55 : 0.25)) route.shift();
  const wp = route[0];
  if (!wp || transportHolds(state, v)) { v.speed = 0; return; }
  const desired = angleTo(v.pos, wp);
  const rearFacing = wrapAngle(desired + Math.PI);
  if (track.backing && Math.abs(wrapAngle(rearFacing - angleTo(v.pos, threatPos))) > DEG30) track.backing = false;
  const desiredHull = track.backing ? rearFacing : desired;
  const tx = Math.floor(v.pos.x), ty = Math.floor(v.pos.y);
  const tile = tileAt(state.map, tx, ty);
  const props = TERRAIN_PROPS[tile];
  const road = tile === 'dirtroad' || tile === 'pavedroad' || tile === 'bridge';
  let speed = (road ? def.speedRoadMs : def.speedOffroadMs * props.speedMul)
    * damageSpeedMul(v) * gradeSpeedMul(state.map, v.pos, wp, GRADE_UPHILL_VEHICLE)
    * (track.backing ? 0.6 : 1);
  const wheeled = def.turnRadiusM != null;
  turnHull(state, v, def, desiredHull, dt, wheeled ? speed : undefined);
  const error = Math.abs(wrapAngle(desiredHull - v.hullFacing));
  if (!wheeled && error > PIVOT_RAD) { v.speed = 0; return; }
  speed *= error > SHARP_TURN_RAD ? SHARP_TURN_SPEED_MUL : error > HEADING_ALIGN_RAD ? 0.7 : 1;
  if (!wheeled && error > TRACK_STRAIGHT_RAD) {
    speed = Math.min(speed, Math.max(0.15, hullTurnNow(state, v, def).rate * dist(v.pos, wp) * TILE_M * 0.6));
  }
  v.hullFacing = wrapAngle(v.hullFacing + trackPullRad(v) * dt);
  const direction = track.backing ? wrapAngle(v.hullFacing + Math.PI) : v.hullFacing;
  const advance = Math.min(dist(v.pos, wp), speed * dt / TILE_M);
  const next = { x: v.pos.x + Math.sin(direction) * advance, y: v.pos.y - Math.cos(direction) * advance };
  if (!isPassable(state.map, Math.floor(next.x), Math.floor(next.y), 'vehicle')) { v.speed = 0; return; }
  v.speed = track.backing ? -speed : speed;
  if (v.holdUntil != null && state.time < v.holdUntil) {
    stepOverrun(state, rng, v, direction);
    if (v.holdUntil != null && state.time < v.holdUntil) { v.speed = 0; return; }
  }
  v.pos = next;
  if (props.crushable) crushTile(state.map, tx, ty);
  treeCrushByVehicle(state.map, tx, ty, def.lengthM);
  stepOverrun(state, rng, v, direction);
}


/** Is the crew manoeuvring into cover right now? Kept for combat's no-short-halt escape gate. */
export function isVehicleReversing(state: BattleState, v: Vehicle): boolean {
  return !!reverseTracks.get(state)?.get(v.id)?.target;
}


/** Hull turn rate right now, rad/s, and the only direction it can turn (0 = either): the vehicle's
 * historical turn-in-place figure (also the cap while driving); x0.7 on soft ground; ONE damaged
 * track: only toward that side, at half rate; a destroyed track or dead engine: none. A
 * wheel-steered halftrack turns at speed / turning radius: not at all when it stands. */
export function hullTurnNow(state: BattleState, v: Vehicle, def: VehicleDef, speedMs = Math.abs(v.speed)): { rate: number; onlyDir: -1 | 0 | 1 } {
  if (isImmobile(v)) return { rate: 0, onlyDir: 0 };
  let rate = def.turnRadiusM != null ? speedMs / def.turnRadiusM : hullTurnRad(def);
  if (isSoftGround(tileAt(state.map, Math.floor(v.pos.x), Math.floor(v.pos.y)))) rate *= SOFT_GROUND_TURN_MUL;
  const l = v.damage?.trackL === 'damaged', r = v.damage?.trackR === 'damaged';
  if (l || r) rate *= 0.5;
  return { rate, onlyDir: l === r ? 0 : l ? -1 : 1 };
}


/** Turns the hull toward `desired` at its real rate (the long way round when a damaged track lets
 * it turn one way only). `speedMs`: the speed a wheel-steered vehicle is turning at. */
export function turnHull(state: BattleState, v: Vehicle, def: VehicleDef, desired: number, dt: number, speedMs?: number): void {
  const { rate, onlyDir } = hullTurnNow(state, v, def, speedMs);
  if (rate <= 0) return;
  let diff = wrapAngle(desired - v.hullFacing);
  if (onlyDir !== 0 && Math.abs(diff) > 0.02 && Math.sign(diff) !== onlyDir) diff -= Math.sign(diff) * Math.PI * 2;
  const step = Math.max(-rate * dt, Math.min(rate * dt, diff));
  v.hullFacing = wrapAngle(v.hullFacing + step);
}


/** The hull heading each vehicle had when it was last stepped: a turret is carried round by its hull. */
const lastHull = new WeakMap<Vehicle, number>();
const kTurning = new WeakSet<Vehicle>();
const DEG = Math.PI / 180;

export function stepVehicleMinds(state: BattleState, rng: Rng, dt: number): void {
  for (const v of state.vehicles.values()) {
    if (v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') continue;
    const team = state.teams.get(v.teamId);
    if (!team) continue;
    const commander = pickCommander(state, team);
    if (!commander) continue;
    stepOneVehicleMind(state, rng, dt, v, team, commander);
  }
}


// ============================================================================
// Existing movement/turret/burn stepping.
// ============================================================================

/** Turns hulls/turrets towards targets or waypoints, drives vehicles, crushes crushable
 * terrain, and progresses burning vehicles towards knocked-out. Also steps crew psychology and
 * automatic reversing-to-cover (spec §10). */
export function stepVehicles(state: BattleState, rng: Rng, dt: number): void {
  const map = state.map;
  stepVehicleMinds(state, rng, dt);
  stepTransport(state, dt); // passengers boarding and leaving
  stepVehicleCrews(state, rng, dt); // hatch queues, climbs, crews going back (spec 2026-09-17 §10)

  stepFragmentLandings(state, rng); // heavy wreckage coming down (sim/vehicleExplosion.ts)
  for (const v of state.vehicles.values()) {
    stepVehicleDamage(state, rng, v); // a crew getting out of a burning vehicle
    if (v.state === 'burning') {
      v.burnTimer += dt;
      stepCookOff(state, rng, v); // rounds popping, then perhaps the rest (or the fuel tank)
      // the fire lasts as long as something aboard may still blow up
      if (v.burnTimer >= BURN_TO_KO_S && !cookOffLive(v)) v.state = 'knockedOut';
    }
    // A burning, knocked-out or abandoned vehicle is dead weight: it never drives, and any path
    // left over from an order or a reverse-to-cover is dropped. Immobilized is NOT in this list.
    if (v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') { v.speed = 0; v.path = []; continue; }

    const def = VEHICLE_DEFS[v.defId];
    if (!def) continue;

    let targetPos: Vec2 | null = null;
    if (v.targetSoldierId != null) {
      const t = state.soldiers.get(v.targetSoldierId);
      if (t) targetPos = t.pos;
    } else if (v.targetVehicleId != null) {
      const t = state.vehicles.get(v.targetVehicleId);
      if (t) targetPos = t.pos;
    } else if (v.targetPoint) {
      targetPos = v.targetPoint;
    }

    const track = reverseTracks.get(state)?.get(v.id);
    const isReversing = !!track?.target;
    stepCrewSeats(state, v); // dead men's seats are taken over (driver first)

    // the turret (and a casemate's gun) rides on the hull: whatever the hull turned since the last
    // step carried it round too; its own traverse then works against that at its limited rate
    const carried = wrapAngle(v.hullFacing - (lastHull.get(v) ?? v.hullFacing));
    lastHull.set(v, v.hullFacing);
    if (carried !== 0 && !turretFrozen(v)) v.turretFacing = wrapAngle(v.turretFacing + carried);
    const gunnerExp = crewEffects(state, v).gunner?.experience;
    // where the gun is wanted: the gunner's lay (sim/combat.ts), else the ordered fire point
    const layPos: Vec2 | null = v.gunLay && v.gunLay.designateLeftS <= 0 ? v.gunLay.aim : null;

    const frozen = def.hasTurret && turretFrozen(v);
    if (frozen) {
      // the turret no longer traverses: it goes where the hull goes, and a standing tank lays its
      // gun by turning the hull (much slower)
      const rel = wrapAngle(v.turretFacing - v.hullFacing);
      if (targetPos && v.path.length === 0 && !isReversing && !isImmobile(v) && crewEffects(state, v).canDrive) {
        v.hullFacing = turnTowards(v.hullFacing, wrapAngle(angleTo(v.pos, layPos ?? targetPos) - rel), hullTurnNow(state, v, def).rate * FROZEN_TURRET_HULL_LAY * dt);
      }
      frozenRel.set(v, rel);
    } else if (v.gunLay) {
      // the gunner is laying: sim/combat.ts traverses the turret / the casemate's gun at its real
      // rate; here a casemate's gun is only kept inside its arc as the hull turns under it
      if (!def.hasTurret) {
        const arc = gunArcRad(def);
        v.turretFacing = wrapAngle(v.hullFacing + Math.max(-arc, Math.min(arc, wrapAngle(v.turretFacing - v.hullFacing))));
      }
    } else {
      // no target: the gun comes back to the ordered fire point or to the hull's axis, at the
      // vehicle's own historical traverse rate (no shared rule)
      const want = def.hasTurret && targetPos ? angleTo(v.pos, targetPos) : v.hullFacing;
      v.turretFacing = turnTowards(v.turretFacing, want, turretTraverseRad(def, v, gunnerExp) * dt);
    }
    if (frozen) v.turretFacing = wrapAngle(v.hullFacing + frozenRel.get(v)!);

    if (isReversing) { if (frozen) v.turretFacing = wrapAngle(v.hullFacing + frozenRel.get(v)!); continue; } // handled by stepVehicleMinds' cover drive this same tick

    const canDrive = !isImmobile(v) && crewEffects(state, v).canDrive;
    // a short halt for an aimed shot (sim/combat.ts): the vehicle stands, keeps its route, and
    // drives on when the round is away
    const fireHalt = v.fireHaltUntil != null && state.time < v.fireHaltUntil;
    if (v.path.length === 0 || !canDrive || fireHalt) {
      v.speed = 0;
      // standing: the crew decides between turning the HULL and only the turret toward the target
      // or threat, from the real rates (mind spec §10): a casemate outside its gun arc must turn the
      // hull; a Tiger's slow turret is helped by the hull at once; a T-34 just swings the turret.
      // A wheel-steered halftrack cannot turn where it stands.
      if (canDrive && !frozen && def.turnRadiusM == null && def.mainWeaponId) {
        const ownTeam = state.teams.get(v.teamId);
        const mind = ownTeam ? pickCommander(state, ownTeam)?.mind : undefined;
        const bearing = layPos ? angleTo(v.pos, layPos) : targetPos ? angleTo(v.pos, targetPos) : mind && mind.threatLevel >= 0.7 ? mind.threatDir : null;
        // standing on an ORDERED arc (Defend/Ambush) the crew must hold: the driver swings the HULL
        // toward it when the turret alone is the slower way round, and then keeps the hull coming
        // round the rest of the way - a hull parked sideways to the arc it was ordered to hold is
        // a turret-ring shot waiting to happen. A bare target point (a lay the gunner can swing to
        // himself) or a fleeting aim never moves the hull; only a REAL threat does (mind spec §10).
        const hullErr = bearing != null ? Math.abs(wrapAngle(bearing - v.hullFacing)) : Infinity;
        const turretErr = targetPos != null ? Math.abs(wrapAngle(angleTo(v.pos, targetPos) - v.turretFacing)) : Infinity;
        const heldArc = targetPos != null && (ownTeam?.order?.type === 'defend' || ownTeam?.order?.type === 'ambush');
        const worthHull = heldArc
          && (hullErr / hullTurnRad(def) < turretErr / turretTraverseRad(def, v, gunnerExp)
            || (turretErr < COARSE_LAY_RAD && hullErr > COARSE_LAY_RAD));
        const threat = bearing != null && targetPos == null && layPos == null; // from the commander's threat sense only
        if (bearing != null && (worthHull || (threat && wantsHullTurn(def, v, bearing, gunnerExp)))) turnHull(state, v, def, bearing, dt);
      }
      continue;
    }
    // a transport stands still while anyone boards or leaves (it keeps its route)
    if (transportHolds(state, v)) { v.speed = 0; continue; }
    // a man under the hull with nowhere to go: stand still and wait (he is re-prompted to dodge)
    if (v.holdUntil != null && state.time < v.holdUntil) {
      stepOverrun(state, rng, v, angleTo(v.pos, v.path[0]));
      if (v.holdUntil != null && state.time < v.holdUntil) { v.speed = 0; continue; }
    }
    v.holdUntil = undefined;
    // early dodge: a man in the path AHEAD of the hull steps aside before the hull-local test
    stepOverrunLookahead(state, rng, v, def);

    const wp = v.path[0];
    const desired = angleTo(v.pos, wp);
    const tx = Math.floor(v.pos.x), ty = Math.floor(v.pos.y);
    const tile = tileAt(map, tx, ty);
    const props = TERRAIN_PROPS[tile];
    const onRoad = tile === 'dirtroad' || tile === 'pavedroad' || tile === 'bridge';
    const baseSpeed = onRoad ? def.speedRoadMs : def.speedOffroadMs;
    // slope: tracks lose far more than legs do on a climb (GRADE_UPHILL_VEHICLE)
    const fullSpeedMs = (onRoad ? baseSpeed : baseSpeed * props.speedMul)
      * gradeSpeedMul(map, v.pos, wp, GRADE_UPHILL_VEHICLE) * damageSpeedMul(v);

    if (def.turnRadiusM != null) {
      // wheel-steered halftrack: it cannot pivot; it drives an arc, or backs up in a K-turn
      if (stepWheeledDrive(state, rng, dt, v, def, wp, desired, fullSpeedMs)) { if (props.crushable) crushTile(map, tx, ty); treeCrushByVehicle(map, tx, ty, def.lengthM); }
      continue;
    }

    turnHull(state, v, def, desired, dt);
    if (frozen) v.turretFacing = wrapAngle(v.hullFacing + frozenRel.get(v)!);
    const headingErr = Math.abs(wrapAngle(desired - v.hullFacing));
    // tracked: a big heading error is turned out on the spot; a sharp turn under way costs speed
    // (<= 40% of the current maximum beyond 30 deg)
    if (headingErr > PIVOT_RAD) {
      v.speed = 0;
      continue;
    }
    let speedMs = fullSpeedMs * (headingErr > SHARP_TURN_RAD ? SHARP_TURN_SPEED_MUL : headingErr > HEADING_ALIGN_RAD ? 0.7 : 1);
    // A tracked vehicle only ever travels along its own hull heading: it drives forward while it
    // keeps turning, and never slips sideways toward the waypoint. So that the arc closes on the
    // waypoint instead of orbiting it, the speed is held to what the hull can turn inside the
    // remaining distance (turning radius = speed / turn rate <= 60% of the distance).
    const d = dist(v.pos, wp);
    if (headingErr > TRACK_STRAIGHT_RAD) {
      const rate = hullTurnNow(state, v, def).rate;
      speedMs = Math.min(speedMs, Math.max(0.3, rate * d * TILE_M * 0.6));
    }
    v.speed = speedMs;
    // one damaged track drags the hull to that side; the driver keeps correcting
    v.hullFacing = wrapAngle(v.hullFacing + trackPullRad(v) * dt);

    const distTiles = (speedMs * dt) / TILE_M;
    // an arc never lands exactly on a waypoint: an intermediate one counts as passed from close by
    const reach = v.path.length > 1 ? Math.max(distTiles, WAYPOINT_REACH_TILES) : distTiles;
    if (d <= reach || d < 1e-4) {
      if (v.path.length === 1) v.pos = { x: wp.x, y: wp.y };
      v.path.shift();
    } else if (headingErr <= TRACK_STRAIGHT_RAD) {
      // lined up: drive at the waypoint (the residual error is turned out as it goes)
      const dir = vnorm(vsub(wp, v.pos));
      v.pos = vadd(v.pos, vscale(dir, distTiles));
    } else {
      const fwd = { x: Math.sin(v.hullFacing), y: -Math.cos(v.hullFacing) };
      const next = vadd(v.pos, vscale(fwd, distTiles));
      const nt = tileAt(map, Math.floor(next.x), Math.floor(next.y));
      // never cut a corner into something a vehicle cannot enter: turn on the spot instead
      if (Number.isFinite(TERRAIN_PROPS[nt].vehicleCost)) v.pos = next; else v.speed = 0;
    }

    if (props.crushable) crushTile(map, tx, ty);
    treeCrushByVehicle(map, tx, ty, def.lengthM);
    stepOverrun(state, rng, v, angleTo(v.pos, wp));
  }

}

/** One step of a wheel-steered vehicle along its route. It cannot pivot: heading changes only at
 * speed / turning radius. Small errors: it drives at the waypoint while steering; larger ones: it
 * drives an arc along its own heading at 40% speed; facing the wrong way: it backs up with the
 * wheels locked over (K-turn) until roughly lined up. Returns true when it moved. */
function stepWheeledDrive(state: BattleState, rng: Rng, dt: number, v: Vehicle, def: VehicleDef, wp: Vec2, desired: number, fullSpeedMs: number): boolean {
  const map = state.map;
  const err = wrapAngle(desired - v.hullFacing);
  const absErr = Math.abs(err);
  if (absErr > K_TURN_RAD) kTurning.add(v);
  else if (absErr < K_TURN_DONE_RAD) kTurning.delete(v);
  const backing = kTurning.has(v);
  const speedMs = fullSpeedMs * (backing ? K_TURN_SPEED_MUL : absErr > HEADING_ALIGN_RAD ? SHARP_TURN_SPEED_MUL : 1);
  if (speedMs <= 0) { v.speed = 0; return false; }
  turnHull(state, v, def, desired, dt, speedMs);
  v.hullFacing = wrapAngle(v.hullFacing + trackPullRad(v) * dt);
  const stepTiles = (speedMs * dt) / TILE_M;
  const d = dist(v.pos, wp);
  // close enough to a waypoint that is not the last: on to the next (an arc never hits it exactly)
  const reach = v.path.length > 1 ? Math.max(stepTiles, 1.5) : stepTiles;
  if (!backing && (d <= reach || d < 1e-4)) {
    if (v.path.length === 1) v.pos = { x: wp.x, y: wp.y };
    v.path.shift();
    v.speed = speedMs;
    return true;
  }
  let next: Vec2;
  if (backing || absErr > HEADING_ALIGN_RAD) {
    const sign = backing ? -1 : 1;
    next = { x: v.pos.x + Math.sin(v.hullFacing) * stepTiles * sign, y: v.pos.y - Math.cos(v.hullFacing) * stepTiles * sign };
    const ntx = Math.floor(next.x), nty = Math.floor(next.y);
    if (!inBounds(map, ntx, nty) || !isPassable(map, ntx, nty, 'vehicle')) {
      // no room for the manoeuvre: shuffle toward the waypoint at a crawl instead
      next = vadd(v.pos, vscale(vnorm(vsub(wp, v.pos)), Math.min(d, stepTiles * 0.5)));
    }
  } else {
    next = vadd(v.pos, vscale(vnorm(vsub(wp, v.pos)), Math.min(d, stepTiles)));
  }
  v.pos = next;
  v.speed = backing ? -speedMs : speedMs;
  stepOverrun(state, rng, v, backing ? wrapAngle(v.hullFacing + Math.PI) : v.hullFacing);
  return true;
}

// ------------------------------------------------------------------ overrun (spec 2026-09-17 §7)
/** A vehicle slower than this (m/s) runs nobody down. */
export const OVERRUN_MIN_SPEED_MS = 0.5;
/** Chance that a man who can react gets out of the way: green / regular / veteran. */
export const OVERRUN_DODGE = { green: 0.7, regular: 0.85, veteran: 0.95 };
export const OVERRUN_WITNESS_M = 15;
const OVERRUN_DODGE_STRESS = 30;
const OVERRUN_WITNESS_STRESS = 15;
const OVERRUN_MSG_EVERY_S = 5;
const overrunMsgAt = new WeakMap<BattleState, number>();
/** Rate-limited 'our men in the way' message, per vehicle. */
const haltMsgAt = new WeakMap<Vehicle, number>();
/** First time each soldier was seen blocking a held vehicle: past STUCK_S he is nudged aside. */
const stuckSince = new WeakMap<Soldier, number>();
/** Last lookahead dodge roll per soldier: re-rolling every tick would let any man ahead of the
 * hull dodge almost surely before the vehicle arrives, so an enemy is asked at most every 1.5 s. */
const lookaheadRollAt = new WeakMap<Soldier, number>();
const HALT_MSG_EVERY_S = 10;
const STUCK_S = 5;

/** Position of `p` in the hull frame of `v`, metres: x to the right, y ahead along `dirRad`. */
function hullLocalM(v: Vehicle, dirRad: number, p: Vec2): { x: number; y: number } {
  const dx = (p.x - v.pos.x) * TILE_M, dy = (p.y - v.pos.y) * TILE_M;
  const fx = Math.sin(dirRad), fy = -Math.cos(dirRad);
  return { x: dx * -fy + dy * fx, y: dx * fx + dy * fy };
}


export function overrunDodgeChance(s: Soldier): number {
  return s.experience < 40 ? OVERRUN_DODGE.green : s.experience >= 70 ? OVERRUN_DODGE.veteran : OVERRUN_DODGE.regular;
}


/** Standing or crouched, unhurt and not pinned, stunned, dazed or cowering: he can throw himself aside. */
export function canReactToOverrun(state: BattleState, s: Soldier): boolean {
  if (s.health !== 'healthy' || s.stance === 'prone') return false;
  if (s.stunnedUntil != null && state.time < s.stunnedUntil) return false;
  if (isDazed(s, state.time)) return false; // reeling from a blast: he does not see it coming
  if (s.activity === 'pinned' || s.activity === 'cowering' || s.activity === 'surrendered') return false;
  return s.mind.state !== 'pinned' && s.mind.state !== 'cowering';
}


/** Nearest free spot beside the hull (the side he is already on first), tile coords, or null. */
function dodgeSpot(state: BattleState, v: Vehicle, dirRad: number, s: Soldier, halfWidthM: number): Vec2 | null {
  const local = hullLocalM(v, dirRad, s.pos);
  const fx = Math.sin(dirRad), fy = -Math.cos(dirRad);
  const rx = -fy, ry = fx; // hull right
  const first = local.x >= 0 ? 1 : -1;
  for (const side of [first, -first]) {
    const lateralM = side * (halfWidthM + 1.0) - local.x;
    const spot = { x: s.pos.x + (rx * lateralM) / TILE_M, y: s.pos.y + (ry * lateralM) / TILE_M };
    const tx = Math.floor(spot.x), ty = Math.floor(spot.y);
    if (inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry')) return spot;
  }
  return null;
}


function runDown(state: BattleState, v: Vehicle, dirRad: number, s: Soldier): void {
  const wasAlive = s.health !== 'dead';
  const wasCounted = s.health === 'dead' || s.health === 'incapacitated';
  s.health = 'dead';
  s.activity = 'dead';
  s.stance = 'prone';
  s.path = [];
  s.crewTask = undefined;
  s.blast = undefined;
  s.crushed = { dir: dirRad, time: state.time };
  if (!wasAlive) return; // a body already lying there is only pressed into the ground
  state.bloodDecals.push({ ...s.pos });
  state.events.push({ kind: 'kill', pos: { ...s.pos }, side: v.side });
  if (!wasCounted) {
    state.sides[v.side].kills++;
    state.sides[s.side].losses++;
    const killerTeam = state.teams.get(v.teamId);
    if (killerTeam) killerTeam.kills++;
  }
  // everyone of his side who sees it within 15 m (spec §7)
  for (const o of state.soldiers.values()) {
    if (o.side !== s.side || o.id === s.id || o.health === 'dead' || o.health === 'incapacitated' || o.vehicleId != null) continue;
    if (dist(o.pos, s.pos) * TILE_M > OVERRUN_WITNESS_M || !hasLOS(state.map, o.pos, s.pos)) continue;
    addStress(o.mind, OVERRUN_WITNESS_STRESS);
  }
  const last = overrunMsgAt.get(state) ?? -1e9;
  if (state.time - last >= OVERRUN_MSG_EVERY_S) {
    overrunMsgAt.set(state, state.time);
    const team = state.teams.get(s.teamId);
    if (s.side === state.config.playerSide) addMessage(state, `${team?.name ?? 'Report'}\n${s.rank}. ${s.name} was run down.`, 'bad');
    else addMessage(state, `${state.teams.get(v.teamId)?.name ?? 'Report'}\nEnemy soldier run down.`, 'good');
  }
}

/** A vehicle moving faster than 0.5 m/s whose hull passes over a man: friends always step aside
 * (drivers avoid their own troops); one with nowhere to go makes the vehicle stop and wait —
 * v.holdUntil is set, the man is re-prompted to dodge, and after 5 s stuck he is nudged to the
 * nearest free tile (never killed). An enemy who can react dodges with probability 0.85 (green
 * 0.7, veteran 0.95) and takes a large stress spike; one who cannot, or who fails, is killed and
 * left crushed in the vehicle's direction of travel. Seeded rng only. */
export function stepOverrun(state: BattleState, rng: Rng, v: Vehicle, dirRad: number): void {
  if (Math.abs(v.speed) <= OVERRUN_MIN_SPEED_MS) return;
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return;
  const halfW = def.widthM / 2, halfL = def.lengthM / 2;
  const reach = (Math.hypot(halfW, halfL) + 0.5) / TILE_M;
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null) continue;
    if (Math.abs(s.pos.x - v.pos.x) > reach || Math.abs(s.pos.y - v.pos.y) > reach) continue;
    const local = hullLocalM(v, dirRad, s.pos);
    if (Math.abs(local.x) > halfW || Math.abs(local.y) > halfL) continue;
    if (s.health === 'dead') { if (!s.crushed) runDown(state, v, dirRad, s); continue; }
    if (s.dodgeUntil != null && state.time < s.dodgeUntil) continue;
    const friendly = s.side === v.side;
    const spot = dodgeSpot(state, v, dirRad, s, halfW);
    const dodges = !!spot && (friendly || (canReactToOverrun(state, s) && rng.chance(overrunDodgeChance(s))));
    if (!dodges) {
      if (friendly) { holdForFriendly(state, v, s); continue; } // nowhere to go: the driver waits
      runDown(state, v, dirRad, s);
      continue;
    }
    if (s.health === 'incapacitated') { s.pos = spot!; continue; } // dragged clear by his comrades
    s.path = [spot!, ...s.path];
    s.dodgeUntil = state.time + 1.2;
    if (!friendly) addStress(s.mind, OVERRUN_DODGE_STRESS);
  }
}



/** A friendly under the hull with no dodge spot: stop the vehicle, re-prompt him once per second,
 * warn once per 10 s; if he is still stuck after 5 s, nudge him to the nearest free tile (he is
 * NEVER run down). */
function holdForFriendly(state: BattleState, v: Vehicle, s: Soldier): void {
  v.holdUntil = state.time + 0.5;
  if (state.time - (stuckSince.get(s) ?? -1e9) > 1) {
    stuckSince.set(s, state.time);
    addStress(s.mind, OVERRUN_DODGE_STRESS);
  }
  if (state.time - (haltMsgAt.get(v) ?? -1e9) >= HALT_MSG_EVERY_S) {
    haltMsgAt.set(v, state.time);
    const team = state.teams.get(v.teamId);
    addMessage(state, `${team?.name ?? 'Report'}\nWe can't advance — our men in the way.`, 'info');
  }
  const first = stuckSince.get(s);
  if (first != null && state.time - first >= STUCK_S) {
    stuckSince.delete(s);
    const spot = nearestFreeTile(state, s.pos);
    if (spot) { s.pos = spot; s.dodgeUntil = state.time + 1.2; }
  }
}



/** Nearest passable infantry tile adjacent to `p` (8-neighbourhood), or null. */
function nearestFreeTile(state: BattleState, p: Vec2): Vec2 | null {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const tx = Math.floor(p.x) + dx, ty = Math.floor(p.y) + dy;
    if (inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry')) return { x: tx + 0.5, y: ty + 0.5 };
  }
  return null;
}

/** Early dodge: before the vehicle moves, any man on the road AHEAD of the hull — within
 * (lengthM * 1.5 + 2) m along the heading, inside the hull's width corridor — is told to step
 * aside now, so the driver never arrives at a man who has not yet started moving. */
function stepOverrunLookahead(state: BattleState, rng: Rng, v: Vehicle, def: VehicleDef): void {
  if (Math.abs(v.speed) <= OVERRUN_MIN_SPEED_MS) return;
  const dirRad = angleTo(v.pos, v.path[0]);
  const halfW = def.widthM / 2;
  const aheadTiles = (def.lengthM * 1.5 + 2) / TILE_M;
  const fx = Math.sin(dirRad), fy = -Math.cos(dirRad);
  const reach = (Math.hypot(halfW, def.lengthM / 2) + aheadTiles) * 1.5;
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null || s.health !== 'healthy') continue;
    if (s.side === v.side) continue; // friends are handled by the hull-local hold rule
    if (s.dodgeUntil != null && state.time < s.dodgeUntil) continue;
    if (Math.abs(s.pos.x - v.pos.x) > reach || Math.abs(s.pos.y - v.pos.y) > reach) continue;
    const along = (s.pos.x - v.pos.x) * fx + (s.pos.y - v.pos.y) * fy;
    const lateral = Math.abs((s.pos.x - v.pos.x) * -fy + (s.pos.y - v.pos.y) * fx);
    if (along < 0 || along > aheadTiles || lateral > halfW + 0.5) continue;
    if (!canReactToOverrun(state, s)) continue;
    if (state.time - (lookaheadRollAt.get(s) ?? -1e9) < 1.5) continue;
    lookaheadRollAt.set(s, state.time);
    const spot = dodgeSpot(state, v, dirRad, s, halfW);
    if (!spot || !rng.chance(overrunDodgeChance(s))) continue;
    s.path = [spot, ...s.path];
    s.dodgeUntil = state.time + 1.2;
    addStress(s.mind, OVERRUN_DODGE_STRESS);
  }
}
