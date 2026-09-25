// Ammunition choice and aim points. A gunner firing at armour picks the ROUND (plain AP, the scarce
// APCR when AP will not do, HE for soft targets, smoke) and the AIM POINT (centre of mass for a
// recruit; a disabling or a killing spot for men who know their trade). Pure functions of the
// state: no dice here, the dice are in combat.ts / vehicleDamage.ts.
import type {
  AimPoint, BattleState, RoundCounts, RoundType, Soldier, Terrain, Vec2, Vehicle, VehicleDef, WeaponDef,
} from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, wrapAngle } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { apcrIssued, bestRoundAgainst, expectedPenetrationChance } from './ballistics';
import { expectedArmorMm } from './vehicleDamage';
import { addMessage } from './messages';
import { bresenhamTiles } from './los';

// ------------------------------------------------------------------ round counts
/** Splits a total into the weapon's load: APCR and smoke are absolute counts (they were scarce),
 * AP and HE share the rest in the load's ratio. Weapons without `rounds`: everything is 'ap'. */
export function splitRounds(weapon: WeaponDef | undefined, total: number, year?: number): RoundCounts {
  const out: RoundCounts = { ap: 0, apcr: 0, he: 0, smoke: 0 };
  total = Math.max(0, Math.floor(total));
  const load = weapon?.rounds;
  if (!weapon || !load) { out.ap = total; return out; }
  out.apcr = apcrIssued(weapon, year) ? Math.min(load.apcr ?? 0, total) : 0;
  out.smoke = Math.min(load.smoke ?? 0, total - out.apcr);
  const rest = total - out.apcr - out.smoke;
  const share = load.ap + load.he > 0 ? load.ap / (load.ap + load.he) : 1;
  out.ap = Math.round(rest * share);
  out.he = rest - out.ap;
  return out;
}

/** A re-split after the totals were changed elsewhere never hands back scarce rounds already used. */
function resplit(prev: RoundCounts | undefined, next: RoundCounts): RoundCounts {
  if (!prev) return next;
  for (const k of ['apcr', 'smoke'] as const) {
    if (next[k] > prev[k]) { next.he += next[k] - prev[k]; next[k] = prev[k]; }
  }
  return next;
}

function total(c: RoundCounts): number { return c.ap + c.apcr + c.he + c.smoke; }

/** A gun gunner's rounds by type (lazy: split from ammo + reserve the first time, and re-split if
 * other code changed the totals behind our back). */
export function soldierRounds(state: BattleState | null, s: Soldier): RoundCounts {
  const w = WEAPONS[s.weaponId];
  const want = s.ammo + s.ammoReserve;
  if (!s.rounds || total(s.rounds) !== want) s.rounds = resplit(s.rounds, splitRounds(w, want, state?.config.year));
  return s.rounds;
}

/** A vehicle's main-gun rounds by type (sum = mainAmmo). */
export function vehicleRounds(state: BattleState | null, v: Vehicle): RoundCounts {
  const def = VEHICLE_DEFS[v.defId];
  const w = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!v.rounds || total(v.rounds) !== v.mainAmmo) v.rounds = resplit(v.rounds, splitRounds(w, v.mainAmmo, state?.config.year));
  return v.rounds;
}

export const ROUND_LABEL: Record<RoundType, string> = { ap: 'AP', apcr: 'APCR', he: 'HE', smoke: 'Smk' };

const outOfMsg = new WeakMap<BattleState, Set<string>>();
/** "<team>\nOut of APCR." once per team and type (own side only). */
export function noteOutOf(state: BattleState, teamId: number, round: RoundType): void {
  const team = state.teams.get(teamId);
  if (!team || team.side !== state.config.playerSide) return;
  let set = outOfMsg.get(state);
  if (!set) { set = new Set(); outOfMsg.set(state, set); }
  const key = `${teamId}:${round}`;
  if (set.has(key)) return;
  set.add(key);
  addMessage(state, `${team.name}\nOut of ${ROUND_LABEL[round]}.`, 'warn');
}

