// ============================================================================
// vehicleExplosion.ts — a vehicle blowing up as a real area event (user request: "when a tank is
// destroyed, sometimes a huge explosion should occur which hits the nearby soldiers").
//
// * `detonateVehicle`: the ammunition goes up — at once (a penetration into a rack,
//   vehicleDamage.ts) or later (cook-off). A synthetic HE charge sized by the main-gun rounds left
//   (8 m for a few rounds up to 18 m for a full load of large-calibre HE) goes through the ordinary
//   blast machinery (combat.ts applyHESplash: casualties on BOTH sides, ragdoll knockback, loose
//   objects, structure damage, stress), plus: near-certain casualties inside 5 m, knock-down out to
//   0.6 of the radius, riders and men on the hatches caught in it, suppression and a stress spike
//   for everyone within 60 m who sees it, a big crater under the hull, 3-6 heavy fragments
//   (`plate` / `wheel` / `hatch` debris thrown 5-25 m that can injure a man they land on) and the
//   turret thrown 2-8 m (`vehicle.turretLanding`).
// * `stepCookOff`: a burning vehicle. Rounds pop (`cookOffPop`: minor fragments within 5 m) and,
//   10-90 s into the fire, the rest may detonate — chance per second rising with time and with the
//   ammunition load. Vehicles without main-gun ammunition (halftracks, empty racks) can only lose
//   their fuel tank: a small blast. The fire burns for as long as that danger lasts.
// * `fireHazardAt` / `nearFireHazard`: burning vehicles as a danger source (coverSeek.ts,
//   vehicleCrew.ts): men keep 15 m away.
// Deterministic: seeded Rng only, Map / array iteration order only.
// ============================================================================
import type { BattleState, Debris, DebrisKind, Side, Soldier, Vec2, Vehicle, VehicleDef, WeaponDef } from '@/shared/types';
import { TILE_M, otherSide } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { applyHESplash, applyHit, leaveCrater } from './combat';
import { applyDaze } from './daze';
import { DEBRIS_CAP, DEBRIS_VARIANTS, debrisOf } from './debris';
import { hasLOS } from './los';
import { coverAt, inBounds } from './map';
import { addMessage } from './messages';
import { addStress, onKnockedDown } from './mind';
import { isPassable } from './path';
import { vehicleRounds } from './aimPoint';
import { hurtCrewman, hurtPassenger } from './vehicleDamage';

// ------------------------------------------------------------------ the charge
/** Explosive weight of one round relative to an HE round of the same gun (AP and APCR: the
 * propellant and a small burster; smoke: propellant). */
const ROUND_WEIGHT = { he: 1, ap: 0.4, apcr: 0.3, smoke: 0.3 } as const;
/** Charge of a full load of large-calibre HE (IS-2, KV, Tiger and up): the 18 m blast. */
export const FULL_CHARGE = 1400;
export const EXPLOSION_MIN_RADIUS_M = 8;
export const EXPLOSION_MAX_RADIUS_M = 18;
/** Soviet 76 mm racks (F-34 / ZiS-5 / ZiS-3: unprotected racks on the fighting compartment floor and walls). */
const VOLATILE_GUNS = new Set(['f34_76', 'kv_zis5', 'zis3_su76']);

/** Size of what is left in the racks: rounds x shell size (heRadius^2), HE counting in full. */
export function ammoCharge(state: BattleState | null, v: Vehicle, def: VehicleDef): number {
  const w = def.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!w || v.mainAmmo <= 0) return 0;
  const r = vehicleRounds(state, v);
  const n = r.he * ROUND_WEIGHT.he + r.ap * ROUND_WEIGHT.ap + r.apcr * ROUND_WEIGHT.apcr + r.smoke * ROUND_WEIGHT.smoke;
  return n * Math.max(1, w.heRadiusM * w.heRadiusM);
}

/** 0..1: how much of a "full load of large-calibre HE" is aboard. */
export function loadFraction(state: BattleState | null, v: Vehicle, def: VehicleDef): number {
  return clamp(Math.sqrt(ammoCharge(state, v, def) / FULL_CHARGE), 0, 1);
}

