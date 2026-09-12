import type {
  BattleEvent, BattleState, Health, Side, Soldier, Team, Vec2, Vehicle, WeaponDef,
} from '@/shared/types';
import { TILE_M, otherSide } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingAngle, facingTo, angleTo, turnTowards, wrapAngle } from '@/shared/math';
import { hitChance, penetrates, armorFacingFor, damageRoll } from './ballistics';
import { tileAt, coverAt, setTile, idx } from './map';
import { hasLOS } from './los';
import { addSmoke } from './smoke';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';

export { hitChance, penetrates };

// ---------------------------------------------------------------- tracking
interface CombatTrack {
  grenadeTimer: Map<number, number>;
  outOfAmmoMessaged: Set<number>;
  smokeRounds: Map<number, { count: number; lastAt: number }>;
  /** small-arms (rifle/smg/lmg/hmg/pistol/coaxmg) rounds fired/landed-as-hits vs soldiers,
   * for the balance harness's "hit rate" metric (see tools/simHarness / test/harness.test.ts). */
  smallArmsFired: number;
  smallArmsHit: number;
}

const tracks = new WeakMap<BattleState, CombatTrack>();

function getTrack(state: BattleState): CombatTrack {
  let t = tracks.get(state);
  if (!t) {
    t = {
      grenadeTimer: new Map(), outOfAmmoMessaged: new Set(), smokeRounds: new Map(),
      smallArmsFired: 0, smallArmsHit: 0,
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

// ------------------------------------------------------------------ target
type Target =
  | { kind: 'soldier'; soldier: Soldier }
  | { kind: 'vehicle'; vehicle: Vehicle }
  | { kind: 'point'; pos: Vec2 };

function targetPosOf(target: Target): Vec2 {
  switch (target.kind) {
    case 'soldier': return target.soldier.pos;
    case 'vehicle': return target.vehicle.pos;
    case 'point': return target.pos;
  }
}

function tracerKindFor(weapon: WeaponDef): 'bullet' | 'shell' | 'mortar' {
  if (weapon.cls === 'mortar') return 'mortar';
  if (weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket') return 'shell';
  return 'bullet';
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

function canSoldierFire(s: Soldier): boolean {
  if (s.vehicleId != null) return false;
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'panicked' || s.activity === 'cowering') return false;
  return !!WEAPONS[s.weaponId];
}

function gatherCandidates(state: BattleState, side: Side): { soldiers: Soldier[]; vehicles: Vehicle[] } {
  const soldiers: Soldier[] = [];
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead') soldiers.push(s);
  }
  const vehicles: Vehicle[] = [];
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    if (v && v.state !== 'knockedOut') vehicles.push(v);
  }
  return { soldiers, vehicles };
}

function pickTarget(state: BattleState, soldier: Soldier, team: Team | undefined, weapon: WeaponDef): Target | null {
  const map = state.map;
  if (soldier.activity === 'movingFast') return null;

  let maxRangeM = weapon.rangeM;
  if (soldier.activity === 'sneaking') maxRangeM = Math.min(maxRangeM, 20);
  else if (soldier.activity === 'moving') maxRangeM = Math.min(maxRangeM, 60);

  const order = team?.order;
  if (order?.type === 'ambush') maxRangeM = Math.min(maxRangeM, 40);
  if (order?.type === 'smoke') return null;

  const inRangeLOS = (pos: Vec2): boolean => {
    const dM = dist(soldier.pos, pos) * TILE_M;
    if (dM > maxRangeM) return false;
    return hasLOS(map, soldier.pos, pos);
  };

  const { soldiers: cands, vehicles: vcands } = gatherCandidates(state, soldier.side);
  const preferVehicles = AT_WEAPON_CLASSES.has(weapon.cls);

  if (order?.type === 'fire' && order.target) {
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
    if (inRangeLOS(order.target)) return { kind: 'point', pos: order.target };
    return null;
  }

  let best: Soldier | Vehicle | null = null;
  let bestD = Infinity;
  let bestIsVehicle = false;
  if (preferVehicles) {
    for (const v of vcands) {
      if (!inRangeLOS(v.pos)) continue;
      const d = dist(soldier.pos, v.pos);
      if (d < bestD) { bestD = d; best = v; bestIsVehicle = true; }
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
  if (!best) return null;
  return bestIsVehicle ? { kind: 'vehicle', vehicle: best as Vehicle } : { kind: 'soldier', soldier: best as Soldier };
}

// ------------------------------------------------------------------ hits
export function applyHit(
  state: BattleState,
  victim: Soldier,
  weapon: WeaponDef,
  rng: Rng,
  killerSide?: Side,
  killer?: Soldier,
): void {
  const cover = coverAt(state.map, victim.pos);
  const result: Health | null = damageRoll(weapon, cover, rng);
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

  const resolvedKillerSide = killerSide ?? otherSide(victim.side);
  const event: BattleEvent = { kind: 'kill', pos: { ...victim.pos }, side: resolvedKillerSide };
  state.events.push(event);
  if (killer) killer.kills++;
  const killerTeam = killer ? state.teams.get(killer.teamId) : undefined;
  if (killerTeam) killerTeam.kills++;
  state.sides[resolvedKillerSide].kills++;
  state.sides[victim.side].losses++;

  if (victim.side === state.config.playerSide) {
    addMessage(state, `${victim.rank}. ${victim.name} has been ${result === 'dead' ? 'killed' : 'incapacitated'}`, 'bad');
  } else {
    addMessage(state, `Enemy soldier killed by ${killerTeam?.name ?? 'friendly forces'}`, 'good');
  }
}

export function applyHESplash(state: BattleState, rng: Rng, pos: Vec2, weapon: WeaponDef, shooterSide: Side): void {
  const map = state.map;
  const radiusTiles = weapon.heRadiusM / TILE_M;
  if (radiusTiles > 0) {
    for (const s of state.soldiers.values()) {
      if (s.health === 'dead' || s.health === 'incapacitated') continue;
      // Crew inside a vehicle are protected by its armor; HE splash (including a shell that
      // failed to penetrate the vehicle it hit) must not roll casualties/suppression against
      // them here. Crew casualties are handled explicitly by koCrew() on penetration.
      if (s.vehicleId != null) continue;
      const d = dist(s.pos, pos);
      if (d > radiusTiles) continue;
      const cover = coverAt(map, s.pos);
      const chance = (1 - d / radiusTiles) * weapon.lethality * (1 - cover * 0.7);
      if (rng.chance(chance)) {
        applyHit(state, s, weapon, rng, shooterSide);
      } else {
        s.suppression = clamp(s.suppression + weapon.suppression * 30, 0, 100);
      }
    }
  }
  const kind = weapon.heRadiusM >= 3 ? 'he' : 'small';
  state.explosions.push({ pos: { ...pos }, radiusM: weapon.heRadiusM, t: 0, kind });
  state.events.push({ kind: 'explosion', pos: { ...pos }, side: shooterSide, weaponId: weapon.id });
  if (weapon.heRadiusM >= 4) {
    const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
    const t = tileAt(map, tx, ty);
    const craterable = new Set(['open', 'grass', 'tallgrass', 'crops', 'snow', 'mud', 'dirtroad']);
    if (craterable.has(t)) {
      setTile(map, tx, ty, 'crater');
      map.craters.push(idx(map, tx, ty));
    }
  }
}

function koCrew(state: BattleState, vehicle: Vehicle, rng: Rng, fullKO: boolean): void {
  const team = state.teams.get(vehicle.teamId);
  if (!team) return;
  if (fullKO) {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      if (rng.chance(0.5)) { s.health = 'dead'; s.activity = 'dead'; }
      else if (rng.chance(0.6)) { s.health = 'wounded'; }
    }
  } else {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      s.health = 'dead';
      s.activity = 'dead';
      break;
    }
  }
}

function fireAtVehicle(
  state: BattleState,
  rng: Rng,
  weapon: WeaponDef,
  shooterPos: Vec2,
  shooterSide: Side,
  vehicle: Vehicle,
  p: number,
  wantTracer: boolean,
): void {
  const kind = tracerKindFor(weapon);
  if (!rng.chance(p)) {
    if (wantTracer) state.tracers.push({ from: { ...shooterPos }, to: { ...vehicle.pos }, t: 0, hit: false, kind });
    return;
  }
  if (wantTracer) state.tracers.push({ from: { ...shooterPos }, to: { ...vehicle.pos }, t: 0, hit: true, kind });

  const distM = dist(shooterPos, vehicle.pos) * TILE_M;
  const facing = armorFacingFor(vehicle, shooterPos);
  const def = VEHICLE_DEFS[vehicle.defId];
  const armorMm = def ? def.armor[facing] : 9999;

  if (weapon.penetrationMm > 0 && penetrates(weapon, distM, armorMm, rng)) {
    vehicle.hits++;
    const roll = rng.next();
    if (roll < 0.5) {
      vehicle.state = rng.chance(0.5) ? 'burning' : 'knockedOut';
      koCrew(state, vehicle, rng, true);
      state.events.push({ kind: 'vehicleKO', pos: { ...vehicle.pos }, side: shooterSide });
    } else if (roll < 0.75) {
      vehicle.state = 'immobilized';
    } else {
      koCrew(state, vehicle, rng, false);
    }
  } else {
    state.events.push({ kind: 'hit', pos: { ...vehicle.pos }, side: shooterSide });
  }

  if (weapon.heRadiusM > 0) applyHESplash(state, rng, vehicle.pos, weapon, shooterSide);
}

// -------------------------------------------------------------- firing
function resolveRound(state: BattleState, rng: Rng, shooter: Soldier, weapon: WeaponDef, target: Target, wantTracer: boolean): void {
  const map = state.map;
  if (target.kind === 'point') {
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      if (dist(s2.pos, target.pos) <= 1) {
        s2.suppression = clamp(s2.suppression + weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5), 0, 100);
      }
    }
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...target.pos }, t: 0, hit: false, kind: tracerKindFor(weapon) });
    return;
  }

  if (target.kind === 'vehicle') {
    const vehicle = target.vehicle;
    const distM = dist(shooter.pos, vehicle.pos) * TILE_M;
    const moving = vehicle.speed > 0.1;
    const p = hitChance(weapon, distM, 0, 'standing', shooter, moving);
    fireAtVehicle(state, rng, weapon, shooter.pos, shooter.side, vehicle, p, wantTracer);
    return;
  }

  const victim = target.soldier;
  const distM = dist(shooter.pos, victim.pos) * TILE_M;
  const cover = coverAt(map, victim.pos);
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const p = hitChance(weapon, distM, cover, victim.stance, shooter, moving);

  if (SMALL_ARMS_CLASSES.has(weapon.cls)) {
    const t = getTrack(state);
    t.smallArmsFired++;
  }

  if (rng.chance(p)) {
    if (SMALL_ARMS_CLASSES.has(weapon.cls)) getTrack(state).smallArmsHit++;
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...victim.pos }, t: 0, hit: true, kind: tracerKindFor(weapon) });
    applyHit(state, victim, weapon, rng, shooter.side, shooter);
  } else {
    const spread = 0.5 + distM / 200;
    const impact = { x: victim.pos.x + rng.gauss() * spread, y: victim.pos.y + rng.gauss() * spread };
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: impact, t: 0, hit: false, kind: tracerKindFor(weapon) });
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      if (s2.id === victim.id) continue;
      if (dist(s2.pos, impact) <= 1) {
        s2.suppression = clamp(s2.suppression + weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5), 0, 100);
      }
    }
    victim.suppression = clamp(victim.suppression + weapon.suppression * 20, 0, 100);
  }
}