// ------------------------------------------------------------------ round choice
export type RoundTarget =
  | { kind: 'vehicle'; armorMm: number; distM: number }
  | { kind: 'soft' }
  | { kind: 'smoke' };

/** Plain AP is good enough at this chance; below it the crew reaches for APCR. */
export const AP_GOOD_ENOUGH = 0.6;
/** APCR is worth its scarcity when it has at least this chance and clearly beats AP. */
export const APCR_WORTH_IT = 0.25;

/** The round to load for this target from what is left. Null = nothing left to fire. */
export function chooseRound(weapon: WeaponDef, counts: RoundCounts, target: RoundTarget): RoundType | null {
  if (!weapon.rounds) return counts.ap > 0 ? 'ap' : null;
  const first = (...order: RoundType[]): RoundType | null => order.find((r) => counts[r] > 0) ?? null;
  if (target.kind === 'smoke') return first('smoke', 'he', 'ap', 'apcr');
  if (target.kind === 'soft') return first('he', 'ap', 'apcr');
  const pAp = counts.ap > 0 ? expectedPenetrationChance(weapon, target.distM, target.armorMm, 'ap') : 0;
  if (pAp >= AP_GOOD_ENOUGH) return 'ap';
  const pApcr = counts.apcr > 0 && weapon.apcr ? expectedPenetrationChance(weapon, target.distM, target.armorMm, 'apcr') : 0;
  if (pApcr >= APCR_WORTH_IT && pApcr > pAp + 0.15) return 'apcr';
  // AP anyway (at the running gear, see aim points); HE beats nothing but is better than silence
  return first('ap', 'apcr', 'he');
}

/** Best penetration chance this gun has, with the rounds it has left, against a plate. */
export function bestChance(weapon: WeaponDef, counts: RoundCounts | null, distM: number, armorMm: number, year?: number): { round: RoundType; chance: number } {
  return bestRoundAgainst(weapon, distM, armorMm, year, counts ?? undefined);
}

// ------------------------------------------------------------------ gunner skill
export const SKILL_REGULAR = 0.35;
export const SKILL_VETERAN = 0.65;
export const SKILL_ACE = 0.85;

/** 0..1: experience (= know-how, mind spec §1) degraded by stress and suppression: a shaken
 * veteran shoots like a novice. */
export function gunnerSkill(s: Soldier): number {
  let k = clamp(s.experience / 100, 0, 1);
  k *= 1 - clamp(s.suppression / 100, 0, 1) * 0.7;
  const st = s.mind?.state;
  if (st === 'shaken') k *= 0.6;
  else if (st === 'pinned' || st === 'cowering' || st === 'panicked' || st === 'broken') k *= 0.3;
  else if (st === 'wary') k *= 0.9;
  const stress = s.mind?.stress ?? 0;
  if (stress > 50) k *= 1 - (stress - 50) / 100;
  return clamp(k, 0, 1);
}

// ------------------------------------------------------------------ aim points
/** Size of the spot relative to the whole vehicle: hit chance multiplier at short range. */
export const SPOT_HIT_MUL: Record<AimPoint, number> = {
  mass: 1, turretRing: 0.55, lowerHull: 0.7, driverPlate: 0.6, gunMantlet: 0.6, runningGear: 0.8,
  engineDeck: 0.7, sideHull: 0.8, rear: 0.8,
};
/** Extra lay time of an aimed shot (x1.2 .. x1.4: the smaller the spot the longer). */
export function aimLayMul(aim: AimPoint): number {
  return aim === 'mass' ? 1 : 1.2 + 0.2 * clamp((0.8 - SPOT_HIT_MUL[aim]) / 0.25, 0, 1);
}
/** Beyond this range even a veteran lays on the centre of mass; an ace further out. */
export const AIMED_MAX_M = 500;
export const AIMED_MAX_ACE_M = 800;
/** Of the rounds that miss the spot, this share still hits the vehicle somewhere. */
export const SPOT_MISS_STILL_HITS = 0.75;