/** Blast radius (m) of the ammunition aboard going up; 0 = nothing to explode. */
export function explosionRadiusM(state: BattleState | null, v: Vehicle, def: VehicleDef): number {
  if (ammoCharge(state, v, def) <= 0) return 0;
  return EXPLOSION_MIN_RADIUS_M + (EXPLOSION_MAX_RADIUS_M - EXPLOSION_MIN_RADIUS_M) * loadFraction(state, v, def);
}

/** Chance that a penetration into the ammunition sets the whole load off AT ONCE (otherwise it
 * burns, vehicleDamage.ts): nothing without rounds, less with a nearly empty rack, more for
 * HE-heavy loads and Soviet 76 mm racks. */
export function rackDetonationChance(state: BattleState | null, v: Vehicle, def: VehicleDef): number {
  const w = def.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!w || v.mainAmmo <= 0) return 0;
  const fill = clamp(v.mainAmmo / Math.max(1, def.mainAmmo), 0, 1);
  const r = vehicleRounds(state, v);
  const heShare = r.he / Math.max(1, v.mainAmmo);
  let m = RACK_DETONATION_BASE * (0.3 + 0.7 * fill);
  if (heShare >= 0.5) m *= 1.15;
  if (VOLATILE_GUNS.has(w.id)) m *= 1.25;
  if (w.heRadiusM < 3) m *= 0.8; // small rounds, small bursters
  return clamp(m, 0, 0.9);
}
/** Tuned with the cook-off rate below so that 15-25 % of destroyed gun tanks end catastrophically
 * (test/vehicleExplosion.test.ts measures it). */
export const RACK_DETONATION_BASE = 0.2;

function blastWeapon(id: string, name: string, radiusM: number, lethality: number): WeaponDef {
  // cls 'hmg': none of the gun / mortar / grenade special cases (direction of fire, roof hits,
  // crater class) apply to a charge going off on the spot — everything is sized by heRadiusM
  return {
    id, name, cls: 'hmg', rangeM: 0, rate: 0, burst: 1, accuracy: 0, lethality, suppression: 1,
    penetrationMm: 0, heRadiusM: radiusM, ammo: 0, reloadS: 0,
  };
}

// ------------------------------------------------------------------ heavy fragments / turret
/** Where something heavy thrown `m` metres along `ang` (atan2 radians) comes down: it flies over
 * walls and hedges, so only the landing spot matters — pulled in until a man could stand there. */
function flyEnd(state: BattleState, origin: Vec2, ang: number, m: number): Vec2 {
  const ux = Math.cos(ang), uy = Math.sin(ang);
  for (let d = m; d > 0.5; d -= 1) {
    const q = { x: origin.x + (ux * d) / TILE_M, y: origin.y + (uy * d) / TILE_M };
    const tx = Math.floor(q.x), ty = Math.floor(q.y);
    if (inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry')) return q;
  }
  return { x: origin.x, y: origin.y };
}

/** Same arc timing as the renderer's loose-object flight (render/soldierAnim.ts ragdollDuration). */
function flightSeconds(force: number): number {
  const f = force * 0.85;
  return clamp(0.5 + 0.62 * f * f, 0.5, 1.9);
}

const FRAGMENT_KINDS: DebrisKind[] = ['plate', 'wheel', 'hatch', 'plate', 'wheel', 'plate'];
export const FRAGMENT_HIT_RADIUS_M = 0.9;

function throwFragments(state: BattleState, rng: Rng, v: Vehicle, n: number, minM: number, maxM: number): void {
  const debris = debrisOf(state);
  const season = state.map.def.season;
  const base = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const ang = base + (i / n) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const m = rng.range(minM, maxM);
    const force = clamp(0.8 + m / 25, 0.8, 1.8);
    const part: Debris = {
      kind: FRAGMENT_KINDS[i % FRAGMENT_KINDS.length], side: v.side, season, pos: flyEnd(state, v.pos, ang, m),
      dir: rng.range(0, Math.PI * 2), variant: rng.int(0, DEBRIS_VARIANTS - 1),
      from: { x: v.pos.x, y: v.pos.y }, thrownAt: state.time, force, landAt: state.time + flightSeconds(force),
    };
    debris.push(part);
  }
  if (debris.length > DEBRIS_CAP) debris.splice(0, debris.length - DEBRIS_CAP);
}

