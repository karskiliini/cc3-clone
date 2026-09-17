// Locational vehicle damage: hit zones from the shot geometry, what sits behind each zone, what a
// penetration (or a hit that does not get through) does to the crew and the equipment there, and
// what the damage then means for the vehicle. The ONE damage model for every hit on a vehicle:
// aimed or centre-of-mass gun rounds, AT rifles, charges and bombs from above, small arms on
// open-topped vehicles. Deterministic: the seeded Rng only.
import type {
  AimPoint, BattleState, CrewRole, EquipState, RoundType, Side, Soldier, Team, Vec2, Vehicle, VehicleDamage,
  VehicleDef, VehicleHatchDef, VehicleLayoutDef, VehicleSystem, VehicleZone, WeaponDef,
} from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, clamp, dist, wrapAngle } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { penetrates, roundPenetrationMm } from './ballistics';
import { coverFrom } from './cover';
import { hasLOS } from './los';
import { addStress } from './mind';
import { addMessage } from './messages';
import { crewShockSeconds, isServiceable, startExit, stepExit } from './vehicleCrew';
import { LOOK_IN_HEIGHT_M, LOOK_IN_RANGE_M, passengersAboard, stressPassengers } from './transport';
import { groundHeightAt } from './map';
import { detonateVehicle, rackDetonationChance } from './vehicleExplosion';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ layout / seats
export function vehicleLayout(def: VehicleDef): Required<VehicleLayoutDef> {
  const l = def.layout ?? {};
  return {
    transmission: l.transmission ?? 'rear',
    sideFuel: l.sideFuel ?? false,
    twoManTurret: l.twoManTurret ?? (def.mainWeaponId != null && def.crew <= 3),
    openTop: l.openTop ?? (def.armor.top <= 0 || def.kind === 'halftrack'),
    bowMg: l.bowMg ?? (def.kind === 'tank' && def.crew >= 4),
    radio: l.radio ?? true,
    hatches: l.hatches ?? defaultHatches(def, l.openTop ?? (def.armor.top <= 0 || def.kind === 'halftrack')),
    // a transport's rear doors (the SdKfz 251's twin doors are one opening: one man at a time)
    doors: l.doors ?? ((def.passengers ?? 0) > 0 ? [{ x: 0, y: -Math.round(def.lengthM * 50) / 100, group: 'rear' }] : []),
  };
}

/** Where the crew gets out, by vehicle class (hull-local metres, x right, y ahead; spec
 * 2026-09-17 §10): tanks have turret/cupola hatches for the turret crew and hull hatches for the
 * driver and bow gunner; open vehicles are left over the sides and the rear. */
function defaultHatches(def: VehicleDef, openTop: boolean): VehicleHatchDef[] {
  const w = def.widthM, len = def.lengthM;
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  if (openTop) {
    const y = def.kind === 'halftrack' ? -len * 0.2 : -len * 0.15;
    return [{ x: -r2(w * 0.4), y: r2(y), group: 'side' }, { x: r2(w * 0.4), y: r2(y), group: 'side' }, { x: 0, y: -r2(len * 0.42), group: 'rear' }];
  }
  const hullY = r2(len * 0.27);
  if (def.kind === 'spg' || !def.hasTurret) {
    // casemate roof hatches (commander, loader) and the driver's hatch
    return [{ x: -r2(w * 0.2), y: -r2(len * 0.05), group: 'turret' }, { x: r2(w * 0.2), y: -r2(len * 0.05), group: 'turret' }, { x: -r2(w * 0.22), y: hullY, group: 'hull' }];
  }
  if (def.crew >= 4) {
    const turret: VehicleHatchDef[] = def.crew >= 5
      ? [{ x: -r2(w * 0.14), y: -r2(len * 0.06), group: 'turret' }, { x: r2(w * 0.16), y: -r2(len * 0.02), group: 'turret' }]
      : [{ x: 0, y: -r2(len * 0.05), group: 'turret' }];
    return [...turret, { x: -r2(w * 0.22), y: hullY, group: 'hull' }, { x: r2(w * 0.22), y: hullY, group: 'hull' }];
  }
  // light tanks: one turret hatch, one driver's hatch
  return [{ x: 0, y: -r2(len * 0.05), group: 'turret' }, { x: def.crew >= 3 ? -r2(w * 0.2) : 0, y: hullY, group: 'hull' }];
}

/** Seats of this vehicle in crew order (the order of the team's soldiers at spawn). In a two-man
 * turret the commander is also the gunner; a two-man crew's commander loads as well. */
export function seatRoles(def: VehicleDef): CrewRole[] {
  const lay = vehicleLayout(def);
  if (!def.mainWeaponId) return def.crew >= 3 ? ['commander', 'driver', 'radioOp'] : ['commander', 'driver'];
  if (def.crew >= 5) return ['commander', 'gunner', 'loader', 'driver', 'radioOp'];
  if (def.crew === 4) return lay.twoManTurret ? ['commander', 'loader', 'driver', 'radioOp'] : ['commander', 'gunner', 'loader', 'driver'];
  if (def.crew === 3) return ['commander', 'loader', 'driver'];
  return ['commander', 'driver'];
}

/** Swap priority (requirements C5): driver > gunner > loader > commander duties > bow MG. */
export const SEAT_PRIORITY: CrewRole[] = ['driver', 'gunner', 'loader', 'commander', 'radioOp'];
/** Who moves into an empty seat, first choice first: always a man from a lower-priority seat. The
 * gun is taken over from inside the turret (commander, then loader); the driver's seat by the man
 * beside him. */
export const SEAT_DONORS: Record<CrewRole, CrewRole[]> = {
  driver: ['radioOp', 'loader', 'commander', 'gunner'],
  gunner: ['commander', 'loader', 'radioOp'],
  loader: ['radioOp', 'commander'],
  commander: ['radioOp'],
  radioOp: [],
};
export const SEAT_SWAP_S: Record<CrewRole, number> = { driver: 12, gunner: 8, loader: 6, commander: 6, radioOp: 6 };

export const ROLE_WORD: Record<CrewRole, string> = {
  commander: 'Commander', gunner: 'Gunner', loader: 'Loader', driver: 'Driver', radioOp: 'Radioman',
};

function able(s: Soldier | undefined, v: Vehicle): s is Soldier {
  return !!s && s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId === v.id;
}

/** True when the commander lays the gun himself. */
function commanderIsGunner(def: VehicleDef): boolean {
  return !seatRoles(def).includes('gunner');
}

export function ensureSeats(state: BattleState, v: Vehicle): NonNullable<Vehicle['seats']> {
  if (v.seats) return v.seats;
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  const seats: NonNullable<Vehicle['seats']> = {};
  if (def && team) {
    const roles = seatRoles(def);
    // a seat nobody was assigned to at the start (hand-built, under-crewed teams) is not modelled:
    // its duty counts as done
    roles.forEach((r, i) => { if (team.soldierIds[i] != null) seats[r] = team.soldierIds[i]; });
    if (def.mainWeaponId && commanderIsGunner(def) && seats.commander != null) seats.gunner = seats.commander;
  }
  v.seats = seats;
  return seats;
}

