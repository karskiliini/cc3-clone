import {vehicleObserver} from './perception';
import {planningMap} from './navigationKnowledge';
/** Organic mortar mobility and light-gun towing. Every reservation and phase is canonical. */
import type { BattleState, Order, Soldier, Team, Vec2, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { Rng } from '@/shared/rng';
import { angleTo, dist, wrapAngle, turnTowards } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { findPath, isPassable } from './path';
import { crewWeaponView, isAbleCrewman, onCrewOrder, towLengthM } from './crewWeapon';
import { BOARD_S, doorSpot, roomLeft, startUnload, passengersAboard } from './transport';
import { crewEffects, isImmobile, seatOccupant } from './vehicleDamage';
import { rearHitch, canTowWeapon } from './vehicleTow';
import { applyOrder } from './orders';
import { addMessage } from './messages';

const alive = (s: Soldier | undefined): s is Soldier => !!s && s.health !== 'dead' && s.health !== 'incapacitated';
const crew = (state: BattleState, team: Team) => team.soldierIds.map(id => state.soldiers.get(id)).filter(alive);
const usable = (state: BattleState, v: Vehicle) => {
  const driver=seatOccupant(state,v,'driver');
  return v.state === 'ok' && !isImmobile(v) && crewEffects(state,v).canDrive
    && !['panicked','broken','routed','surrendered'].includes(driver?.mind.state ?? 'calm');
};
function reserved(state: BattleState, id: number, except: number): boolean {
  return [...state.teams.values()].some(t => t.id !== except && t.mobility?.vehicleIds.includes(id));
}
function access(state: BattleState, v: Vehicle): Vec2 { return doorSpot(state, v, VEHICLE_DEFS[v.defId]); }
function walk(state: BattleState, s: Soldier, target: Vec2): void {
  if (dist(s.pos, target) < 0.35) { s.path = []; s.activity = 'idle'; return; }
  if (!s.path.length || dist(s.path[s.path.length - 1], target) > 0.5) s.path = findPath(planningMap(state,s), s.pos, target, 'infantry');
  s.activity = 'moving'; s.stance = 'standing';
}
function vehicleRoute(state: BattleState, v: Vehicle, order: Order, slot: number): void {
  // Park behind the emplacement, in separate lateral slots, never on the weapon's destination.
  const dx = order.target.x - v.pos.x, dy = order.target.y - v.pos.y, length = Math.max(1, dm.hypot(dx, dy));
  const fx = dx / length, fy = dy / length;
  const points = [...(order.waypoints ?? []), order.target].map((p, i, all) => ({
    x: p.x - fy * slot * 3 - (i === all.length - 1 ? fx * 3 : 0),
    y: p.y + fx * slot * 3 - (i === all.length - 1 ? fy * 3 : 0),
  }));
  const route: Vec2[] = []; let from = v.pos;
  for (const p of points) {
    const leg = findPath(planningMap(state,vehicleObserver(state,v,'driver')), from, p, 'vehicle', 6000, undefined, { def: VEHICLE_DEFS[v.defId] });
    if (!leg.length && dist(from, p) > 0.5) { v.path = []; return; }
    route.push(...leg); from = p;
  }
  v.path = route;
  const team = state.teams.get(v.teamId);
  if (team) {
    team.order = { type: 'move', target: points[points.length - 1], issuedAt: state.time };
    for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (s && s.vehicleId === v.id && alive(s)) s.activity = 'moving'; }
  }
}