/** Heavy fragments coming down: a man under one is hit. Called every step (sim/vehicle.ts). */
export function stepFragmentLandings(state: BattleState, rng: Rng): void {
  const debris = state.debris;
  if (!debris || debris.length === 0) return;
  for (const part of debris) {
    if (part.landAt == null || state.time < part.landAt) continue;
    part.landAt = undefined;
    for (const s of state.soldiers.values()) {
      if (s.vehicleId != null || s.health === 'dead' || s.health === 'incapacitated') continue;
      if (dist(s.pos, part.pos) * TILE_M > FRAGMENT_HIT_RADIUS_M) continue;
      applyHit(state, s, FRAGMENT_WEAPON, rng, otherSide(s.side));
      addStress(s.mind, 20);
    }
  }
}
const FRAGMENT_WEAPON = blastWeapon('vehicle_fragment', 'Wreckage', 0, 0.55);
const POP_WEAPON = blastWeapon('cookoff_pop', 'Cook-off', 0, 0.2);

function throwTurret(state: BattleState, rng: Rng, v: Vehicle, def: VehicleDef, load: number): void {
  v.turretBlown = true;
  // heavier turrets less far: armour thickness stands in for the turret's weight
  const heavy = clamp((def.armor.front + def.armor.side) / 200, 0.15, 1.1);
  const m = clamp((8.5 - 5.5 * heavy) * (0.6 + 0.4 * load) + rng.range(-0.8, 0.8), 2, 8);
  v.turretLanding = flyEnd(state, v.pos, rng.range(0, Math.PI * 2), m);
  // never back onto its own hull
  if (dist(v.turretLanding, v.pos) * TILE_M < 2) v.turretLanding = { x: v.pos.x + 2 / TILE_M, y: v.pos.y };
  v.turretLandingDir = rng.range(0, Math.PI * 2);
}

// ------------------------------------------------------------------ the blast
export const WITNESS_RADIUS_M = 60;
export const INNER_LETHAL_M = 5;
/** Men are knocked down out to this share of the blast radius (an ordinary shell: half). */
export const KNOCKDOWN_SHARE = 0.6;

function everyoneAboardDies(state: BattleState, v: Vehicle, side: Side): void {
  const team = state.teams.get(v.teamId);
  if (team) {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (s && s.vehicleId === v.id) hurtCrewman(state, v, s, 'dead', side, team, true);
    }
  }
  for (const id of v.passengerIds ?? []) {
    const s = state.soldiers.get(id);
    if (s && s.vehicleId === v.id) hurtPassenger(state, v, s, 'dead', side);
  }
  // men on the hatches and doors are blown off the hull with everybody else outside
  for (const s of state.soldiers.values()) if (s.hatch && s.hatch.vehicleId === v.id) { s.hatch = undefined; s.bailRun = undefined; }
}

/** The area event shared by the ammunition and the fuel-tank explosion. */
function blastAt(state: BattleState, rng: Rng, v: Vehicle, weapon: WeaponDef, killerSide: Side, craterM: number): void {
  const pos = { x: v.pos.x, y: v.pos.y };
  const radiusTiles = weapon.heRadiusM / TILE_M;
  const near: Soldier[] = [];
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (dist(s.pos, pos) <= radiusTiles * KNOCKDOWN_SHARE) near.push(s);
  }
  // inside 5 m of an ammunition explosion hardly anyone gets away with it
  if (weapon.heRadiusM >= EXPLOSION_MIN_RADIUS_M) {
    for (const s of near) {
      if (dist(s.pos, pos) * TILE_M > INNER_LETHAL_M) continue;
      const cover = coverAt(state.map, s.pos);
      if (rng.chance(0.9 * (1 - cover * 0.5))) applyHit(state, s, weapon, rng, killerSide);
      else if (cover < 0.5 && s.health === 'healthy') { s.health = 'wounded'; s.morale = clamp(s.morale - 20, 0, 100); }
    }
  }
  const distBefore = new Map<number, number>();
  for (const s of near) distBefore.set(s.id, dist(s.pos, pos));
  applyHESplash(state, rng, pos, weapon, killerSide, undefined, v.id);
  leaveCrater(state, pos, weapon, craterM);
  // the blast wave floors men further out than a shell's would
  for (const s of near) {
    if (s.health === 'dead' || s.health === 'incapacitated') continue;
    if (s.stunnedUntil != null && s.stunnedUntil > state.time) continue;
    const force = clamp(1 - (distBefore.get(s.id) ?? 0) / radiusTiles, 0.2, 1) * clamp(weapon.heRadiusM / 6, 0.4, 1.5);
    s.stunnedUntil = state.time + Math.min(4, rng.range(1.5, 3) + (s.experience < 35 ? 0.5 : 0));
    applyDaze(state, s, force, false);
    s.stance = 'prone';
    s.path = [];
    onKnockedDown(s, force);
  }
}

