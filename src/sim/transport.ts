// Infantry riding in transports (the SdKfz 251): a Move order onto a friendly transport with room
// is a mount order; the men walk to the rear door and board ONE AT A TIME; the vehicle stands
// still while anyone boards or leaves; mounted men are `vehicleId` + `seat: 'passenger'` (never
// crew); any order to the riding team, a Dismount order to the transport, or the vehicle being
// lost unloads them through the door (a lost vehicle: over the sides as well). Deterministic.
import type { BattleState, HatchClimb, Order, Soldier, Team, Vec2, Vehicle, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { inBounds } from './map';
import { findPath, isPassable } from './path';
import { addMessage } from './messages';
import { addStress } from './mind';
import { settleTile } from './coverSeek';
import { vehicleLayout } from './vehicleDamage';
import { BESIDE_HULL_M, besideHatch, hullToWorld } from './vehicleCrew';
import { isDazed } from './daze';

/** Seconds one man needs through the door (a squad of ten: about 15 s). */
export const BOARD_S = 1.5;
/** A man this close to the door spot (tiles) steps in when the door is free. */
const DOOR_REACH_TILES = 0.9;
/** The transport does not wait for stragglers longer than this. */
export const WAIT_MAX_S = 45;
/** A Move order ending this close to a transport (m, beyond half its length) means "get in". */
export const MOUNT_ORDER_RADIUS_M = 2.5;
/** Passengers firing over the sides of a halted transport. */
export const PASSENGER_FIRE_MUL = 0.4;
/** A shooter this much higher (m), this close (m), sees into an open compartment. */
export const LOOK_IN_HEIGHT_M = 3;
export const LOOK_IN_RANGE_M = 60;

const isAble = (s: Soldier | undefined): s is Soldier => !!s && s.health !== 'dead' && s.health !== 'incapacitated';
const usable = (v: Vehicle): boolean => v.state === 'ok' || v.state === 'immobilized';

export function passengerCapacity(v: Vehicle): number { return VEHICLE_DEFS[v.defId]?.passengers ?? 0; }

/** Everyone riding (able or not: a body still takes its place). */
export function passengersAboard(state: BattleState, v: Vehicle): Soldier[] {
  const out: Soldier[] = [];
  for (const id of v.passengerIds ?? []) { const s = state.soldiers.get(id); if (s && s.vehicleId === v.id && s.seat === 'passenger') out.push(s); }
  return out;
}

function climbingIn(state: BattleState, v: Vehicle): number {
  let n = 0;
  for (const s of state.soldiers.values()) if (s.hatch && s.hatch.passenger && s.hatch.kind === 'mount' && s.hatch.vehicleId === v.id) n++;
  return n;
}

export function roomLeft(state: BattleState, v: Vehicle): number {
  return Math.max(0, passengerCapacity(v) - passengersAboard(state, v).length - climbingIn(state, v));
}

/** Infantry, and crew-served teams that can carry their weapon (MG, mortar): yes. AT guns, vehicle
 * crews: no. */
export function canTeamMount(team: Team): boolean {
  if (team.vehicleId != null || team.outOfAction) return false;
  if (team.type === 'atgun') return false;
  const cw = team.crewWeapon;
  return !(cw && WEAPONS[cw.weaponId]?.cls === 'atgun');
}

/** The friendly transport a Move order onto `pos` means, or null. */
export function transportAt(state: BattleState, team: Team, pos: Vec2): Vehicle | null {
  let best: Vehicle | null = null, bestD = Infinity;
  for (const v of state.vehicles.values()) {
    if (v.side !== team.side || !usable(v) || passengerCapacity(v) <= 0) continue;
    const def = VEHICLE_DEFS[v.defId];
    const d = dist(pos, v.pos) * TILE_M;
    if (d > def.lengthM / 2 + MOUNT_ORDER_RADIUS_M || d >= bestD) continue;
    best = v; bestD = d;
  }
  return best;
}

/** Where the men queue: on the ground behind the rear door (tile coords). */
export function doorSpot(state: BattleState, v: Vehicle, def: VehicleDef): Vec2 {
  const door = vehicleLayout(def).doors[0];
  if (!door) return { ...v.pos };
  const p = hullToWorld(v, door.x, -(def.lengthM / 2 + BESIDE_HULL_M));
  const tx = Math.floor(p.x), ty = Math.floor(p.y);
  if (inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry')) return p;
  return besideHatch(state, v, def, 0);
}
function doorOnHull(v: Vehicle, def: VehicleDef): Vec2 {
  const door = vehicleLayout(def).doors[0];
  return door ? hullToWorld(v, door.x, door.y + 0.9) : { ...v.pos };
}

function teamAboard(state: BattleState, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (s && s.seat === 'passenger' && s.vehicleId != null) out.push(s); }
  return out;
}

/** Called by applyOrder before anything else. Turns a Move / Move Fast order onto a friendly
 * transport into a mount order (the target becomes the door), and unloads a riding team that is
 * ordered to do anything else. Returns 'handled' when applyOrder has nothing more to do. */
export function transportOrderHook(state: BattleState, team: Team, order: Order): 'handled' | null {
  // the transport itself: Dismount
  if (team.vehicleId != null) {
    if (!order.dismount) return null;
    const v = state.vehicles.get(team.vehicleId);
    if (v && passengersAboard(state, v).length > 0) startUnload(state, v, false);
    return 'handled';
  }
  const moveLike = order.type === 'move' || order.type === 'moveFast';
  let v: Vehicle | null = null;
  if (moveLike && canTeamMount(team)) {
    v = order.mountVehicleId != null ? state.vehicles.get(order.mountVehicleId) ?? null : transportAt(state, team, order.target);
    if (v && (v.side !== team.side || !usable(v) || passengerCapacity(v) <= 0)) v = null;
    if (v && roomLeft(state, v) <= 0 && team.transportId !== v.id) v = null;
  }
  const riding = teamAboard(state, team);
  if (v) {
    order.mountVehicleId = v.id;
    order.target = doorSpot(state, v, VEHICLE_DEFS[v.defId]);
    delete order.waypoints;
    if (team.transportId != null && team.transportId !== v.id && riding.length > 0) {
      const old = state.vehicles.get(team.transportId);
      if (old) startUnload(state, old, false, team.id);
    }
    team.transportId = v.id;
    return null;
  }
  delete order.mountVehicleId;
  if (riding.length > 0 && team.transportId != null) {
    // any other order: out they get, and then they carry it out
    const tv = state.vehicles.get(team.transportId);
    if (tv) startUnload(state, tv, false, team.id);
  } else if (team.transportId != null) team.transportId = undefined;
  return null;
}

export function startUnload(state: BattleState, v: Vehicle, panicked: boolean, teamId?: number): void {
  if (v.unloading) {
    v.unloading.panicked = v.unloading.panicked || panicked;
    if (teamId == null || v.unloading.teamId !== teamId) v.unloading.teamId = undefined;
    return;
  }
  v.unloading = { panicked, startedAt: state.time, teamId };
  const name = VEHICLE_DEFS[v.defId]?.name ?? 'Vehicle';
  if (v.side === state.config.playerSide && !panicked) addMessage(state, `${name}\nPassengers dismounting.`, 'info');
}

function threatDirFor(state: BattleState, v: Vehicle, s: Soldier): number | null {
  if (s.mind.threatDir != null) return s.mind.threatDir;
  const crewTeam = state.teams.get(v.teamId);
  if (crewTeam) for (const id of crewTeam.soldierIds) { const c = state.soldiers.get(id); if (c && c.mind.threatDir != null) return c.mind.threatDir; }
  let best: Vec2 | null = null, bd = Infinity;
  for (const id of state.spotted[v.side]) { const e = state.soldiers.get(id); if (!e || !isAble(e)) continue; const d = dist(e.pos, v.pos); if (d < bd) { bd = d; best = e.pos; } }
  for (const id of state.spottedVehicles[v.side]) { const e = state.vehicles.get(id); if (!e) continue; const d = dist(e.pos, v.pos); if (d < bd) { bd = d; best = e.pos; } }
  return best ? angleTo(v.pos, best) : null;
}

function stepUnload(state: BattleState, v: Vehicle, def: VehicleDef): void {
  const un = v.unloading;
  if (!un) return;
  const waiting = passengersAboard(state, v).filter((s) => isAble(s) && (un.teamId == null || s.teamId === un.teamId));
  if (waiting.length === 0) { v.unloading = undefined; return; }
  if (Math.abs(v.speed) > 0.05) return; // it stops first (stepVehicles holds it)
  const lay = vehicleLayout(def);
  const exits: { door: boolean; index: number; busyUntil: number }[] = [{ door: true, index: 0, busyUntil: v.doorBusyUntil ?? 0 }];
  if (un.panicked) lay.hatches.forEach((h, i) => { if (h.group === 'side') exits.push({ door: false, index: i, busyUntil: v.hatchBusyUntil?.[i] ?? 0 }); });
  for (const ex of exits) {
    if (ex.busyUntil > state.time) continue;
    const s = waiting.shift();
    if (!s) break;
    const dur = BOARD_S * (un.panicked ? 0.7 : 1) * (s.health === 'wounded' ? 1.5 : 1);
    const from = ex.door ? doorOnHull(v, def) : hullToWorld(v, lay.hatches[ex.index].x * 0.6, lay.hatches[ex.index].y);
    const to = ex.door ? doorSpot(state, v, def) : besideHatch(state, v, def, ex.index);
    const climb: HatchClimb = { vehicleId: v.id, hatch: ex.index, kind: 'bailout', from, to, start: state.time, until: state.time + dur, panicked: un.panicked, passenger: true, overSide: !ex.door };
    if (ex.door) v.doorBusyUntil = climb.until; else (v.hatchBusyUntil ??= [])[ex.index] = climb.until;
    s.vehicleId = null;
    s.seat = undefined;
    s.hatch = climb;
    s.pos = { ...from };
    s.path = [];
    s.stance = 'standing';
    s.cover = 0;
    if (un.panicked) { s.activity = 'panicked'; s.mind.state = 'panicked'; s.mind.stateSince = state.time; addStress(s.mind, 30); }
  }
  v.passengerIds = (v.passengerIds ?? []).filter((id) => { const p = state.soldiers.get(id); return !!p && p.vehicleId === v.id; });
}

/** Climb finished (called by vehicleCrew.stepClimbs): a passenger is aboard. */
export function onPassengerBoarded(state: BattleState, v: Vehicle, s: Soldier): void {
  if (!usable(v) || passengersAboard(state, v).length >= passengerCapacity(v)) { s.activity = 'defending'; s.stance = 'crouching'; return; }
  s.vehicleId = v.id;
  s.seat = 'passenger';
  s.pos = { ...v.pos };
  s.path = [];
  s.activity = 'idle';
  s.stance = 'crouching';
  s.suppression = 0;
  (v.passengerIds ??= []).push(s.id);
}

/** Climb finished: a passenger is on the ground behind the transport. An orderly dismount fans out
 * to cover behind/beside the vehicle, away from what they know of the enemy (or sets off on the
 * team's order). */
export function onPassengerOut(state: BattleState, v: Vehicle, s: Soldier, panicked: boolean): void {
  if (panicked) return; // vehicleCrew gives him his run
  const team = state.teams.get(s.teamId);
  const def = VEHICLE_DEFS[v.defId];
  s.stance = 'crouching';
  const order = team?.order;
  if (team && order && !order.mountVehicleId && (order.type === 'move' || order.type === 'moveFast' || order.type === 'sneak')) {
    const dest = { x: order.target.x + s.formationOffset.x, y: order.target.y + s.formationOffset.y };
    s.path = findPath(state.map, s.pos, dest, 'infantry');
    s.activity = order.type === 'moveFast' ? 'movingFast' : order.type === 'sneak' ? 'sneaking' : 'moving';
    s.stance = order.type === 'sneak' ? 'prone' : 'standing';
    return;
  }
  const threat = threatDirFor(state, v, s);
  const away = threat != null ? threat + Math.PI : v.hullFacing + Math.PI;
  const idx = team ? Math.max(0, team.soldierIds.indexOf(s.id)) : 0;
  const lateral = ((idx % 5) - 2) * 1.6;
  const back = (def?.lengthM ?? 6) / 2 + 2 + Math.floor(idx / 5) * 1.8;
  const ax = Math.sin(away), ay = -Math.cos(away);
  const slot = { x: v.pos.x + (ax * back + -ay * lateral) / TILE_M, y: v.pos.y + (ay * back + ax * lateral) / TILE_M };
  const taken = (tx: number, ty: number): boolean => {
    if (!team) return false;
    for (const id of team.soldierIds) {
      if (id === s.id) continue;
      const o = state.soldiers.get(id);
      const end = o && o.path.length > 0 ? o.path[o.path.length - 1] : o?.vehicleId == null ? o?.pos : undefined;
      if (end && Math.floor(end.x) === tx && Math.floor(end.y) === ty) return true;
    }
    return false;
  };
  const tile = settleTile(state, s, slot, threat ?? v.hullFacing, 3, taken) ?? slot;
  s.path = findPath(state.map, s.pos, tile, 'infantry');
  s.activity = s.path.length > 0 ? 'moving' : 'defending';
  s.mind.anchor = { x: tile.x, y: tile.y };
}

function straightLineClear(state: BattleState, a: Vec2, b: Vec2): boolean {
  const n = Math.max(2, Math.ceil(dist(a, b) * 2));
  for (let k = 1; k <= n; k++) {
    const x = Math.floor(a.x + ((b.x - a.x) * k) / n), y = Math.floor(a.y + ((b.y - a.y) * k) / n);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'infantry')) return false;
  }
  return true;
}

