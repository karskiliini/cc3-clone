// Leaving and re-entering vehicles (spec 2026-09-17 §10): the crew climbs out one man per hatch at
// a time and is exposed while it does; a serviceable vehicle stays where it was left, with its
// damage and ammunition, and its OWN crew goes back once every survivor has his nerve again, the
// threat that drove them out is believed gone (the belief model decides, not the truth) or has no
// line of fire, and something useful still works. Re-manned, the seats are filled for what still
// works. Deterministic: the seeded Rng only.
import type { BattleState, CrewRole, HatchClimb, Order, Soldier, Team, Vec2, Vehicle, VehicleDef, VehicleHatchDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, clamp, dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { inBounds } from './map';
import { findPath, isPassable } from './path';
import { hasLOS } from './los';
import { bestRoundAgainst } from './ballistics';
import { addMessage } from './messages';
import { onPassengerBoarded, onPassengerOut } from './transport';
import { isDazed } from './daze';
import {
  coaxUsable, crewRoleOf, ensureSeats, expectedArmorMm, hasSystem, hurtCrewman, isImmobile, mainGunUsable, seatRoles, systemState, vehicleLayout,
} from './vehicleDamage';

/** Seconds a calm, unhurt man of average experience needs through a hatch (spec: 1.5 to 2.5 s). */
export const CLIMB_MIN_S = 1.5;
export const CLIMB_MAX_S = 2.5;
/** A panicked bail-out is faster and sloppier. */
export const PANIC_CLIMB_MUL = 0.6;
export const WOUNDED_CLIMB_MUL = 1.5;
/** How far from the hull side a man lands (m). */
export const BESIDE_HULL_M = 0.9;
/** The crew goes back to a vehicle no farther away than this (m). */
export const REMOUNT_REACH_M = 150;
/** A Move order ending this close to the team's own abandoned vehicle is an order to re-man it (m). */
export const REMOUNT_ORDER_RADIUS_M = 6;
/** Veterans go back sooner and under more risk. */
export const VETERAN_EXP = 70;
export const RECRUIT_EXP = 40;
/** A known gun that cannot do better than this against the hull does not keep veterans out. */
const VETERAN_DANGER_OK = 0.15;
const THREAT_RANGE_M = 800;
export const WILL_NOT_GO_BACK = 'Crew will not go back yet.';

function isAble(s: Soldier | undefined): s is Soldier {
  return !!s && s.health !== 'dead' && s.health !== 'incapacitated';
}

export function climbSeconds(s: Soldier, panicked: boolean): number {
  let t = clamp(2.4 - s.experience / 100, CLIMB_MIN_S, CLIMB_MAX_S);
  if (panicked) t *= PANIC_CLIMB_MUL;
  if (s.health === 'wounded') t *= WOUNDED_CLIMB_MUL;
  return t;
}

/** Hull-local metres (x right, y ahead) to tile coordinates. */
export function hullToWorld(v: Vehicle, x: number, y: number): Vec2 {
  const fx = Math.sin(v.hullFacing), fy = -Math.cos(v.hullFacing);
  const rx = -fy, ry = fx;
  return { x: v.pos.x + (rx * x + fx * y) / TILE_M, y: v.pos.y + (ry * x + fy * y) / TILE_M };
}

/** A hatch in hull-local metres as it lies NOW: turret hatches go round with the turret. */
export function hatchLocal(v: Vehicle, def: VehicleDef, h: VehicleHatchDef): { x: number; y: number } {
  if (h.group !== 'turret' || !def.hasTurret) return { x: h.x, y: h.y };
  const a = v.turretFacing - v.hullFacing;
  const c = Math.cos(a), sn = Math.sin(a);
  // x right, y ahead, clockwise-positive heading
  return { x: h.x * c + h.y * sn, y: -h.x * sn + h.y * c };
}
/** The hatch on the hull, tile coords. */
export function hatchWorld(v: Vehicle, def: VehicleDef, h: VehicleHatchDef): Vec2 {
  const l = hatchLocal(v, def, h);
  return hullToWorld(v, l.x, l.y);
}

/** Hull-local spot on the ground beside a hatch: out over the nearer side (the rear for a rear
 * door); `flip` takes the other side. */
function besideLocal(def: VehicleDef, h: VehicleHatchDef, at: { x: number; y: number }, flip: boolean, preferRight: boolean): { x: number; y: number } {
  if (h.group === 'rear' && !flip) return { x: at.x, y: -(def.lengthM / 2 + BESIDE_HULL_M) };
  let sign = at.x > 0.05 ? 1 : at.x < -0.05 ? -1 : preferRight ? 1 : -1;
  if (flip && h.group !== 'rear') sign = -sign;
  return { x: sign * (def.widthM / 2 + BESIDE_HULL_M), y: clamp(at.y, -def.lengthM / 2, def.lengthM / 2) };
}

/** Where a man using hatch `hi` stands on the ground (tile coords): the near side, else the other
 * side, else the hull itself when the ground there cannot be walked on. */
export function besideHatch(state: BattleState, v: Vehicle, def: VehicleDef, hi: number, threatDir: number | null = null): Vec2 {
  const h = vehicleLayout(def).hatches[hi];
  if (!h) return { ...v.pos };
  // a centre-line hatch: drop down the side away from the threat
  let preferRight = true;
  if (threatDir != null) {
    const right = hullToWorld(v, 1, 0);
    const toThreat = { x: Math.sin(threatDir), y: -Math.cos(threatDir) };
    preferRight = (right.x - v.pos.x) * toThreat.x + (right.y - v.pos.y) * toThreat.y <= 0;
  }
  for (const flip of [false, true]) {
    const l = besideLocal(def, h, hatchLocal(v, def, h), flip, preferRight);
    const p = hullToWorld(v, l.x, l.y);
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry')) return p;
  }
  return { ...v.pos };
}

const TURRET_ROLES = new Set<CrewRole>(['commander', 'gunner', 'loader']);

/** Hatches this man may use: turret crew the turret and cupola hatches, driver and bow gunner the
 * hull hatches; everyone the sides and rear of an open vehicle. A group the vehicle lacks falls
 * back to any hatch. */
export function hatchesFor(state: BattleState, v: Vehicle, def: VehicleDef, s: Soldier): number[] {
  const hatches = vehicleLayout(def).hatches;
  const role = crewRoleOf(state, v, s.id);
  const group = role && !TURRET_ROLES.has(role) ? 'hull' : 'turret';
  const all = hatches.map((_, i) => i);
  const own = all.filter((i) => hatches[i].group === group);
  return own.length > 0 ? own : all;
}

function threatDirOf(state: BattleState, team: Team): number | null {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (isAble(s) && s.mind.threatDir != null) return s.mind.threatDir;
  }
  return null;
}

