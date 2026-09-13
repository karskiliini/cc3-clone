import type { BattleState, Soldier, Team, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist, turnTowards, vadd, vnorm, vscale, vsub, wrapAngle } from '@/shared/math';
import { idx, inBounds, setTile, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { hasLOS, losTrace } from './los';
import { isPassable } from './path';
import { addStress, addOrMergeBelief } from './mind';
import { expectedPenetrationChance } from './ballistics';
import { addMessage } from './messages';

const HEADING_ALIGN_RAD = 0.35;
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

interface ArmorThreat { pos: Vec2; distM: number; weapon: WeaponDef; theirArmor: number | null }

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
    out.push({ pos: { ...ev.pos }, distM, weapon, theirArmor: edef.armor.front });
  }
  for (const id of state.spotted[v.side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (!w || (w.cls !== 'atgun' && w.cls !== 'atrocket' && w.cls !== 'atrifle')) continue;
    const distM = dist(v.pos, s.pos) * TILE_M;
    if (distM > 400) continue;
    out.push({ pos: { ...s.pos }, distM, weapon: w, theirArmor: null });
  }
  return out;
}

interface ReverseTrack { target: Vec2 | null; fleeingSince: number | null; cooldownUntil: number }
const reverseTracks = new WeakMap<BattleState, Map<number, ReverseTrack>>();
function getReverseTrack(state: BattleState, vehicleId: number): ReverseTrack {
  let m = reverseTracks.get(state);
  if (!m) { m = new Map(); reverseTracks.set(state, m); }
  let t = m.get(vehicleId);
  if (!t) { t = { target: null, fleeingSince: null, cooldownUntil: -Infinity }; m.set(vehicleId, t); }
  return t;
}

/** Cover for a vehicle (spec §10): a tile within 12 tiles whose LOS toward the threat is blocked,
 * within 4 tiles, by a building/stonewall/woods. */
const BLOCKING_TERRAIN = new Set(['buildingStone', 'buildingWood', 'stonewall', 'woods']);
function findVehicleCoverTile(state: BattleState, v: Vehicle, threatPos: Vec2): Vec2 | null {
  const map = state.map;
  const cx = Math.floor(v.pos.x), cy = Math.floor(v.pos.y);
  let best: Vec2 | null = null;
  let bestD = Infinity;
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
      const d = dist(v.pos, tile);
      if (d < bestD) { bestD = d; best = tile; }
    }
  }
  return best;
}

function stepOneVehicleMind(state: BattleState, rng: Rng, dt: number, v: Vehicle, team: Team, commander: Soldier): void {
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return;
  const mind = commander.mind;
  mind.threatLevel = Math.max(0, mind.threatLevel - 0.1 * dt);

  const threats = gatherArmorThreats(state, v);
  let top: ArmorThreat | null = null;
  let topDanger = 0;
  for (const th of threats) {
    const d = expectedPenetrationChance(th.weapon, th.distM, def.armor.front);
    if (d > topDanger || !top) { topDanger = d; top = th; }
  }
  // Belief-only threat (spec §10c): an unseen AT shooter that just sent a round past us. Danger is
  // estimated from the weapon that fired, so a near miss alone can start a reverse to cover.
  if (!top) {
    const nm = nearMisses.get(state)?.get(v.id);
    if (nm && state.time - nm.at <= NEAR_MISS_MEMORY_S) {
      const distM = dist(v.pos, nm.pos) * TILE_M;
      top = { pos: { ...nm.pos }, distM, weapon: nm.weapon, theirArmor: null };
      topDanger = expectedPenetrationChance(nm.weapon, distM, def.armor.front);
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
      const ourTwoShot = 1 - (1 - expectedPenetrationChance(ourWeapon, top.distM, top.theirArmor)) ** 2;
      const theirTwoShot = 1 - (1 - topDanger) ** 2;
      // "only seek cover when our two-shot kill chance against it is lower than its chance against us"
      shouldFlee = ourTwoShot < theirTwoShot;
    }
  }
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
    return;
  }

  if (v.state === 'immobilized') {
    // crew bails: vehicle abandoned, crew become panicked infantry (spec §10.2).
    v.state = 'abandoned';
    if (team.side === state.config.playerSide) addMessage(state, `${team.name}\nCrew bailing out!`, 'bad');
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      s.vehicleId = null;
      s.pos = { ...v.pos };
      s.activity = 'panicked';
      s.mind.state = 'panicked';
      s.path = [];
    }
    return;
  }

  if (!track.target) {
    track.target = findVehicleCoverTile(state, v, top.pos);
  }
  if (track.target) {
    driveReversing(state, dt, v, def.speedOffroadMs, def.turnRateRad, top.pos, track.target);
    if (dist(v.pos, track.target) < 0.5) track.target = null;
  }
}