function walkTo(state: BattleState, s: Soldier, spot: Vec2, fast: boolean): void {
  const end = s.path.length > 0 ? s.path[s.path.length - 1] : null;
  if (!end || dist(end, spot) > 0.3) {
    // straight there when the ground allows: men funnelled through the same tile centres jam
    if (straightLineClear(state, s.pos, spot)) s.path = [{ ...spot }];
    else {
      s.path = findPath(state.map, s.pos, spot, 'infantry');
      if (s.path.length === 0 || dist(s.path[s.path.length - 1], spot) > 0.05) s.path.push({ ...spot });
    }
  }
  if (s.activity !== 'moving' && s.activity !== 'movingFast') s.activity = fast ? 'movingFast' : 'moving';
  s.stance = 'standing';
  s.mind.anchor = null;
}

const SEVERE = new Set(['pinned', 'cowering', 'panicked', 'broken', 'berserk']);
function canBoard(state: BattleState, s: Soldier): boolean {
  if (!isAble(s) || s.vehicleId != null || s.hatch || s.activity === 'surrendered') return false;
  if (s.stunnedUntil != null && state.time < s.stunnedUntil) return false;
  if (isDazed(s, state.time)) return false; // dazed by a blast: in no state to climb aboard
  return !SEVERE.has(s.mind.state);
}

