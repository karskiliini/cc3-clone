// ============================================================================
// crewWeapon.ts — crew-served weapons (mortars, heavy MGs, AT / infantry guns)
// as objects on the map that are WORKED BY MEN, TASK BY TASK
// (docs/superpowers/specs/2026-09-17-soldier-animation-design.md §6).
//
// A weapon is a small state machine whose transitions are tasks. The state is
// the set of deploy tasks already `done` (guns: unhook, spreadLeft/Right,
// digLeft/Right; mortars: placeBaseplate, mountTube, setBipod; HMGs: placeTripod,
// mountGun, feedBelt) plus the firing chain (`chambered`, `laid`, `recoilUntil`).
// A task only progresses while an ABLE crewman stands at its station and works
// it; the seconds already worked are kept in `progress` when he is hit or
// breaks, and the next man carries on from there. Tasks of one stage (the two
// trail legs, the two spades) are open together, so two men work them in
// parallel and one man one after the other. Each step free able men are
// assigned to the open tasks: nearest first, the leader last, ties by soldier
// id. Men physically walk to the stations, which are points in the weapon
// frame (metres from the pivot, rotated by the weapon's facing).
//
// Firing chain — guns: emplaced -> load (loader at the breech; the round is
// taken from the ammunition here, not at the shot) -> lay (gunner at the sight,
// time by traverse angle; a new or moved target needs a new lay) -> fire ->
// recoil -> emplaced. Mortars: lay (by range) -> dropRound per bomb. HMGs:
// feedBelt (again whenever a belt runs out) -> lay -> the gunner fires.
//
// The weapon stays owned by its gunner soldier (`Soldier.weaponId`), so combat
// only asks `fireMissionWait` whether the round may go and reports it with
// `onMissionRound`. Also here: abandonment / re-manning from the soldier-mind
// spec §11. Deterministic: no rng, only battle time and soldier state.
// ============================================================================
import type {
  BattleState, CrewTaskId, CrewWeaponState, CrewWeaponVisual, FireMission, Soldier, Team, TeamStatusWord, Vec2,
  WeaponClass, OrderType, AimPoint, RoundType, Vehicle,
} from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist, facingAngle, facingFromAngle, turnTowards, wrapAngle } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { findPath, isPassable } from './path';
import { inBounds, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { addMessage } from './messages';
import { VEHICLE_DEFS } from '@/data/units';
import { LOAD_ATGUN_MUL, LAY_MOVING_TARGET_MUL, bracketLost, bracketMul, fineLayBaseS, followUpLayS, laySkillMul, loadSkillMul, weaponLoadS } from './gunTiming';
import { AIM_HOLD_MAX_S, SKILL_ACE, aimLayMul, chooseAimPoint, chooseRound, gunnerSkill, noteOutOf, soldierRounds } from './aimPoint';
import { expectedArmorMm } from './vehicleDamage';
import { formationBaseHeading, rotateOffset } from './spawn';
import { isDazed, recoveryFactor } from './daze';

export type CrewServedClass = 'mortar' | 'hmg' | 'atgun';
const CREW_SERVED = new Set<WeaponClass>(['mortar', 'hmg', 'atgun']);

/** A gunner further than this (tiles) from his set-up weapon has left it. */
export const MANNED_RADIUS_TILES = 6;
/** A crewman this close (tiles) to an abandoned weapon picks it up again. */
export const REMAN_RADIUS_TILES = 1.5;
/** A calm crewman goes back to an abandoned weapon within this range (40 m, spec §11). */
export const RETURN_RADIUS_TILES = 40 / TILE_M;
/** A man this close (tiles) to a station is at it. */
export const AT_STATION_TILES = 0.3;
/** Walking pace between stations, m/s (a crouched scuttle). */
export const STATION_WALK_MS = 1.6;
/** Swinging a limbered gun round by its trail, rad/s. */
const SWING_RATE = 1.2;

const MOVE_ORDERS = new Set<OrderType>(['move', 'moveFast', 'sneak']);

// ------------------------------------------------------------------ tasks
/** Seconds of work per task for an average crew (spec §6 table). TUNING: balance is adjusted here,
 * not in the mechanism. */
export const TASK_S: Record<CrewTaskId, number> = {
  unhook: 2, spreadLeft: 3, spreadRight: 3, digLeft: 2, digRight: 2,
  liftLeft: 1, liftRight: 1, closeLeft: 1.5, closeRight: 1.5, hook: 1,
  placeBaseplate: 3, mountTube: 2, setBipod: 2, liftBipod: 1, dismountTube: 1, liftBaseplate: 1,
  placeTripod: 3, mountGun: 2, feedBelt: 2, dismountGun: 1.5, liftTripod: 1.5,
  load: 3.5, lay: 2, fire: 0, dropRound: 2, unload: 2,
};
/** A gunner feeding his own belts takes twice as long (no assistant: 4 s). */
export const SELF_FEED_FACTOR = 2;
/** Recoil, run-out and case ejection after a gun fires. */
export const RECOIL_S = 0.6;

const DEPLOY_STAGES: Record<CrewServedClass, CrewTaskId[][]> = {
  atgun: [['unhook'], ['spreadLeft', 'spreadRight'], ['digLeft', 'digRight']],
  mortar: [['placeBaseplate'], ['mountTube'], ['setBipod']],
  hmg: [['placeTripod'], ['mountGun'], ['feedBelt']],
};
/** Packing task -> the deploy task it undoes. (A belt is simply lifted out with the gun.) */
const UNDOES: Partial<Record<CrewTaskId, CrewTaskId>> = {
  liftLeft: 'digLeft', liftRight: 'digRight', closeLeft: 'spreadLeft', closeRight: 'spreadRight', hook: 'unhook',
  liftBipod: 'setBipod', dismountTube: 'mountTube', liftBaseplate: 'placeBaseplate',
  dismountGun: 'mountGun', liftTripod: 'placeTripod',
};
const UNDONE_BY: Partial<Record<CrewTaskId, CrewTaskId>> = {};
for (const k of Object.keys(UNDOES) as CrewTaskId[]) UNDONE_BY[UNDOES[k]!] = k;

const PACK_TASKS = new Set<CrewTaskId>(Object.keys(UNDOES) as CrewTaskId[]);
const GUNNER_TASKS = new Set<CrewTaskId>(['lay', 'fire']);
/** Serving tasks the gunner leaves to the others when he can (his place is at the sight). */
const LOADER_TASKS = new Set<CrewTaskId>(['load', 'dropRound', 'feedBelt', 'unload']);

/** Team status word for the first open task (spec §6). */
const TASK_STATUS: Record<CrewTaskId, TeamStatusWord> = {
  unhook: 'Unlimbering', spreadLeft: 'Spreading trails', spreadRight: 'Spreading trails', digLeft: 'Digging in', digRight: 'Digging in',
  liftLeft: 'Packing up', liftRight: 'Packing up', closeLeft: 'Packing up', closeRight: 'Packing up', hook: 'Packing up',
  placeBaseplate: 'Setting up', mountTube: 'Setting up', setBipod: 'Setting up',
  liftBipod: 'Packing up', dismountTube: 'Packing up', liftBaseplate: 'Packing up',
  placeTripod: 'Setting up', mountGun: 'Setting up', feedBelt: 'Loading', dismountGun: 'Packing up', liftTripod: 'Packing up',
  load: 'Loading', lay: 'Aiming', fire: 'Firing', dropRound: 'Loading', unload: 'Loading',
};
/** What one crewman is doing, for the soldier monitor's activity cell. */
export const TASK_WORD: Record<CrewTaskId, string> = {
  unhook: 'Unhooking', spreadLeft: 'Trail leg', spreadRight: 'Trail leg', digLeft: 'Digging in', digRight: 'Digging in',
  liftLeft: 'Lifting spade', liftRight: 'Lifting spade', closeLeft: 'Closing trail', closeRight: 'Closing trail', hook: 'Hooking up',
  placeBaseplate: 'Baseplate', mountTube: 'Mounting tube', setBipod: 'Setting bipod',
  liftBipod: 'Packing up', dismountTube: 'Packing up', liftBaseplate: 'Packing up',
  placeTripod: 'Tripod', mountGun: 'Mounting gun', feedBelt: 'Feeding belt', dismountGun: 'Packing up', liftTripod: 'Packing up',
  load: 'Loading', lay: 'Aiming', fire: 'Firing', dropRound: 'Dropping round', unload: 'Unloading',
};
export const CREW_TASK_WORDS: string[] = Array.from(new Set(Object.values(TASK_WORD)));

/** The word for a crewman's current task, or null when he has none. */
export function crewTaskWord(s: Soldier): string | null {
  return s.crewTask ? TASK_WORD[s.crewTask.id] : null;
}

// ------------------------------------------------------------------ geometry
/** Role positions around a set-up weapon, in metres in the weapon frame (x right, y down; the
 * muzzle points to -y) relative to the weapon pivot (baseplate / tripod / gun axle): the gunner's
 * seat at the sight, the loader at the breech / muzzle / feed, the assistant by the ammunition.
 * Shared by the sim (stations, standby posts) and the renderer. */
export interface CrewLayout { gunner: Vec2; loader: Vec2; assistant: Vec2 }
export const CREW_LAYOUT: Record<CrewServedClass, CrewLayout> = {
  // (numbers copied from the `stations` block of public/sprites/weapons_*.json, y negated: the
  // atlas has y forward, this frame has the muzzle at -y. The sim never reads the loaded art.)
  mortar: { gunner: { x: -0.6, y: -0.1 }, loader: { x: 0.6, y: -0.55 }, assistant: { x: 1.6, y: 1.5 } },
  hmg: { gunner: { x: 0, y: 1.15 }, loader: { x: -0.95, y: 0.1 }, assistant: { x: -1.6, y: 1.6 } },
  atgun: { gunner: { x: -0.55, y: 0.6 }, loader: { x: 0.55, y: 0.95 }, assistant: { x: 1.9, y: 1.9 } },
};
/** Weapons whose stations differ from their class (the Maxim is fed from the right). */
const LAYOUT_OVERRIDE: Record<string, Partial<CrewLayout>> = {
  maxim: { loader: { x: 0.95, y: 0.1 }, assistant: { x: 1.6, y: 1.6 } },
};
export function crewLayout(weaponId: string): CrewLayout {
  const cls = crewServedClass(weaponId) ?? 'atgun';
  return { ...CREW_LAYOUT[cls], ...(LAYOUT_OVERRIDE[weaponId] ?? {}) };
}

/** Where the men grip the trail legs of each gun: leg end swung out / closed for towing, and the
 * tail where the closed trails are held to haul or swing the gun (metres, weapon frame; from the
 * art's `stations`). */
export interface TrailGeom { open: Vec2; closed: Vec2; tailM: number }
const TRAILS: Record<string, TrailGeom> = {
  pak38: { open: { x: 1.28, y: 2.61 }, closed: { x: 0.55, y: 2.45 }, tailM: 3.05 },
  pak40: { open: { x: 1.49, y: 2.95 }, closed: { x: 0.55, y: 2.85 }, tailM: 3.45 },
  m1937_45mm: { open: { x: 1.2, y: 2.54 }, closed: { x: 0.55, y: 2.35 }, tailM: 2.95 },
  zis3: { open: { x: 1.58, y: 3.02 }, closed: { x: 0.55, y: 2.95 }, tailM: 3.55 },
};
const DEFAULT_TRAIL: TrailGeom = { open: { x: 1.4, y: 2.8 }, closed: { x: 0.55, y: 2.65 }, tailM: 3.25 };
export function trailGeom(weaponId: string): TrailGeom { return TRAILS[weaponId] ?? DEFAULT_TRAIL; }

/** Where the man working one trail leg stands (metres, weapon frame). `side` -1 = left, +1 = right;
 * `open` 0..1 — he walks the arc with the leg as he swings it out. */
export function trailEndM(weaponId: string, side: -1 | 1, open: number): Vec2 {
  const g = trailGeom(weaponId);
  const t = clamp(open, 0, 1);
  // along an arc about the trail hinge near the axle, not a straight chord
  const a0 = Math.atan2(g.closed.x, g.closed.y), a1 = Math.atan2(g.open.x, g.open.y);
  const r0 = Math.hypot(g.closed.x, g.closed.y), r1 = Math.hypot(g.open.x, g.open.y);
  const a = a0 + (a1 - a0) * t, r = r0 + (r1 - r0) * t;
  return { x: side * Math.sin(a) * r, y: Math.cos(a) * r };
}

/** Distance (m) from the axle to where the haulers hold the closed trails. */
export function towLengthM(weaponId: string): number { return trailGeom(weaponId).tailM; }

export function crewServedClass(weaponId: string): CrewServedClass | null {
  const w = WEAPONS[weaponId];
  return w && CREW_SERVED.has(w.cls) ? (w.cls as CrewServedClass) : null;
}

/** World (tile) position of a weapon-frame offset given in metres. */
export function weaponFramePoint(pivot: Vec2, facing: number, offM: Vec2): Vec2 {
  const r = rotateOffset({ x: offM.x / TILE_M, y: offM.y / TILE_M }, facing);
  return { x: pivot.x + r.x, y: pivot.y + r.y };
}

/** Weapon pivot for a gunner at `gunnerPos` serving a weapon that faces `facing`. */
export function pivotFromGunner(cls: CrewServedClass, gunnerPos: Vec2, facing: number): Vec2 {
  const r = rotateOffset({ x: CREW_LAYOUT[cls].gunner.x / TILE_M, y: CREW_LAYOUT[cls].gunner.y / TILE_M }, facing);
  return { x: gunnerPos.x - r.x, y: gunnerPos.y - r.y };
}

function taskFrac(cw: CrewWeaponState, task: CrewTaskId): number {
  if (cw.done?.includes(task)) return 1;
  return clamp((cw.progress?.[task] ?? 0) / Math.max(1e-6, TASK_S[task]), 0, 1);
}

/** How far each trail leg is swung out, 0..1 (left, right) — for the renderer and the stations. */
export function trailOpenFrac(cw: CrewWeaponState): { left: number; right: number } {
  const one = (spread: CrewTaskId, close: CrewTaskId): number => {
    if (cw.done?.includes(spread)) return 1 - clamp((cw.progress?.[close] ?? 0) / TASK_S[close], 0, 1);
    return taskFrac(cw, spread);
  };
  return { left: one('spreadLeft', 'closeLeft'), right: one('spreadRight', 'closeRight') };
}

/** Station of a task in the weapon frame, metres from the pivot. Trail-leg stations travel with
 * the leg as it swings. */
export function taskStationM(cw: CrewWeaponState, cls: CrewServedClass, task: CrewTaskId): Vec2 {
  const L = crewLayout(cw.weaponId);
  const open = trailOpenFrac(cw);
  switch (task) {
    case 'unhook': case 'hook': return { x: 0, y: towLengthM(cw.weaponId) };
    case 'spreadLeft': case 'closeLeft': case 'digLeft': case 'liftLeft': return trailEndM(cw.weaponId, -1, open.left);
    case 'spreadRight': case 'closeRight': case 'digRight': case 'liftRight': return trailEndM(cw.weaponId, 1, open.right);
    case 'placeBaseplate': case 'liftBaseplate': return { x: 0, y: 0.6 };
    case 'mountTube': case 'dismountTube': return { x: 0.65, y: 0.2 };
    case 'setBipod': case 'liftBipod': return { x: 0, y: -1.75 };
    case 'placeTripod': case 'liftTripod': return { x: 0, y: cw.weaponId === 'maxim' ? 1.75 : 0.7 };
    case 'mountGun': case 'dismountGun': return { x: 0.7, y: 0.55 };
    case 'load': case 'dropRound': case 'feedBelt': case 'unload': return L.loader;
    case 'lay': case 'fire': return L.gunner;
  }
}

export function taskStation(cw: CrewWeaponState, cls: CrewServedClass, task: CrewTaskId): Vec2 {
  return weaponFramePoint(cw.pos, cw.facing, taskStationM(cw, cls, task));
}

// ------------------------------------------------------------------ crew
function isActive(s: Soldier | undefined): s is Soldier {
  return !!s && s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId == null;
}

function isFleeing(s: Soldier): boolean {
  return s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'surrendered';
}

/** Spec §6: a task only progresses while a living, able crewman works it — not dead,
 * incapacitated, stunned, pinned, cowering, panicked, routed or surrendered. */
export function isAbleCrewman(state: BattleState, s: Soldier | undefined): s is Soldier {
  if (!isActive(s) || isFleeing(s)) return false;
  if (s.stunnedUntil != null && state.time < s.stunnedUntil) return false;
  if (isDazed(s, state.time)) return false; // dazed by a blast (sim/daze.ts): another man takes his task
  if (s.dodgeUntil != null && state.time < s.dodgeUntil) return false; // leaping clear of a vehicle
  if (s.activity === 'pinned' || s.activity === 'cowering') return false;
  const m = s.mind.state;
  return m !== 'pinned' && m !== 'cowering' && m !== 'panicked' && m !== 'broken';
}

/** The crew-served weapon a team fields, if any (from its soldiers, dead or alive). */
export function teamCrewWeaponId(state: BattleState, team: Team): string | null {
  if (team.vehicleId != null) return null;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && crewServedClass(s.weaponId)) return s.weaponId;
  }
  return null;
}