/** The able man working this seat now (null while it is empty or its new man is still moving over). */
export function seatOccupant(state: BattleState, v: Vehicle, role: CrewRole): Soldier | null {
  const seats = ensureSeats(state, v);
  const id = seats[role];
  if (id == null) return null;
  const s = state.soldiers.get(id);
  return able(s, v) ? s : null;
}

/** Role of a crewman, by the highest-priority seat he holds (or is moving to). */
export function crewRoleOf(state: BattleState, v: Vehicle, soldierId: number): CrewRole | null {
  const seats = ensureSeats(state, v);
  if (v.seatSwap?.soldierId === soldierId) return v.seatSwap.role;
  const def = VEHICLE_DEFS[v.defId];
  // a commander who also lays the gun reads as Commander
  if (seats.commander === soldierId && def && commanderIsGunner(def)) return 'commander';
  for (const r of SEAT_PRIORITY) if (seats[r] === soldierId) return r;
  return null;
}

/** The man who held `role` when the battle began (crew order). */
function originalSeatId(state: BattleState, v: Vehicle, role: CrewRole): number | null {
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  if (!def || !team) return null;
  const roles = seatRoles(def);
  let i = roles.indexOf(role);
  if (i < 0 && role === 'gunner') i = roles.indexOf('commander');
  return i >= 0 ? team.soldierIds[i] ?? null : null;
}

/** Fills empty seats by the swap priority: the lowest-priority able man moves over, which takes
 * SEAT_SWAP_S; nobody works the seat meanwhile. One swap at a time. */
export function stepCrewSeats(state: BattleState, v: Vehicle): void {
  const def = VEHICLE_DEFS[v.defId];
  const team = state.teams.get(v.teamId);
  if (!def || !team) return;
  const seats = ensureSeats(state, v);
  const dual = def.mainWeaponId != null && commanderIsGunner(def);
  const sw = v.seatSwap;
  if (sw) {
    const man = state.soldiers.get(sw.soldierId);
    if (!able(man, v)) { v.seatSwap = undefined; }
    else if (state.time >= sw.until) {
      seats[sw.role] = man.id;
      if (dual && sw.role === 'gunner') seats.commander = man.id;
      v.seatSwap = undefined;
      if (team.side === state.config.playerSide) addMessage(state, `${team.name}\n${man.rank}. ${man.name} takes over as ${ROLE_WORD[sw.role].toLowerCase()}.`, 'info');
    } else return;
  }
  for (let pi = 0; pi < SEAT_PRIORITY.length; pi++) {
    const role = SEAT_PRIORITY[pi];
    if (!(role in seats)) continue;
    if (dual && role === 'commander') continue; // follows the gunner's seat
    if (seatOccupant(state, v, role)) continue;
    // nobody leaves a working seat for one whose equipment is dead (spec 2026-09-17 §10): an
    // immobilised tank is fought as a pillbox, a tank without its gun is driven
    if (role === 'driver' && isImmobile(v)) continue;
    if (role === 'gunner' && def.mainWeaponId != null && !mainGunUsable(v)) continue;
    for (const from of SEAT_DONORS[role]) {
      if (!(from in seats)) continue;
      if (dual && from === 'commander') continue;
      const donor = seatOccupant(state, v, from);
      if (!donor) continue;
      seats[from] = null;
      if (dual && from === 'gunner') seats.commander = null;
      v.seatSwap = { role, soldierId: donor.id, until: state.time + SEAT_SWAP_S[role] };
      return;
    }
  }
}

export interface CrewEffects {
  /** someone is in the driver's seat */
  canDrive: boolean;
  /** the man laying the main gun, or null (gun silent) */
  gunner: Soldier | null;
  /** hit-chance multiplier of a stand-in gunner (1 for the original gunner) */
  gunnerMul: number;
  /** reload time multiplier: x1.8 when the loader's seat is empty (the commander loads) */
  reloadMul: number;
  commanderUp: boolean;
  /** spotting multiplier: x0.5 without a commander */
  spotMul: number;
  /** seconds added to a change of target without a commander */
  retargetS: number;
}

export const LOADER_DOWN_RELOAD_MUL = 1.8;
export const STAND_IN_GUNNER_MUL = 0.7;

export function crewEffects(state: BattleState, v: Vehicle): CrewEffects {
  const seats = ensureSeats(state, v);
  let gunner = seatOccupant(state, v, 'gunner');
  if (!('gunner' in seats)) {
    const team = state.teams.get(v.teamId);
    if (team) for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (able(s, v)) { gunner = s; break; } }
  }
  let gunnerMul = 1;
  if (gunner && 'gunner' in seats && gunner.id !== originalSeatId(state, v, 'gunner')) {
    gunnerMul = STAND_IN_GUNNER_MUL * clamp((0.7 + gunner.experience / 300) / 0.85, 0.8, 1.1);
  }
  const hasLoaderSeat = 'loader' in seats;
  const commanderUp = !('commander' in seats) || !!seatOccupant(state, v, 'commander');
  return {
    canDrive: !('driver' in seats) || !!seatOccupant(state, v, 'driver'),
    gunner, gunnerMul,
    reloadMul: hasLoaderSeat && !seatOccupant(state, v, 'loader') ? LOADER_DOWN_RELOAD_MUL : 1,
    commanderUp,
    spotMul: commanderUp ? 1 : 0.5,
    retargetS: commanderUp ? 0 : 3,
  };
}

// ------------------------------------------------------------------ equipment states
const SYSTEMS: VehicleSystem[] = ['mainGun', 'coaxMg', 'bowMg', 'sight', 'traverse', 'engine', 'transmission', 'trackL', 'trackR', 'radio', 'fuelLeak'];

export function ensureDamage(v: Vehicle): VehicleDamage {
  if (!v.damage) {
    const d = {} as VehicleDamage;
    for (const k of SYSTEMS) d[k] = 'ok';
    v.damage = d;
  }
  return v.damage;
}
export function systemState(v: Vehicle, sys: VehicleSystem): EquipState { return v.damage?.[sys] ?? 'ok'; }

const RANK: Record<EquipState, number> = { ok: 0, damaged: 1, destroyed: 2 };
/** Damage only ever gets worse. Returns true when the state changed. */
export function worsen(v: Vehicle, sys: VehicleSystem, to: EquipState): boolean {
  const d = ensureDamage(v);
  if (RANK[to] <= RANK[d[sys]]) return false;
  d[sys] = to;
  if (isImmobile(v) && v.state === 'ok') { v.state = 'immobilized'; v.path = []; }
  return true;
}