function stepBoarding(state: BattleState, team: Team, v: Vehicle, def: VehicleDef): void {
  const order = team.order;
  if (!order || order.mountVehicleId !== v.id) return;
  if (!usable(v) || v.unloading || v.exiting) { order.mountVehicleId = undefined; if (teamAboard(state, team).length === 0) team.transportId = undefined; return; }
  const cw = team.crewWeapon;
  const packed = !cw || cw.phase === 'packed';
  const spot = doorSpot(state, v, def);
  const still = Math.abs(v.speed) <= 0.05;
  let outside = 0;
  let place = 0; // his place in the queue behind the door
  const fx = Math.sin(v.hullFacing), fy = -Math.cos(v.hullFacing);
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || !isAble(s) || s.vehicleId != null) continue;
    if (s.hatch) { outside++; continue; }
    if (!canBoard(state, s)) continue;
    if (cw?.mountBlocked && cw.gunnerId === s.id) { outside++; continue; }
    if (roomLeft(state, v) <= 0) { if (s.path.length > 0 && dist(s.path[s.path.length - 1], spot) < 1) { s.path = []; s.activity = 'defending'; s.stance = 'crouching'; } continue; }
    outside++;
    if (!packed) continue; // the move order is packing the weapon first (crewWeapon.ts)
    const d = dist(s.pos, spot);
    if (still && d <= DOOR_REACH_TILES && (v.doorBusyUntil ?? 0) <= state.time) {
      const dur = BOARD_S * (s.health === 'wounded' ? 1.5 : 1);
      s.hatch = { vehicleId: v.id, hatch: 0, kind: 'mount', from: { ...s.pos }, to: doorOnHull(v, def), start: state.time, until: state.time + dur, panicked: false, passenger: true };
      v.doorBusyUntil = s.hatch.until;
      s.path = [];
      s.activity = 'idle';
      continue;
    }
    // the queue: a file behind the door, the next man at the door itself
    const k = place++;
    const side = k === 0 ? 0 : k % 2 === 1 ? 0.3 : -0.3;
    const slot = { x: spot.x - fx * 0.55 * k + -fy * side, y: spot.y - fy * 0.55 * k + fx * side };
    if (dist(s.pos, slot) <= 0.25) { s.path = []; s.activity = 'idle'; s.stance = 'crouching'; continue; } // waits his turn
    walkTo(state, s, slot, order.type === 'moveFast');
  }
  if (outside === 0) {
    // everyone who could get in is in (the rest follow on foot)
    team.order = null;
    v.waitingSince = undefined;
  }
}