/** Crew-drill speed factor on every task time (spec §6: green x1.25, veteran x0.8). */
export function crewDrillFactor(experience: number): number {
  return experience < 50 ? clamp(1 + ((50 - experience) / 30) * 0.25, 1, 1.25) : clamp(1 - ((experience - 50) / 30) * 0.2, 0.8, 1);
}

/** Working time of the whole into-action drill for a full crew of this experience (parallel tasks
 * side by side, no walking). */
export function setupTimeS(weaponId: string, experience: number): number {
  const cls = crewServedClass(weaponId);
  if (!cls) return 0;
  let t = 0;
  for (const stage of DEPLOY_STAGES[cls]) t += Math.max(...stage.map((k) => TASK_S[k]));
  return t * crewDrillFactor(experience);
}

/** Working time of packing up for a full crew (parallel tasks side by side, no walking). */
export function packTimeS(weaponId: string): number {
  const cls = crewServedClass(weaponId);
  if (!cls) return 0;
  let t = 0;
  for (const stage of DEPLOY_STAGES[cls]) {
    const inv = stage.map((k) => UNDONE_BY[k]).filter((k): k is CrewTaskId => !!k);
    if (inv.length > 0) t += Math.max(...inv.map((k) => TASK_S[k]));
  }
  return t;
}