export function isImmobile(v: Vehicle): boolean {
  const d = v.damage;
  if (!d) return v.state === 'immobilized';
  return v.state === 'immobilized' || d.trackL === 'destroyed' || d.trackR === 'destroyed' || d.engine === 'destroyed' || d.transmission === 'destroyed';
}
/** Speed multiplier from damage: engine damaged x0.5, a damaged track x0.6, transmission x0.6. */
export function damageSpeedMul(v: Vehicle): number {
  const d = v.damage;
  if (!d) return 1;
  let m = 1;
  if (d.engine === 'damaged') m *= 0.5;
  if (d.trackL === 'damaged' || d.trackR === 'damaged') m *= 0.6;
  if (d.transmission === 'damaged') m *= 0.6;
  return m;
}
/** A single damaged track pulls the vehicle to that side: rad/s of unwanted turn while driving. */
export function trackPullRad(v: Vehicle): number {
  const d = v.damage;
  if (!d) return 0;
  const l = d.trackL === 'damaged', r = d.trackR === 'damaged';
  return l === r ? 0 : l ? -0.06 : 0.06;
}
export function mainGunUsable(v: Vehicle): boolean { return systemState(v, 'mainGun') !== 'destroyed'; }
export function coaxUsable(v: Vehicle): boolean { return systemState(v, 'coaxMg') !== 'destroyed'; }
export function turretFrozen(v: Vehicle): boolean { return systemState(v, 'traverse') === 'destroyed' || !!v.turretBlown; }
/** Turret traverse rate multiplier (a jammed ring that still moves is slow). */
export function traverseMul(v: Vehicle): number { return systemState(v, 'traverse') === 'damaged' ? 0.4 : 1; }
export function radioOut(v: Vehicle): boolean { return systemState(v, 'radio') === 'destroyed'; }
/** Orders reach a vehicle without a radio by hand signal or runner. */
export const RADIO_OUT_ORDER_DELAY_S = 8;
/** Sight damaged: accuracy x0.6; destroyed: point-blank fire only (over the barrel). */
export const SIGHT_DESTROYED_MAX_M = 100;
export function sightAccuracyMul(v: Vehicle, distM: number): number {
  const s = systemState(v, 'sight');
  let m = s === 'damaged' ? 0.6 : s === 'destroyed' ? (distM <= SIGHT_DESTROYED_MAX_M ? 0.5 : 0) : 1;
  if (systemState(v, 'mainGun') === 'damaged') m *= 0.8;
  return m;
}

// ------------------------------------------------------------------ hit location
export type ArmorFace = 'front' | 'side' | 'rear' | 'top';
export interface HitLocation {
  zone: VehicleZone;
  face: ArmorFace;
  /** the precise spot, when the round landed on an aimed (or lucky) spot */
  spot?: AimPoint;
}

export const TURRET_ZONES = new Set<VehicleZone>(['turretFront', 'turretSide', 'turretRear', 'mantlet', 'cupola']);

/** Off-axis angle (0 = dead ahead, PI = dead astern) and side (+1 = shooter to the right). */
function aspect(facing: number, from: Vec2, to: Vec2): { off: number; right: number } {
  const d = wrapAngle(angleTo(from, to) - facing);
  return { off: Math.abs(d), right: d >= 0 ? 1 : -1 };
}

/** Chance that a round from this bearing lands on the SIDE rather than the front/rear plate. Front
 * within 40 deg and rear within 25 deg are pure; the side share grows linearly over the next 40. */
export function sideShare(offRad: number): number {
  const deg = offRad / DEG;
  return deg <= 90 ? clamp((deg - 40) / 40, 0, 1) : clamp((180 - deg - 25) / 40, 0, 1);
}

function faceFor(rng: Rng | null, off: number): ArmorFace {
  const p = sideShare(off);
  const side = rng ? rng.next() < p : p >= 0.5;
  return side ? 'side' : off <= Math.PI / 2 ? 'front' : 'rear';
}

/** Hull-down: a wall, bank or crest between the shooter and the hull leaves only the turret to hit
 * (the existing cover and LOS-height tests). */
export function isHullDown(state: BattleState, v: Vehicle, shooterPos: Vec2): boolean {
  if (dist(v.pos, shooterPos) < 1.5) return false;
  if (coverFrom(state.map, v.pos, angleTo(v.pos, shooterPos)) >= 0.45) return true;
  if (!state.map.ground) return false;
  return !hasLOS(state.map, shooterPos, v.pos, { eyeM: 1.2, targetM: 0.6 }) && hasLOS(state.map, shooterPos, v.pos, { eyeM: 1.2, targetM: 2.2 });
}

export interface LocateOpts { aimPoint?: AimPoint; hullDown?: boolean; fromAbove?: boolean }

/** Chance that a centre-of-mass hit lands on a weak spot by luck. */
export const LUCKY_SPOT_CHANCE = 0.06;

function turretZone(rng: Rng, face: ArmorFace, withSmall: boolean): VehicleZone {
  if (face === 'front') {
    if (!withSmall) return 'turretFront';
    const r = rng.next();
    return r < 0.25 ? 'mantlet' : r < 0.32 ? 'cupola' : 'turretFront';
  }
  if (withSmall && rng.next() < 0.08) return 'cupola';
  return face === 'rear' ? 'turretRear' : 'turretSide';
}

/** Where a hit lands: from the attack bearing relative to hull and turret (which differ when the
 * turret is traversed), weighted by presented area; an aimed spot goes where it was aimed when
 * that spot is presented. */
export function locateHit(rng: Rng, v: Vehicle, def: VehicleDef, shooterPos: Vec2 | null, opts: LocateOpts = {}): HitLocation {
  const lay = vehicleLayout(def);
  if (opts.fromAbove || !shooterPos) {
    if (lay.openTop) return { zone: 'top', face: 'top' };
    return rng.next() < 0.35 ? { zone: 'engineDeck', face: 'top' } : { zone: 'top', face: 'top' };
  }
  const hull = aspect(v.hullFacing, v.pos, shooterPos);
  const tur = aspect(def.hasTurret ? v.turretFacing : v.hullFacing, v.pos, shooterPos);
  const hullFace = faceFor(rng, hull.off);
  const turFace = faceFor(rng, tur.off);
  const gear: VehicleZone = hullFace === 'side' ? (hull.right > 0 ? 'runningGearR' : 'runningGearL') : rng.next() < 0.5 ? 'runningGearL' : 'runningGearR';

  const aim = opts.aimPoint && opts.aimPoint !== 'mass' ? opts.aimPoint : undefined;
  if (aim) {
    const hullAim = aim !== 'turretRing' && aim !== 'gunMantlet';
    if (!(hullAim && opts.hullDown)) {
      switch (aim) {
        case 'turretRing': return { zone: turretZone(rng, turFace, false), face: turFace, spot: aim };
        case 'gunMantlet': if (turFace === 'front') return { zone: 'mantlet', face: 'front', spot: aim }; break;
        case 'driverPlate': if (hullFace === 'front') return { zone: 'hullFrontUpper', face: 'front', spot: aim }; break;
        case 'lowerHull': return hullFace === 'front' ? { zone: 'hullFrontLower', face: 'front', spot: aim } : { zone: hullFace === 'rear' ? 'hullRear' : 'hullSide', face: hullFace, spot: aim };
        case 'runningGear': return { zone: gear, face: 'side', spot: aim };
        case 'engineDeck': case 'rear':
          if (hullFace === 'rear') return { zone: 'hullRear', face: 'rear', spot: aim };
          if (hullFace === 'side') return { zone: 'engineDeck', face: 'side', spot: aim };
          break;
        case 'sideHull': if (hullFace === 'side') return { zone: 'hullSide', face: 'side', spot: aim }; break;
      }
    }
  }

  // centre of visible mass
  const turretShare = opts.hullDown ? 1 : 0.31;
  const r = rng.next();
  let loc: HitLocation;
  if (r < turretShare) loc = { zone: turretZone(rng, turFace, true), face: turFace };
  else {
    const h = rng.next();
    if (hullFace === 'front') loc = h < 0.48 ? { zone: 'hullFrontUpper', face: 'front' } : h < 0.78 ? { zone: 'hullFrontLower', face: 'front' } : { zone: gear, face: 'side' };
    else if (hullFace === 'side') loc = h < 0.46 ? { zone: 'hullSide', face: 'side' } : h < 0.70 ? { zone: 'engineDeck', face: 'side' } : { zone: gear, face: 'side' };
    else loc = h < 0.6 ? { zone: 'hullRear', face: 'rear' } : h < 0.75 ? { zone: 'engineDeck', face: 'rear' } : { zone: gear, face: 'side' };
  }
  // luck: a weak spot in the zone that was hit
  if (rng.next() < LUCKY_SPOT_CHANCE) {
    if (TURRET_ZONES.has(loc.zone) && loc.zone !== 'cupola') loc.spot = loc.zone === 'mantlet' ? 'gunMantlet' : 'turretRing';
    else if (loc.zone === 'hullFrontUpper') loc.spot = 'driverPlate';
    else if (loc.zone === 'hullFrontLower') loc.spot = 'lowerHull';
    else if (loc.zone === 'hullRear') loc.spot = 'rear';
  }
  return loc;
}