/** Free-soonest hatch for this man; among equally free ones the one farthest from the threat. */
function pickHatch(state: BattleState, v: Vehicle, def: VehicleDef, s: Soldier, threatDir: number | null): number {
  const hatches = vehicleLayout(def).hatches;
  const busy = v.hatchBusyUntil ?? [];
  let best = -1, bestT = Infinity, bestAway = -Infinity;
  for (const i of hatchesFor(state, v, def, s)) {
    const t = Math.max(busy[i] ?? 0, 0);
    let away = 0;
    if (threatDir != null) {
      const p = hatchWorld(v, def, hatches[i]);
      away = -((p.x - v.pos.x) * Math.sin(threatDir) + (p.y - v.pos.y) * -Math.cos(threatDir));
    }
    const tt = Math.max(t, 0);
    if (tt < bestT - 1e-9 || (Math.abs(tt - bestT) <= 1e-9 && away > bestAway + 1e-9)) { best = i; bestT = tt; bestAway = away; }
  }
  return best;
}

// ------------------------------------------------------------------ getting out
/** The crew starts to leave: one man per hatch at a time (stepVehicleCrews does the rest). */
export function startExit(state: BattleState, v: Vehicle, opts: { panicked: boolean; fire?: boolean }): void {
  if (v.exiting) {
    v.exiting.panicked = v.exiting.panicked || opts.panicked;
    v.exiting.fire = v.exiting.fire || !!opts.fire;
    return;
  }
  v.exiting = { panicked: opts.panicked, fire: !!opts.fire, startedAt: state.time };
  v.remount = undefined;
}

function menInside(state: BattleState, v: Vehicle, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (isAble(s) && s.vehicleId === v.id) out.push(s); }
  return out;
}