/** Where the weapon should point: the gunner's current target, the team's fire/defend/ambush
 * facing, the gunner's sense of the threat, or (fallback) his own facing. */
function desiredFacing(state: BattleState, team: Team, gunner: Soldier, from: Vec2, fallback: number): number {
  if (gunner.targetSoldierId != null) {
    const t = state.soldiers.get(gunner.targetSoldierId);
    if (t && t.health !== 'dead') return angleTo(from, t.pos);
  }
  if (gunner.targetVehicleId != null) {
    const v = state.vehicles.get(gunner.targetVehicleId);
    if (v) return angleTo(from, v.pos);
  }
  if (gunner.targetPoint) return angleTo(from, gunner.targetPoint);
  const ord = team.order;
  if (ord && ord.type === 'fire') return angleTo(from, ord.target);
  if (ord && (ord.type === 'defend' || ord.type === 'ambush')) return facingAngle(team.facing);
  if (gunner.mind.threatDir != null) return gunner.mind.threatDir;
  return fallback;
}

function isOrderedMove(team: Team, gunner: Soldier, cw: CrewWeaponState): boolean {
  if (gunner.path.length === 0 || isFleeing(gunner)) return false;
  const ord = team.order;
  return !!ord && MOVE_ORDERS.has(ord.type) && ord.issuedAt >= cw.setAt;
}

// ------------------------------------------------------------------ state
function allDeployTasks(cls: CrewServedClass): CrewTaskId[] { return DEPLOY_STAGES[cls].flat(); }

/** True when every into-action task is done: the weapon can be served. */
export function isInAction(cw: CrewWeaponState): boolean {
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return false;
  ensureTaskState(cw, cls);
  return allDeployTasks(cls).every((k) => cw.done!.includes(k));
}

/** Fill in the task state of a record that only carries the older `phase` field. */
function ensureTaskState(cw: CrewWeaponState, cls: CrewServedClass): void {
  if (cw.done && cw.goal) { cw.progress ??= {}; cw.workers ??= {}; return; }
  const ready = cw.phase === 'ready';
  cw.done = ready ? allDeployTasks(cls) : [];
  cw.goal = cw.phase === 'packed' || cw.phase === 'packing' ? 'pack' : 'deploy';
  cw.progress = {};
  cw.workers = {};
  cw.open = [];
}

function setGoal(cw: CrewWeaponState, goal: 'deploy' | 'pack'): void {
  if (cw.goal === goal) return;
  cw.goal = goal;
  // half-done work of the other direction is dropped; what is DONE stays done
  for (const k of Object.keys(cw.progress!) as CrewTaskId[]) {
    if (PACK_TASKS.has(k) !== (goal === 'pack') && k !== 'lay' && k !== 'load' && k !== 'dropRound') delete cw.progress![k];
  }
  cw.workers = {};
}

function clearMission(cw: CrewWeaponState): void {
  cw.mission = undefined;
  cw.firePhase = undefined;
  cw.laid = false;
  if (cw.progress) delete cw.progress.lay;
}

function ammoToLoad(gunner: Soldier): boolean { return gunner.ammo > 0 || gunner.ammoReserve > 0; }

/** A round of another type than the mission needs sits in the breech, and the needed one is there
 * to be loaded. */
function wrongRoundChambered(state: BattleState, cw: CrewWeaponState, gunner: Soldier): boolean {
  const want = cw.mission?.wantRound;
  if (!cw.chambered || !want || !cw.chamberedType || cw.chamberedType === want) return false;
  return soldierRounds(state, gunner)[want] > 0;
}

/** The round the loader reaches for: what the mission needs; with no mission, AP while enemy armour
 * is about, else HE. */
function roundToLoad(state: BattleState, cw: CrewWeaponState, gunner: Soldier): RoundType | null {
  const w = WEAPONS[cw.weaponId];
  if (!w) return null;
  const counts = soldierRounds(state, gunner);
  const want = cw.mission?.wantRound;
  if (want && counts[want] > 0) return want;
  if (!w.rounds) return counts.ap > 0 ? 'ap' : null;
  let armour = false;
  for (const id of state.spottedVehicles[gunner.side]) {
    const v = state.vehicles.get(id);
    if (v && v.state !== 'knockedOut' && v.state !== 'burning' && v.state !== 'abandoned') { armour = true; break; }
  }
  const order: RoundType[] = want === 'smoke' ? ['smoke', 'he', 'ap', 'apcr'] : armour || want === 'ap' || want === 'apcr' ? ['ap', 'apcr', 'he'] : ['he', 'ap', 'apcr'];
  return order.find((r) => counts[r] > 0) ?? null;
}

function requestedWithin(state: BattleState, m: FireMission | undefined, seconds: number): boolean {
  return !!m && state.time - (m.lastRequestAt ?? m.startedAt) <= seconds;
}

/** The tasks open right now, in order. */
function computeOpenTasks(state: BattleState, cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier | undefined): CrewTaskId[] {
  const done = cw.done!;
  const stages = DEPLOY_STAGES[cls];
  if (cw.goal === 'pack') {
    for (let i = stages.length - 1; i >= 0; i--) {
      const out: CrewTaskId[] = [];
      for (const k of stages[i]) if (done.includes(k) && UNDONE_BY[k]) out.push(UNDONE_BY[k]!);
      if (out.length > 0) return out;
    }
    return [];
  }
  for (const stage of stages) {
    const out = stage.filter((k) => !done.includes(k));
    if (out.length > 0) {
      // a belt can only be fed when there is one
      if (out.length === 1 && out[0] === 'feedBelt' && gunner && !ammoToLoad(gunner)) return [];
      return out;
    }
  }
  if (!gunner) return [];
  const w = WEAPONS[cw.weaponId];
  const m = cw.mission;
  if (cls === 'atgun') {
    if (cw.recoilUntil != null && state.time < cw.recoilUntil) return [];
    // LOADING and LAYING run side by side: the layer corrects his lay while the round goes in
    if (!cw.chambered) {
      const out: CrewTaskId[] = ammoToLoad(gunner) ? ['load'] : [];
      if (m && !cw.laid && requestedWithin(state, m, 1.5)) out.push('lay');
      return out;
    }
    // the wrong round for this target is in the breech: out with it (the gunner lays meanwhile)
    if (wrongRoundChambered(state, cw, gunner) && requestedWithin(state, m, 1.5)) return cw.laid ? ['unload'] : ['unload', 'lay'];
    if (m && !cw.laid && requestedWithin(state, m, 1.5)) return ['lay'];
    return [];
  }
  if (cls === 'mortar') {
    if (!m || !requestedWithin(state, m, 1 / Math.max(0.01, w?.rate ?? 0.15) + 2)) return [];
    // the loader hangs the bomb over the muzzle while the gunner finishes the lay; it drops when
    // the mortar is laid
    const out: CrewTaskId[] = [];
    const layLeft = cw.laid ? 0 : (m.layS ?? TASK_S.lay) * (1 - clamp((cw.progress?.lay ?? 0) / TASK_S.lay, 0, 1));
    if (!cw.chambered && gunner.ammo > 0 && gunner.fireTimer <= TASK_S.dropRound * 1.25 + 0.1 && layLeft <= TASK_S.dropRound) out.push('dropRound');
    if (!cw.laid) out.push('lay');
    return out;
  }
  if (m && !cw.laid && requestedWithin(state, m, 1.5)) return ['lay'];
  return [];
}

/** Assignment order (spec §6): nearest able free man first, the leader last, ties by soldier id.
 * The gunner leaves loading to the others when there are any. */
function pickWorker(free: Soldier[], station: Vec2, task: CrewTaskId, gunnerId: number, avoidId: number | undefined): Soldier | null {
  let best: Soldier | null = null;
  let bestKey: [number, number, number, number, number] | null = null;
  for (const s of free) {
    if (GUNNER_TASKS.has(task) && s.id !== gunnerId) continue;
    const key: [number, number, number, number, number] = [
      avoidId != null && s.id === avoidId ? 1 : 0,
      LOADER_TASKS.has(task) && s.id === gunnerId ? 1 : 0,
      s.isLeader ? 1 : 0,
      Math.round(dist(s.pos, station) * 1000),
      s.id,
    ];
    let less = bestKey == null;
    if (bestKey) {
      for (let i = 0; i < key.length; i++) {
        if (key[i] !== bestKey[i]) { less = key[i] < bestKey[i]; break; }
      }
    }
    if (less) { best = s; bestKey = key; }
  }
  return best;
}

/** One step of a crewman towards `target` (tile coords). Returns true when he is at it. */
function walkTo(state: BattleState, s: Soldier, target: Vec2, dt: number): boolean {
  const d = dist(s.pos, target);
  if (d <= 0.04) { s.pos = { x: target.x, y: target.y }; return true; }
  const step = Math.min(d, (STATION_WALK_MS * (s.health === 'wounded' ? 0.7 : 1) * dt) / TILE_M);
  const nx = s.pos.x + ((target.x - s.pos.x) / d) * step;
  const ny = s.pos.y + ((target.y - s.pos.y) / d) * step;
  const tx = Math.floor(nx), ty = Math.floor(ny);
  const sameTile = tx === Math.floor(s.pos.x) && ty === Math.floor(s.pos.y);
  if (!sameTile && (!inBounds(state.map, tx, ty) || !isPassable(state.map, tx, ty, 'infantry'))) {
    return true; // a wall or water in the way: he works from where he stands
  }
  s.facing = facingFromAngle(angleTo(s.pos, target));
  s.pos = { x: nx, y: ny };
  s.animFrame = Math.floor(state.time / 0.3) % 2;
  return dist(s.pos, target) <= AT_STATION_TILES;
}