/** Spot factors on the facing plate (requirements B). */
export const SPOT_ARMOR_FACTOR: Partial<Record<AimPoint, number>> = { turretRing: 0.85, lowerHull: 0.8, driverPlate: 0.9, gunMantlet: 1.1 };
export const RUNNING_GEAR_MM = 20;
const ZONE_ARMOR_FACTOR: Partial<Record<VehicleZone, number>> = { mantlet: 1.1, hullFrontLower: 0.8, cupola: 0.8 };

/** Effective plate (mm) at a hit location. */
export function locationArmorMm(def: VehicleDef, loc: HitLocation): number {
  if (loc.zone === 'runningGearL' || loc.zone === 'runningGearR') return RUNNING_GEAR_MM;
  const base = def.armor[loc.face];
  if (loc.spot) {
    const weak = def.weakSpots?.[loc.spot];
    // a known weak plate only counts from the side it is on (turret ring: any; others: their face)
    const applies = loc.spot === 'turretRing' || (loc.spot === 'rear' || loc.spot === 'engineDeck' ? loc.face === 'rear' : loc.spot === 'sideHull' ? loc.face === 'side' : loc.face === 'front');
    if (weak != null && applies) return Math.min(weak, base * (ZONE_ARMOR_FACTOR[loc.zone] ?? 1));
    // the spot factor replaces the zone factor (lowerHull and gunMantlet are zones of their own)
    const f = SPOT_ARMOR_FACTOR[loc.spot];
    if (f != null && loc.face !== 'top') return base * f;
  }
  return base * (ZONE_ARMOR_FACTOR[loc.zone] ?? 1);
}

/** The plate a gunner reckons with for an aim point from where he stands (no dice: the dominant
 * face for the bearing). Used by aim-point choice, round choice and penChance. */
export function expectedArmorMm(v: Vehicle, def: VehicleDef, shooterPos: Vec2, aim: AimPoint, ace = false): number {
  if (aim === 'runningGear') return RUNNING_GEAR_MM;
  const hull = faceFor(null, aspect(v.hullFacing, v.pos, shooterPos).off);
  const tur = faceFor(null, aspect(def.hasTurret ? v.turretFacing : v.hullFacing, v.pos, shooterPos).off);
  const face: ArmorFace = aim === 'turretRing' || aim === 'gunMantlet' ? tur : aim === 'rear' || aim === 'engineDeck' ? (hull === 'rear' ? 'rear' : 'side') : aim === 'sideHull' ? 'side' : hull;
  const zone: VehicleZone = aim === 'gunMantlet' ? 'mantlet' : aim === 'turretRing' ? 'turretFront' : aim === 'lowerHull' && face === 'front' ? 'hullFrontLower' : 'hullSide';
  if (aim === 'mass') return def.armor[hull];
  const loc: HitLocation = { zone, face, spot: aim };
  if (ace) return locationArmorMm(def, loc);
  return locationArmorMm({ ...def, weakSpots: undefined }, loc);
}

// ------------------------------------------------------------------ what is behind a zone
interface ZoneContents {
  crew: CrewRole[];
  /** chance each of those men is hit by a penetration */
  crewP: number;
  /** equipment and its chance to be damaged by a penetration */
  equip: [VehicleSystem, number][];
  ammoP: number;
  fireP: number;
}

function zoneContents(def: VehicleDef, loc: HitLocation): ZoneContents {
  const lay = vehicleLayout(def);
  const frontDrive = lay.transmission === 'front';
  switch (loc.zone) {
    case 'turretFront': case 'turretSide': case 'turretRear':
      return { crew: ['commander', 'gunner', 'loader'], crewP: 0.42, equip: [['mainGun', 0.2], ['coaxMg', 0.2], ['sight', 0.25], ['traverse', loc.spot === 'turretRing' ? 0.9 : 0.3]], ammoP: loc.zone === 'turretRear' ? 0.3 : 0.16, fireP: 0.06 };
    case 'mantlet':
      return { crew: ['gunner', 'loader'], crewP: 0.25, equip: [['mainGun', 0.6], ['sight', 0.5], ['coaxMg', 0.35]], ammoP: 0.05, fireP: 0.03 };
    case 'cupola':
      return { crew: ['commander'], crewP: 0.75, equip: [], ammoP: 0, fireP: 0 };
    case 'hullFrontUpper':
      return { crew: ['driver', 'radioOp'], crewP: 0.5, equip: [['bowMg', 0.3], ['radio', 0.3], ...(frontDrive ? [['transmission', 0.3] as [VehicleSystem, number]] : [])], ammoP: 0.14, fireP: frontDrive ? 0.1 : 0.08 };
    case 'hullFrontLower':
      return { crew: ['driver'], crewP: 0.3, equip: frontDrive ? [['transmission', 0.75]] : [], ammoP: frontDrive ? 0.1 : 0.2, fireP: frontDrive ? 0.12 : 0.08 };
    case 'hullSide':
      return { crew: ['loader', 'gunner', 'driver', 'radioOp', 'commander'], crewP: 0.2, equip: [['fuelLeak', lay.sideFuel ? 0.45 : 0.1], ['traverse', 0.1]], ammoP: 0.3, fireP: lay.sideFuel ? 0.3 : 0.12 };
    case 'hullRear': case 'engineDeck':
      return { crew: [], crewP: 0, equip: [['engine', 0.8], ['fuelLeak', 0.4], ...(!frontDrive ? [['transmission', 0.4] as [VehicleSystem, number]] : [])], ammoP: 0.03, fireP: 0.45 };
    case 'top':
      return lay.openTop
        ? { crew: ['commander', 'gunner', 'loader', 'driver', 'radioOp'], crewP: 0.4, equip: [['mainGun', 0.15], ['sight', 0.2], ['radio', 0.2]], ammoP: 0.2, fireP: 0.15 }
        : { crew: ['commander', 'gunner', 'loader'], crewP: 0.35, equip: [['sight', 0.15], ['traverse', 0.1]], ammoP: 0.12, fireP: 0.08 };
    default:
      return { crew: [], crewP: 0, equip: [], ammoP: 0, fireP: 0 };
  }
}

