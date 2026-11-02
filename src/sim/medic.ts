import {planningMap} from './navigationKnowledge';
import {humanCapability} from './humanCondition';
import {canObserveComrade,learnCasualty,perception} from './perception';
import {visualIds,vehicleVisualIds,vehicleObserver,knownContacts,knowsDirectly,teamObserver,directContacts} from './perception';
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
import { isPassable } from './path';
import { addMessage } from './messages';
import * as dm from '@/shared/dmath';

/** Seconds a bandage / stabilise takes (the medic's `bandageUntil`, which the renderer plays). */
export const MEDIC_TREAT_S = 3;
/** Squad initiative cooldown per wounded man (s): one treatment attempt this often. */
const RETRY_COOLDOWN_S = 10;
/** Heavy fire: suppression above this and nobody stops to play medic. */
const MAX_SUPPRESSION = 40;
/** Walk-to-patient reach (tiles): he kneels right beside the man (the bandage pose reaches ~1 m). */
const REACH_TILES = 0.75;
/** He walks to a point this far short of the patient (tiles), so he kneels beside him, not on him. */
const KNEEL_OFF_TILES = 0.45;
/** Carry: the casualty is dragged this far behind the medic (metres). Matches the render pose
 * pair `crew.drag` / `prone.dragged` (tools/blender/soldiers.py DRAG_M). */
export const DRAG_M = 1.3;
/** The carrier heads for cover at least this far from the nearest spotted enemy (tiles). */
const SAFE_DIST_TILES = 10 / TILE_M;

interface MedicTask {
  medicId: number;
  patientId: number;
  patientPos?:Vec2;
  /** 'walk' -> 'treat' -> 'carry' */
  phase: 'walk' | 'treat' | 'carry';
  since: number;
  /** carry: the route to cover has been given (an empty path afterwards = arrived) */
  routed?: boolean;
}
/** One task per team (per state), plus per-patient retry cooldown. */


/** Per-soldier treatment deadline (the sim's own copy of `bandageUntil`). */


export function isReceivingTreatment(state:BattleState,s:Soldier):boolean {
  return [...((state.humanRuntime?.medicTasks as Map<number,MedicTask>|undefined)?.values()??[])].some(t=>t.patientId===s.id&&t.phase==='treat');
}

export function isTreating(s: Soldier, time: number): boolean {
  const t = s.treatmentUntil;
  return t != null && time < t;
}

function taskMap(state: BattleState): Map<number, MedicTask> {
  let m = (state.humanRuntime?.medicTasks as Map<number,MedicTask>|undefined);
  if (!m) { m = new Map(); (state.humanRuntime??={}).medicTasks=m; }
  return m;
}

/** Nearest spotted enemy position to `p`, or null when nobody hostile is spotted. */
function nearestSpottedEnemyPos(state:BattleState,observer:Soldier,p:Vec2):Vec2|null{
 let best:Vec2|null=null,bd=Infinity;for(const c of knownContacts(state,observer)){if(c.health==='dead')continue;const d=dist(c.pos,p);if(d<bd){bd=d;best=c.pos;}}return best;
}