/** Puts the next men onto the free hatches. Works in battle time, so a caller that advanced the
 * clock by more than one step still gets the hatch-by-hatch sequence. */
export function stepExit(state: BattleState, rng: Pick<Rng, 'next'>, v: Vehicle): void {
  const ex = v.exiting;
  if (!ex) return;
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  if (!def || !team) { v.exiting = undefined; return; }
  const busy = (v.hatchBusyUntil ??= []);
  const threatDir = threatDirOf(state, team);
  const enemy = team.side === 'german' ? 'soviet' : 'german';
  for (let guard = 0; guard < 32; guard++) {
    const inside = menInside(state, v, team);
    if (inside.length === 0) { v.exiting = undefined; return; }
    // the man whose hatch is free first goes next (crew order breaks ties)
    let man: Soldier | null = null, hi = -1, at = Infinity;
    for (const s of inside) {
      const h = pickHatch(state, v, def, s, threatDir);
      if (h < 0) continue;
      const t = Math.max(busy[h] ?? 0, ex.startedAt);
      if (t < at - 1e-9) { man = s; hi = h; at = t; }
    }
    if (!man || at > state.time) return;
    if (ex.fire) {
      // the fire gets some of them before they reach the hatch
      const r = rng.next();
      if (r < 0.2) { hurtCrewman(state, v, man, 'dead', enemy, team, true); continue; }
      if (r < 0.45) hurtCrewman(state, v, man, 'wounded', enemy, team, true);
    }
    const panicked = ex.panicked || ex.fire;
    const h = vehicleLayout(def).hatches[hi];
    const climb: HatchClimb = {
      vehicleId: v.id, hatch: hi, kind: 'bailout', from: hatchWorld(v, def, h), to: besideHatch(state, v, def, hi, threatDir),
      start: at, until: at + climbSeconds(man, panicked), panicked,
    };
    busy[hi] = climb.until;
    man.vehicleId = null;
    man.hatch = climb;
    man.pos = { ...climb.from };
    man.path = [];
    man.stance = 'standing';
    man.cover = 0;
    man.targetSoldierId = null; man.targetVehicleId = null; man.targetPoint = null;
    if (panicked) { man.activity = 'panicked'; man.mind.state = 'panicked'; man.mind.stateSince = state.time; }
    else man.activity = 'idle';
  }
}

/** 0..1 of a man's climb at battle time `time`. */
export function hatchProgress(c: HatchClimb, time: number): number {
  return clamp((time - c.start) / Math.max(1e-6, c.until - c.start), 0, 1);
}

function stepClimbs(state: BattleState): void {
  for (const s of state.soldiers.values()) {
    const c = s.hatch;
    if (!c) continue;
    if (s.health === 'dead' || s.health === 'incapacitated') { s.hatch = undefined; continue; } // shot off the hull: he lies where he fell
    const v = state.vehicles.get(c.vehicleId);
    const def = v ? VEHICLE_DEFS[v.defId] : undefined;
    if (v && def) {
      // the hull may have been slewed meanwhile: both ends follow it
      const h = c.passenger ? undefined : vehicleLayout(def).hatches[c.hatch]; // a standing transport: fixed ends
      if (h) { const onHull = hatchWorld(v, def, h); if (c.kind === 'bailout') c.from = onHull; else c.to = onHull; }
    }
    const p = hatchProgress(c, state.time);
    s.pos = { x: c.from.x + (c.to.x - c.from.x) * p, y: c.from.y + (c.to.y - c.from.y) * p };
    s.stance = 'standing';
    s.cover = 0;
    s.path = [];
    if (state.time < c.until) continue;
    s.hatch = undefined;
    if (c.kind === 'bailout') {
      s.pos = { ...c.to };
      if (c.panicked) {
        s.activity = 'panicked'; s.mind.state = 'panicked';
        s.reloadTimer = 0; // movement.ts: free to pick a direction to run in
        if (v) s.bailRun = { to: runSpot(state, v, s), until: state.time + (v.state === 'burning' ? BAIL_RUN_FIRE_S : BAIL_RUN_S) };
      } else { s.activity = 'defending'; s.stance = 'crouching'; }
      if (c.passenger && v) onPassengerOut(state, v, s, c.panicked);
    } else if (c.passenger) {
      if (v) onPassengerBoarded(state, v, s); else { s.activity = 'defending'; s.stance = 'crouching'; }
    } else if (v && v.state !== 'burning' && v.state !== 'knockedOut') {
      s.vehicleId = v.id;
      s.pos = { ...v.pos };
      s.activity = 'idle';
      s.stance = 'crouching';
    } else { s.pos = { ...c.from }; s.activity = 'defending'; s.stance = 'crouching'; }
  }
}