function shockWitnesses(state: BattleState, pos: Vec2, scale: number): void {
  const rT = WITNESS_RADIUS_M / TILE_M;
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null || s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(s.pos, pos);
    if (d > rT || !hasLOS(state.map, s.pos, pos)) continue;
    const k = (1 - 0.6 * (d / rT)) * scale;
    addStress(s.mind, (s.experience < 35 ? 26 : s.experience < 65 ? 18 : 12) * k);
    s.suppression = clamp(s.suppression + 45 * k, 0, 100);
    s.mind.lastIncomingAt = state.time;
  }
}

/** The ammunition aboard explodes. Returns false (and does nothing) when there is none. */
export function detonateVehicle(state: BattleState, rng: Rng, v: Vehicle, killerSide: Side): boolean {
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return false;
  const radiusM = explosionRadiusM(state, v, def);
  if (radiusM <= 0) return false;
  const load = loadFraction(state, v, def);
  const team = state.teams.get(v.teamId);
  v.fire = { t0: state.time };
  v.state = 'burning';
  v.path = []; v.speed = 0;
  v.exiting = undefined; v.unloading = undefined; v.remount = undefined; v.bailBy = undefined; v.seatSwap = undefined;
  (v.cookOff ??= { checkedS: 0, pops: 0 }).ended = 'detonated';
  everyoneAboardDies(state, v, killerSide);
  if (def.hasTurret) throwTurret(state, rng, v, def, load);
  v.mainAmmo = 0;
  v.rounds = undefined; v.loadedRound = undefined;

  const weapon = blastWeapon('ammo_explosion', 'Ammunition explosion', radiusM, 0.9);
  blastAt(state, rng, v, weapon, killerSide, 4 + 3 * load);
  throwFragments(state, rng, v, rng.int(3, 6), 5, 10 + 15 * load);
  shockWitnesses(state, v.pos, 0.7 + 0.3 * load);
  state.events.push({ kind: 'vehicleExplosion', pos: { ...v.pos }, side: killerSide, radiusM: Math.round(radiusM * 10) / 10, turretLanding: v.turretLanding ? { ...v.turretLanding } : undefined });
  if (team && team.side === state.config.playerSide) addMessage(state, `${team.name}\nAmmunition explodes!`, 'bad');
  return true;
}

export const FUEL_BLAST_RADIUS_M = 5;
/** The fuel tank of a burning vehicle goes up: a small blast, no turret thrown. */
function fuelExplosion(state: BattleState, rng: Rng, v: Vehicle, killerSide: Side): void {
  everyoneAboardDies(state, v, killerSide);
  v.exiting = undefined; v.unloading = undefined;
  const weapon = blastWeapon('fuel_explosion', 'Fuel explosion', FUEL_BLAST_RADIUS_M, 0.45);
  blastAt(state, rng, v, weapon, killerSide, 2.5);
  throwFragments(state, rng, v, rng.int(1, 2), 3, 8);
  shockWitnesses(state, v.pos, 0.35);
  state.events.push({ kind: 'vehicleExplosion', pos: { ...v.pos }, side: killerSide, radiusM: FUEL_BLAST_RADIUS_M });
  const team = state.teams.get(v.teamId);
  if (team && team.side === state.config.playerSide) addMessage(state, `${team.name}\nFuel tank explodes!`, 'bad');
}

// ------------------------------------------------------------------ cook-off
export const COOKOFF_FROM_S = 10;
export const COOKOFF_UNTIL_S = 90;
/** First rounds start popping this long into the fire. */
export const POPS_FROM_S = 5;
/** Detonation chance per second at the END of the window with a full large-calibre load; it rises
 * linearly from a quarter of this at COOKOFF_FROM_S. */