/** Does this vehicle have that piece of equipment at all? */
export function hasSystem(def: VehicleDef, sys: VehicleSystem): boolean {
  const lay = vehicleLayout(def);
  switch (sys) {
    case 'radio': return lay.radio;
    case 'bowMg': return lay.bowMg;
    case 'mainGun': case 'sight': return def.mainWeaponId != null;
    case 'coaxMg': return def.coaxWeaponId != null;
    case 'traverse': return def.hasTurret;
    default: return true;
  }
}

/** Behind-armour effect of what came through: APCR cores and small calibres do less than big AP
 * and HE-filled shells. */
export function behindArmorFactor(weapon: WeaponDef, round: RoundType): number {
  if (weapon.cls === 'atrifle') return 0.35;
  let k = clamp(0.55 + weapon.heRadiusM / 9, 0.55, 1.25);
  if (round === 'apcr' && (weapon.apcr?.falloffPerKm ?? 1) > 0) k *= 0.65; // a HEAT jet is not a sub-calibre core
  return k;
}

// ------------------------------------------------------------------ casualties / bail-out
function crewOf(state: BattleState, v: Vehicle, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (able(s, v)) out.push(s); }
  return out;
}

export function hurtCrewman(state: BattleState, v: Vehicle, s: Soldier, to: 'dead' | 'incapacitated' | 'wounded', side: Side, team: Team, quiet = false): void {
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  const role = crewRoleOf(state, v, s.id);
  if (to === 'wounded') {
    if (s.health === 'wounded') return;
    s.health = 'wounded';
    s.morale = clamp(s.morale - 20, 0, 100);
    if (!quiet && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${role ? ROLE_WORD[role] : 'Crewman'} wounded.`, 'bad');
    return;
  }
  s.health = to;
  s.activity = to;
  state.events.push({ kind: 'kill', pos: { ...v.pos }, side });
  state.sides[side].kills++;
  state.sides[s.side].losses++;
  if (!quiet && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${role ? ROLE_WORD[role] : 'Crewman'} ${to === 'dead' ? 'killed' : 'badly wounded'}.`, 'bad');
}

export interface BailOpts {
  /** false: an orderly dismount (ends kneeling by the vehicle); default: a panicked bail-out */
  panicked?: boolean;
  /** why they left: sets how long it takes them to think of going back */
  cause?: 'panic' | 'penetration' | 'heavy' | 'shortCrew';
}

/** A passenger hit inside the compartment: he stays aboard where he fell. */
export function hurtPassenger(state: BattleState, v: Vehicle, s: Soldier, to: 'dead' | 'incapacitated' | 'wounded', side: Side): void {
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  if (to === 'wounded') { if (s.health !== 'wounded') { s.health = 'wounded'; s.morale = clamp(s.morale - 20, 0, 100); } return; }
  s.health = to;
  s.activity = to;
  state.events.push({ kind: 'kill', pos: { ...v.pos }, side });
  state.sides[side].kills++;
  state.sides[s.side].losses++;
  const t = state.teams.get(s.teamId);
  if (t && t.side === state.config.playerSide) addMessage(state, `${t.name}\n${s.rank}. ${s.name} ${to === 'dead' ? 'killed' : 'badly wounded'} in the ${VEHICLE_DEFS[v.defId]?.name ?? 'vehicle'}.`, 'bad');
}

/** The crew leaves the vehicle (reused by the mind model's panic bail-out, spec §10.2): the hull is
 * left in `to` at once, the men get out one per hatch at a time (sim/vehicleCrew.ts, spec
 * 2026-09-17 §10) and end up as infantry beside it. A hull left `abandoned` keeps its damage and
 * ammunition; the crew remembers what drove it out. */
export function bailOut(state: BattleState, v: Vehicle, team: Team, to: 'abandoned' | 'knockedOut' | 'burning', message: string | null = 'Crew bails out!', opts: BailOpts = {}): void {
  if (to === 'abandoned' && (v.state === 'immobilized' || isImmobile(v))) v.wasImmobile = true;
  v.state = to;
  v.path = [];
  v.speed = 0;
  v.bailBy = undefined;
  v.seatSwap = undefined;
  v.remount = undefined;
  if (message && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${message}`, 'bad');
  const crew = crewOf(state, v, team);
  // the crew shared one mind (the commander's): every man takes what it knew and felt with him
  const lead = crew.find((c) => c.id === team.leaderId) ?? crew[0];
  const panicked = opts.panicked ?? true;
  if (lead) {
    let latest: { pos: Vec2; time: number } | null = null;
    for (const b of lead.mind.beliefs) if (!latest || b.time > latest.time) latest = { pos: { ...b.pos }, time: b.time };
    v.bailThreat = latest;
    const exp = crew.reduce((a, c) => a + c.experience, 0) / crew.length;
    v.crewShockUntil = state.time + crewShockSeconds(exp, opts.cause ?? 'panic');
    const floor = opts.cause === 'heavy' ? 95 : opts.cause === 'penetration' ? 85 : panicked ? 75 : 30;
    for (const c of crew) {
      if (c !== lead) {
        c.mind.beliefs = lead.mind.beliefs.map((b) => ({ ...b, pos: { ...b.pos } }));
        c.mind.threatDir = lead.mind.threatDir;
        c.mind.threatLevel = lead.mind.threatLevel;
      }
      c.mind.stress = Math.max(c.mind.stress, lead.mind.stress, floor);
    }
  }
  if (to === 'abandoned') team.order = null;
  startExit(state, v, { panicked, fire: to === 'burning' });
  stepExit(state, NO_RNG, v);
}

/** stepExit only draws when a fire is thinning the crew; bailOut never starts one of those. */
const NO_RNG = { next: (): number => 1 };

/** Seconds a crew has to get out of a vehicle on fire. */
export const FIRE_BAIL_S = 3;

/** A vehicle on fire: the crew goes for the hatches at once, as fast as the hatches allow, and the
 * fire gets some of the men before they reach one. */
function startFireBail(state: BattleState, v: Vehicle, team: Team | undefined): void {
  v.bailBy = state.time + FIRE_BAIL_S;
  v.seatSwap = undefined;
  if (!team) return;
  const crew = crewOf(state, v, team);
  for (const c of crew) c.mind.stress = Math.max(c.mind.stress, 85);
  startExit(state, v, { panicked: true, fire: true });
}

/** Bail-outs in progress (one man per hatch at a time; a crew whose vehicle is on fire has
 * FIRE_BAIL_S before the flames reach the fighting compartment). */
export function stepVehicleDamage(state: BattleState, rng: Rng, v: Vehicle): void {
  if (v.exiting) stepExit(state, rng, v);
  if (v.bailBy != null && state.time >= v.bailBy) v.bailBy = undefined;
}

// ------------------------------------------------------------------ resolving a hit
export interface VehicleHitInput {
  weapon: WeaponDef;
  round?: RoundType;
  shooterPos: Vec2 | null;
  shooterSide: Side;
  shooterTeamId?: number;
  distM: number;
  /** aim point whose spot was actually hit (omit for centre-of-mass resolution) */
  aimPoint?: AimPoint;
  fromAbove?: boolean;
  /** force the location (tests) */
  location?: HitLocation;
}
export interface VehicleHitResult {
  location: HitLocation;
  armorMm: number;
  penetrated: boolean;
  /** the vehicle was knocked out / set on fire / blew up by this hit */
  ko: boolean;
  outcome: 'none' | 'bounced' | 'damaged' | 'immobilised' | 'crewHit' | 'fire' | 'explosion' | 'abandoned' | 'knockedOut';
}

const BIG_CLASSES = new Set(['tankgun', 'atgun', 'atrocket']);
function isBigRound(w: WeaponDef): boolean { return BIG_CLASSES.has(w.cls) || (w.cls === 'grenade' && w.penetrationMm > 0) || (w.cls === 'mortar'); }

function shooterMsg(state: BattleState, input: VehicleHitInput, text: string): void {
  if (input.shooterSide !== state.config.playerSide) return;
  const t = input.shooterTeamId != null ? state.teams.get(input.shooterTeamId) : undefined;
  addMessage(state, `${t?.name ?? 'Report'}\n${text}`, 'good');
}

/** Minimum able crew to keep fighting the vehicle. */
function minCrew(def: VehicleDef): number { return def.crew >= 4 ? 2 : 1; }

function killAll(state: BattleState, v: Vehicle, team: Team, side: Side): void {
  for (const s of crewOf(state, v, team)) hurtCrewman(state, v, s, 'dead', side, team, true);
}

/** One hit on a vehicle, start to finish. */
export function resolveVehicleHit(state: BattleState, rng: Rng, v: Vehicle, input: VehicleHitInput): VehicleHitResult {
  const def = VEHICLE_DEFS[v.defId];
  const round: RoundType = input.round ?? 'ap';
  const weapon = input.weapon;
  const hullDown = !!input.shooterPos && !input.fromAbove && isHullDown(state, v, input.shooterPos);
  // a shooter well above an open compartment, close by, fires down into it
  const looksIn = !!def && !!input.shooterPos && !input.fromAbove && vehicleLayout(def).openTop && input.distM <= LOOK_IN_RANGE_M
    && groundHeightAt(state.map, input.shooterPos) - groundHeightAt(state.map, v.pos) > LOOK_IN_HEIGHT_M;
  const location = input.location ?? (def
    ? locateHit(rng, v, def, input.shooterPos, { aimPoint: input.aimPoint, hullDown, fromAbove: input.fromAbove || looksIn })
    : { zone: 'hullSide' as VehicleZone, face: 'side' as ArmorFace });
  const armorMm = def ? locationArmorMm(def, location) : 9999;
  const res: VehicleHitResult = { location, armorMm, penetrated: false, ko: false, outcome: 'bounced' };
  const team = state.teams.get(v.teamId);
  if (!def || v.state === 'knockedOut' || v.state === 'burning') { res.outcome = 'none'; return res; }

  const lay = vehicleLayout(def);
  const openHit = lay.openTop && location.face === 'top';
  const pen = roundPenetrationMm(weapon, input.distM, round);
  res.penetrated = pen > 0 && penetrates(weapon, input.distM, armorMm, rng, round);
  // an open top stops nothing that bursts over it
  if (!res.penetrated && openHit && weapon.heRadiusM > 0) res.penetrated = true;

  const isGear = location.zone === 'runningGearL' || location.zone === 'runningGearR';
  const trackSys: VehicleSystem = location.zone === 'runningGearL' ? 'trackL' : 'trackR';
  const wasImmobile = isImmobile(v);
  const name = def.name;

  if (!res.penetrated) {
    nonPenetrating(state, rng, v, def, team, input, location, armorMm, pen);
    if (!wasImmobile && isImmobile(v)) { res.outcome = 'immobilised'; shooterMsg(state, input, `${name} immobilised.`); }
    return res;
  }

  v.hits++;
  if (isGear) {
    worsen(v, trackSys, rng.next() < 0.7 ? 'destroyed' : 'damaged');
    res.outcome = isImmobile(v) ? 'immobilised' : 'damaged';
    if (!wasImmobile && isImmobile(v)) {
      shooterMsg(state, input, `Hit the tracks — ${name} immobilised.`);
      if (team && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${location.zone === 'runningGearL' ? 'Left' : 'Right'} track broken.`, 'bad');
    }
    crewStress(state, v, team, 10);
    return res;
  }

  const c = zoneContents(def, location);
  const k = behindArmorFactor(weapon, round);

  // ---- catastrophic: ammunition, then fire
  // (sim/vehicleExplosion.ts) a penetration into the ammunition: sometimes the whole load goes up at
  // once — a real area event; an empty rack cannot, a nearly empty one rarely does, HE-heavy loads
  // and Soviet 76 mm racks more often — otherwise the propellant burns: a fierce fire that may
  // still cook the rounds off later
  if (def.mainWeaponId && v.mainAmmo > 0 && rng.next() < c.ammoP * k) {
    state.events.push({ kind: 'vehicleKO', pos: { ...v.pos }, side: input.shooterSide });
    res.ko = true;
    if (rng.next() < rackDetonationChance(state, v, def)) {
      if (team) killAll(state, v, team, input.shooterSide);
      detonateVehicle(state, rng, v, input.shooterSide); // blast, turret, crater, "Ammunition explodes!"
      shooterMsg(state, input, `${name}: ammunition explodes!`);
      res.outcome = 'explosion';
      return res;
    }
    v.state = 'burning';
    v.path = []; v.speed = 0;
    v.cookOff = { checkedS: 0, pops: 0, rackFire: true };
    startFireBail(state, v, team);
    if (team && team.side === state.config.playerSide) addMessage(state, `${team.name}\nAmmunition on fire — bail out!`, 'bad');
    shooterMsg(state, input, `${name} is burning.`);
    res.outcome = 'fire';
    return res;
  }
  const fireP = (c.fireP + (systemState(v, 'fuelLeak') !== 'ok' ? 0.25 : 0)) * clamp(k, 0.5, 1.2);
  // ---- crew in the zone
  let casualties = 0;
  if (team && c.crewP > 0) {
    for (const role of c.crew) {
      const s = seatOccupant(state, v, role);
      if (!s) continue;
      if (role === 'commander' && location.zone !== 'cupola' && location.zone !== 'top' && seatOccupant(state, v, 'gunner')?.id === s.id && c.crew.includes('gunner')) continue; // rolled as gunner
      if (rng.next() >= c.crewP * k) continue;
      const r = rng.next();
      hurtCrewman(state, v, s, r < 0.5 ? 'dead' : r < 0.7 ? 'incapacitated' : 'wounded', input.shooterSide, team);
      if (r < 0.7) casualties++;
    }
  }
  // ---- passengers in the fighting compartment (sim/transport.ts)
  if (team && (location.zone === 'top' || location.zone === 'hullSide' || location.zone === 'hullRear')) {
    const pP = (location.zone === 'top' ? 0.4 : 0.25) * k;
    for (const s of passengersAboard(state, v)) {
      if (s.health === 'dead' || s.health === 'incapacitated' || rng.next() >= pP) continue;
      const r = rng.next();
      hurtPassenger(state, v, s, r < 0.45 ? 'dead' : r < 0.65 ? 'incapacitated' : 'wounded', input.shooterSide);
    }
  }
  stressPassengers(state, v, 30);
  // ---- equipment in the zone
  for (const [sys, p] of c.equip) {
    if (!hasSystem(def, sys)) continue;
    if (rng.next() >= p * clamp(k, 0.6, 1.1)) continue;
    const to: EquipState = sys === 'fuelLeak' ? 'damaged' : rng.next() < 0.55 ? 'destroyed' : 'damaged';
    if (worsen(v, sys, to) && team && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${systemWord(sys, to)}.`, 'bad');
  }
  if (location.spot === 'turretRing' && systemState(v, 'traverse') !== 'ok') shooterMsg(state, input, 'Turret ring hit — turret jammed.');
  if (location.spot === 'gunMantlet' && systemState(v, 'mainGun') === 'destroyed') shooterMsg(state, input, `${name}: main gun knocked out.`);
  if (!wasImmobile && isImmobile(v)) shooterMsg(state, input, `${name} immobilised.`);

  if (rng.next() < fireP) {
    v.state = 'burning';
    v.path = []; v.speed = 0;
    startFireBail(state, v, team);
    state.events.push({ kind: 'vehicleKO', pos: { ...v.pos }, side: input.shooterSide });
    if (team && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${location.zone === 'hullRear' || location.zone === 'engineDeck' ? 'Engine on fire' : 'Vehicle on fire'} — bail out!`, 'bad');
    shooterMsg(state, input, `${name} is burning.`);
    res.ko = true; res.outcome = 'fire';
    return res;
  }

  // ---- the tank fights on with what is left, unless the crew has had enough
  crewStress(state, v, team, 25);
  res.outcome = casualties > 0 ? 'crewHit' : isImmobile(v) && !wasImmobile ? 'immobilised' : 'damaged';
  if (team && v.state !== 'abandoned') {
    const left = crewOf(state, v, team);
    const exp = left.length > 0 ? left.reduce((a, s) => a + s.experience, 0) / left.length : 0;
    let bailP = 0.5 - exp / 200 + 0.18 * casualties;
    if (isImmobile(v)) bailP += 0.25;
    if (def.mainWeaponId && !mainGunUsable(v)) bailP += 0.2;
    if (left.length < minCrew(def) || rng.next() < bailP) {
      // a hull that still has something useful working is only abandoned: its crew may come back
      // (spec 2026-09-17 §10); recruits who saw a comrade killed by the hit may never
      const stays = left.length > 0 && isServiceable(v);
      if (stays && casualties > 0 && exp < 40 && rng.next() < 0.6) v.noReturn = true;
      bailOut(state, v, team, stays ? 'abandoned' : 'knockedOut', left.length > 0 ? 'Crew bails out!' : null, { cause: casualties > 0 ? 'heavy' : 'penetration', panicked: exp < 60 || casualties > 0 });
      state.events.push({ kind: 'vehicleKO', pos: { ...v.pos }, side: input.shooterSide });
      shooterMsg(state, input, `${name} knocked out.`);
      res.ko = true; res.outcome = 'knockedOut';
    }
  } else if (v.state === 'abandoned') {
    v.state = 'knockedOut';
    state.events.push({ kind: 'vehicleKO', pos: { ...v.pos }, side: input.shooterSide });
    res.ko = true; res.outcome = 'knockedOut';
  }
  return res;
}