/** Seconds a man who bailed out in a panic runs before he goes to ground. */
export const BAIL_RUN_S = 4;
/** ...and out of a burning one: long enough to get clear of it (sim/vehicleExplosion.ts FIRE_HAZARD_M). */
export const BAIL_RUN_FIRE_S = 8;

/** Where a panicked man runs to: 8 to 14 m from the hull, away from the threat (else straight away
 * from the vehicle), over ground he can cross in a straight line. */
function runSpot(state: BattleState, v: Vehicle, s: Soldier): Vec2 {
  const away = angleTo(v.pos, s.pos);
  const base = s.mind.threatDir != null ? s.mind.threatDir + Math.PI : away;
  // men from the two sides fan out instead of running in file
  const lean = Math.sin(away - base) >= 0 ? 0.5 : -0.5;
  // out of a burning vehicle: clear of the 15 m its ammunition can reach before going to ground
  for (const m of v.state === 'burning' ? [22, 18, 14, 10, 6] : [14, 10, 6]) {
    for (const off of [lean, 0, -lean, lean * 2.4]) {
      const a = base + off;
      const to = { x: s.pos.x + (Math.sin(a) * m) / TILE_M, y: s.pos.y + (-Math.cos(a) * m) / TILE_M };
      let ok = true;
      for (let k = 1; k <= 7 && ok; k++) {
        const x = Math.floor(s.pos.x + ((to.x - s.pos.x) * k) / 7), y = Math.floor(s.pos.y + ((to.y - s.pos.y) * k) / 7);
        ok = inBounds(state.map, x, y) && isPassable(state.map, x, y, 'infantry');
      }
      if (ok) return to;
    }
  }
  return { ...s.pos };
}

// ------------------------------------------------------------------ is it worth going back to
/** Something useful still works: it can move, or fire its gun, or fire an MG. */
export function isServiceable(v: Vehicle): boolean {
  if (v.state === 'burning' || v.state === 'knockedOut' || v.turretBlown) return false;
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return false;
  if (!v.wasImmobile && !isImmobile(v)) return true;
  if (def.mainWeaponId && mainGunUsable(v) && v.mainAmmo > 0) return true;
  if (def.coaxWeaponId && coaxUsable(v) && v.coaxAmmo > 0) return true;
  return hasSystem(def, 'bowMg') && systemState(v, 'bowMg') !== 'destroyed' && v.coaxAmmo > 0;
}

function survivorsOutside(state: BattleState, v: Vehicle, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (isAble(s) && s.vehicleId == null && s.activity !== 'surrendered') out.push(s); }
  return out;
}

function avgExperience(men: Soldier[]): number {
  return men.length > 0 ? men.reduce((a, s) => a + s.experience, 0) / men.length : 0;
}

/** Lying stunned or still dazed by a blast (daze.ts): he cannot climb a hull in that state. */
function knockedSilly(state: BattleState, s: Soldier): boolean {
  return (s.stunnedUntil != null && state.time < s.stunnedUntil) || isDazed(s, state.time);
}

function calmEnough(s: Soldier, allowWary: boolean): boolean {
  const st = s.mind.state;
  return st === 'calm' || st === 'alert' || (allowWary && st === 'wary');
}

/** A gun the crew KNOWS of (spotted by its side now, or the believed position of what drove them
 * out) with a line of fire to the hull. Veterans shrug at guns that cannot hurt the vehicle. */
