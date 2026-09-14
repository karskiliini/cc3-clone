import type {
  BattleEvent, BattleMessage, BattleState, Health, Side, Soldier, Team, Vec2, Vehicle, WeaponDef,
} from '@/shared/types';
import type { GameMap, Terrain } from '@/shared/types';
import { AMBUSH_TRIGGER_M, TILE_M, otherSide } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingAngle, facingTo, angleTo, turnTowards, wrapAngle } from '@/shared/math';
import { hitChance, penetrates, armorFacingFor, damageRoll } from './ballistics';
import { tileAt, coverAt, setTile, idx } from './map';
import { hasLOS } from './los';
import { addSmoke } from './smoke';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';
import { coverFrom } from './cover';
import { onIncomingFire, onExplosionNear, onOwnWound, onCasualtySeen, onGunnerHit, onFired, isFirstFireFrozen, addStress } from './mind';
import { onVehicleHit, onVehicleNearMiss } from './vehicle';
import { attackPhase } from './orders';
import type { Order } from '@/shared/types';

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
  /** Balance round 4 instrumentation (see test/harness.test.ts): total shots fired, suppression
   * points applied to the enemy, and mortar HE rounds fired, all keyed by the FIRING side. */
  shotsFiredBySide: Record<Side, number>;
  suppressionAppliedBySide: Record<Side, number>;
  mortarRoundsFiredBySide: Record<Side, number>;
  /** spec §4: MG/rifle suppressive fire on a `fired` belief happens every 3rd opportunity. */
  beliefFireCounter: Map<number, number>;
}

const tracks = new WeakMap<BattleState, CombatTrack>();