export const AIM_WORD: Record<AimPoint, string> = {
  mass: 'centre', turretRing: 'turret ring', lowerHull: 'lower hull', driverPlate: 'driver plate',
  gunMantlet: 'mantlet', runningGear: 'tracks', engineDeck: 'engine', sideHull: 'side', rear: 'rear',
};
/** Every "Aiming: ..." line the soldier monitor can show. */
export const AIM_WORDS: string[] = Object.values(AIM_WORD).map((w) => `Aiming: ${w}`);

/** Hit-chance multiplier for laying on a spot: its size, falling with range and target movement. */
export function spotHitMul(aim: AimPoint, distM: number, targetMoving: boolean, skill: number): number {
  if (aim === 'mass') return 1;
  const maxM = skill > SKILL_ACE ? AIMED_MAX_ACE_M : AIMED_MAX_M;
  const rangeTerm = 1 - 0.35 * clamp(distM / maxM, 0, 1);
  return SPOT_HIT_MUL[aim] * rangeTerm * (targetMoving ? 0.8 : 1);
}

export interface AimChoice {
  aimPoint: AimPoint;
  /** the round he reckons with */
  round: RoundType;
  /** his estimate of penetrating at that spot */
  chance: number;
  /** hold fire a moment: the target is turning and about to show a better plate */
  hold: boolean;
}

/** A plate counts as beatable from this chance up. */
export const BEATABLE = 0.35;

function faceOff(v: Vehicle, from: Vec2): number { return Math.abs(wrapAngle(angleTo(v.pos, from) - v.hullFacing)); }

/** Is the target turning so that it will show more of its side or rear to `from` in a moment? */
function turningToFlank(v: Vehicle, from: Vec2): boolean {
  if (v.path.length === 0) return false;
  const heading = angleTo(v.pos, v.path[0]);
  const now = faceOff(v, from);
  const then = Math.abs(wrapAngle(angleTo(v.pos, from) - heading));
  return Math.abs(wrapAngle(heading - v.hullFacing)) > 0.3 && then > now + 0.3 && then > (50 * Math.PI) / 180;
}

/** The gunner's aim point on `target` (requirements B). `counts` = the rounds he has left
 * (null = assume every issued type), `skill` from `gunnerSkill`. */
export function chooseAimPoint(
  weapon: WeaponDef, counts: RoundCounts | null, skill: number, from: Vec2, target: Vehicle, year?: number,
): AimChoice {
  const def: VehicleDef | undefined = VEHICLE_DEFS[target.defId];
  const distM = dist(from, target.pos) * TILE_M;
  const at = (aim: AimPoint, ace = false) => bestChance(weapon, counts, distM, def ? expectedArmorMm(target, def, from, aim, ace) : 9999, year);
  const mass = at('mass');
  const choice: AimChoice = { aimPoint: 'mass', round: mass.round, chance: mass.chance, hold: false };
  if (!def || weapon.penetrationMm <= 0) return choice;
  const moving = Math.abs(target.speed) > 0.1;
  const ace = skill > SKILL_ACE;
  const maxM = ace ? AIMED_MAX_ACE_M : AIMED_MAX_M;
  if (skill < SKILL_REGULAR || distM > maxM) return choice;

  const gear = at('runningGear');
  if (skill <= SKILL_VETERAN) {
    // regular: the tracks when his best round will not beat the plate facing him
    if (mass.chance < BEATABLE && gear.chance >= BEATABLE && !isStopped(target)) return { aimPoint: 'runningGear', round: gear.round, chance: gear.chance, hold: false };
    return choice;
  }

  // veteran / ace: best expected outcome for the geometry and the round
  const off = faceOff(target, from);
  const seesRear = off >= (135 * Math.PI) / 180;
  const seesSide = !seesRear && off > (60 * Math.PI) / 180;
  const kill: AimPoint[] = seesRear ? ['rear', 'turretRing'] : seesSide ? ['sideHull', 'turretRing'] : ['turretRing', 'driverPlate', 'lowerHull'];
  // his reckoning: a centre-of-mass hit that gets through kills about every other time; a round that
  // misses the spot narrowly still lands somewhere on the vehicle
  const massScore = mass.chance * MASS_VALUE;
  let best: AimChoice | null = null;
  let bestScore = massScore;
  for (const aim of kill) {
    const c = at(aim, ace);
    if (c.chance < BEATABLE) continue;
    const pSpot = spotHitMul(aim, distM, moving, skill);
    const score = c.chance * pSpot * KILL_VALUE[aim]! + (1 - pSpot) * SPOT_MISS_STILL_HITS * massScore;
    if (score > bestScore) { bestScore = score; best = { aimPoint: aim, round: c.round, chance: c.chance, hold: false }; }
  }
  if (best) return best;
  if (mass.chance >= BEATABLE) return choice;

  // cannot be beaten from here: wait for the flank if it is coming, else disable
  if (turningToFlank(target, from)) return { ...choice, hold: true };
  if (!isStopped(target) && gear.chance >= BEATABLE) return { aimPoint: 'runningGear', round: gear.round, chance: gear.chance, hold: false };
  const mant = at('gunMantlet', ace);
  if (off <= (60 * Math.PI) / 180) return { aimPoint: 'gunMantlet', round: mant.round, chance: mant.chance, hold: false };
  return choice;
}