function abandon(state: BattleState, team: Team, cw: CrewWeaponState, why: 'fled' | 'fell'): void {
  if (cw.abandoned) return;
  cw.abandoned = true;
  cw.abandonedAt = state.time;
  cw.workers = {};
  // (half-assembled: it lies as it is, with the work already done; a returning crew carries on)
  if (why === 'fled' && team.side === state.config.playerSide && (cw.done?.length ?? 0) > 0) {
    addMessage(state, `${team.name}\nThe crew abandons the gun!`, 'warn');
  }
}

/** Create the state for a team that has a crew-served weapon but no record yet. */
function initCrewWeapon(state: BattleState, team: Team, gunner: Soldier, cls: CrewServedClass): CrewWeaponState {
  const moving = gunner.path.length > 0;
  const facing = state.time <= 0.15 && team.order == null
    ? formationBaseHeading(state.map, team.side)
    : desiredFacing(state, team, gunner, gunner.pos, facingAngle(gunner.facing));
  const cw: CrewWeaponState = {
    weaponId: gunner.weaponId,
    pos: moving ? { ...gunner.pos } : pivotFromGunner(cls, gunner.pos, facing),
    facing,
    phase: moving ? 'packed' : 'ready',
    timer: 0,
    phaseTotal: 0,
    gunnerId: gunner.id,
    abandoned: false,
    abandonedAt: 0,
    setAt: moving ? -1 : state.time,
  };
  ensureTaskState(cw, cls);
  team.crewWeapon = cw;
  return cw;
}

/** Deploy-screen / pre-battle view of a team's weapon: the stored state, or a set-up weapon at its
 * gunner facing the deploy heading. Pure (never writes the state). */
export function crewWeaponView(state: BattleState, team: Team): CrewWeaponState | null {
  if (team.crewWeapon) return team.crewWeapon;
  const weaponId = teamCrewWeaponId(state, team);
  if (!weaponId) return null;
  const cls = crewServedClass(weaponId)!;
  let gunner: Soldier | undefined;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.weaponId === weaponId) { gunner = s; break; }
  }
  if (!gunner) return null;
  const facing = formationBaseHeading(state.map, team.side);
  return {
    weaponId, pos: pivotFromGunner(cls, gunner.pos, facing), facing, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: gunner.id, abandoned: gunner.health === 'dead', abandonedAt: 0, setAt: 0,
    goal: 'deploy', done: allDeployTasks(cls), progress: {}, workers: {}, open: [],
  };
}

/** Takeover delay for the next crewman (spec §11: 2-6 s, longer for the inexperienced). */
function takeoverDelayS(s: Soldier): number {
  return 6 - 4 * clamp(s.experience / 100, 0, 1);
}

function isReturnCandidate(s: Soldier): boolean {
  if (isFleeing(s) || s.activity === 'cowering' || s.activity === 'pinned' || s.activity === 'hiding') return false;
  const st = s.mind.state;
  return st === 'calm' || st === 'alert' || st === 'wary';
}

/** Soldiers of the team a gunner could be: alive, on foot, not running away. */
function crewCandidates(state: BattleState, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (isActive(s) && !isFleeing(s)) out.push(s);
  }
  return out;
}

function stepAbandoned(state: BattleState, team: Team, cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier | undefined): void {
  const crew = gunner ? (isFleeing(gunner) ? [] : [gunner]) : crewCandidates(state, team);
  // someone back at the weapon re-mans it
  for (const s of crew) {
    if (dist(s.pos, cw.pos) > REMAN_RADIUS_TILES + (cls === 'atgun' ? 1 : 0)) continue;
    if (s.path.length > 0 && !(team.order && MOVE_ORDERS.has(team.order.type) && team.order.issuedAt > cw.abandonedAt)) continue;
    if (!gunner && state.time < cw.abandonedAt + takeoverDelayS(s)) continue;
    const old = state.soldiers.get(cw.gunnerId);
    if (old && old.id !== s.id && old.weaponId === cw.weaponId && s.weaponId !== cw.weaponId) {
      s.weaponId = cw.weaponId;
      s.ammo = old.ammo;
      s.ammoReserve = old.ammoReserve;
      s.reloadTimer = 0;
      s.fireTimer = Math.max(s.fireTimer, 0);
      old.ammo = 0;
      old.ammoReserve = 0;
    }
    cw.gunnerId = s.id;
    cw.abandoned = false;
    cw.setAt = state.time;
    if (team.side === state.config.playerSide) {
      addMessage(state, `${team.name}\n${s.rank}. ${s.name} mans the gun.`, 'info');
    }
    // the work already done on the weapon stands; he only has to lay it again
    clearMission(cw);
    if (cw.done!.length === 0 && cw.goal === 'pack') setGoal(cw, 'deploy');
    return;
  }
  // a calm crewman walks back to it (checked once a second)
  if (Math.round(state.time * 10) % 10 !== 0) return;
  const ord = team.order;
  if (ord && MOVE_ORDERS.has(ord.type) && ord.issuedAt > cw.abandonedAt) return; // sent elsewhere
  let best: Soldier | null = null;
  let bestD = RETURN_RADIUS_TILES;
  for (const s of crew) {
    if (s.path.length > 0 || !isReturnCandidate(s)) continue;
    const d = dist(s.pos, cw.pos);
    if (d <= bestD) { bestD = d; best = s; }
  }
  if (!best) return;
  const path = findPath(state.map, best.pos, cw.pos, 'infantry');
  if (path.length === 0) return;
  best.path = path;
  best.activity = 'moving';
  best.stance = 'crouching';
}

/** Legacy fields the HUD, renderer fallbacks and older tests read, derived from the task state. */
function deriveLegacy(cw: CrewWeaponState, cls: CrewServedClass): void {
  const all = allDeployTasks(cls);
  const done = cw.done!;
  let total = 0, left = 0;
  if (cw.goal === 'pack') {
    for (const k of all) {
      const inv = UNDONE_BY[k];
      if (!inv) continue;
      total += TASK_S[inv];
      if (done.includes(k)) left += TASK_S[inv] - Math.min(TASK_S[inv], cw.progress![inv] ?? 0);
    }
    cw.phase = done.some((k) => UNDONE_BY[k]) ? 'packing' : 'packed';
  } else {
    for (const k of all) {
      total += TASK_S[k];
      if (!done.includes(k)) left += TASK_S[k] - Math.min(TASK_S[k], cw.progress![k] ?? 0);
    }
    cw.phase = all.every((k) => done.includes(k)) ? 'ready' : 'settingUp';
  }
  cw.timer = left;
  cw.phaseTotal = total;
  const open = cw.open ?? [];
  if (cw.phase !== 'ready' && !open.includes('feedBelt')) cw.firePhase = undefined;
  else if (open.includes('load') || open.includes('dropRound') || open.includes('feedBelt')) cw.firePhase = 'loading';
  else if (open.includes('lay')) cw.firePhase = 'aiming';
  else if (cw.mission && cw.laid && (cls === 'hmg' || cw.chambered)) cw.firePhase = 'ready';
  else if (cw.mission) cw.firePhase = cw.laid ? 'loading' : 'aiming';
  else cw.firePhase = undefined;
}

const HELP_AFTER_S = 3;
const HELP_MSG_EVERY_S = 30;

function helpMessage(task: CrewTaskId): string {
  if (LOADER_TASKS.has(task)) return 'No one to load!';
  if (GUNNER_TASKS.has(task)) return 'No one to aim the gun!';
  if (PACK_TASKS.has(task)) return 'No one to pack up the gun!';
  return 'No one to set up the gun!';
}

function completeTask(state: BattleState, team: Team, cw: CrewWeaponState, cls: CrewServedClass, task: CrewTaskId, worker: Soldier, gunner: Soldier): void {
  delete cw.progress![task];
  delete cw.workers![task];
  const undoes = UNDOES[task];
  if (undoes) {
    cw.done = cw.done!.filter((k) => k !== undoes && !(task === 'dismountGun' && k === 'feedBelt'));
    return;
  }
  switch (task) {
    case 'load': {
      // the round leaves the ammunition stack HERE, not when it is fired
      const w = WEAPONS[cw.weaponId];
      if (gunner.ammo <= 0 && gunner.ammoReserve > 0 && w) {
        const take = Math.min(w.ammo, gunner.ammoReserve);
        gunner.ammo = take;
        gunner.ammoReserve -= take;
      }
      if (gunner.ammo > 0) {
        // the round type is chosen HERE (requirements A2) and leaves its own count
        const type = roundToLoad(state, cw, gunner);
        const counts = soldierRounds(state, gunner);
        gunner.ammo--;
        cw.chambered = true;
        cw.chamberedType = type ?? 'ap';
        if (type) {
          counts[type] = Math.max(0, counts[type] - 1);
          if (counts[type] === 0 && w?.rounds) noteOutOf(state, team.id, type);
        }
      }
      return;
    }
    case 'unload': {
      // back onto the stack
      if (cw.chambered) {
        const counts = soldierRounds(state, gunner);
        counts[cw.chamberedType ?? 'ap']++;
        gunner.ammo++;
        cw.chambered = false;
        cw.chamberedType = undefined;
      }
      return;
    }
    case 'dropRound': cw.chambered = true; return;
    case 'lay':
      cw.laid = true;
      if (cw.mission) { cw.facing = angleTo(cw.pos, cw.mission.layAim); cw.mission.timer = 0; }
      return;
    case 'feedBelt': {
      const w = WEAPONS[cw.weaponId];
      if (gunner.ammo <= 0 && w) {
        const take = Math.min(w.ammo, gunner.ammoReserve);
        gunner.ammo = take;
        gunner.ammoReserve -= take;
      }
      break;
    }
    case 'placeBaseplate': cw.baseplateBy = worker.id; break;
    default: break;
  }
  cw.done!.push(task);
  // into action (not after every new belt during a fight)
  const ready = allDeployTasks(cls).every((k) => cw.done!.includes(k));
  if (ready && !(task === 'feedBelt' && cw.mission) && team.side === state.config.playerSide) {
    addMessage(state, `${team.name}\n${cls === 'atgun' ? 'Gun' : cls === 'mortar' ? 'Mortar' : 'MG'} ready.`, 'info');
  }
}