function clamp01to100(x: number): number { return x < 0 ? 0 : x > 100 ? 100 : x; }

/** Reverses the vehicle toward `dest` while keeping its hull within 30 deg of `threatPos` (never
 * exposing the flank to a live AT threat), at 60% of forward speed (spec §10). */
function driveReversing(state: BattleState, dt: number, v: Vehicle, speedMs: number, turnRateRad: number, threatPos: Vec2, dest: Vec2): void {
  const desiredHull = angleTo(v.pos, threatPos);
  v.hullFacing = turnTowards(v.hullFacing, desiredHull, turnRateRad * dt);

  const towardDest = angleTo(v.pos, dest);
  // Reversing means the vehicle's rear (hullFacing + PI) leads toward dest; only reverse while the
  // hull stays within 30 deg of the threat, i.e. never turn away from it to chase a better reverse
  // heading — the vehicle simply backs up along whatever line the hull-toward-threat constraint allows.
  const hullFacesThreat = Math.abs(wrapAngle(v.hullFacing - desiredHull)) <= DEG30;
  if (!hullFacesThreat) { v.speed = 0; return; }

  const revSpeed = speedMs * 0.6;
  v.speed = revSpeed;
  const distTiles = (revSpeed * dt) / TILE_M;
  const dir = vnorm(vsub(dest, v.pos));
  const remaining = dist(v.pos, dest);
  if (remaining <= distTiles) v.pos = { ...dest };
  else v.pos = vadd(v.pos, vscale(dir, distTiles));
  void towardDest;
}

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

  for (const v of state.vehicles.values()) {
    if (v.state === 'burning') {
      v.burnTimer += dt;
      if (v.burnTimer >= BURN_TO_KO_S) v.state = 'knockedOut';
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

    if (def.hasTurret) {
      const turretTargetAngle = targetPos ? angleTo(v.pos, targetPos) : v.hullFacing;
      v.turretFacing = turnTowards(v.turretFacing, turretTargetAngle, def.turnRateRad * 2 * dt);
    } else {
      v.turretFacing = v.hullFacing;
    }

    if (isReversing) continue; // handled by stepVehicleMinds' driveReversing this same tick

    if (v.path.length === 0 || v.state === 'immobilized') {
      v.speed = 0;
      continue;
    }

    const wp = v.path[0];
    const desired = angleTo(v.pos, wp);
    v.hullFacing = turnTowards(v.hullFacing, desired, def.turnRateRad * dt);
    const aligned = Math.abs(wrapAngle(desired - v.hullFacing)) <= HEADING_ALIGN_RAD;

    if (!aligned) {
      v.speed = 0;
      continue;
    }

    const tx = Math.floor(v.pos.x), ty = Math.floor(v.pos.y);
    const tile = tileAt(map, tx, ty);
    const props = TERRAIN_PROPS[tile];
    const onRoad = tile === 'dirtroad' || tile === 'pavedroad' || tile === 'bridge';
    const baseSpeed = onRoad ? def.speedRoadMs : def.speedOffroadMs;
    const speedMs = onRoad ? baseSpeed : baseSpeed * props.speedMul;
    v.speed = speedMs;

    const distTiles = (speedMs * dt) / TILE_M;
    const d = dist(v.pos, wp);
    if (d <= distTiles || d < 1e-4) {
      v.pos = { x: wp.x, y: wp.y };
      v.path.shift();
    } else {
      const dir = vnorm(vsub(wp, v.pos));
      v.pos = vadd(v.pos, vscale(dir, distTiles));
    }

    if (props.crushable) {
      setTile(map, tx, ty, 'open');
      if (!map.dirtyTiles) map.dirtyTiles = [];
      map.dirtyTiles.push(idx(map, tx, ty));
    }
  }
}