function fireBurst(state: BattleState, rng: Rng, soldier: Soldier, weapon: WeaponDef, target: Target): void {
  soldier.fireTimer = 1 / weapon.rate;
  if (soldier.activity !== 'moving' && soldier.activity !== 'sneaking' && soldier.activity !== 'movingFast') {
    soldier.activity = 'firing';
  }
  soldier.lastFiredAt = state.time;
  const tPos = targetPosOf(target);
  soldier.facing = facingTo(soldier.pos, tPos);
  state.flashes.push({ pos: { ...soldier.pos }, facing: facingAngle(soldier.facing), t: 0 });
  state.events.push({ kind: 'shot', pos: { ...soldier.pos }, weaponId: weapon.id, side: soldier.side });

  const tracerEvery = weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg' ? 1 : weapon.cls === 'smg' ? 3 : 0;

  for (let i = 0; i < weapon.burst; i++) {
    if (soldier.ammo <= 0) break;
    soldier.ammo--;
    resolveRound(state, rng, soldier, weapon, target, tracerEvery > 0 && i % tracerEvery === 0);
  }
}

function stepSoldierCombat(state: BattleState, rng: Rng, dt: number, soldier: Soldier, track: CombatTrack): void {
  if (!canSoldierFire(soldier)) return;
  const weapon = WEAPONS[soldier.weaponId];
  if (!weapon || weapon.indirect) return;
  const team = state.teams.get(soldier.teamId);

  if (soldier.activity === 'reloading') {
    soldier.reloadTimer -= dt;
    if (soldier.reloadTimer <= 0) {
      const take = Math.min(weapon.ammo, soldier.ammoReserve);
      soldier.ammo = take;
      soldier.ammoReserve -= take;
      soldier.activity = 'idle';
    }
    return;
  }

  soldier.fireTimer -= dt;

  if (soldier.ammo <= 0) {
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

  const target = pickTarget(state, soldier, team, weapon);
  if (!target) return;
  fireBurst(state, rng, soldier, weapon, target);
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
    if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'sneaking' || s.activity === 'ambushing') continue;
    if (s.grenades <= 0) continue;
    const timer = (track.grenadeTimer.get(s.id) ?? 0) - dt;
    if (timer > 0) { track.grenadeTimer.set(s.id, timer); continue; }

    const enemy = nearestSpottedEnemy(state, s);
    if (enemy && dist(enemy.pos, s.pos) * TILE_M <= 25 && hasLOS(state.map, s.pos, enemy.pos)) {
      s.grenades--;
      track.grenadeTimer.set(s.id, 1 / 0.1);
      state.events.push({ kind: 'shot', pos: { ...s.pos }, weaponId: 'grenade', side: s.side });
      applyHESplash(state, rng, enemy.pos, grenadeWeapon, s.side);
    } else {
      track.grenadeTimer.set(s.id, 1);
    }
  }
}

