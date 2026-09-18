// medic.ts — first aid and casualty carry (spec 2026-09-17 §8, task B8).
// No dedicated medic unit: any healthy infantry soldier of a squad acts on his own initiative
// when a teammate is wounded or incapacitated and the squad is not under heavy fire. Wounded
// men are bandaged back to healthy; incapacitated men are stabilized and carried toward rear
// cover (a carried patient is hidden from enemy spotting — CC3-style carry saves lives).
// A new player order always cancels the task: the patient is put down gently where he lies.
import type { BattleState, Soldier, Team, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { hasLOS } from './los';
import { addMessage } from './messages';

/** Seconds the bandage/stabilize anim runs (drives render/soldierAnim markBandage). */
export const MEDIC_TREAT_S = 3;
import { markBandage } from '@/render/soldierAnim';
/** Squad initiative cooldown per wounded man (s): one treatment attempt this often. */
const RETRY_COOLDOWN_S = 10;
/** Heavy fire: suppression above this and nobody stops to play medic. */
const MAX_SUPPRESSION = 40;
/** Walk-to-patient reach (tiles). */
const REACH_TILES = 1.5;
/** The carrier heads for cover at least this far from the nearest spotted enemy (tiles). */
const SAFE_DIST_TILES = 10 / TILE_M;

interface MedicTask {
  medicId: number;
  patientId: number;
  /** 'walk' -> 'treat' -> 'carry' */
  phase: 'walk' | 'treat' | 'carry';
  since: number;
}
/** One task per team (per state), plus per-patient retry cooldown. */
const tasks = new WeakMap<BattleState, Map<number, MedicTask>>();
const retryAt = new WeakMap<BattleState, Map<number, number>>();
/** Per-soldier treatment deadline, read by the renderer through markBandage. */
const treatUntil = new WeakMap<Soldier, number>();

export function isTreating(s: Soldier, time: number): boolean {
  const t = treatUntil.get(s);
  return t != null && time < t;
}

function taskMap(state: BattleState): Map<number, MedicTask> {
  let m = tasks.get(state);
  if (!m) { m = new Map(); tasks.set(state, m); }
  return m;
}

/** Nearest spotted enemy position to `p`, or null when nobody hostile is spotted. */
function nearestSpottedEnemyPos(state: BattleState, side: Soldier['side'], p: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[side === 'german' ? 'soviet' : 'german']) {
    const t = state.teams.get(id);
    if (!t || t.outOfAction) continue;
    const d = dist(t.pos, p);
    if (d < bestD) { bestD = d; best = t.pos; }
  }
  return best;
}