function stepTasks(state: BattleState, team: Team, cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier, orderedMove: boolean, dt: number): void {
  const crew: Soldier[] = [];
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (isActive(s) && !isFleeing(s)) crew.push(s);
  }
  // the crew's place is at the gun (mind spec §11: its anchor): no wandering off to look for cover,
  // and an unordered path (set before he joined the drill) is dropped
  const able: Soldier[] = [];
  for (const s of crew) {
    s.mind.lastCoverSeekAt = state.time;
    if (!isAbleCrewman(state, s)) continue;
    able.push(s);
    if (!orderedMove && s.path.length > 0) { s.path = []; if (s.activity === 'moving' || s.activity === 'movingFast' || s.activity === 'sneaking') s.activity = team.order?.type === 'defend' ? 'defending' : 'idle'; }
  }

  // HMG: an empty belt has to be replaced before the gun speaks again
  if (cls === 'hmg' && cw.goal === 'deploy' && gunner.ammo <= 0 && gunner.ammoReserve > 0 && cw.done!.includes('feedBelt')) {
    cw.done = cw.done!.filter((k) => k !== 'feedBelt');
  }

  const open = computeOpenTasks(state, cw, cls, gunner);
  cw.open = open;
  const workers = cw.workers!;
  for (const k of Object.keys(workers) as CrewTaskId[]) {
    const w = state.soldiers.get(workers[k]!);
    if (!open.includes(k) || !isAbleCrewman(state, w) || !able.includes(w)) delete workers[k];
  }
  const busy = new Set<number>(Object.values(workers) as number[]);
  for (const task of open) {
    if (workers[task] != null) continue;
    const free = able.filter((s) => !busy.has(s.id));
    const avoid = task === 'setBipod' && able.length > 1 ? cw.baseplateBy : undefined;
    const pick = pickWorker(free, taskStation(cw, cls, task), task, gunner.id, avoid);
    if (pick) { workers[task] = pick.id; busy.add(pick.id); }
  }

  // work the tasks
  let worked = false;
  let wantFacing: number | null = null;
  for (const task of open) {
    const w = workers[task] != null ? state.soldiers.get(workers[task]!) : undefined;
    if (!w) continue;
    const station = taskStation(cw, cls, task);
    const there = dist(w.pos, station) <= AT_STATION_TILES || walkTo(state, w, station, dt);
    // a man still recovering from a daze works slowly (sim/daze.ts: x0.7 fading back to 1)
    const total = taskDurationS(cw, task, w, gunner) / recoveryFactor(w, state.time);
    if (there) {
      worked = true;
      if (w.stance === 'standing') w.stance = 'crouching';
      w.facing = facingFromAngle(task === 'lay' || task === 'fire' || cls === 'hmg' ? cw.facing : angleTo(w.pos, cw.pos));
      if (w.id !== gunner.id) w.fireTimer = Math.max(w.fireTimer, 0.5); // hands full
      if (task === 'unhook') {
        // he swings the limbered gun round by its trail onto the bearing it is wanted on
        const want = desiredFacing(state, team, gunner, cw.pos, cw.facing);
        cw.facing = turnTowards(cw.facing, want, SWING_RATE * dt);
        if (Math.abs(wrapAngle(want - cw.facing)) > 0.15) { w.crewTask = { id: task, progress: taskFrac(cw, task), walking: false }; continue; }
      }
      let p = (cw.progress![task] ?? 0) + dt * (TASK_S[task] / Math.max(1e-6, total));
      if (task === 'dropRound' && !cw.laid) p = Math.min(p, TASK_S.dropRound * 0.9); // bomb held at the muzzle
      cw.progress![task] = p;
      if (task === 'lay' && cw.mission) {
        const left = Math.max(dt, (TASK_S.lay - p) * (total / TASK_S.lay));
        wantFacing = angleTo(cw.pos, cw.mission.layAim);
        cw.facing = turnTowards(cw.facing, wantFacing, (Math.abs(wrapAngle(wantFacing - cw.facing)) / left) * dt);
        cw.mission.timer = Math.max(0, left - dt);
      }
      if (p >= TASK_S[task] - 1e-9) { w.crewTask = { id: task, progress: 1, walking: false }; completeTask(state, team, cw, cls, task, w, gunner); continue; }
    }
    w.crewTask = { id: task, progress: clamp((cw.progress![task] ?? 0) / TASK_S[task], 0, 1), walking: !there };
  }

  // no one able to take an open task: tell the player (rate-limited)
  const unmanned = open.find((k) => workers[k] == null);
  if (worked || !unmanned || cw.lastWorkedAt == null) cw.lastWorkedAt = state.time;
  if (unmanned && team.side === state.config.playerSide
    && state.time - (cw.lastWorkedAt ?? state.time) >= HELP_AFTER_S
    && state.time - (cw.lastHelpMsgAt ?? -1e9) >= HELP_MSG_EVERY_S) {
    cw.lastHelpMsgAt = state.time;
    addMessage(state, `${team.name}\n${helpMessage(unmanned)}`, 'warn');
  }

  // men without a task stand by at their posts (not while packing: they wait to move off)
  if (cw.goal === 'deploy') {
    const lay = crewLayout(cw.weaponId);
    const posts: Vec2[] = [lay.loader, lay.assistant, { x: -lay.assistant.x, y: lay.assistant.y + 0.4 }];
    const idle = able.filter((s) => !busy.has(s.id) && s.id !== gunner.id)
      .sort((a, b) => Number(a.isLeader) - Number(b.isLeader) || a.id - b.id);
    if (!busy.has(gunner.id) && able.includes(gunner) && isInActionNow(cw, cls)) {
      const at = walkTo(state, gunner, weaponFramePoint(cw.pos, cw.facing, CREW_LAYOUT[cls].gunner), dt);
      if (at) { if (gunner.stance === 'standing') gunner.stance = 'crouching'; if (cls === 'hmg') gunner.stance = 'prone'; }
    }
    idle.forEach((s, i) => {
      if (i >= posts.length) return;
      const at = walkTo(state, s, weaponFramePoint(cw.pos, cw.facing, posts[i]), dt);
      if (at && s.stance === 'standing') s.stance = 'crouching';
    });
  }
}

function isInActionNow(cw: CrewWeaponState, cls: CrewServedClass): boolean {
  return allDeployTasks(cls).every((k) => cw.done!.includes(k) || k === 'feedBelt');
}

/** Seconds this worker needs for the whole task. */
function taskDurationS(cw: CrewWeaponState, task: CrewTaskId, worker: Soldier, gunner: Soldier): number {
  // guns: loading by calibre and the fine lay follow sim/gunTiming.ts (their own skill tables)
  if (crewServedClass(cw.weaponId) === 'atgun') {
    if (task === 'load') return Math.max(0.05, gunLoadBaseS(cw.weaponId) * loadSkillMul(worker.experience));
    if (task === 'lay') return Math.max(0.05, (cw.mission?.layS ?? TASK_S.lay) * laySkillMul(worker.experience));
  }
  let base = task === 'lay' ? cw.mission?.layS ?? TASK_S.lay : TASK_S[task];
  if (task === 'feedBelt' && worker.id === gunner.id) base *= SELF_FEED_FACTOR;
  return Math.max(0.05, base * crewDrillFactor(worker.experience));
}

/** Hauling pace of a manhandled gun, m/s. */
export const HAUL_SPEED_MS = 1.3;
/** How fast the men can slew the gun about its axle while pushing it, rad/s. */
export const HAUL_TURN_RATE = 0.9;
/** Hauler stations either side of the towing eye (metres, weapon frame). */
export function haulStationM(weaponId: string, i: number): Vec2 {
  return { x: i === 0 ? -0.4 : 0.4, y: towLengthM(weaponId) };
}