// ------------------------------------------------------------------- mortars
function teamHasLOSTo(state: BattleState, side: Side, target: Vec2): boolean {
  for (const s of state.soldiers.values()) {
    if (s.side !== side) continue;
    if (s.health === 'dead' || s.health === 'incapacitated') continue;
    if (hasLOS(state.map, s.pos, target)) return true;
  }
  return false;
}

function findEnemyCluster(state: BattleState, side: Side): Vec2 | null {
  const ids = Array.from(state.spotted[side]);
  let best: Vec2 | null = null;
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
    if (count > bestCount) { bestCount = count; best = s.pos; }
  }
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

function stepMortarTeam(state: BattleState, rng: Rng, dt: number, team: Team, track: CombatTrack): void {
  const gunner = findGunner(state, team);
  if (!gunner) return;
  const weapon = WEAPONS[gunner.weaponId];
  if (!weapon) return;

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

  const order = team.order;
  const isSmokeOrder = order?.type === 'smoke' && weapon.smoke;

  let target: Vec2 | null = null;
  if (order?.type === 'fire' && order.target) target = order.target;
  else if (isSmokeOrder) target = order!.target;
  else target = findEnemyCluster(state, team.side);
  if (!target) return;

  const distM = dist(gunner.pos, target) * TILE_M;
  if (distM < (weapon.minRangeM ?? 0) || distM > weapon.rangeM) return;
  if (!teamHasLOSTo(state, team.side, target)) return;

  gunner.fireTimer = 1 / weapon.rate;
  gunner.ammo--;
  gunner.lastFiredAt = state.time;
  gunner.activity = 'firing';
  state.events.push({ kind: 'shot', pos: { ...gunner.pos }, weaponId: weapon.id, side: gunner.side });

  const errM = 3 + distM / 100;
  const errTiles = errM / TILE_M;
  const impact = { x: target.x + rng.gauss() * errTiles, y: target.y + rng.gauss() * errTiles };

  if (isSmokeOrder) {
    const rec = track.smokeRounds.get(team.id) ?? { count: 0, lastAt: -Infinity };
    state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: 'mortar' });
    addSmoke(state.map, impact, 3, 1.0);
    state.explosions.push({ pos: { ...impact }, radiusM: 3, t: 0, kind: 'smoke' });
    state.events.push({ kind: 'explosion', pos: { ...impact }, side: gunner.side, weaponId: weapon.id });
    rec.count++;
    rec.lastAt = state.time;
    track.smokeRounds.set(team.id, rec);
    if (rec.count >= 3) {
      team.order = { type: 'defend', target: order!.target, issuedAt: state.time };
    }
    return;
  }

  state.tracers.push({ from: { ...gunner.pos }, to: impact, t: 0, hit: true, kind: 'mortar' });
  applyHESplash(state, rng, impact, weapon, gunner.side);
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
function vehicleHitChance(weapon: WeaponDef, distM: number, cover: number, stance: Soldier['stance'], moving: boolean): number {
  if (distM > weapon.rangeM) return 0;
  const rf = distM <= 100 ? 1 : Math.pow(100 / distM, 0.8);
  const st = stance === 'standing' ? 1 : stance === 'crouching' ? 0.7 : 0.45;
  const p = weapon.accuracy * rf * (1 - cover * 0.8) * st * (moving ? 0.6 : 1);
  return clamp(p, 0.02, 0.95);
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

function pickVehicleTarget(state: BattleState, vehicle: Vehicle): Target | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;

  if (weapon && weapon.penetrationMm > 0) {
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const id of state.spottedVehicles[vehicle.side]) {
      const v = state.vehicles.get(id);
      if (!v || v.state === 'knockedOut') continue;
      const d = dist(vehicle.pos, v.pos) * TILE_M;
      if (d > weapon.rangeM) continue;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return { kind: 'vehicle', vehicle: best };
  }

  const team = state.teams.get(vehicle.teamId);
  if (team?.order?.type === 'fire' && team.order.target) {
    return { kind: 'point', pos: team.order.target };
  }

  const inf = pickNearestInfantry(state, vehicle, 300);
  if (inf) return { kind: 'soldier', soldier: inf };
  return null;
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

  vehicle.mainFireTimer -= dt;
  vehicle.coaxFireTimer -= dt;

  // smoke order for vehicles
  if (team?.order?.type === 'smoke') {
    const rec = track.smokeRounds.get(vehicle.teamId) ?? { count: 0, lastAt: -Infinity };
    if (state.time - rec.lastAt >= 4 && rec.count < 3) {
      addSmoke(state.map, team.order.target, 3, 1.0);
      state.explosions.push({ pos: { ...team.order.target }, radiusM: 3, t: 0, kind: 'smoke' });
      rec.count++;
      rec.lastAt = state.time;
      track.smokeRounds.set(vehicle.teamId, rec);
      if (rec.count >= 3) team.order = { type: 'defend', target: team.order.target, issuedAt: state.time };
    }
    return;
  }

  const target = pickVehicleTarget(state, vehicle);

  if (target && def.mainWeaponId && vehicle.mainAmmo > 0) {
    const weapon = WEAPONS[def.mainWeaponId];
    const tPos = targetPosOf(target);
    const desired = angleTo(vehicle.pos, tPos);
    const turnRate = (def.turnRateRad || 0.5) * 2;
    if (def.hasTurret) vehicle.turretFacing = turnTowards(vehicle.turretFacing, desired, turnRate * dt);
    const facingRef = def.hasTurret ? vehicle.turretFacing : vehicle.hullFacing;
    const facingDiff = Math.abs(wrapAngle(desired - facingRef));

    if (facingDiff <= 0.1 && vehicle.mainFireTimer <= 0 && hasLOS(state.map, vehicle.pos, tPos)) {
      vehicle.mainFireTimer = 1 / weapon.rate;
      vehicle.mainAmmo--;
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: weapon.id, side: vehicle.side });

      if (target.kind === 'vehicle') {
        const distM = dist(vehicle.pos, target.vehicle.pos) * TILE_M;
        const moving = target.vehicle.speed > 0.1;
        const p = vehicleHitChance(weapon, distM, 0, 'standing', moving);
        fireAtVehicle(state, rng, weapon, vehicle.pos, vehicle.side, target.vehicle, p, true);
      } else if (target.kind === 'soldier') {
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...target.soldier.pos }, t: 0, hit: true, kind: 'shell' });
        if (weapon.heRadiusM > 0) applyHESplash(state, rng, target.soldier.pos, weapon, vehicle.side);
      } else {
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...target.pos }, t: 0, hit: true, kind: 'shell' });
        if (weapon.heRadiusM > 0) applyHESplash(state, rng, target.pos, weapon, vehicle.side);
      }
    }
  }

  if (def.coaxWeaponId && vehicle.coaxAmmo > 0) {
    const coax = WEAPONS[def.coaxWeaponId];
    const infTarget = pickNearestInfantry(state, vehicle, 400);
    if (infTarget && vehicle.coaxFireTimer <= 0 && hasLOS(state.map, vehicle.pos, infTarget.pos)) {
      vehicle.coaxFireTimer = 1 / coax.rate;
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: coax.id, side: vehicle.side });
      for (let i = 0; i < coax.burst && vehicle.coaxAmmo > 0; i++) {
        vehicle.coaxAmmo--;
        const distM = dist(vehicle.pos, infTarget.pos) * TILE_M;
        const cover = coverAt(state.map, infTarget.pos);
        const moving = infTarget.activity === 'moving' || infTarget.activity === 'movingFast';
        const p = vehicleHitChance(coax, distM, cover, infTarget.stance, moving);
        const hit = rng.chance(p);
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...infTarget.pos }, t: 0, hit, kind: 'bullet' });
        if (hit) applyHit(state, infTarget, coax, rng, vehicle.side);
      }
    }
  }
}

// ------------------------------------------------------------------- main
export function stepCombat(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  for (const soldier of state.soldiers.values()) {
    stepSoldierCombat(state, rng, dt, soldier, track);
  }

  stepGrenades(state, rng, dt, track);

  for (const team of state.teams.values()) {
    if (team.vehicleId == null) stepMortarTeam(state, rng, dt, team, track);
  }

  stepSmokeOrders(state);

  for (const vehicle of state.vehicles.values()) {
    stepVehicleCombat(state, rng, dt, vehicle, track);
  }
}