/** Cover tile ~SAFE_DIST from the enemy, nearest to `from`; falls back to `from` itself. */
function rearCoverSpot(state: BattleState, team: Team, from: Vec2, enemy: Vec2 | null): Vec2 {
  const map = state.map;
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  for (let y = 1; y < map.height - 1; y += 2) for (let x = 1; x < map.width - 1; x += 2) {
    const t = map.tiles[y * map.width + x];
    if (t === 'water' || t === 'buildingWood' || t === 'buildingStone' || t === 'floor') continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    if (enemy && dist(p, enemy) < SAFE_DIST_TILES) continue;
    // prefer close to the carrier, and prefer cover-ish terrain
    const cover = t === 'woods' || t === 'rubble' || t === 'trench' || t === 'scatteredtrees' ? 0 : 6;
    const score = dist(p, from) + cover;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best ?? from;
}

/** Per sim step: hand out and advance medic tasks. Stepped from battle.ts after stepPickups. */
export function stepMedic(state: BattleState, rng: Rng, dt: number): void {
  const m = taskMap(state);
  const retries = retryAt.get(state) ?? (() => { const r = new Map<number, number>(); retryAt.set(state, r); return r; })();

  for (const team of state.teams.values()) {
    if (team.outOfAction || team.vehicleId != null) continue;
    const task = m.get(team.id);

    // advance the running task
    if (task) {
      const medic = state.soldiers.get(task.medicId);
      const patient = state.soldiers.get(task.patientId);
      if (!medic || !patient || medic.health === 'dead' || patient.health === 'dead' || medic.health === 'incapacitated') {
        m.delete(team.id);
        continue;
      }
      // a new player order (issued after the task began) cancels the carry — drop the patient
      const order = team.order;
      if (order && state.time - order.issuedAt < 0.5 && task.phase !== 'walk') {
        // a new player order cancels the task; the patient is put down where he lies
        markBandage(medic, state.time - MEDIC_TREAT_S);
        patient.carrying = undefined;
        medic.carrying = undefined;
        m.delete(team.id);
        continue;
      }
      if (task.phase === 'walk') {
        if (dist(medic.pos, patient.pos) <= REACH_TILES) {
          task.phase = 'treat';
          task.since = state.time;
          treatUntil.set(medic, state.time + MEDIC_TREAT_S);
          markBandage(medic, state.time);
          medic.path = [];
        } else if (medic.path.length === 0 && medic.activity !== 'moving') {
          medic.path = findMedicPath(state, medic.pos, patient.pos);
          medic.activity = 'moving';
          if (medic.path.length === 0) { m.delete(team.id); continue; }
        }
      } else if (task.phase === 'treat') {
        medic.path = [];
        if (state.time >= task.since + MEDIC_TREAT_S) {
          if (patient.health === 'wounded') {
            patient.health = 'healthy';
            if (patient.side === state.config.playerSide) addMessage(state, `${team.name}\n${patient.name} bandaged.`, 'good');
            m.delete(team.id);
          } else {
            // incapacitated: stabilized, then carried to the rear
            task.phase = 'carry';
            task.since = state.time;
            medic.carrying = { patientId: patient.id, since: state.time };
            if (patient.side === state.config.playerSide) addMessage(state, `${team.name}\nCarrying ${patient.name} to cover.`, 'good');
          }
        }
      } else {
        // carry: half speed toward rear cover; the patient rides (drawn by unitRender)
        if (medic.path.length === 0 && medic.activity !== 'moving') {
          const enemy = nearestSpottedEnemyPos(state, medic.side, medic.pos);
          const dest = rearCoverSpot(state, team, medic.pos, enemy);
          medic.path = findMedicPath(state, medic.pos, dest);
          if (medic.path.length === 0) {
            medic.carrying = undefined;
            m.delete(team.id);
            continue;
          }
          medic.activity = 'moving';
        }
        if (medic.path.length === 0) {
          medic.carrying = undefined;
          if (patient.side === state.config.playerSide) addMessage(state, `${team.name}\n${patient.name} is in cover.`, 'good');
          m.delete(team.id);
        }
      }
      continue;
    }

    // hand out a new task: healthy man + wounded/incapacitated teammate, squad not under fire
    let patient: Soldier | null = null;
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || s.vehicleId != null || s.carrying) continue;
      if (s.health !== 'wounded' && s.health !== 'incapacitated') continue;
      const last = retries.get(s.id) ?? -Infinity;
      if (state.time - last < RETRY_COOLDOWN_S) continue;
      if (!patient || dist(team.pos, s.pos) < dist(team.pos, patient.pos)) patient = s;
    }
    if (!patient) continue;
    if (patient.suppression > MAX_SUPPRESSION) continue;

    let medic: Soldier | null = null;
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || s === patient || s.vehicleId != null || s.carrying) continue;
      if (s.health !== 'healthy') continue;
      if (s.suppression > MAX_SUPPRESSION) continue;
      if (!medic || dist(s.pos, patient.pos) < dist(medic.pos, patient.pos)) medic = s;
    }
    if (!medic) continue;
    retries.set(patient.id, state.time);
    m.set(team.id, { medicId: medic.id, patientId: patient.id, phase: 'walk', since: state.time });
  }
}

/** Straight-line path (the sim's movement code handles collisions); a LOS-free fallback is fine
 * because the walker re-paths each time the queue empties. */
function findMedicPath(state: BattleState, from: Vec2, to: Vec2): Vec2[] {
  const d = dist(from, to);
  if (d < 0.5) return [];
  const steps = Math.max(1, Math.ceil(d));
  const path: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    path.push({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  }
  return path;
}

/** A carried patient is hidden from enemy spotting (CC3-style carry saves lives). */
export function isCarried(state: BattleState, s: Soldier): boolean {
  if (!s.carrying) return false;
  return true;
}

// keep Rng import used (stepMedic takes it for future dierolls parity with pickup.ts)
export type { Rng };