/** The men who push the gun: the gunner and the nearest other able crewman (leader last). */
export function gunHaulers(state: BattleState, team: Team, cw: CrewWeaponState): Soldier[] {
  const gunner = state.soldiers.get(cw.gunnerId);
  if (!isActive(gunner)) return [];
  let mate: Soldier | null = null;
  let key: [number, number, number] | null = null;
  const st = weaponFramePoint(cw.pos, cw.facing, haulStationM(cw.weaponId, 1));
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.id === gunner.id || !isAbleCrewman(state, s)) continue;
    const k: [number, number, number] = [s.isLeader ? 1 : 0, Math.round(dist(s.pos, st) * 1000), s.id];
    if (!key || k[0] < key[0] || (k[0] === key[0] && (k[1] < key[1] || (k[1] === key[1] && k[2] < key[2])))) { key = k; mate = s; }
  }
  return mate && dist(mate.pos, st) <= 3 ? [gunner, mate] : [gunner];
}

/** A limbered gun on the move (user report: it must pivot between its wheels, not at the trail
 * end). The pose point `cw.pos` is ALWAYS the axle midpoint: it travels along the gunner's order
 * path, the heading slews about the axle at a limited rate towards the direction of travel (the
 * gun is pushed muzzle-first), and the haulers are put at their stations FROM the axle pose. */
function haulGun(state: BattleState, team: Team, cw: CrewWeaponState, gunner: Soldier, dt: number): void {
  const path = gunner.path;
  if (path.length > 0 && !isFleeing(gunner) && isAbleCrewman(state, gunner)) {
    const wp = path[0];
    const want = dist(cw.pos, wp) > 0.05 ? angleTo(cw.pos, wp) : cw.facing;
    cw.facing = turnTowards(cw.facing, want, HAUL_TURN_RATE * dt);
    // push on only when the muzzle points roughly where it is going (else slew on the spot)
    const off = Math.abs(wrapAngle(want - cw.facing));
    if (off < 0.15) {
      const tile = tileAt(state.map, Math.floor(cw.pos.x), Math.floor(cw.pos.y));
      const lone = gunHaulers(state, team, cw).length < 2 ? 0.6 : 1;
      let remaining = (HAUL_SPEED_MS * lone * TERRAIN_PROPS[tile].speedMul * (gunner.health === 'wounded' ? 0.7 : 1) * dt) / TILE_M;
      while (remaining > 0 && path.length > 0) {
        const d = dist(cw.pos, path[0]);
        if (d <= remaining) { cw.pos = { x: path[0].x, y: path[0].y }; remaining -= d; path.shift(); }
        else { cw.pos = { x: cw.pos.x + ((path[0].x - cw.pos.x) / d) * remaining, y: cw.pos.y + ((path[0].y - cw.pos.y) / d) * remaining }; remaining = 0; }
      }
      if (path.length === 0) { gunner.activity = team.order?.type === 'defend' ? 'defending' : 'idle'; }
    }
  }
  // the men, from the axle pose
  gunHaulers(state, team, cw).forEach((s, i) => {
    const st = weaponFramePoint(cw.pos, cw.facing, haulStationM(cw.weaponId, i));
    if (i === 0 || dist(s.pos, st) <= 0.15) s.pos = st;
    else walkTo(state, s, st, dt * 2); // the second man catches up with the trail at a trot
    s.facing = facingFromAngle(cw.facing);
    s.animFrame = Math.floor(state.time / 0.3) % 2;
    if (i > 0 && path.length === 0) s.path = [];
  });
}

/** True for the men pushing a limbered gun: crewWeapon.ts moves them with the axle, so
 * movement.ts must not also walk them along their own paths. */
export function isHaulingGun(state: BattleState, s: Soldier): boolean {
  const team = state.teams.get(s.teamId);
  const cw = team?.crewWeapon;
  if (!cw || cw.abandoned || cw.phase !== 'packed' || cw.goal !== 'pack' || crewServedClass(cw.weaponId) !== 'atgun') return false;
  return gunHaulers(state, team!, cw).some((h) => h.id === s.id);
}

function stepTeamWeapon(state: BattleState, team: Team, dt: number): void {
  let cw = team.crewWeapon;
  const weaponId = cw?.weaponId ?? teamCrewWeaponId(state, team);
  if (!weaponId) return;
  const cls = crewServedClass(weaponId);
  if (!cls) return;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.crewTask) s.crewTask = undefined;
  }
  let gunner = cw ? state.soldiers.get(cw.gunnerId) : undefined;
  if (cw && (!isActive(gunner) || gunner.weaponId !== weaponId)) {
    // the weapon has changed hands (mind.ts promotes the next crewman when the gunner falls)
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (isActive(s) && s.weaponId === weaponId) { cw.gunnerId = s.id; gunner = s; break; }
    }
  }
  if (!cw) {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (isActive(s) && s.weaponId === weaponId) { gunner = s; break; }
    }
    if (!gunner) return;
    cw = initCrewWeapon(state, team, gunner, cls);
  }
  ensureTaskState(cw, cls);

  if (!isActive(gunner) || cw.abandoned || isFleeing(gunner)) clearMission(cw);
  if (!isActive(gunner)) {
    // gunner down: the weapon lies where it is until the next man takes it over
    if (!cw.abandoned) {
      const fallen = gunner as Soldier | undefined;
      if (fallen && cw.done!.length === 0 && cw.goal === 'pack') cw.pos = { ...fallen.pos };
      abandon(state, team, cw, 'fell');
    }
    stepAbandoned(state, team, cw, cls, undefined);
    cw.open = [];
    deriveLegacy(cw, cls);
    return;
  }

  if (cw.abandoned) {
    stepAbandoned(state, team, cw, cls, gunner);
    cw.open = [];
    deriveLegacy(cw, cls);
    gateFire(cw, gunner, dt);
    return;
  }

  if (isFleeing(gunner)) {
    // running away: drop it right here
    if (cw.done!.length === 0 && cw.goal === 'pack') cw.pos = { ...gunner.pos };
    abandon(state, team, cw, 'fled');
    cw.open = [];
    deriveLegacy(cw, cls);
    gateFire(cw, gunner, dt);
    return;
  }

  const orderedMove = isOrderedMove(team, gunner, cw);
  const carried = cw.done!.length === 0 && cw.goal === 'pack';
  if (orderedMove) {
    if (cw.goal !== 'pack') { setGoal(cw, 'pack'); clearMission(cw); }
  } else if (carried) {
    if (gunner.path.length === 0) {
      // arrived: the weapon goes down here and the drill starts
      if (cls === 'atgun') {
        // (it was hauled muzzle-first ahead of the men at its trails: it stands where it stopped)
      } else {
        const facing = desiredFacing(state, team, gunner, gunner.pos, facingAngle(gunner.facing));
        cw.facing = facing;
        cw.pos = pivotFromGunner(cls, gunner.pos, facing);
      }
      setGoal(cw, 'deploy');
      cw.setAt = state.time;
      cw.lastWorkedAt = state.time;
    }
  } else if (cw.goal === 'pack') {
    // the move was cancelled while packing: back into action from where they were
    setGoal(cw, 'deploy');
    cw.setAt = state.time;
  }

  if (cw.done!.length === 0 && cw.goal === 'pack') {
    // carried: the weapon goes with the gunner. A gun is a towed body: its AXLE follows the path
    // and the men are placed from the axle pose, never the other way round.
    if (cls === 'atgun') {
      haulGun(state, team, cw, gunner, dt);
    } else {
      cw.pos = { ...gunner.pos };
      cw.facing = facingAngle(gunner.facing);
    }
    cw.open = [];
    cw.workers = {};
    cw.chambered = cls === 'atgun' ? cw.chambered : false;
    deriveLegacy(cw, cls);
    gateFire(cw, gunner, dt);
    return;
  }

  if (dist(gunner.pos, cw.pos) > MANNED_RADIUS_TILES) {
    abandon(state, team, cw, 'fled');
    cw.open = [];
    deriveLegacy(cw, cls);
    gateFire(cw, gunner, dt);
    return;
  }

  // crews in no state to work the gun give the mission up
  if (cw.mission && !canWorkGun(gunner)) clearMission(cw);
  stepTasks(state, team, cw, cls, gunner, orderedMove, dt);
  deriveLegacy(cw, cls);
  gateFire(cw, gunner, dt);
}

/** Keep the gunner's fire timer above zero for this step's combat pass unless the weapon is in
 * action and manned (combat decrements `fireTimer` by dt and fires only at <= 0). */
function gateFire(cw: CrewWeaponState, gunner: Soldier, dt: number): void {
  if (!cw.abandoned && cw.phase === 'ready' && gunner.id === cw.gunnerId) return;
  if (gunner.weaponId !== cw.weaponId) return;
  gunner.fireTimer = Math.max(gunner.fireTimer, dt + 1e-3);
}

/** Advance every crew-served weapon one sim step. Called at the start of stepMovement. */
export function stepCrewWeapons(state: BattleState, dt: number): void {
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    // riding in a transport with the weapon packed: it goes where its gunner goes
    if (team.transportId != null && team.crewWeapon) {
      const g = state.soldiers.get(team.crewWeapon.gunnerId);
      if (g && g.seat === 'passenger' && g.vehicleId != null) { team.crewWeapon.pos = { ...g.pos }; continue; }
    }
    stepTeamWeapon(state, team, dt);
  }
}

/** True while this soldier's team is packing its weapon: the crew stays with it until it is packed
 * (the men with a packing task walk to their stations; the others wait). */
export function isHeldForPacking(state: BattleState, s: Soldier): boolean {
  const team = state.teams.get(s.teamId);
  const cw = team?.crewWeapon;
  if (!cw || cw.phase !== 'packing' || cw.abandoned) return false;
  return !isFleeing(s);
}