function getTrack(state: BattleState): CombatTrack {
  let t = tracks.get(state);
  if (!t) {
    t = {
      grenadeTimer: new Map(), outOfAmmoMessaged: new Set(), smokeRounds: new Map(),
      smallArmsFired: 0, smallArmsHit: 0,
      shotsFiredBySide: { german: 0, soviet: 0 },
      suppressionAppliedBySide: { german: 0, soviet: 0 },
      mortarRoundsFiredBySide: { german: 0, soviet: 0 },
      beliefFireCounter: new Map(),
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

function addShots(state: BattleState, side: Side, n: number): void {
  getTrack(state).shotsFiredBySide[side] += n;
}

function addSuppressionStat(state: BattleState, side: Side, amount: number): void {
  getTrack(state).suppressionAppliedBySide[side] += amount;
}

/** Balance round 4 instrumentation: cumulative shots fired / suppression applied (to the enemy) /
 * mortar HE rounds fired, by firing side, for the whole battle so far. */
export function getCombatInstrumentation(state: BattleState): {
  shotsFiredBySide: Record<Side, number>;
  suppressionAppliedBySide: Record<Side, number>;
  mortarRoundsFiredBySide: Record<Side, number>;
} {
  const t = getTrack(state);
  return {
    shotsFiredBySide: { ...t.shotsFiredBySide },
    suppressionAppliedBySide: { ...t.suppressionAppliedBySide },
    mortarRoundsFiredBySide: { ...t.mortarRoundsFiredBySide },
  };
}

// ------------------------------------------------------------------ target
export type Target =
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

function tracerKindFor(weapon: WeaponDef): 'bullet' | 'mg' | 'shell' | 'mortar' {
  if (weapon.cls === 'mortar') return 'mortar';
  if (weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket') return 'shell';
  if (weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg') return 'mg';
  return 'bullet';
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

function canSoldierFire(s: Soldier, state: BattleState): boolean {
  if (s.vehicleId != null) return false;
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  if (s.activity === 'surrendered' || s.activity === 'routed' || s.activity === 'panicked' || s.activity === 'cowering') return false;
  if (isFirstFireFrozen(state, s.id)) return false;
  return !!WEAPONS[s.weaponId];
}

function gatherCandidates(state: BattleState, side: Side): { soldiers: Soldier[]; vehicles: Vehicle[] } {
  const soldiers: Soldier[] = [];
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated') soldiers.push(s);
  }
  const vehicles: Vehicle[] = [];
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    if (v && v.state !== 'knockedOut') vehicles.push(v);
  }
  return { soldiers, vehicles };
}

// ------------------------------------------------------- attack-unit targeting
/** Weapons that may put suppressive fire on a last known / unseen position (not single-shot AT). */
/** Attack-unit order: a soldier with no shot at his target still engages enemies this close. */
const SELF_DEFENCE_M = 50;
const AREA_FIRE_CLASSES = new Set(['rifle', 'smg', 'lmg', 'hmg', 'coaxmg', 'mortar', 'tankgun']);
/** MG gunners rotate their bursts across the best few members of the target team. */
const mgSpread = new WeakMap<BattleState, Map<number, number>>();

function exposureScore(state: BattleState, shooterPos: Vec2, victim: Soldier): number {
  const cover = coverFrom(state.map, victim.pos, angleTo(victim.pos, shooterPos));
  const st = victim.stance === 'standing' ? 1 : victim.stance === 'crouching' ? 0.7 : 0.45;
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const dM = dist(shooterPos, victim.pos) * TILE_M;
  return (1 - cover * 0.8) * st * (moving ? 1.2 : 1) / (1 + dM / 100);
}

/** Target selection for a soldier under an attack-unit Fire order: the best member of the target
 * team HE can engage (spotted, in range, LOS from his own position); otherwise suppress the tracked
 * / last known position with an area weapon, or wait. Returns 'free' in the hold phase so normal
 * (defend-like) selection applies. */
function pickAttackUnitTarget(
  state: BattleState, soldier: Soldier, weapon: WeaponDef, order: Order, inRangeLOS: (p: Vec2) => boolean,
): Target | null | 'free' {
  const phase = attackPhase(state, order);
  if (phase === 'hold') return 'free';
  const tgt = state.teams.get(order.targetTeamId!);
  if (!tgt) return 'free';
  if (phase === 'tracking') {
    if (tgt.vehicleId != null) {
      const v = state.vehicles.get(tgt.vehicleId);
      const def = v ? VEHICLE_DEFS[v.defId] : undefined;
      const canHurt = AT_WEAPON_CLASSES.has(weapon.cls)
        || ((weapon.cls === 'rifle' || weapon.cls === 'smg' || weapon.cls === 'lmg' || weapon.cls === 'hmg') && !!def && def.armor.side < 20);
      if (v && canHurt && state.spottedVehicles[soldier.side].has(v.id) && v.state !== 'knockedOut' && inRangeLOS(v.pos)) {
        return { kind: 'vehicle', vehicle: v };
      }
      return null; // no point hosing armour with small arms; wait for a shot
    }
    const cands: { s: Soldier; score: number }[] = [];
    for (const id of tgt.soldierIds) {
      if (!state.spotted[soldier.side].has(id)) continue;
      const e = state.soldiers.get(id);
      if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
      if (!inRangeLOS(e.pos)) continue;
      cands.push({ s: e, score: exposureScore(state, soldier.pos, e) });
    }
    if (cands.length > 0) {
      cands.sort((a, b) => b.score - a.score || a.s.id - b.s.id);
      let i = 0;
      if (weapon.cls === 'lmg' || weapon.cls === 'hmg') {
        let m = mgSpread.get(state);
        if (!m) { m = new Map(); mgSpread.set(state, m); }
        const n = (m.get(soldier.id) ?? 0) + 1;
        m.set(soldier.id, n);
        i = n % Math.min(cands.length, 3);
      }
      return { kind: 'soldier', soldier: cands[i].s };
    }
  }
  // no personal shot at a member (tracking) or target lost (suppress): area fire at the ball
  if (AREA_FIRE_CLASSES.has(weapon.cls) && inRangeLOS(order.target)) return { kind: 'point', pos: order.target };
  return null;
}

/** Test hook: the target a soldier would engage right now (same rules as stepSoldierCombat). */
export function pickSoldierTargetForTest(state: BattleState, soldier: Soldier): Target | null {
  const weapon = WEAPONS[soldier.weaponId];
  return weapon ? pickTarget(state, soldier, state.teams.get(soldier.teamId), weapon) : null;
}

function pickTarget(state: BattleState, soldier: Soldier, team: Team | undefined, weapon: WeaponDef): Target | null {
  const map = state.map;
  if (soldier.activity === 'movingFast') return null;

  let maxRangeM = weapon.rangeM;
  if (soldier.activity === 'sneaking') maxRangeM = Math.min(maxRangeM, 20);
  // Balance fix (suspect b follow-up): 60m capped a 'moving' attacker's return fire well short of
  // where the defender (stationary, unrestricted weapon range) could already be hitting them —
  // raised to 100m so an advancing team can shoot back for more of its approach.
  else if (soldier.activity === 'moving') maxRangeM = Math.min(maxRangeM, 100);

  const order = team?.order;
  if (order?.type === 'ambush') maxRangeM = Math.min(maxRangeM, AMBUSH_TRIGGER_M);
  if (order?.type === 'smoke') return null;

  const inRangeLOS = (pos: Vec2): boolean => {
    const dM = dist(soldier.pos, pos) * TILE_M;
    if (dM > maxRangeM) return false;
    return hasLOS(map, soldier.pos, pos);
  };

  const { soldiers: cands, vehicles: vcands } = gatherCandidates(state, soldier.side);
  const preferVehicles = AT_WEAPON_CLASSES.has(weapon.cls);

  if (order?.type === 'fire' && order.target && order.targetTeamId != null) {
    const picked = pickAttackUnitTarget(state, soldier, weapon, order, inRangeLOS);
    if (picked) {
      if (picked !== 'free') return picked;
      // 'hold' phase: watch the last known position but defend against anything that shows up
    } else {
      // No shot at the target unit: he keeps his position and waits, but still defends himself
      // against an enemy at close range (SELF_DEFENCE_M) rather than ignoring it.
      maxRangeM = Math.min(maxRangeM, SELF_DEFENCE_M);
    }
  } else if (order?.type === 'fire' && order.target) {
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
  if (best) return bestIsVehicle ? { kind: 'vehicle', vehicle: best as Vehicle } : { kind: 'soldier', soldier: best as Soldier };

  // spec §4: with no visible enemy, MG/LMG/rifle can put suppressive fire on a `fired` belief
  // (confidence > 0.6, LOS) every 3rd firing opportunity, to conserve ammo. Ambushers never do this
  // (they hold fire until an enemy is actually seen within 30 m).
  const suppressiveClasses = weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'rifle';
  if (suppressiveClasses && order?.type !== 'ambush') {
    const bestBelief = soldier.mind.beliefs
      .filter((b) => b.kind === 'fired' && b.confidence > 0.6 && inRangeLOS(b.pos))
      .sort((a, b) => dist(soldier.pos, a.pos) - dist(soldier.pos, b.pos))[0];
    if (bestBelief) {
      const track = getTrack(state);
      const n = (track.beliefFireCounter.get(soldier.id) ?? 0) + 1;
      track.beliefFireCounter.set(soldier.id, n);
      if (n % 3 === 0) return { kind: 'point', pos: bestBelief.pos };
      return null;
    }
  }
  return null;
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
  // A soldier who is already incapacitated or dead cannot be hit again: no re-rolled outcome, no
  // repeated kill/casualty message, no double-counted kill (regression: the same "has been killed"
  // message and kill event firing twice for one soldier because later shots kept landing on an
  // already-incapacitated body before it was excluded from targeting).
  if (victim.health === 'dead' || victim.health === 'incapacitated') return;

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
  onOwnWound(victim);

  const victimTeamForGunner = state.teams.get(victim.teamId);
  const victimWeapon = WEAPONS[victim.weaponId];
  if (victimTeamForGunner && victimWeapon && (victimWeapon.cls === 'lmg' || victimWeapon.cls === 'hmg')) {
    onGunnerHit(state, victimTeamForGunner);
  }

  const killed = result === 'dead';
  if (victimTeamForGunner) {
    for (const id of victimTeamForGunner.soldierIds) {
      if (id === victim.id) continue;
      const teammate = state.soldiers.get(id);
      if (!teammate || teammate.health === 'dead' || teammate.health === 'incapacitated') continue;
      if (dist(teammate.pos, victim.pos) <= 15 && hasLOS(state.map, teammate.pos, victim.pos)) {
        onCasualtySeen(state, rng, teammate, victim, killed);
      }
    }
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
    const victimTeam = state.teams.get(victim.teamId);
    const verb = result === 'dead' ? 'killed' : 'wounded';
    addMessage(state, `${victimTeam?.name ?? 'Report'}\n${victim.rank}. ${victim.name} has been ${verb}.`, 'bad');
  } else {
    reportEnemyKill(state, killerTeam);
  }
}

/** Coalesced "Enemy soldier killed." report: one line per killer team within 5 s; further kills in
 * that window update the same line to "N enemy soldiers killed." instead of spamming the log. */
const killReportAt = new WeakMap<BattleState, Map<number, { at: number; count: number; msg: BattleMessage }>>();
function reportEnemyKill(state: BattleState, killerTeam: Team | undefined): void {
  let m = killReportAt.get(state);
  if (!m) { m = new Map(); killReportAt.set(state, m); }
  const key = killerTeam?.id ?? -1;
  const prev = m.get(key);
  const name = killerTeam?.name ?? 'Report';
  if (prev && state.time - prev.at < 5 && state.messages.includes(prev.msg)) {
    prev.count++;
    prev.msg.text = `${name}\n${prev.count} enemy soldiers killed.`;
    return;
  }
  addMessage(state, `${name}\nEnemy soldier killed.`, 'good');
  m.set(key, { at: state.time, count: 1, msg: state.messages[state.messages.length - 1] });
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
        const amount = weapon.suppression * 30;
        s.suppression = clamp(s.suppression + amount, 0, 100);
        addSuppressionStat(state, shooterSide, amount);
      }
    }
  }
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    onExplosionNear(state, s, pos);
  }

  const kind = weapon.heRadiusM >= 3 ? 'he' : 'small';
  state.explosions.push({ pos: { ...pos }, radiusM: weapon.heRadiusM, t: 0, kind });
  state.events.push({ kind: 'explosion', pos: { ...pos }, side: shooterSide, weaponId: weapon.id });
  leaveCrater(state, pos, weapon);
}

/** Blast mark size by explosive: grenade ~1 m scorched hole, AT rocket a small scorch, mortar
 * ~2.5 m, tank/AT gun HE 2.6-3.8 m by calibre (heRadiusM), heavy (122 mm+) ~5 m. */
export function craterForWeapon(weapon: WeaponDef): { sizeM: number; kind: 'shell' | 'grenade' } | null {
  if (weapon.heRadiusM <= 0 || weapon.cls === 'flamethrower') return null;
  if (weapon.cls === 'grenade') return { sizeM: 1, kind: 'grenade' };
  if (weapon.cls === 'atrocket') return { sizeM: 1.2, kind: 'grenade' };
  if (weapon.cls === 'mortar') return { sizeM: 2.5, kind: 'shell' };
  const r = weapon.heRadiusM;
  return { sizeM: r >= 8 ? 5 : r >= 5 ? 3.8 : r >= 4 ? 3.2 : 2.6, kind: 'shell' };
}

/** Ground a blast leaves a visible mark on (never buildings, water, bridges or inside woods). */
const MARKABLE_TERRAIN = new Set<Terrain>(['open', 'grass', 'tallgrass', 'crops', 'snow', 'mud', 'dirtroad', 'pavedroad', 'crater', 'trench', 'scatteredtrees', 'rubble']);
/** Ground a blast of heRadiusM >= 4 digs a real 'crater' tile into (crater cover, passable — a
 * dirt road tile stays passable as a crater). This tile rule is deliberately the long-standing,
 * balance-tuned one (the AI harness is sensitive to crater cover near assaults); only the
 * VISIBLE mark is sized by weapon. */
const CRATERABLE_TERRAIN = new Set<Terrain>(['open', 'grass', 'tallgrass', 'crops', 'snow', 'mud', 'dirtroad']);

function leaveCrater(state: BattleState, pos: Vec2, weapon: WeaponDef): void {
  const map: GameMap = state.map;
  const c = craterForWeapon(weapon);
  if (!c) return;
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  const t = tileAt(map, tx, ty);
  if (!MARKABLE_TERRAIN.has(t)) return;
  let onVehicle = false;
  for (const v of state.vehicles.values()) if (dist(v.pos, pos) < 1.2) { onVehicle = true; break; }
  // the visible bowl + ejecta must not spill over a wall, roof or river bank: shrink it to fit
  let sizeM = c.sizeM;
  const reach = Math.ceil(sizeM / TILE_M);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const nt = tileAt(map, tx + dx, ty + dy);
      if (nt !== 'buildingStone' && nt !== 'buildingWood' && nt !== 'floor' && nt !== 'water' && nt !== 'bridge') continue;
      // distance (m) from the blast to the nearest edge of that tile, and the rim that fits
      const ex = Math.max(tx + dx - pos.x, 0, pos.x - (tx + dx + 1));
      const ey = Math.max(ty + dy - pos.y, 0, pos.y - (ty + dy + 1));
      sizeM = Math.min(sizeM, Math.hypot(ex, ey) * TILE_M * 0.9);
    }
  }
  sizeM = Math.max(0.8, sizeM);
  const marks = (map.craterMarks ??= []);
  // repeated rounds into the same spot deepen one hole rather than stacking identical marks
  // (a round bursting on a vehicle's hull only scorches the ground under it)
  const kind = onVehicle ? 'grenade' : c.kind;
  if (onVehicle) sizeM = Math.min(sizeM, 1.2);
  if (!marks.some((m) => m.kind === kind && m.sizeM >= sizeM && dist(m, pos) < 0.35)) {
    marks.push({ x: pos.x, y: pos.y, sizeM: Math.round(sizeM * 100) / 100, kind });
  }
  if (weapon.heRadiusM < 4 || !CRATERABLE_TERRAIN.has(t)) return;
  setTile(map, tx, ty, 'crater');
  map.craters.push(idx(map, tx, ty));
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
    onVehicleNearMiss(state, vehicle, weapon, shooterPos);
    return;
  }
  if (wantTracer) state.tracers.push({ from: { ...shooterPos }, to: { ...vehicle.pos }, t: 0, hit: true, kind });

  const distM = dist(shooterPos, vehicle.pos) * TILE_M;
  const facing = armorFacingFor(vehicle, shooterPos);
  const def = VEHICLE_DEFS[vehicle.defId];
  const armorMm = def ? def.armor[facing] : 9999;

  let penetrated = false;
  if (weapon.penetrationMm > 0 && penetrates(weapon, distM, armorMm, rng)) {
    penetrated = true;
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
  if (vehicle.state !== 'knockedOut' && vehicle.state !== 'burning') {
    onVehicleHit(state, vehicle, weapon, penetrated, { ...shooterPos });
  }

  if (weapon.heRadiusM > 0) applyHESplash(state, rng, vehicle.pos, weapon, shooterSide);
}