export const COOKOFF_PEAK_PER_S = 0.003;
/** A fire that started in the ammunition itself cooks off this much more readily. */
export const RACK_FIRE_MUL = 2;
/** Chance over the whole window that a burning vehicle without main-gun ammunition loses its fuel tank. */
export const FUEL_BLAST_CHANCE = 0.3;
const POP_RADIUS_M = 5;

/** True while a burning vehicle may still blow up. */
export function cookOffLive(v: Vehicle): boolean {
  return v.state === 'burning' && !v.cookOff?.ended && v.burnTimer < COOKOFF_UNTIL_S;
}

function cookOffPop(state: BattleState, rng: Rng, v: Vehicle): void {
  const lost = Math.min(v.mainAmmo, rng.int(1, 3));
  v.mainAmmo -= lost;
  if (v.cookOff) v.cookOff.pops += lost;
  state.events.push({ kind: 'cookOffPop', pos: { ...v.pos } });
  state.explosions.push({ pos: { ...v.pos }, radiusM: 1.5, t: 0, kind: 'small' });
  const enemy = otherSide(v.side);
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null || s.health === 'dead' || s.health === 'incapacitated') continue;
    const dM = dist(s.pos, v.pos) * TILE_M;
    if (dM > 15) continue;
    s.suppression = clamp(s.suppression + 12 * (1 - dM / 15), 0, 100);
    addStress(s.mind, 4 * (1 - dM / 15));
    if (dM <= POP_RADIUS_M && rng.chance(0.12 * (1 - dM / POP_RADIUS_M) * (1 - coverAt(state.map, s.pos) * 0.7))) applyHit(state, s, POP_WEAPON, rng, enemy);
  }
}

/** One burning vehicle, checked once per second of its fire. */
export function stepCookOff(state: BattleState, rng: Rng, v: Vehicle): void {
  if (v.state !== 'burning') return;
  const co = (v.cookOff ??= { checkedS: 0, pops: 0 });
  if (co.ended) return;
  const def = VEHICLE_DEFS[v.defId];
  if (!def) { co.ended = 'burntOut'; return; }
  while (!co.ended && co.checkedS + 1 <= v.burnTimer) {
    const t = ++co.checkedS;
    if (t > COOKOFF_UNTIL_S) { co.ended = 'burntOut'; break; }
    const load = loadFraction(state, v, def);
    const ramp = t < COOKOFF_FROM_S ? 0 : 0.25 + 0.75 * (t - COOKOFF_FROM_S) / (COOKOFF_UNTIL_S - COOKOFF_FROM_S);
    if (load <= 0) {
      // fuel only: the same rising shape, scaled to FUEL_BLAST_CHANCE over the window
      const area = (COOKOFF_UNTIL_S - COOKOFF_FROM_S) * 0.625;
      if (ramp > 0 && rng.chance((-Math.log(1 - FUEL_BLAST_CHANCE) / area) * ramp)) { co.ended = 'fuel'; fuelExplosion(state, rng, v, otherSide(v.side)); }
      continue;
    }
    if (t >= POPS_FROM_S && rng.chance(0.1 * (0.4 + 0.6 * load))) cookOffPop(state, rng, v);
    const volatile = (def.mainWeaponId != null && VOLATILE_GUNS.has(def.mainWeaponId) ? 1.25 : 1) * (co.rackFire ? RACK_FIRE_MUL : 1);
    if (ramp > 0 && rng.chance(COOKOFF_PEAK_PER_S * ramp * load * volatile)) detonateVehicle(state, rng, v, otherSide(v.side));
  }
}

// ------------------------------------------------------------------ danger source
/** Men keep this far from a burning vehicle. */
export const FIRE_HAZARD_M = 15;

/** Positions of the burning vehicles (tile coords). */
export function fireHazards(state: BattleState): Vec2[] {
  const out: Vec2[] = [];
  for (const v of state.vehicles.values()) if (v.state === 'burning') out.push(v.pos);
  return out;
}

export function nearFireHazard(hazards: readonly Vec2[], p: Vec2, marginM = 0): boolean {
  const r = (FIRE_HAZARD_M + marginM) / TILE_M;
  for (const h of hazards) if (Math.abs(h.x - p.x) <= r && Math.abs(h.y - p.y) <= r && dist(h, p) <= r) return true;
  return false;
}