/** Cover tile ~SAFE_DIST from the enemy, nearest to `from`; falls back to `from` itself. */
function rearCoverSpot(state: BattleState, team: Team, from: Vec2, enemy: Vec2 | null): Vec2 {
  const map = planningMap(state,state.soldiers.get(team.leaderId));
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
  const retries = (state.humanRuntime?.medicRetries as Map<number,number>|undefined) ?? (() => { const r = new Map<number, number>(); (state.humanRuntime??={}).medicRetries=r; return r; })();

  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    const task = m.get(team.id);

    // advance the running task
    if (task) {
      const medic = state.soldiers.get(task.medicId);
      const patient = state.soldiers.get(task.patientId);
      if (!medic || !patient || medic.health === 'dead' || medic.health === 'incapacitated') {
        m.delete(team.id);
        continue;
      }
      const visible=canObserveComrade(state,medic,patient);
      if(visible){learnCasualty(state,medic,patient.id,{health:patient.health,pos:{...patient.pos},observedAt:state.time,sourceId:medic.id,isLeader:patient.isLeader});task.patientPos={...patient.pos};}
      if((task.phase!=='walk'||visible)&&patient.health==='dead'){m.delete(team.id);continue;}
      if(!humanCapability(medic,state.time).canOperate)continue;
      const knownPos=task.patientPos??medic.perception?.casualties[patient.id]?.pos??{...medic.pos};
      // a new player order (issued after the task began) cancels the carry — drop the patient
      const order = team.order;
      if (order && state.time - order.issuedAt < 0.5 && task.phase !== 'walk') {
        // a new player order cancels the task; the patient is put down where he lies
        medic.bandageUntil = undefined;
        medic.bandageFace = undefined;
        patient.carrying = undefined;
        medic.carrying = undefined;
        m.delete(team.id);
        continue;
      }
      if (task.phase === 'walk') {
        if(dist(medic.pos,knownPos)<=REACH_TILES&&!visible){m.delete(team.id);continue;}
        if (visible&&dist(medic.pos, patient.pos) <= REACH_TILES) {
          task.phase = 'treat';
          task.since = state.time;
          medic.treatmentUntil=state.time+MEDIC_TREAT_S;
          medic.bandageUntil = state.time + MEDIC_TREAT_S;
          medic.bandageFace = { ...patient.pos };
          medic.path = [];
        } else if (medic.path.length === 0) {
          // (an empty path means he is standing, whatever stale 'moving' activity he carries)
          const d = dist(medic.pos, knownPos);
          const k = d > KNEEL_OFF_TILES ? (d - KNEEL_OFF_TILES) / d : 0;
          medic.path = findMedicPath(state, medic.pos, {
            x: medic.pos.x + (knownPos.x - medic.pos.x) * k, y: medic.pos.y + (knownPos.y - medic.pos.y) * k,
          });
          medic.activity = 'moving';
          if (medic.path.length === 0) { m.delete(team.id); continue; }
        }
      } else if (task.phase === 'treat') {
        medic.path = [];
        if (state.time >= task.since + MEDIC_TREAT_S) {
          if (patient.health === 'wounded') {
            patient.health = 'healthy';
            addMessage(state, `${team.name}\n${patient.name} bandaged.`, 'good', patient.side);
            m.delete(team.id);
          } else {
            // incapacitated: stabilized, then carried to the rear
            task.phase = 'carry';
            task.since = state.time;
            medic.carrying = { patientId: patient.id, since: state.time };
            addMessage(state, `${team.name}\nCarrying ${patient.name} to cover.`, 'good', patient.side);
          }
        }
      } else {
        // carry: toward rear cover, dragging the patient DRAG_M behind (drawn by unitRender)
        if (medic.path.length === 0 && !task.routed) {
          task.routed = true;
          const enemy = nearestSpottedEnemyPos(state, medic, medic.pos);
          const dest = rearCoverSpot(state, team, medic.pos, enemy);
          medic.path = findMedicPath(state, medic.pos, dest);
          if (medic.path.length === 0) {
            medic.carrying = undefined;
            m.delete(team.id);
            continue;
          }
          medic.activity = 'moving';
        }
        dragBehind(state, medic, patient);
        if (medic.path.length === 0) {
          medic.carrying = undefined;
          addMessage(state, `${team.name}\n${patient.name} is in cover.`, 'good', patient.side);
          m.delete(team.id);
        }
      }
      continue;
    }

    // Each potential helper chooses only from injuries they actually saw or were told about.
    let patient:Soldier|null=null,medic:Soldier|null=null,point:Vec2|null=null,best=Infinity;
    for(const sid of team.soldierIds){const helper=state.soldiers.get(sid);if(!helper||helper.health!=='healthy'||helper.vehicleId!=null||helper.carrying||helper.suppression>MAX_SUPPRESSION||!humanCapability(helper,state.time).canOperate)continue;
      for(const id of team.soldierIds){const seen=state.soldiers.get(id);if(seen&&id!==helper.id&&canObserveComrade(state,helper,seen))learnCasualty(state,helper,id,{health:seen.health,pos:{...seen.pos},observedAt:state.time,sourceId:helper.id,isLeader:seen.isLeader});}
      for(const [id,known] of Object.entries(helper.perception?.casualties??{})){
        if(known.health!=='wounded'&&known.health!=='incapacitated'||state.time-known.observedAt>120)continue;
        const casualty=state.soldiers.get(Number(id));if(!casualty||casualty.teamId!==team.id||casualty.id===helper.id)continue;
        if(state.time-(retries.get(casualty.id)??-Infinity)<RETRY_COOLDOWN_S)continue;
        const d=dist(helper.pos,known.pos);if(d<best){best=d;patient=casualty;medic=helper;point={...known.pos};}
      }
    }
    if(!patient||!medic||!point)continue;retries.set(patient.id,state.time);m.set(team.id,{medicId:medic.id,patientId:patient.id,patientPos:point,phase:'walk',since:state.time});

  }
}

/** The casualty slides along DRAG_M behind the medic, on the far side from where he is heading
 * (a trailing drag, not a teleport). Never into impassable ground: then he stays put this step. */
function dragBehind(state: BattleState, medic: Soldier, patient: Soldier): void {
  const next = medic.path[0];
  const ahead = next ? { x: next.x - medic.pos.x, y: next.y - medic.pos.y } : { x: medic.pos.x - patient.pos.x, y: medic.pos.y - patient.pos.y };
  const len = dm.hypot(ahead.x, ahead.y);
  if (len < 1e-4) return;
  const r = DRAG_M / TILE_M;
  const p = { x: medic.pos.x - (ahead.x / len) * r, y: medic.pos.y - (ahead.y / len) * r };
  // blend toward the trailing spot so turns swing him round instead of snapping
  const q = { x: patient.pos.x + (p.x - patient.pos.x) * 0.35, y: patient.pos.y + (p.y - patient.pos.y) * 0.35 };
  if (!isPassable(state.map, Math.floor(q.x), Math.floor(q.y), 'infantry')) return;
  patient.pos = q;
  patient.path = [];
}

/** Straight-line path (the sim's movement code handles collisions); a LOS-free fallback is fine
 * because the walker re-paths each time the queue empties. */
function findMedicPath(state: BattleState, from: Vec2, to: Vec2): Vec2[] {
  const d = dist(from, to);
  if (d < 0.05) return [];
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