/** Called after ordinary order ingest, so the existing pack-up drill still owns the weapon. */
export function requestMotorizedCrew(state: BattleState, team: Team, order: Order): void {
  if (team.supportForTeamId != null) return;
  if (team.mobility) {
    const m = team.mobility;
    m.order = structuredClone(order);
    if (order.type === 'moveFast' && m.phase === 'driving') {
      m.vehicleIds.forEach((id, i) => { const v = state.vehicles.get(id); if (v) vehicleRoute(state, v, order, i); });
    } else if (order.type !== 'moveFast') { m.abort = true; m.phase = 'unloading'; }
    return;
  }
  if (order.type !== 'moveFast' || team.vehicleId != null) return;
  const cw = team.crewWeapon ?? crewWeaponView(state, team);
  if (!cw || cw.destroyed) return;
  const tow = team.type === 'atgun' || team.type === 'rocket';
  if (!tow && team.type !== 'mortar') return;
  let vehicles: Vehicle[];
  if (tow) {
    vehicles = [...state.vehicles.values()].filter(v => v.side === team.side && usable(state, v)
      && VEHICLE_DEFS[v.defId]?.lightTransport && !reserved(state, v.id, team.id)
      && dist(v.pos, cw.pos) <= 18).sort((a, b) => dist(a.pos, cw.pos) - dist(b.pos, cw.pos) || a.id - b.id);
    const tractor = vehicles.find(v => canTowWeapon(v, cw.weaponId));
    if (!tractor) return;
    vehicles = [tractor, ...vehicles.filter(v => v !== tractor)];
  } else vehicles = (team.assignedVehicleIds ?? []).map(id => state.vehicles.get(id))
    .filter((v): v is Vehicle => !!v && usable(state, v) && !reserved(state, v.id, team.id));
  const men = crew(state, team), assignments: Record<number, number> = {};
  let capacity = 0; vehicles = vehicles.filter(v => {
    if (capacity >= men.length) return false; capacity += roomLeft(state, v); return true;
  });
  if (!vehicles.length || (!tow && vehicles.reduce((n, v) => n + roomLeft(state, v), 0) < men.length)) return;
  const ordered = [...men].sort((a,b) => (a.id === cw.gunnerId ? -1 : b.id === cw.gunnerId ? 1 : a.id - b.id));
  let at = 0;
  for (const v of vehicles) for (let seat = 0; seat < roomLeft(state, v) && at < ordered.length; seat++) assignments[ordered[at++].id] = v.id;
  team.crewWeapon = cw;
  team.mobility = { phase: 'packing', order: structuredClone(order), vehicleIds: vehicles.map(v => v.id), assignments, startedAt: state.time, tow };
  team.transportId = vehicles[0].id;
  onCrewOrder(state, team, 'moveFast');
  // The pending destination belongs to the coordinator; unassigned men wait with the kit.
  for (const s of men) if (s.vehicleId == null && !s.hatch) { s.path = []; s.activity = 'idle'; }
  for (const v of vehicles) { v.path = []; v.mobilityTeamId = team.id; }
}

function finish(state: BattleState, team: Team, rng: Rng): void {
  const m = team.mobility!;
  for (const id of m.vehicleIds) {
    const v = state.vehicles.get(id); if (v) { v.path = []; delete v.mobilityTeamId; if (v.towedTeamId === team.id) delete v.towedTeamId; }
  }
  if (team.crewWeapon) delete team.crewWeapon.transport;
  delete team.mobility; delete team.transportId;
  const order = { ...m.order, type: m.order.type === 'moveFast' ? 'move' as const : m.order.type, waypoints: undefined, onFoot: true, issuedAt: state.time };
  applyOrder(state, team, order, rng, true);
}
function unload(state: BattleState, team: Team, vehicles: Vehicle[], dt: number, rng: Rng): void {
  const m = team.mobility!, cw = team.crewWeapon!;
  m.unloadStartedAt ??= state.time;
  for (const v of vehicles) {
    v.path = [];
    if (passengersAboard(state, v).some(s => s.teamId === team.id)) startUnload(state, v, !usable(state, v), team.id);
  }
  const men = crew(state, team);
  if (men.some(s => s.vehicleId != null || s.hatch)) return;
  const tr = cw.transport;
  if (!tr) { finish(state, team, rng); return; }
  const v = state.vehicles.get(tr.vehicleId);
  if (!v || !['ok', 'immobilized', 'abandoned'].includes(v.state)) {
    if (tr.phase === 'loaded' || tr.phase === 'loading') cw.destroyed = true;
    finish(state, team, rng); return;
  }
  if (tr.phase !== 'unloading' && tr.phase !== 'uncoupling') {
    tr.phase = m.tow ? 'uncoupling' : 'unloading'; tr.startedAt = state.time; tr.until = state.time + 2.5;
    tr.from = m.tow ? { ...cw.pos } : access(state, v);
  }
  const worker = men.find(s => isAbleCrewman(state, s));
  if (!worker) {
    if (state.time - m.unloadStartedAt > 15) {
      // No able crew remains to finish the drill: leave the real kit here, release the drivers.
      cw.pos = { ...(m.tow ? cw.pos : access(state, v)) }; cw.abandoned = true; cw.abandonedAt = state.time;
      delete cw.transport;
      for (const carrier of vehicles) { delete carrier.mobilityTeamId; if (carrier.towedTeamId === team.id) delete carrier.towedTeamId; }
      delete team.mobility; delete team.transportId; team.order = null; return;
    }
    tr.startedAt += dt; tr.until += dt; return;
  }
  const point = m.tow ? cw.pos : tr.from;
  walk(state, worker, point);
  if (dist(worker.pos, point) > 1.2) { tr.startedAt += dt; tr.until += dt; return; }
  worker.crewTask = { id: m.tow ? 'unhook' : 'liftBaseplate', progress: Math.min(1, (state.time - tr.startedAt) / 2.5), walking: false };
  worker.activity = 'idle'; worker.stance = 'crouching';
  if (state.time < tr.until) return;
  if (!m.tow) cw.pos = { ...tr.from };
  finish(state, team, rng);
}