function knownThreatCovers(state: BattleState, v: Vehicle, def: VehicleDef, men: Soldier[], veteran: boolean): boolean {
  const year = state.config.year;
  const dangerous = (weaponId: string | null | undefined, from: Vec2): boolean => {
    const w = weaponId ? WEAPONS[weaponId] : undefined;
    if (!w) return false;
    const distM = dist(from, v.pos) * TILE_M;
    if (distM > THREAT_RANGE_M) return false;
    const danger = bestRoundAgainst(w, distM, expectedArmorMm(v, def, from, 'mass'), year).chance;
    if (danger <= 0.01 || (veteran && danger < VETERAN_DANGER_OK)) return false;
    return hasLOS(state.map, from, v.pos);
  };
  for (const id of state.spottedVehicles[v.side]) {
    const ev = state.vehicles.get(id);
    if (!ev || ev.side === v.side || (ev.state !== 'ok' && ev.state !== 'immobilized')) continue;
    if (dangerous(VEHICLE_DEFS[ev.defId]?.mainWeaponId, ev.pos)) return true;
  }
  for (const id of state.spotted[v.side]) {
    const e = state.soldiers.get(id);
    if (!isAble(e) || e.side === v.side || e.vehicleId != null) continue;
    const cls = WEAPONS[e.weaponId]?.cls;
    if (cls !== 'atgun' && cls !== 'atrocket' && cls !== 'atrifle') continue;
    if (dangerous(e.weaponId, e.pos)) return true;
  }
  // what drove them out: still believed to be there, and able to see the hull from where they think it is
  const bt = v.bailThreat;
  if (bt) {
    const need = veteran ? 0.6 : 0.3;
    for (const s of men) {
      for (const b of s.mind.beliefs) {
        if (b.confidence <= need || dist(b.pos, bt.pos) > 6) continue;
        if (hasLOS(state.map, b.pos, v.pos)) return true;
      }
    }
  }
  return false;
}

export type ReturnRefusal = 'noCrew' | 'useless' | 'refuses' | 'notCalm' | 'shock' | 'far' | 'threat';

/** Will the crew of this abandoned vehicle go back now? `ordered`: the player told them to, which
 * overrides their caution about known threats and the time they take to get over it, but not
 * their nerves. Returns null when they go. */
export function crewReturnRefusal(state: BattleState, v: Vehicle, ordered: boolean): ReturnRefusal | null {
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  if (!def || !team || v.state !== 'abandoned' || !isServiceable(v)) return 'useless';
  if (v.exiting) return 'notCalm';
  const men = survivorsOutside(state, v, team);
  if (men.length === 0) return 'noCrew';
  if (v.noReturn) return 'refuses';
  const veteran = avgExperience(men) >= VETERAN_EXP;
  if (men.some((s) => s.hatch || !calmEnough(s, ordered || veteran) || knockedSilly(state, s))) return 'notCalm';
  if (men.some((s) => dist(s.pos, v.pos) * TILE_M > REMOUNT_REACH_M)) return 'far';
  if (ordered) return null;
  if (v.crewShockUntil != null && state.time < v.crewShockUntil) return 'shock';
  if (knownThreatCovers(state, v, def, men, veteran)) return 'threat';
  return null;
}

/** Seconds before a crew that bailed out thinks of going back: longer for green crews, much
 * longer after a heavy hit (`heavy`: a penetration with casualties). */
export function crewShockSeconds(avgExp: number, cause: 'panic' | 'penetration' | 'heavy' | 'shortCrew'): number {
  const base = cause === 'heavy' ? 90 : cause === 'penetration' ? 45 : cause === 'shortCrew' ? 30 : 20;
  return base * clamp(1.6 - avgExp / 100, 0.6, 1.5);
}

// ------------------------------------------------------------------ going back
/** Seats for what still works (spec §10): driver if it can move, gunner if the gun works, then
 * loader, commander duties, bow MG; the seats of dead equipment come last. Each man keeps his own
 * seat when it is among those to be filled. */