/** The part of a riding team that found no room keeps up on foot. */
function stepFollowers(state: BattleState, team: Team, v: Vehicle, tick: boolean): void {
  if (!tick || team.order || teamAboard(state, team).length === 0) return;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || !canBoard(state, s)) continue;
    if (dist(s.pos, v.pos) * TILE_M > 12) walkTo(state, s, { ...v.pos }, Math.abs(v.speed) > 2);
    else if (s.path.length > 0 && dist(s.path[s.path.length - 1], v.pos) < 1) { s.path = []; s.activity = 'defending'; }
  }
}

/** True while the transport must stand still: someone is on the door, it is unloading, or men
 * ordered aboard are still on their way (for at most WAIT_MAX_S). */
export function transportHolds(state: BattleState, v: Vehicle): boolean {
  if (passengerCapacity(v) <= 0) return false;
  if (v.unloading) return true;
  let boarding = false;
  for (const team of state.teams.values()) {
    if (team.transportId !== v.id) continue;
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s) continue;
      if (s.hatch && s.hatch.passenger && s.hatch.vehicleId === v.id) return true;
      if (team.order?.mountVehicleId === v.id && canBoard(state, s) && roomLeft(state, v) > 0) boarding = true;
    }
  }
  if (!boarding) { v.waitingSince = undefined; return false; }
  if (v.waitingSince == null) {
    v.waitingSince = state.time;
    if (v.path.length > 0 && v.side === state.config.playerSide) addMessage(state, `${VEHICLE_DEFS[v.defId]?.name ?? 'Vehicle'}\nWaiting for passengers.`, 'info');
  }
  return state.time - v.waitingSince < WAIT_MAX_S;
}