/** Before vehicle requests; packing itself is still stepped by crewWeapon.ts. */
export function stepMotorizedCrews(state: BattleState, rng: Rng, dt: number): void {
  for (const team of state.teams.values()) {
    const m = team.mobility, cw = team.crewWeapon;
    if (!m || !cw) continue;
    const vehicles = m.vehicleIds.map(id => state.vehicles.get(id)).filter((v): v is Vehicle => !!v);
    const primary = vehicles[0], men = crew(state, team);
    if (!men.length) {
      for (const v of vehicles) { v.path = []; delete v.mobilityTeamId; if (v.towedTeamId === team.id) delete v.towedTeamId; }
      cw.abandoned = true; cw.abandonedAt = state.time;
      if (cw.transport?.phase === 'towed') delete cw.transport;
      delete team.mobility; delete team.transportId; team.order = null; continue;
    }
    for (const s of men) if (s.vehicleId != null && m.vehicleIds.includes(s.vehicleId) && !state.vehicles.has(s.vehicleId)) {
      // Keep the last accepted position if a carrier has left the entity set.
      s.vehicleId = null; s.seat = undefined; s.hatch = undefined; s.path = []; s.stance = 'prone';
    }
    if (!primary || vehicles.length !== m.vehicleIds.length || vehicles.some(v => !usable(state, v))) { m.abort = true; m.phase = 'unloading'; }
    if (m.phase === 'unloading') { unload(state, team, vehicles, dt, rng); continue; }
    if (state.time - m.startedAt > 90 && m.phase !== 'driving') {
      m.abort = true; m.phase = 'unloading'; addMessage(state, `${team.name}: transport interrupted.`, 'warn', team.side); continue;
    }
    if (m.phase === 'packing') {
      if (cw.phase !== 'packed') continue;
      m.phase = 'boarding';
    }
    if (m.phase === 'boarding') {
      for (const v of vehicles) { v.path = []; v.mobilityTeamId = team.id; }
      if (vehicles.some(v => Math.abs(v.speed) > 0.05)) continue;
      if (m.tow && !cw.transport) {
        const h = rearHitch(primary)!; const facing = wrapAngle(primary.hullFacing + Math.PI), len = towLengthM(cw.weaponId) / TILE_M;
        const target = { x: h.x / TILE_M + dm.sin(facing) * len, y: h.y / TILE_M - dm.cos(facing) * len };
        const g = state.soldiers.get(cw.gunnerId);
        if (!g || !isAbleCrewman(state, g)) continue;
        if (dist(cw.pos, target) > 0.08) {
          if (!g.path.length || dist(g.path[g.path.length - 1], target) > 0.2) {
            const path = findPath(planningMap(state,g), cw.pos, target, 'vehicle');
            const end = path.at(-1) ?? cw.pos;
            if (Math.floor(end.x) === Math.floor(target.x) && Math.floor(end.y) === Math.floor(target.y)
              && isPassable(state.map, Math.floor(target.x), Math.floor(target.y), 'vehicle')) path.push({ ...target });
            g.path = path;
          }
          g.activity = 'moving'; continue;
        }
        cw.transport = { vehicleId: primary.id, phase: 'coupling', startedAt: state.time, until: state.time + 2.5, from: { ...cw.pos } };
      }
      if (!m.tow && !cw.transport) {
        for (const s of men) if (s.vehicleId == null && !s.hatch && isAbleCrewman(state, s)) {
          walk(state, s, access(state, state.vehicles.get(m.assignments[s.id] ?? primary.id)!));
        }
        const g = state.soldiers.get(cw.gunnerId), point = access(state, primary);
        if (!g || !isAbleCrewman(state, g) || dist(g.pos, point) > 1.1 || dist(cw.pos, point) > 1.1) continue;
        cw.transport = { vehicleId: primary.id, phase: 'loading', startedAt: state.time, until: state.time + 2.5, from: { ...cw.pos } };
      }
      const tr = cw.transport!;
      const working = tr.phase === 'loading' || tr.phase === 'coupling';
      for (const s of men) {
        if (s.vehicleId != null || s.hatch) continue;
        const v = state.vehicles.get(m.assignments[s.id] ?? primary.id)!;
        const point = working && s.id === cw.gunnerId ? (m.tow ? cw.pos : access(state, primary)) : access(state, v);
        if (isAbleCrewman(state, s)) walk(state, s, point);
      }
      if (working) {
        const worker = men.find(s => isAbleCrewman(state, s) && dist(s.pos, m.tow ? cw.pos : access(state, primary)) < 1.2);
        if (!worker) { tr.startedAt += dt; tr.until += dt; continue; }
        worker.crewTask = { id: m.tow ? 'hook' : 'liftBaseplate', progress: Math.min(1, (state.time - tr.startedAt) / 2.5), walking: false };
        worker.activity = 'idle'; worker.stance = 'crouching'; worker.path = [];
        if (m.tow) {
          const h = rearHitch(primary)!, facing = wrapAngle(primary.hullFacing + Math.PI), len = towLengthM(cw.weaponId) / TILE_M;
          cw.facing = turnTowards(cw.facing, facing, dt * 1.5);
          const p = Math.min(1, dt / Math.max(dt, tr.until - state.time));
          const x = h.x / TILE_M + dm.sin(facing) * len, y = h.y / TILE_M - dm.cos(facing) * len;
          cw.pos = { x: cw.pos.x + (x - cw.pos.x) * p, y: cw.pos.y + (y - cw.pos.y) * p };
        }
        if (state.time < tr.until) continue;
        if (m.tow) { const h = rearHitch(primary)!, facing = wrapAngle(primary.hullFacing + Math.PI), len = towLengthM(cw.weaponId) / TILE_M;
          cw.facing = facing; cw.pos = { x: h.x / TILE_M + dm.sin(facing) * len, y: h.y / TILE_M - dm.cos(facing) * len };
          tr.phase = 'towed'; primary.towedTeamId = team.id;
        } else { tr.phase = 'loaded'; cw.pos = { ...primary.pos }; }
      }
      if (tr.phase === 'loaded' || tr.phase === 'towed') for (const s of men) s.crewTask = undefined;
      for (const s of men) {
        const v = state.vehicles.get(m.assignments[s.id]);
        if (!v || s.vehicleId != null || s.hatch || !isAbleCrewman(state, s) || dist(s.pos, access(state, v)) > 0.9
          || roomLeft(state, v) <= 0 || (v.doorBusyUntil ?? 0) > state.time) continue;
        const from = { ...s.pos }, to = { ...v.pos };
        s.hatch = { vehicleId: v.id, hatch: 0, kind: 'mount', from, to, start: state.time, until: state.time + BOARD_S, panicked: false, passenger: true };
        v.doorBusyUntil = s.hatch.until; s.path = []; s.activity = 'idle';
      }
      const waiting = men.some(s => m.assignments[s.id] != null && s.vehicleId !== m.assignments[s.id]);
      if (waiting) continue;
      m.phase = 'driving'; vehicles.forEach((v,i) => vehicleRoute(state, v, m.order, i));
    }
    if (m.phase === 'driving') {
      if (!m.tow && cw.transport) cw.pos = { ...primary.pos };
      for (const s of men) if (s.vehicleId == null && !s.hatch && isAbleCrewman(state, s)) walk(state, s, access(state, primary));
      if (vehicles.every(v => !v.path.length && Math.abs(v.speed) < 0.05)) m.phase = 'unloading';
    }
  }
}

export function motorizedHold(state: BattleState, v: Vehicle): boolean {
  const mobility = v.mobilityTeamId != null ? state.teams.get(v.mobilityTeamId)?.mobility : undefined;
  return mobility != null && mobility.phase !== 'driving';
}