export function assignSeatsForWhatWorks(state: BattleState, v: Vehicle): void {
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  if (!def || !team) return;
  const seats = ensureSeats(state, v);
  const roles = seatRoles(def);
  const dual = def.mainWeaponId != null && !roles.includes('gunner');
  const canMove = !isImmobile(v);
  const gunOk = def.mainWeaponId != null && mainGunUsable(v);
  const has = (r: CrewRole): boolean => r in seats && !(dual && r === 'commander');
  const first: CrewRole[] = [], last: CrewRole[] = [];
  (canMove ? first : last).push('driver');
  (gunOk ? first : last).push('gunner');
  first.push('loader', 'commander', 'radioOp');
  const order = [...first, ...last].filter(has);
  const men = menInside(state, v, team);
  const original = (r: CrewRole): number | null => {
    let i = roles.indexOf(r);
    if (i < 0 && r === 'gunner') i = roles.indexOf('commander');
    return i >= 0 ? team.soldierIds[i] ?? null : null;
  };
  const wanted = order.slice(0, men.length);
  const free = new Set(men.map((s) => s.id));
  for (const r of order) seats[r] = null;
  for (const r of wanted) { const id = original(r); if (id != null && free.has(id)) { seats[r] = id; free.delete(id); } }
  for (const r of wanted) {
    if (seats[r] != null) continue;
    const id = men.find((s) => free.has(s.id))?.id;
    if (id == null) break;
    seats[r] = id; free.delete(id);
  }
  if (dual && 'commander' in seats) seats.commander = seats.gunner ?? null;
  v.seatSwap = undefined;
}

function goLive(state: BattleState, v: Vehicle, team: Team): void {
  const def = VEHICLE_DEFS[v.defId];
  v.state = v.wasImmobile || isImmobile(v) ? 'immobilized' : 'ok';
  v.wasImmobile = undefined;
  v.bailThreat = undefined;
  v.crewShockUntil = undefined;
  v.path = []; v.speed = 0;
  v.targetSoldierId = null; v.targetVehicleId = null; v.targetPoint = null;
  assignSeatsForWhatWorks(state, v);
  const inside = menInside(state, v, team);
  if (!inside.some((s) => s.id === team.leaderId) && inside.length > 0) {
    const old = state.soldiers.get(team.leaderId);
    if (!old || old.health === 'dead' || old.health === 'incapacitated') { if (old) old.isLeader = false; team.leaderId = inside[0].id; inside[0].isLeader = true; }
  }
  team.order = null;
  if (team.side === state.config.playerSide) addMessage(state, `${team.name}\nCrew returns to the ${def?.name ?? 'vehicle'}.`, 'good');
}

function sendToHatch(state: BattleState, v: Vehicle, def: VehicleDef, s: Soldier, fast: boolean): void {
  const hi = pickHatch(state, v, def, s, null);
  if (hi < 0) return;
  const spot = besideHatch(state, v, def, hi);
  const d = dist(s.pos, spot);
  if (d <= 0.35 || (s.path.length === 0 && d <= 0.8)) {
    const busy = (v.hatchBusyUntil ??= []);
    if ((busy[hi] ?? 0) > state.time) { s.path = []; s.activity = 'idle'; s.stance = 'crouching'; return; } // waits his turn
    const h = vehicleLayout(def).hatches[hi];
    s.hatch = { vehicleId: v.id, hatch: hi, kind: 'mount', from: { ...s.pos }, to: hatchWorld(v, def, h), start: state.time, until: state.time + climbSeconds(s, false), panicked: false };
    busy[hi] = s.hatch.until;
    s.path = [];
    s.activity = 'idle';
    return;
  }
  const end = s.path.length > 0 ? s.path[s.path.length - 1] : null;
  if (!end || dist(end, spot) > 0.5) {
    s.path = findPath(state.map, s.pos, spot, 'infantry');
    if (s.path.length === 0 || dist(s.path[s.path.length - 1], spot) > 0.05) s.path.push(spot);
  }
  s.activity = fast ? 'movingFast' : 'moving';
  s.stance = 'standing';
}

function stepRemount(state: BattleState, v: Vehicle, team: Team, def: VehicleDef): void {
  const rm = v.remount;
  if (!rm) return;
  if (v.state === 'burning' || v.state === 'knockedOut' || v.exiting) { v.remount = undefined; return; }
  const outside = survivorsOutside(state, v, team);
  const veteran = avgExperience(outside) >= VETERAN_EXP;
  let coming = 0;
  for (const s of outside) {
    if (s.hatch) { coming++; continue; }
    if (!calmEnough(s, rm.ordered || veteran) || knockedSilly(state, s)) continue; // lost his nerve on the way
    coming++;
    sendToHatch(state, v, def, s, rm.ordered);
  }
  if (coming > 0) return;
  v.remount = undefined;
  if (v.state === 'abandoned' && menInside(state, v, team).length > 0) goLive(state, v, team);
}