function crewStress(state: BattleState, v: Vehicle, team: Team | undefined, amount: number): void {
  if (!team) return;
  for (const s of crewOf(state, v, team)) addStress(s.mind, amount * (1.4 - s.experience / 100));
}

/** A hit that did not get through: spall, jammed ring, broken optics, track and antenna damage,
 * men hit in an open compartment; green crews may leave a tank that still works. */
function nonPenetrating(
  state: BattleState, rng: Rng, v: Vehicle, def: VehicleDef, team: Team | undefined, input: VehicleHitInput,
  loc: HitLocation, armorMm: number, penMm: number,
): void {
  const weapon = input.weapon;
  const lay = vehicleLayout(def);
  const big = isBigRound(weapon);
  const say = (sys: VehicleSystem, to: EquipState): void => {
    if (!hasSystem(def, sys)) return;
    if (worsen(v, sys, to) && team && team.side === state.config.playerSide) addMessage(state, `${team.name}\n${systemWord(sys, to)}.`, 'bad');
  };
  if (!big) {
    // small arms and AT rifles: only men in an open compartment, from the side, rear or above
    const above = loc.zone === 'top';
    if (lay.openTop && team && ((TURRET_ZONES.has(loc.zone) && loc.face !== 'front') || above) && rng.next() < (above ? 0.3 : 0.1)) {
      const riders = passengersAboard(state, v).filter((p) => p.health !== 'dead' && p.health !== 'incapacitated');
      if (riders.length > 0 && rng.next() < riders.length / (riders.length + 2)) {
        const r = rng.next();
        hurtPassenger(state, v, riders[rng.int(0, riders.length - 1)], r < 0.35 ? 'dead' : r < 0.55 ? 'incapacitated' : 'wounded', input.shooterSide);
        stressPassengers(state, v, 8);
        return;
      }
      const crew = crewOf(state, v, team);
      if (crew.length > 0) {
        const s = crew[rng.int(0, crew.length - 1)];
        const r = rng.next();
        hurtCrewman(state, v, s, r < 0.35 ? 'dead' : r < 0.55 ? 'incapacitated' : 'wounded', input.shooterSide, team);
      }
    }
    return;
  }
  stressPassengers(state, v, 10);
  const isGear = loc.zone === 'runningGearL' || loc.zone === 'runningGearR';
  if (isGear) { if (rng.next() < 0.35) say(loc.zone === 'runningGearL' ? 'trackL' : 'trackR', 'damaged'); return; }
  const turret = TURRET_ZONES.has(loc.zone);
  if (turret && rng.next() < (loc.spot === 'turretRing' ? 0.35 : 0.06)) {
    say('traverse', loc.spot === 'turretRing' && rng.next() < 0.5 ? 'destroyed' : 'damaged');
    if (loc.spot === 'turretRing') shooterMsg(state, input, 'Turret ring hit — turret jammed.');
  }
  if ((loc.zone === 'mantlet' || loc.zone === 'turretFront') && rng.next() < (loc.spot === 'gunMantlet' ? 0.4 : 0.07)) say('sight', rng.next() < 0.3 ? 'destroyed' : 'damaged');
  if (loc.zone === 'mantlet' && rng.next() < (loc.spot === 'gunMantlet' ? 0.3 : 0.05)) say('mainGun', rng.next() < 0.5 ? 'destroyed' : 'damaged');
  if (loc.zone === 'hullFrontUpper' && rng.next() < 0.05) say('bowMg', 'destroyed');
  if (rng.next() < (weapon.heRadiusM >= 4 ? 0.07 : 0.03)) say('radio', 'destroyed');
  if (!turret && weapon.heRadiusM >= 4 && rng.next() < 0.06) say(rng.next() < 0.5 ? 'trackL' : 'trackR', 'damaged');
  // spall: a big round that nearly got through
  if (team && penMm >= armorMm * 0.75 && rng.next() < 0.2) {
    const c = zoneContents(def, loc);
    const men = c.crew.map((r) => seatOccupant(state, v, r)).filter((s): s is Soldier => !!s);
    if (men.length > 0) hurtCrewman(state, v, men[rng.int(0, men.length - 1)], rng.next() < 0.3 ? 'incapacitated' : 'wounded', input.shooterSide, team);
  }
  // green crews may bail out of a still-working tank (the shared mind is the commander's)
  if (team && v.state !== 'abandoned') {
    const crew = crewOf(state, v, team);
    const lead = crew[0];
    if (lead && lead.experience < 35 && (lead.mind.state === 'cowering' || lead.mind.state === 'panicked') && rng.next() < 0.2) {
      bailOut(state, v, team, 'abandoned', 'Crew bails out!', { cause: 'panic' });
    }
  }
}