// -------------------------------------------------------------- firing
// Balance round 4: near-miss suppression radius widened 1 -> 1.5 tiles (3m) so that massed fire
// aimed near a group (not scoring an actual hit) suppresses the whole group, not just whoever
// happens to stand within 2m of the exact impact point — this is what should be making defenders
// stop shooting back under heavy incoming fire even when the attacker's low hit-chance-in-cover
// means they rarely actually kill anyone (see the suppression fire-rate throttle in
// stepSoldierCombat below, which is what actually converts this suppression into fewer shots back).
const SUPPRESSION_SPLASH_RADIUS_TILES = 1.5;

const NOISE_RADIUS_TILES = 100 / TILE_M;

/** Cheap "noise" stress (spec §2) for soldiers of the affected side within 100 m of an impact, using
 * a loop the caller already runs over all soldiers for splash suppression (no extra O(N) scan). */
function maybeNoiseStress(s2: Soldier, impact: Vec2, weaponCls: WeaponDef['cls']): void {
  if (weaponCls === 'rifle' || weaponCls === 'pistol') return; // only MG bursts / guns / explosions count as "noise"
  if (dist(s2.pos, impact) > NOISE_RADIUS_TILES) return;
  addStress(s2.mind, 1 * (1 - (s2.cover ?? 0) * 0.5));
}