/** Orders hook (orders.ts): a move order starts the pack-up tasks at once; a fire order drops the
 * current lay so the bring-into-action chain (load -> lay -> fire) starts on the new target. */
export function onCrewOrder(state: BattleState, team: Team, type: OrderType): void {
  const cw = team.crewWeapon;
  if (!cw || cw.abandoned) return;
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return;
  ensureTaskState(cw, cls);
  if (MOVE_ORDERS.has(type)) {
    const gunner = state.soldiers.get(cw.gunnerId);
    if (gunner && gunner.path.length > 0 && cw.goal !== 'pack') { setGoal(cw, 'pack'); clearMission(cw); deriveLegacy(cw, cls); }
  } else if (type === 'fire' || type === 'smoke') {
    clearMission(cw);
  }
}

/** Team status override for the HUD: the word of the open task (spec §6). */
export function crewWeaponStatus(team: Team): TeamStatusWord | null {
  const cw = team.crewWeapon;
  if (!cw || cw.abandoned) return null;
  const first = cw.open?.[0];
  if (first) return TASK_STATUS[first];
  if (cw.phase === 'settingUp') return 'Setting up';
  if (cw.phase === 'packing') return 'Packing up';
  if (cw.recoilUntil != null && cw.mission && cw.phase === 'ready' && cw.firePhase === 'ready') return 'Firing';
  if (cw.phase === 'ready' && cw.firePhase === 'aiming') return 'Aiming';
  if (cw.phase === 'ready' && cw.firePhase === 'loading') return 'Loading';
  return null;
}

/** Which weapon picture goes with the task state (spec §6 Visuals). */
export function crewWeaponVisual(state: BattleState, cw: CrewWeaponState): CrewWeaponVisual {
  const cls = crewServedClass(cw.weaponId);
  const done = cw.done;
  if (!cls || !done) return cw.phase === 'ready' ? 'emplaced' : cw.phase === 'packed' ? 'packed' : 'half';
  if (cls === 'atgun') {
    if (!done.includes('unhook')) return 'limbered';
    const l = done.includes('spreadLeft'), r = done.includes('spreadRight');
    if (l && r) {
      if (!(done.includes('digLeft') && done.includes('digRight'))) return 'trailsOpen';
      return cw.recoilUntil != null && state.time < cw.recoilUntil ? 'recoil' : 'emplaced';
    }
    return l ? 'trailLeftOpen' : r ? 'trailRightOpen' : 'trailsClosed';
  }
  if (cls === 'mortar') {
    if (done.includes('setBipod')) return 'emplaced';
    return done.includes('mountTube') ? 'tube' : done.includes('placeBaseplate') ? 'baseplate' : 'packed';
  }
  if (done.includes('mountGun')) return 'emplaced';
  return done.includes('placeTripod') ? 'tripod' : 'packed';
}

// ------------------------------------------------------------------ fire missions
// A fire mission is the lay on one target. A new aim point more than MISSION_NEW_AIM_M from the lay
// point starts a new mission (a whole new lay); a tracked team that moves more than MISSION_RELAY_M
// from the lay point costs a short re-lay and keeps the mission (and the mortar's walk-in).

/** A new aim point further than this from the current lay point starts a new mission. */
export const MISSION_NEW_AIM_M = 15;
/** A tracked target that has moved further than this from the lay point needs a re-lay correction. */
export const MISSION_RELAY_M = 10;
/** Mortar lay time at zero / at maximum range (seconds, average crew). */
export const MORTAR_LAY_S: [number, number] = [6, 10];
/** AT gun: seconds of swinging the piece by its trail and handwheel, none for no traverse up to
 * this for a half-turn; the FINE LAY on top follows sim/gunTiming.ts (4 s up to 200 m, +1 s per
 * further 200 m, moving target x1.5, the layer's skill, the aim point). */
export const ATGUN_TRAVERSE_S = 2.5;
/** Open gun: the calibre's loading time x0.9 for a regular crew (sim/gunTiming.ts). */
export function gunLoadBaseS(weaponId: string): number {
  const w = WEAPONS[weaponId];
  return w ? weaponLoadS(w) * LOAD_ATGUN_MUL : TASK_S.load;
}
export const HMG_LAY_S = 2;
/** Load time per round. HMGs are belt fed: no separate load per burst. */
export const LOAD_S: Record<CrewServedClass, number> = { mortar: TASK_S.dropRound, hmg: 0, atgun: TASK_S.load };
/** Drill factor of the man doing it: guns use the loading / laying tables of sim/gunTiming.ts. */
function loadDrill(cls: CrewServedClass, experience: number): number { return cls === 'atgun' ? loadSkillMul(experience) : crewDrillFactor(experience); }
function layDrill(cls: CrewServedClass, experience: number): number { return cls === 'atgun' ? laySkillMul(experience) : crewDrillFactor(experience); }
function loadBaseS(cls: CrewServedClass, weaponId: string): number { return cls === 'atgun' ? gunLoadBaseS(weaponId) : LOAD_S[cls]; }
/** Re-lay correction on a moving tracked target (seconds, average crew). */
export const RELAY_S = 1.5;

function layBaseS(weaponId: string, distM: number, traverseRad: number, targetMoving = false): number {
  const cls = crewServedClass(weaponId);
  if (!cls) return 0;
  if (cls === 'mortar') {
    const range = WEAPONS[weaponId]?.rangeM ?? 1000;
    return MORTAR_LAY_S[0] + (MORTAR_LAY_S[1] - MORTAR_LAY_S[0]) * clamp(distM / range, 0, 1);
  }
  if (cls === 'atgun') return fineLayBaseS(distM) * (targetMoving ? LAY_MOVING_TARGET_MUL : 1) + ATGUN_TRAVERSE_S * clamp(Math.abs(traverseRad) / Math.PI, 0, 1);
  return HMG_LAY_S;
}

/** Lay (aim) time for a new mission. `distM` is the range to the aim point, `traverseRad` the angle
 * the weapon must turn from its current facing. */
export function layTimeS(weaponId: string, experience: number, distM: number, traverseRad: number, targetMoving = false): number {
  const cls = crewServedClass(weaponId);
  return cls ? layBaseS(weaponId, distM, traverseRad, targetMoving) * layDrill(cls, experience) : 0;
}

export function loadTimeS(weaponId: string, experience: number): number {
  const cls = crewServedClass(weaponId);
  return cls ? loadBaseS(cls, weaponId) * loadDrill(cls, experience) : 0;
}

/** Crews that are not in a state to work the gun abort the mission. */
function canWorkGun(s: Soldier): boolean {
  return !isFleeing(s) && s.activity !== 'cowering' && s.activity !== 'routed';
}

export interface FireRequest {
  /** where the round is going */
  aim: Vec2;
  /** team being engaged/tracked, or null for a point target */
  targetTeamId: number | null;
  /** extra seconds before the first round of a new mission (e.g. a spotter's correction by radio) */
  extraFirstRoundDelayS?: number;
  /** guns: what is being fired at, for the round type and the aim point (absent = soft target) */
  targetVehicle?: Vehicle | null;
  smoke?: boolean;
  /** the target is on the move (guns: fine lay x1.5) */
  targetMoving?: boolean;
}

/** Seconds (estimate) until the weapon can fire on its mission; 0 = it may fire now. */
function missionRemaining(state: BattleState, cw: CrewWeaponState, cls: CrewServedClass, gunner: Soldier): number {
  const f = crewDrillFactor(gunner.experience);
  const fLoad = loadDrill(cls, gunner.experience);
  let t = 0;
  if (cw.recoilUntil != null && state.time < cw.recoilUntil) t += cw.recoilUntil - state.time;
  // progress runs 0..TASK_S[task] whatever the real duration: scale what is left
  const loadTask = cls === 'mortar' ? 'dropRound' : 'load';
  let loadLeft = 0;
  if (cls !== 'hmg' && !cw.chambered) loadLeft = loadBaseS(cls, cw.weaponId) * (1 - clamp((cw.progress?.[loadTask] ?? 0) / TASK_S[loadTask], 0, 1)) * fLoad;
  else if (cls === 'atgun' && wrongRoundChambered(state, cw, gunner)) loadLeft = Math.max(0, TASK_S.unload - (cw.progress?.unload ?? 0)) * f + loadBaseS(cls, cw.weaponId) * fLoad;
  let layLeft = 0;
  if (!cw.laid) {
    const total = (cw.mission?.layS ?? TASK_S.lay) * layDrill(cls, gunner.experience);
    layLeft = total * (1 - clamp((cw.progress?.lay ?? 0) / TASK_S.lay, 0, 1));
  }
  // a gun is loaded and laid side by side; a mortar bomb is dropped once the lay is done
  t += cls === 'atgun' ? Math.max(loadLeft, layLeft) : loadLeft + layLeft;
  if (t <= 0 && cls !== 'mortar') {
    // loaded and laid: the gunner must be at the sight to fire
    const seat = weaponFramePoint(cw.pos, cw.facing, CREW_LAYOUT[cls].gunner);
    const d = dist(gunner.pos, seat);
    if (d > AT_STATION_TILES + 0.1) t += (d * TILE_M) / STATION_WALK_MS;
  }
  return t;
}

/** Called by combat when the gunner of a crew-served weapon wants to fire at `req.aim`. Starts a new
 * mission (a new lay) or a re-lay correction as needed and returns the seconds still to wait, or 0
 * when the round may be fired now: the weapon in action, a round loaded, laid on this target and
 * the gunner at the sight. Soldiers who do not serve a crew weapon always get 0. */