/** HE bursting beside or on a vehicle (mortar bombs, grenades, charges, shells that fell short):
 * a burst on the hull is a hit from above; near an open-topped vehicle fragments reach the crew. */
export function onBlastNearVehicle(state: BattleState, rng: Rng, v: Vehicle, pos: Vec2, weapon: WeaponDef, shooterSide: Side): void {
  if (v.state === 'knockedOut' || v.state === 'burning') return;
  const def = VEHICLE_DEFS[v.defId];
  if (!def || weapon.heRadiusM <= 0) return;
  const dM = dist(v.pos, pos) * TILE_M;
  if (dM > Math.max(weapon.heRadiusM, 2)) return;
  if (dM <= Math.max(1.5, def.widthM / 2)) {
    resolveVehicleHit(state, rng, v, { weapon, round: weapon.rounds ? 'he' : 'ap', shooterPos: null, shooterSide, distM: 0, fromAbove: true });
    return;
  }
  const team = state.teams.get(v.teamId);
  if (!team) return;
  const f = 1 - dM / weapon.heRadiusM;
  if (vehicleLayout(def).openTop) {
    for (const s of passengersAboard(state, v)) {
      if (s.health === 'dead' || s.health === 'incapacitated' || rng.next() >= 0.3 * f * weapon.lethality) continue;
      const r = rng.next();
      hurtPassenger(state, v, s, r < 0.3 ? 'dead' : r < 0.5 ? 'incapacitated' : 'wounded', shooterSide);
    }
    for (const s of crewOf(state, v, team)) {
      if (rng.next() >= 0.3 * f * weapon.lethality) continue;
      const r = rng.next();
      hurtCrewman(state, v, s, r < 0.3 ? 'dead' : r < 0.5 ? 'incapacitated' : 'wounded', shooterSide, team);
    }
    const left = crewOf(state, v, team);
    if (left.length < minCrew(def) && v.state !== 'abandoned') bailOut(state, v, team, 'abandoned', left.length > 0 ? 'Crew bails out!' : null, { cause: 'shortCrew', panicked: left.some((c) => c.mind.state === 'panicked' || c.mind.state === 'cowering') });
  }
  if (weapon.heRadiusM >= 5 && dM <= 3 && rng.next() < 0.12) worsen(v, rng.next() < 0.5 ? 'trackL' : 'trackR', 'damaged');
}