function resolveRound(state: BattleState, rng: Rng, shooter: Soldier, weapon: WeaponDef, target: Target, wantTracer: boolean): void {
  const map = state.map;
  if (target.kind === 'point') {
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      const dTiles = dist(s2.pos, target.pos);
      if (dTiles <= SUPPRESSION_SPLASH_RADIUS_TILES) {
        const amount = weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5);
        s2.suppression = clamp(s2.suppression + amount, 0, 100);
        addSuppressionStat(state, shooter.side, amount);
        onIncomingFire(state, rng, s2, shooter, target.pos, weapon.cls);
      } else {
        maybeNoiseStress(s2, target.pos, weapon.cls);
      }
    }
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...target.pos }, t: 0, hit: false, kind: tracerKindFor(weapon) });
    if (weapon.heRadiusM === 0) state.explosions.push({ pos: { ...target.pos }, radiusM: 0, t: 0, kind: 'small' });
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
  // Directional cover (spec §9): the protection victim's tile offers against fire arriving FROM
  // the shooter's bearing, not the omni `soldier.cover` (kept only for display).
  const angleFromVictimToShooter = angleTo(victim.pos, shooter.pos);
  const cover = coverFrom(map, victim.pos, angleFromVictimToShooter);
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const p = hitChance(weapon, distM, cover, victim.stance, shooter, moving);

  if (SMALL_ARMS_CLASSES.has(weapon.cls)) {
    const t = getTrack(state);
    t.smallArmsFired++;
  }

  if (rng.chance(p)) {
    if (SMALL_ARMS_CLASSES.has(weapon.cls)) getTrack(state).smallArmsHit++;
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: { ...victim.pos }, t: 0, hit: true, kind: tracerKindFor(weapon) });
    onIncomingFire(state, rng, victim, shooter, victim.pos, weapon.cls, false);
    applyHit(state, victim, weapon, rng, shooter.side, shooter);
  } else {
    const spread = 0.5 + distM / 200;
    const impact = { x: victim.pos.x + rng.gauss() * spread, y: victim.pos.y + rng.gauss() * spread };
    if (wantTracer) state.tracers.push({ from: { ...shooter.pos }, to: impact, t: 0, hit: false, kind: tracerKindFor(weapon) });
    if (weapon.heRadiusM === 0) state.explosions.push({ pos: { ...impact }, radiusM: 0, t: 0, kind: 'small' });
    onIncomingFire(state, rng, victim, shooter, impact, weapon.cls);
    for (const s2 of state.soldiers.values()) {
      if (s2.side === shooter.side) continue;
      if (s2.health === 'dead' || s2.health === 'incapacitated') continue;
      if (s2.id === victim.id) continue;
      const dTiles = dist(s2.pos, impact);
      if (dTiles <= SUPPRESSION_SPLASH_RADIUS_TILES) {
        const amount = weapon.suppression * 40 * (1 - (s2.cover ?? 0) * 0.5);
        s2.suppression = clamp(s2.suppression + amount, 0, 100);
        addSuppressionStat(state, shooter.side, amount);
        onIncomingFire(state, rng, s2, shooter, impact, weapon.cls);
      } else {
        maybeNoiseStress(s2, impact, weapon.cls);
      }
    }
    const directAmount = weapon.suppression * 20;
    victim.suppression = clamp(victim.suppression + directAmount, 0, 100);
    addSuppressionStat(state, shooter.side, directAmount);
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
  const flashKind = weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 'shell' as const : undefined;
  state.flashes.push({ pos: { ...soldier.pos }, facing: facingAngle(soldier.facing), t: 0, kind: flashKind });
  state.events.push({ kind: 'shot', pos: { ...soldier.pos }, weaponId: weapon.id, side: soldier.side });

  // Every MG round and every tank/AT shell gets a tracer; small arms (rifle/
  // SMG) show a tracer roughly every 3rd shot, like the original's darting
  // tracer rounds mixed in with the rest of the burst.
  const tracerEvery =
    weapon.cls === 'lmg' || weapon.cls === 'hmg' || weapon.cls === 'coaxmg'
    || weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 1
    : weapon.cls === 'smg' || weapon.cls === 'rifle' ? 3
    : 0;

  let roundsFired = 0;
  for (let i = 0; i < weapon.burst; i++) {
    if (soldier.ammo <= 0) break;
    soldier.ammo--;
    roundsFired++;
    resolveRound(state, rng, soldier, weapon, target, tracerEvery > 0 && i % tracerEvery === 0);
  }
  addShots(state, soldier.side, roundsFired);
}