/** Team-box word of a team that is boarding, riding or getting out, or null. */
export function transportWord(state: BattleState, team: Team): 'Mounting' | 'Mounted' | 'Dismounting' | null {
  if (team.transportId == null) return null;
  const v = state.vehicles.get(team.transportId);
  if (!v) return null;
  let aboard = 0, leaving = 0;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || !isAble(s)) continue;
    if (s.seat === 'passenger' && s.vehicleId === v.id) aboard++;
    if (s.hatch?.passenger && s.hatch.kind === 'bailout') leaving++;
  }
  if (leaving > 0 || (v.unloading && aboard > 0)) return 'Dismounting';
  if (team.order?.mountVehicleId === v.id) return 'Mounting';
  return aboard > 0 ? 'Mounted' : null;
}

/** A hit on a loaded transport is a shock to everyone aboard. */
export function stressPassengers(state: BattleState, v: Vehicle, amount: number): void {
  for (const s of passengersAboard(state, v)) if (isAble(s)) addStress(s.mind, amount * (1.4 - s.experience / 100));
}

/** Per sim step (from stepVehicles): unloading, boarding, followers, lost vehicles. */
export function stepTransport(state: BattleState, dt: number): void {
  const tick = Math.floor(state.time / 2) !== Math.floor((state.time - dt) / 2);
  for (const v of state.vehicles.values()) {
    if (passengerCapacity(v) <= 0) continue;
    const def = VEHICLE_DEFS[v.defId];
    if (!def) continue;
    if (!usable(v) && !v.unloading && passengersAboard(state, v).some(isAble)) startUnload(state, v, true);
    else if (!usable(v) && v.unloading && !v.unloading.panicked) { v.unloading.panicked = true; v.unloading.teamId = undefined; }
    stepUnload(state, v, def);
  }
  for (const team of state.teams.values()) {
    if (team.transportId == null) continue;
    const v = state.vehicles.get(team.transportId);
    const def = v ? VEHICLE_DEFS[v.defId] : undefined;
    if (!v || !def) { team.transportId = undefined; continue; }
    stepBoarding(state, team, v, def);
    stepFollowers(state, team, v, tick);
    if (team.order?.mountVehicleId !== v.id && teamAboard(state, team).length === 0) {
      let climbing = false;
      for (const id of team.soldierIds) if (state.soldiers.get(id)?.hatch?.passenger) climbing = true;
      if (!climbing) team.transportId = undefined;
    }
  }
}