export function fireMissionWait(state: BattleState, team: Team | undefined, gunner: Soldier, req: FireRequest): number {
  const cw = team?.crewWeapon;
  if (!cw || cw.gunnerId !== gunner.id || gunner.weaponId !== cw.weaponId) return 0;
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return 0;
  ensureTaskState(cw, cls);
  if (!isInAction(cw) || cw.goal !== 'deploy' || cw.abandoned || !canWorkGun(gunner)) { clearMission(cw); return 1; }
  const m = cw.mission;
  const movedM = m ? dist(m.layAim, req.aim) * TILE_M : Infinity;
  const sameTrack = !!m && m.targetTeamId != null && m.targetTeamId === req.targetTeamId;
  if (!m || (!sameTrack && movedM > MISSION_NEW_AIM_M)) {
    const distM = dist(gunner.pos, req.aim) * TILE_M;
    const traverse = wrapAngle(angleTo(cw.pos, req.aim) - cw.facing);
    const moving = req.targetMoving ?? (!!req.targetVehicle && Math.abs(req.targetVehicle.speed) > 0.1);
    const layS = layBaseS(cw.weaponId, distM, traverse, moving) + (req.extraFirstRoundDelayS ?? 0) / layDrill(cls, gunner.experience);
    const mission: FireMission = {
      layAim: { x: req.aim.x, y: req.aim.y }, targetTeamId: req.targetTeamId, timer: layS * layDrill(cls, gunner.experience),
      rounds: 0, loaded: !!cw.chambered, startedAt: state.time, layS, lastRequestAt: state.time,
    };
    cw.mission = mission;
    cw.laid = false;
    delete cw.progress!.lay;
  } else {
    m.lastRequestAt = state.time;
    if (sameTrack && movedM > MISSION_RELAY_M) {
      // tracked target moved: small correction, keeps the mission (and its walk-in)
      m.layAim = { x: req.aim.x, y: req.aim.y };
      if (cw.laid) { cw.laid = false; m.layS = RELAY_S; delete cw.progress!.lay; } else m.layS = (m.layS ?? TASK_S.lay) + RELAY_S * (1 - clamp((cw.progress!.lay ?? 0) / TASK_S.lay, 0, 1));
    } else if (!sameTrack && req.targetTeamId !== m.targetTeamId) {
      m.targetTeamId = req.targetTeamId; // a nearby target of another team: same lay, now tracking it
    }
  }
  let hold = false;
  if (cls === 'atgun') hold = layOnTarget(state, cw, gunner, req, !m || cw.mission !== m);
  const wait = missionRemaining(state, cw, cls, gunner);
  cw.mission!.timer = wait;
  if (hold && wait <= 1e-6) return 0.5;
  return wait > 1e-6 ? wait : 0;
}

/** Guns: the round this mission needs and, against armour, the gunner's aim point (chosen when the
 * lay starts or the target vehicle changes; an aimed lay takes 20-40% longer). Returns true while
 * a veteran holds his fire for a better presentation. */
function layOnTarget(state: BattleState, cw: CrewWeaponState, gunner: Soldier, req: FireRequest, newMission: boolean): boolean {
  const m = cw.mission!;
  const w = WEAPONS[cw.weaponId];
  if (!w) return false;
  const counts = soldierRounds(state, gunner);
  const tv = req.targetVehicle ?? null;
  // the round in the breech counts as available to him
  const have = cw.chambered && cw.chamberedType ? { ...counts, [cw.chamberedType]: counts[cw.chamberedType] + 1 } : counts;
  if (!tv) {
    m.aimPoint = undefined; m.aimVehicleId = undefined;
    m.wantRound = chooseRound(w, have, { kind: req.smoke ? 'smoke' : 'soft' }) ?? undefined;
    return false;
  }
  let hold = false;
  if (newMission || m.aimVehicleId !== tv.id || m.aimPoint == null) {
    const choice = chooseAimPoint(w, have, gunnerSkill(gunner), cw.pos, tv, state.config.year);
    const before = aimLayMul(m.aimPoint ?? 'mass');
    m.aimPoint = choice.aimPoint;
    if (m.aimVehicleId !== tv.id) { m.misses = 0; m.bracketFrom = undefined; m.bracketAt = undefined; }
    m.aimVehicleId = tv.id;
    if (!cw.laid) m.layS = ((m.layS ?? TASK_S.lay) / before) * aimLayMul(choice.aimPoint);
    hold = choice.hold;
    if (hold) m.aimPoint = undefined; // look again at the next request
  }
  if (hold && state.time - m.startedAt > AIM_HOLD_MAX_S) hold = false;
  const def = VEHICLE_DEFS[tv.defId];
  const armorMm = def ? expectedArmorMm(tv, def, cw.pos, m.aimPoint ?? 'mass', gunnerSkill(gunner) > SKILL_ACE) : 9999;
  m.wantRound = chooseRound(w, have, { kind: 'vehicle', armorMm, distM: dist(cw.pos, tv.pos) * TILE_M }) ?? undefined;
  return hold;
}

/** The type of the round in this gunner's breech ('ap' for weapons with one round type). */
export function chamberedRoundType(team: Team | undefined, s: Soldier): RoundType {
  const cw = team?.crewWeapon;
  return cw && cw.gunnerId === s.id && cw.chambered && cw.chamberedType ? cw.chamberedType : 'ap';
}

/** The gunner's aim point on `vehicleId` for the current mission ('mass' when none). */
export function missionAimPoint(team: Team | undefined, vehicleId: number): AimPoint {
  const m = team?.crewWeapon?.mission;
  return m && m.aimVehicleId === vehicleId && m.aimPoint ? m.aimPoint : 'mass';
}

/** Called by combat after a crew-served weapon fired a round: counts it; the breech is empty again
 * (guns recoil and run out first), the next bomb has to be dropped. */
export function onMissionRound(state: BattleState, team: Team | undefined, gunner: Soldier): void {
  const cw = team?.crewWeapon;
  if (!cw || cw.gunnerId !== gunner.id) return;
  const cls = crewServedClass(cw.weaponId);
  if (!cls) return;
  if (cw.mission) { cw.mission.rounds++; cw.mission.loaded = false; }
  if (cls !== 'hmg') { cw.chambered = false; cw.chamberedType = undefined; }
  if (cls === 'atgun') {
    cw.recoilUntil = state.time + RECOIL_S;
    // FOLLOW-UP: the piece has jumped; the next round on this target needs a correction of
    // 1.5-2.5 s (by the layer's skill), made while the loader rams the next round
    if (cw.mission) {
      cw.laid = false;
      cw.mission.layS = followUpLayS(gunner.experience) / laySkillMul(gunner.experience);
      delete cw.progress?.lay;
    }
  }
  gunner.crewTask = { id: 'fire', progress: 0, walking: false };
}

/** Bracketing (sim/gunTiming.ts): hit-chance multiplier of this gun's next round at `vehicle`: +15%
 * per observed miss on the same target, up to +30%, lost when either party has moved ~10 m. */
export function missionBracketMul(team: Team | undefined, from: Vec2, vehicle: Vehicle): number {
  const m = team?.crewWeapon?.mission;
  if (!m || m.aimVehicleId !== vehicle.id) return 1;
  if (bracketLost(m, from, vehicle.pos)) { m.misses = 0; m.bracketFrom = undefined; m.bracketAt = undefined; }
  return bracketMul(m.misses);
}

/** The crew watched its round at `vehicle` fall: a miss is corrected for the next one. */
export function onMissionShotAtVehicle(team: Team | undefined, hit: boolean, from: Vec2, vehicle: Vehicle): void {
  const m = team?.crewWeapon?.mission;
  if (!m || hit) return;
  if (m.aimVehicleId == null) m.aimVehicleId = vehicle.id;
  if (m.aimVehicleId !== vehicle.id) return;
  m.misses = Math.min(2, (m.misses ?? 0) + 1);
  m.bracketFrom ??= { ...from };
  m.bracketAt ??= { ...vehicle.pos };
}

/** Guns and HMGs take their ammunition through the crew's tasks (`load` / `feedBelt`), so combat's
 * own magazine reload does not apply to their gunner. */
export function crewFeedsAmmo(team: Team | undefined, s: Soldier): boolean {
  const cw = team?.crewWeapon;
  if (!cw || cw.gunnerId !== s.id || s.weaponId !== cw.weaponId) return false;
  const cls = crewServedClass(cw.weaponId);
  return cls === 'atgun' || cls === 'hmg';
}

/** A round sits in the breech of this gunner's gun (it already left his ammunition count). */
export function hasChamberedRound(team: Team | undefined, s: Soldier): boolean {
  const cw = team?.crewWeapon;
  return !!cw && cw.gunnerId === s.id && s.weaponId === cw.weaponId && !!cw.chambered && crewServedClass(cw.weaponId) === 'atgun';
}

/** Combat fires the chambered round: hand it back to the count combat is about to take it from. */
export function takeChamberedRound(team: Team | undefined, s: Soldier): void {
  if (hasChamberedRound(team, s)) s.ammo++;
}

/** Rounds already fired on the team's current mission (0 when none). */
export function missionRounds(team: Team | undefined): number {
  return team?.crewWeapon?.mission?.rounds ?? 0;
}