function stepSoldierCombat(state: BattleState, rng: Rng, dt: number, soldier: Soldier, track: CombatTrack): void {
  if (!canSoldierFire(soldier, state)) return;
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

  // Balance round 4: a soldier's OWN suppression should throttle how often they return fire, not
  // just degrade their accuracy (ballistics.ts's shooterFactor already does that). Design brief
  // §6.7: suppression >60 -> pinned ("won't move, may fire"), >85 -> cowering (doesn't fire, and
  // canSoldierFire already excludes 'cowering'). This makes ">60 fires at ~30% rate, >85 not at
  // all" true from the raw suppression VALUE this same tick, instead of waiting a frame for the
  // activity transition in stepMorale (which runs after stepCombat) to catch up.
  // Berserk soldiers ignore suppression entirely (spec §3); everyone else keeps the throttle above,
  // now driven by the mental state (pinned fires at 30%, cowering/panicked already excluded by
  // canSoldierFire) rather than the raw suppression number, which used to race ahead of the state
  // machine by a tick.
  if (soldier.mind.state !== 'berserk') {
    // Tried loosening 30%->40% and >85->90 (paired with the suppression-decay change above);
    // harness showed the combination made attacker win rate worse, not better. Reverted to the
    // original spec §6.7 thresholds — the shot-volume gap turned out to be dominated by the AI's
    // move/fire-eligibility split (see ai.ts bounding overwatch), not this throttle.
    if (soldier.mind.state === 'pinned' && !rng.chance(0.3)) return;
    if (soldier.suppression > 85) return;
    if (soldier.suppression > 60 && !rng.chance(0.3)) return;
  }

  const target = pickTarget(state, soldier, team, weapon);
  if (!target) return;
  onFired(state, rng, soldier);
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
  // Tried lowering this to 2 (more mortar targets on spread-out defenses); harness showed it made
  // the attacker win rate slightly worse (31%->27%), so reverted to the original threshold.
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
  if (order?.type === 'fire' && order.target) target = attackPhase(state, order) === 'hold' ? findEnemyCluster(state, team.side) : order.target;
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
  track.mortarRoundsFiredBySide[gunner.side]++;
  addShots(state, gunner.side, 1);
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

/** Main-gun target for a vehicle on an attack-unit Fire order: AP at the target vehicle, HE at the
 * best visible member of a target infantry team, HE on the tracked/last known position otherwise. */
function pickVehicleAttackTarget(state: BattleState, vehicle: Vehicle, weapon: WeaponDef | null, order: Order): Target | null | 'free' {
  const phase = attackPhase(state, order);
  if (phase === 'hold') return 'free';
  const tgt = state.teams.get(order.targetTeamId!);
  if (!tgt) return 'free';
  const rangeM = weapon ? weapon.rangeM : 400;
  if (phase === 'tracking') {
    if (tgt.vehicleId != null) {
      const v = state.vehicles.get(tgt.vehicleId);
      if (v && v.state !== 'knockedOut' && state.spottedVehicles[vehicle.side].has(v.id) && dist(vehicle.pos, v.pos) * TILE_M <= rangeM) return { kind: 'vehicle', vehicle: v };
      return null;
    }
    let best: Soldier | null = null;
    let bestScore = -Infinity;
    for (const id of tgt.soldierIds) {
      if (!state.spotted[vehicle.side].has(id)) continue;
      const e = state.soldiers.get(id);
      if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
      if (dist(vehicle.pos, e.pos) * TILE_M > rangeM || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
      const sc = exposureScore(state, vehicle.pos, e);
      if (sc > bestScore) { bestScore = sc; best = e; }
    }
    if (best) return { kind: 'soldier', soldier: best };
  }
  if (weapon && weapon.heRadiusM > 0 && dist(vehicle.pos, order.target) * TILE_M <= rangeM) return { kind: 'point', pos: order.target };
  return null;
}

/** Coax MG target: members of an attack-unit target infantry team first, else nearest spotted. */
function pickCoaxTarget(state: BattleState, vehicle: Vehicle, rangeM: number): Soldier | null {
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId != null && attackPhase(state, order) === 'tracking') {
    const tgt = state.teams.get(order.targetTeamId);
    if (tgt && tgt.vehicleId == null) {
      let best: Soldier | null = null;
      let bestD = Infinity;
      for (const id of tgt.soldierIds) {
        if (!state.spotted[vehicle.side].has(id)) continue;
        const e = state.soldiers.get(id);
        if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
        const d = dist(vehicle.pos, e.pos) * TILE_M;
        if (d > rangeM || d >= bestD || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
        bestD = d; best = e;
      }
      if (best) return best;
    }
  }
  return pickNearestInfantry(state, vehicle, rangeM);
}

function pickVehicleTarget(state: BattleState, vehicle: Vehicle): Target | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  const order = state.teams.get(vehicle.teamId)?.order;
  if (order?.type === 'fire' && order.targetTeamId != null) {
    const picked = pickVehicleAttackTarget(state, vehicle, weapon, order);
    if (picked !== 'free') return picked;
  }

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
      addShots(state, vehicle.side, 1);
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: weapon.id, side: vehicle.side });
      state.flashes.push({ pos: { ...vehicle.pos }, facing: facingRef, t: 0, kind: 'shell' });

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
    const infTarget = pickCoaxTarget(state, vehicle, 400);
    if (infTarget && vehicle.coaxFireTimer <= 0 && hasLOS(state.map, vehicle.pos, infTarget.pos)) {
      vehicle.coaxFireTimer = 1 / coax.rate;
      state.events.push({ kind: 'shot', pos: { ...vehicle.pos }, weaponId: coax.id, side: vehicle.side });
      let coaxRounds = 0;
      for (let i = 0; i < coax.burst && vehicle.coaxAmmo > 0; i++) {
        vehicle.coaxAmmo--;
        coaxRounds++;
        const distM = dist(vehicle.pos, infTarget.pos) * TILE_M;
        const cover = coverAt(state.map, infTarget.pos);
        const moving = infTarget.activity === 'moving' || infTarget.activity === 'movingFast';
        const p = vehicleHitChance(coax, distM, cover, infTarget.stance, moving);
        const hit = rng.chance(p);
        state.tracers.push({ from: { ...vehicle.pos }, to: { ...infTarget.pos }, t: 0, hit, kind: 'bullet' });
        if (hit) {
          applyHit(state, infTarget, coax, rng, vehicle.side);
        } else {
          // Balance round 4: a vehicle coax MG missing should still suppress nearby infantry —
          // this was previously a silent miss with no suppression at all, understating how
          // dangerous a tank's coax MG is to infantry pinned in the open near it.
          for (const s2 of state.soldiers.values()) {
            if (s2.side === vehicle.side || s2.health === 'dead' || s2.health === 'incapacitated') continue;
            if (dist(s2.pos, infTarget.pos) > SUPPRESSION_SPLASH_RADIUS_TILES) continue;
            const amount = coax.suppression * 35 * (1 - (s2.cover ?? 0) * 0.5);
            s2.suppression = clamp(s2.suppression + amount, 0, 100);
            addSuppressionStat(state, vehicle.side, amount);
          }
        }
      }
      addShots(state, vehicle.side, coaxRounds);
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