// ------------------------------------------------------------------ words / renderer view
const SYSTEM_WORDS: Record<VehicleSystem, [string, string]> = {
  mainGun: ['Main gun damaged', 'Main gun destroyed'],
  coaxMg: ['Coax MG damaged', 'Coax MG destroyed'],
  bowMg: ['Bow MG damaged', 'Bow MG destroyed'],
  sight: ['Sight damaged', 'Sight destroyed'],
  traverse: ['Traverse jammed', 'Turret stuck'],
  engine: ['Engine damaged', 'Engine destroyed'],
  transmission: ['Gearbox damaged', 'Gearbox destroyed'],
  trackL: ['Left track damaged', 'Left track broken'],
  trackR: ['Right track damaged', 'Right track broken'],
  radio: ['Radio damaged', 'Radio destroyed'],
  fuelLeak: ['Fuel leak', 'Fuel leak'],
};
export function systemWord(sys: VehicleSystem, st: EquipState): string { return SYSTEM_WORDS[sys][st === 'destroyed' ? 1 : 0]; }
/** Every damage word the soldier monitor can show (width-fit test). */
export const DAMAGE_WORDS: string[] = Array.from(new Set(Object.values(SYSTEM_WORDS).flat()));

export interface VehicleDamageView {
  /** thin smoke trail from the engine deck (engine damaged/destroyed, not yet burning) */
  engineSmoke: boolean;
  burning: boolean;
  /** a broken track lies slewed beside the hull */
  brokenTrack: 'L' | 'R' | 'both' | null;
  turretBlown: boolean;
  /** where the blown-off turret lies (tile coords) and its direction; absent = beside the hull */
  turretLanding?: { pos: Vec2; dir: number };
  /** atlas state key for the turret sprite, or null for the normal one */
  turretKey: 'turret.blown' | null;
  /** damaged systems for the HUD, worst first */
  systems: { system: VehicleSystem; state: EquipState; word: string }[];
}

export function vehicleDamageView(v: Vehicle): VehicleDamageView {
  const d = v.damage;
  const systems: VehicleDamageView['systems'] = [];
  if (d) for (const k of SYSTEMS) if (d[k] !== 'ok') systems.push({ system: k, state: d[k], word: systemWord(k, d[k]) });
  systems.sort((a, b) => RANK[b.state] - RANK[a.state]);
  const l = d?.trackL === 'destroyed', r = d?.trackR === 'destroyed';
  return {
    engineSmoke: !!d && d.engine !== 'ok' && v.state !== 'burning' && v.state !== 'knockedOut',
    burning: v.state === 'burning',
    brokenTrack: l && r ? 'both' : l ? 'L' : r ? 'R' : null,
    turretBlown: !!v.turretBlown,
    turretLanding: v.turretBlown && v.turretLanding ? { pos: v.turretLanding, dir: v.turretLandingDir ?? 0 } : undefined,
    turretKey: v.turretBlown ? 'turret.blown' : null,
    systems,
  };
}