/** The player's Move order onto the team's own abandoned vehicle. Returns true when the order was
 * a re-man order (obeyed or refused), false when it is an ordinary order. */
export function tryRemountOrder(state: BattleState, team: Team, order: Order): boolean {
  if (team.vehicleId == null) return false;
  const v = state.vehicles.get(team.vehicleId);
  if (!v || v.state !== 'abandoned') return false;
  if (order.type !== 'move' && order.type !== 'moveFast' && order.type !== 'sneak') return false;
  const def = VEHICLE_DEFS[v.defId];
  const reachM = Math.max(REMOUNT_ORDER_RADIUS_M, (def?.lengthM ?? 6) / 2 + 2);
  if (dist(order.target, v.pos) * TILE_M > reachM) return false;
  const why = crewReturnRefusal(state, v, true);
  if (why === 'useless' || why === 'noCrew') return true;
  if (why) {
    if (team.side === state.config.playerSide) addMessage(state, `${team.name}\n${WILL_NOT_GO_BACK}`, 'warn');
    return true;
  }
  v.remount = { since: state.time, ordered: true };
  return true;
}

/** True when a Move order of this team onto `pos` would send the crew back into its own vehicle
 * (the battle screen shows a mount hint). */
export function isRemountTarget(state: BattleState, team: Team, pos: Vec2): boolean {
  if (team.vehicleId == null) return false;
  const v = state.vehicles.get(team.vehicleId);
  if (!v || v.state !== 'abandoned' || !isServiceable(v)) return false;
  const def = VEHICLE_DEFS[v.defId];
  return dist(pos, v.pos) * TILE_M <= Math.max(REMOUNT_ORDER_RADIUS_M, (def?.lengthM ?? 6) / 2 + 2);
}

/** Team-box word for a vehicle whose crew is outside it or on the hatches, or null. */
export function crewOutsideWord(state: BattleState, v: Vehicle): 'Bailing out' | 'Remounting' | 'Abandoned' | null {
  if (v.exiting) return 'Bailing out';
  if (v.remount) return 'Remounting';
  if (v.state !== 'abandoned') return null;
  const team = state.teams.get(v.teamId);
  if (team) for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (s?.hatch && isAble(s)) return s.hatch.kind === 'mount' ? 'Remounting' : 'Bailing out'; }
  return 'Abandoned';
}

/** An abandoned vehicle that may yet be re-manned: its team is not out of action. */
export function crewMayReturn(state: BattleState, v: Vehicle): boolean {
  if (v.state !== 'abandoned' || v.noReturn || !isServiceable(v)) return false;
  const team = state.teams.get(v.teamId);
  if (!team) return false;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (isAble(s) && s.activity !== 'surrendered' && s.activity !== 'routed') return true;
  }
  return false;
}

/** Per sim step: hatch queues, climbs, and the crews' own decision to go back (looked at once a
 * second: it costs line-of-sight traces). */
export function stepVehicleCrews(state: BattleState, rng: Rng, dt: number): void {
  const tick = Math.floor(state.time) !== Math.floor(state.time - dt);
  for (const v of state.vehicles.values()) {
    if (v.exiting) stepExit(state, rng, v);
    if (v.state === 'ok' || v.state === 'immobilized') { if (!v.remount) continue; }
    else if (v.state !== 'abandoned') {
      // shot out from under the men who had just climbed back in
      if (v.remount) { const t = state.teams.get(v.teamId); if (t && menInside(state, v, t).length > 0) startExit(state, v, { panicked: true, fire: v.state === 'burning' }); }
      v.remount = undefined;
      continue;
    }
    const team = state.teams.get(v.teamId);
    const def = VEHICLE_DEFS[v.defId];
    if (!team || !def) continue;
    if (!v.remount && tick && v.state === 'abandoned' && crewReturnRefusal(state, v, false) == null) v.remount = { since: state.time, ordered: false };
    stepRemount(state, v, team, def);
  }
  stepClimbs(state);
}

/** Direction the crew last believed the danger to be in, for the renderer and tests. */
export function bailThreatDir(v: Vehicle): number | null {
  return v.bailThreat ? angleTo(v.pos, v.bailThreat.pos) : null;
}