const MASS_VALUE = 0.55;
/** Relative worth of a penetration at a kill spot (what is behind it). */
const KILL_VALUE: Partial<Record<AimPoint, number>> = { turretRing: 1.0, driverPlate: 0.85, lowerHull: 0.8, sideHull: 1.1, rear: 1.15 };

/** Already immobilised: no point shooting the tracks off again. */
function isStopped(v: Vehicle): boolean {
  return v.state === 'immobilized' || v.damage?.trackL === 'destroyed' || v.damage?.trackR === 'destroyed';
}

/** Longest a veteran waits for a flank presentation. */
export const AIM_HOLD_MAX_S = 4;

// ------------------------------------------------------------------ moving-target lead
/** A moving target is harder to hit in proportion to its speed: the gunner must take correct
 * lead, and taking lead costs him. 1 at rest, ~0.55 at a fast advance (11 m/s road). Deterministic
 * — no rng draw, so hit-chance banding stays repeatable for tests. */
export function leadFactor(speedMs: number): number {
  return 1 / (1 + speedMs / 14);
}

/** Vegetation a direct-fire AT round must not be launched through. Walls stop or deflect shells,
 * and a bazooka/panzerschreck round bursts on anything it cannot pass. Exported for the shot-path
 * gate in combat.ts and its tests. */
export interface ShotBlock {
  tile: Vec2;
  /** 'wood' = stops/bursts AT rockets, shells punch through; 'hard' = stops everything */
  kind: 'wood' | 'hard';
}

const AT_ROCKET_BLOCKING = new Set<Terrain>(['hedge', 'buildingWood', 'fence']);
const SHELL_BLOCKING = new Set<Terrain>(['buildingWood', 'stonewall', 'buildingStone']);

/** The first blocker a straight shot from `from` to `to` crosses, ignoring the endpoints' own
 * tiles (a firer in woods shoots out of them; the target's cover is its own business). */
export function shotBlocker(map: { tiles: Terrain[]; width: number }, from: Vec2, to: Vec2, atRocket: boolean): ShotBlock | null {
  const tiles = bresenhamTiles(Math.floor(from.x), Math.floor(from.y), Math.floor(to.x), Math.floor(to.y));
  for (let i = 1; i < tiles.length - 1; i++) {
    const t = tiles[i];
    const terrain = map.tiles[t.y * map.width + t.x];
    if (atRocket ? AT_ROCKET_BLOCKING.has(terrain) : SHELL_BLOCKING.has(terrain)) {
      return { tile: t, kind: terrain === 'buildingWood' || terrain === 'hedge' || terrain === 'fence' ? 'wood' : 'hard' };
    }
  }
  return null;
}
