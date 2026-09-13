// ============================================================================
// mind.ts — per-soldier psychology, belief memory and mental-state machine.
// See docs/superpowers/specs/2026-09-13-soldier-mind-design.md (sections 1-8, 11).
// ============================================================================
import type {
  Activity, BattleState, EnemyBelief, MentalState, Soldier, SoldierMind, Team, Vec2, WeaponClass,
} from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, angleTo } from '@/shared/math';
import { hasLOS } from './los';
import { findPath } from './path';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';
import { applyOrderToSoldier } from './orders';

// ---------------------------------------------------------------- motivation
/** Motivation seed from experience (proxy for conscript/regular/elite quality bands) + leadership. */
export function baseMotivation(experience: number, isLeader: boolean): number {
  let m: number;
  if (experience < 35) m = 30 + (experience / 35) * 20;        // conscript 30-50
  else if (experience < 55) m = 50 + ((experience - 35) / 20) * 20; // regular 50-70
  else m = 70 + Math.min(1, (experience - 55) / 45) * 20;      // elite 70-90
  if (isLeader) m += 10;
  return clamp(m, 0, 100);
}

type Trait = NonNullable<SoldierMind['trait']>;
const TRAITS: Trait[] = ['steady', 'nervous', 'brave', 'reckless', 'cautious', 'stoic'];

/** Roll a hidden personality trait (spec §11). Leaders are never `nervous`. */
export function rollTrait(rng: Rng, isLeader: boolean): Trait | undefined {
  // ~60% of soldiers get a notable trait; the rest are unremarkable (undefined).
  if (!rng.chance(0.6)) return undefined;
  let t = rng.pick(TRAITS);
  if (isLeader) while (t === 'nervous') t = rng.pick(TRAITS);
  return t;
}

export function createMind(motivation: number, time = 0, trait?: Trait): SoldierMind {
  return {
    state: 'calm',
    motivation,
    stress: 0,
    fear: 0,
    beliefs: [],
    threatDir: null,
    threatLevel: 0,
    lastIncomingAt: -999,
    hesitation: 0,
    surrounded: false,
    helpless: false,
    stateSince: time,
    anchor: null,
    lastCoverSeekAt: -999,
    trait,
  };
}

const SEVERITY: MentalState[] = ['calm', 'alert', 'wary', 'shaken', 'pinned', 'cowering', 'panicked', 'broken'];
function severityIdx(s: MentalState): number { const i = SEVERITY.indexOf(s); return i < 0 ? 99 : i; }

function traitStressMul(trait?: Trait): number {
  if (trait === 'steady') return 0.8;
  if (trait === 'nervous') return 1.3;
  return 1;
}

/** Add (or subtract) stress, applying the soldier's trait multiplier to positive amounts. */
export function addStress(mind: SoldierMind, amount: number): void {
  const scaled = amount > 0 ? amount * traitStressMul(mind.trait) : amount;
  mind.stress = clamp(mind.stress + scaled, 0, 100);
}

// ------------------------------------------------------------------ tracking
interface SoldierTrack {
  panicLowFear: number;
  shakenLowFear: number;
  calmNoThreat: number;
  beliefAccum: number;
  shareAccum: number;
  hadFirstFire: boolean;
  freezeUntil: number;
  shotsFromSpot: number;
  spotAnchor: Vec2 | null;
  buddyFearUntil: number;
  gunAbandoned: boolean;
}

interface MindTrack {
  soldiers: Map<number, SoldierTrack>;
  berserkUntil: Map<number, number>;
  lastRallyAt: Map<number, number>;       // by team id
  leaderDeadSince: Map<number, number>;   // by team id
  gunTakeoverAt: Map<number, number>;     // by team id
  lastMsgAt: Map<number, number>;         // by team id, personality-message rate limit
}

const tracks = new WeakMap<BattleState, MindTrack>();

function getTrack(state: BattleState): MindTrack {
  let t = tracks.get(state);
  if (!t) {
    t = {
      soldiers: new Map(), berserkUntil: new Map(), lastRallyAt: new Map(),
      leaderDeadSince: new Map(), gunTakeoverAt: new Map(), lastMsgAt: new Map(),
    };
    tracks.set(state, t);
  }
  return t;
}

function getSoldierTrack(track: MindTrack, id: number): SoldierTrack {
  let t = track.soldiers.get(id);
  if (!t) {
    t = {
      panicLowFear: 0, shakenLowFear: 0, calmNoThreat: 0, beliefAccum: 0, shareAccum: 0,
      hadFirstFire: false, freezeUntil: -Infinity, shotsFromSpot: 0, spotAnchor: null,
      buddyFearUntil: -Infinity, gunAbandoned: false,
    };
    track.soldiers.set(id, t);
  }
  return t;
}

/** Rate-limited (1 per 5 s per team) personality message, player-side flavour per spec §11. */
function personalityMessage(state: BattleState, track: MindTrack, team: Team, text: string, kind: 'info' | 'bad' | 'good' = 'info'): void {
  if (team.side !== state.config.playerSide) return; // personality messages are player-side only (spec §11)
  const last = track.lastMsgAt.get(team.id) ?? -Infinity;
  if (state.time - last < 5) return;
  track.lastMsgAt.set(team.id, state.time);
  addMessage(state, `${team.name}\n${text}`, kind);
}

/** True while a soldier is frozen by first-fire shock (spec §11): no movement, no fire. */
export function isFirstFireFrozen(state: BattleState, soldierId: number): boolean {
  const t = getTrack(state).soldiers.get(soldierId);
  return !!t && state.time < t.freezeUntil;
}

// ------------------------------------------------------------------- beliefs
const MAX_BELIEFS = 8;
const MERGE_RADIUS_TILES = 4;

/** Add a new belief or merge into an existing one within 4 tiles. Exported for spotting.ts/sharing. */
export function addOrMergeBelief(
  mind: SoldierMind, pos: Vec2, kind: EnemyBelief['kind'], confidence: number, count: number, time: number,
): void {
  let best: EnemyBelief | null = null;
  let bestD = Infinity;
  for (const b of mind.beliefs) {
    const d = dist(b.pos, pos);
    if (d <= MERGE_RADIUS_TILES && d < bestD) { bestD = d; best = b; }
  }
  if (best) {
    best.pos = { ...pos };
    best.confidence = Math.max(best.confidence, confidence);
    best.count = Math.max(best.count, count);
    if (kind === 'seen') best.kind = 'seen';
    best.time = time;
    return;
  }
  if (mind.beliefs.length >= MAX_BELIEFS) {
    let worst = 0;
    let worstC = Infinity;
    mind.beliefs.forEach((b, i) => { if (b.confidence < worstC) { worstC = b.confidence; worst = i; } });
    mind.beliefs.splice(worst, 1);
  }
  mind.beliefs.push({ pos: { ...pos }, count, confidence, kind, time, deadSeen: 0 });
}

/** Called by spotting.ts for each (spotter, spotted-enemy) pair each spotting pass. */
export function onSpotted(state: BattleState, spotter: Soldier, enemy: Soldier, clusterCount: number): void {
  addOrMergeBelief(spotter.mind, enemy.pos, 'seen', 1, clusterCount, state.time);
  if (spotter.mind.state === 'calm') spotter.mind.state = 'alert';
}

function countDeadNear(state: BattleState, soldier: Soldier, pos: Vec2): number {
  let n = 0;
  for (const e of state.soldiers.values()) {
    if (e.side === soldier.side) continue;
    if (e.health !== 'dead') continue;
    if (dist(e.pos, pos) > MERGE_RADIUS_TILES) continue;
    if (!hasLOS(state.map, soldier.pos, e.pos)) continue;
    n++;
  }
  return n;
}

function enemyVisibleNear(state: BattleState, soldier: Soldier, pos: Vec2): boolean {
  for (const id of state.spotted[soldier.side]) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    if (dist(e.pos, pos) <= MERGE_RADIUS_TILES) return true;
  }
  return false;
}

function maintainBeliefs(state: BattleState, soldier: Soldier, dtSinceLast: number): void {
  const mind = soldier.mind;
  for (let i = mind.beliefs.length - 1; i >= 0; i--) {
    const b = mind.beliefs[i];
    b.confidence -= (1 / 120) * dtSinceLast;
    if (hasLOS(state.map, soldier.pos, b.pos) && !enemyVisibleNear(state, soldier, b.pos)) {
      b.confidence *= Math.pow(0.5, dtSinceLast / 10);
    }
    b.deadSeen = countDeadNear(state, soldier, b.pos);
    if (b.deadSeen >= b.count) {
      addStress(mind, -10);
      mind.beliefs.splice(i, 1);
      continue;
    }
    if (b.confidence < 0.1) mind.beliefs.splice(i, 1);
  }
}

function shareBeliefs(state: BattleState, soldier: Soldier, team: Team | undefined): void {
  if (!team) return;
  const isLeader = soldier.id === team.leaderId;
  for (const id of team.soldierIds) {
    if (id === soldier.id) continue;
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    const dM = dist(o.pos, soldier.pos) * TILE_M;
    const shares = (isLeader && dM <= 30) || dM <= 10;
    if (!shares) continue;
    for (const b of soldier.mind.beliefs) {
      addOrMergeBelief(o.mind, b.pos, 'reported', b.confidence * 0.7, b.count, state.time);
    }
  }
}

// -------------------------------------------------------------- threat level
function decayThreatAndBeliefs(state: BattleState, dt: number, soldier: Soldier, t: SoldierTrack): void {
  const mind = soldier.mind;
  mind.threatLevel = Math.max(0, mind.threatLevel - 0.1 * dt);

  let strongest: EnemyBelief | null = null;
  for (const b of mind.beliefs) {
    if (b.confidence > 0.5 && (!strongest || b.confidence > strongest.confidence)) strongest = b;
  }
  if (strongest) {
    mind.threatLevel = Math.max(mind.threatLevel, 0.4);
    mind.threatDir = angleTo(soldier.pos, strongest.pos);
  }
  if (mind.threatLevel <= 0.2) mind.threatDir = null;

  t.beliefAccum += dt;
  if (t.beliefAccum >= 0.5) {
    maintainBeliefs(state, soldier, t.beliefAccum);
    t.beliefAccum = 0;
  }
  t.shareAccum += dt;
  if (t.shareAccum >= 2) {
    shareBeliefs(state, soldier, state.teams.get(soldier.teamId));
    t.shareAccum = 0;
  }
}

// ------------------------------------------------------------------- events
/** Fire that lands near (or on) a soldier: near-miss/hit stress + belief/threatDir update (spec §5),
 * plus first-fire shock for green troops (spec §11). */
export function onIncomingFire(
  state: BattleState, rng: Rng, soldier: Soldier, shooter: Soldier | null, impactPos: Vec2,
  weaponCls: WeaponClass, applyStress = true,
): void {
  const mind = soldier.mind;
  const distTiles = dist(soldier.pos, impactPos);
  const distM = distTiles * TILE_M;
  const coverFactor = 1 - (soldier.cover ?? 0) * 0.5;

  if (applyStress) {
    if (distTiles <= 1.5) {
      // Balance tuning (harness): halved from the design brief's raw table (6/9/14) — at the
      // brief's original magnitudes, stress saturated almost instantly under any sustained
      // firefight and the panic ratchet below never let the attacking side recover, collapsing
      // its return fire to near zero and gutting the harness's attacker win rate (2/16).
      let base = 3;
      if (weaponCls === 'lmg' || weaponCls === 'hmg' || weaponCls === 'smg' || weaponCls === 'coaxmg') base = 4.5;
      else if (weaponCls === 'tankgun' || weaponCls === 'atgun' || weaponCls === 'atrocket' || weaponCls === 'mortar') base = 7;
      addStress(mind, base * coverFactor);
    } else if (distM <= 100) {
      addStress(mind, 0.5 * coverFactor);
    }
  }
  mind.lastIncomingAt = state.time;

  if (shooter) {
    const spotted = state.spotted[soldier.side].has(shooter.id);
    if (spotted) {
      addOrMergeBelief(mind, shooter.pos, 'fired', 0.9, 1, state.time);
      mind.threatDir = angleTo(soldier.pos, shooter.pos);
      mind.threatLevel = 1;
    } else if (hasLOS(state.map, soldier.pos, shooter.pos)) {
      mind.threatDir = angleTo(soldier.pos, shooter.pos);
      mind.threatLevel = 1;
      const dir = mind.threatDir;
      const farPos = { x: soldier.pos.x + Math.sin(dir) * (60 / TILE_M), y: soldier.pos.y - Math.cos(dir) * (60 / TILE_M) };
      addOrMergeBelief(mind, farPos, 'fired', 0.5, 1, state.time);
    } else {
      mind.threatLevel = Math.max(mind.threatLevel, 0.6);
    }
  } else {
    mind.threatLevel = Math.max(mind.threatLevel, 0.6);
  }
  if (mind.state === 'calm') mind.state = 'alert';

  // ---- first-fire shock (spec §11): experience < 30, first time fired upon this battle.
  if (applyStress) {
    const track = getTrack(state);
    const t = getSoldierTrack(track, soldier.id);
    if (!t.hadFirstFire && soldier.experience < 30) {
      t.hadFirstFire = true;
      const team = state.teams.get(soldier.teamId);
      const leader = team ? state.soldiers.get(team.leaderId) : undefined;
      const leaderNear5 = !!leader && leader.id !== soldier.id && leader.health !== 'dead' && leader.health !== 'incapacitated'
        && dist(leader.pos, soldier.pos) * TILE_M <= 5;
      // Balance fix (suspect c): first-fire shock used to freeze every green soldier independently
      // the instant he was fired upon, so a whole conscript squad taking its first incoming rounds
      // together could freeze almost as one — no one left firing back to justify the freeze. Cap it
      // to at most 30% of the squad concurrently frozen; once that quota is full the rest still take
      // the stress hit (already applied above) but keep acting.
      let squadFrozenCount = 0;
      if (team) {
        for (const id of team.soldierIds) {
          if (id === soldier.id) continue;
          const ot = track.soldiers.get(id);
          if (ot && state.time < ot.freezeUntil) squadFrozenCount++;
        }
      }
      const squadSize = team ? team.soldierIds.length : 1;
      const frozenQuotaOk = squadFrozenCount < Math.max(1, Math.ceil(squadSize * 0.3));
      if (!leaderNear5 && frozenQuotaOk) {
        mind.state = 'shaken';
        mind.stateSince = state.time;
        t.freezeUntil = state.time + rng.range(3, 8);
        const teamObj = state.teams.get(soldier.teamId);
        if (teamObj) personalityMessage(state, track, teamObj, `${soldier.rank}. ${soldier.name} has frozen up.`, 'bad');
      }
    }
  }
}

/** Explosion (HE/mortar/grenade) landing within 20 m of a soldier (spec §2). */
export function onExplosionNear(state: BattleState, soldier: Soldier, pos: Vec2): void {
  const distM = dist(soldier.pos, pos) * TILE_M;
  if (distM > 20) return;
  const coverFactor = 1 - (soldier.cover ?? 0) * 0.5;
  addStress(soldier.mind, 15 * (1 - distM / 20) * coverFactor);
  soldier.mind.lastIncomingAt = state.time;
  soldier.mind.threatLevel = Math.max(soldier.mind.threatLevel, 0.6);
  if (soldier.mind.state === 'calm') soldier.mind.state = 'alert';
}

function nearestBeliefOrEnemy(state: BattleState, s: Soldier): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[s.side]) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const d = dist(e.pos, s.pos);
    if (d < bestD) { bestD = d; best = e.pos; }
  }
  if (best) return best;
  for (const b of s.mind.beliefs) {
    const d = dist(b.pos, s.pos);
    if (d < bestD) { bestD = d; best = b.pos; }
  }
  return best;
}

function enterBerserk(state: BattleState, soldier: Soldier, track: MindTrack): void {
  soldier.mind.state = 'berserk';
  soldier.mind.stateSince = state.time;
  soldier.activity = 'berserk';
  track.berserkUntil.set(soldier.id, state.time + 20);
  const dest = nearestBeliefOrEnemy(state, soldier);
  if (dest) {
    soldier.targetPoint = { ...dest };
    soldier.path = findPath(state.map, soldier.pos, dest, 'infantry');
  }
}

function maybeBerserk(state: BattleState, rng: Rng, soldier: Soldier, track: MindTrack): void {
  if (soldier.mind.state === 'berserk') return;
  const chance = soldier.mind.trait === 'brave' ? 0.08 : 0.05;
  if (soldier.experience > 70 && soldier.morale > 60 && rng.chance(chance)) {
    enterBerserk(state, soldier, track);
  }
}

function buddyIdOf(team: Team, id: number): number | null {
  const i = team.soldierIds.indexOf(id);
  if (i < 0) return null;
  if (i + 1 < team.soldierIds.length) return team.soldierIds[i + 1];
  if (i - 1 >= 0) return team.soldierIds[i - 1];
  return null;
}

/** A teammate was killed/wounded within sight (spec §2 table + §11 buddies/payback). */
export function onCasualtySeen(state: BattleState, rng: Rng, soldier: Soldier, victim: Soldier, killed: boolean): void {
  const team = state.teams.get(soldier.teamId);
  const isBuddy = team ? buddyIdOf(team, soldier.id) === victim.id : false;

  let amount = (killed ? 14 : 7) * (victim.isLeader ? 2 : 1);
  if (isBuddy && killed) amount = Math.max(amount, 25);
  addStress(soldier.mind, amount);

  if (killed && isBuddy) {
    const track = getTrack(state);
    if (soldier.experience >= 60) {
      // "payback": mark the strongest nearby belief (likely the killer) as high-priority.
      let best: EnemyBelief | null = null;
      let bestD = Infinity;
      for (const b of soldier.mind.beliefs) {
        const d = dist(b.pos, victim.pos);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best) { best.confidence = 1; best.count += 1; best.time = state.time; }
      if (team) personalityMessage(state, track, team, `${soldier.rank}. ${soldier.name} wants payback.`, 'info');
    } else if (soldier.experience < 40) {
      getSoldierTrack(track, soldier.id).buddyFearUntil = state.time + 30;
    }
  }

  if (killed) maybeBerserk(state, rng, soldier, getTrack(state));
}

/** The soldier was hit himself (spec §2 "Own wound"). */
export function onOwnWound(soldier: Soldier): void {
  addStress(soldier.mind, 25);
}

/** MG gunner hit while manning the gun: whole team gets +20 stress (spec §11 MG teams). */
export function onGunnerHit(state: BattleState, team: Team): void {
  for (const id of team.soldierIds) {
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    addStress(o.mind, 20);
  }
}

/** Called by combat.ts each time a soldier fires; drives sniper relocation (spec §11). */
export function onFired(state: BattleState, rng: Rng, soldier: Soldier): void {
  const team = state.teams.get(soldier.teamId);
  if (!team || team.type !== 'sniper') return;
  const t = getSoldierTrack(getTrack(state), soldier.id);
  if (!t.spotAnchor || dist(t.spotAnchor, soldier.pos) > 1) {
    t.spotAnchor = { ...soldier.pos };
    t.shotsFromSpot = 0;
  }
  t.shotsFromSpot++;
  if (t.shotsFromSpot >= 3) {
    t.shotsFromSpot = 0;
    t.spotAnchor = null;
    const angle = rng.range(0, Math.PI * 2);
    const distTiles = rng.range(10, 20) / TILE_M;
    const dest = { x: soldier.pos.x + Math.cos(angle) * distTiles, y: soldier.pos.y + Math.sin(angle) * distTiles };
    soldier.path = findPath(state.map, soldier.pos, dest, 'infantry');
    if (soldier.activity !== 'firing') soldier.activity = 'moving';
  }
}

// ---------------------------------------------------------- continuous inputs
const AT_WEAPON_CLASSES = new Set<WeaponClass>(['atgun', 'atrocket', 'atrifle']);

function teamHasAT(state: BattleState, team: Team): boolean {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (w && AT_WEAPON_CLASSES.has(w.cls)) return true;
  }
  return false;
}

function enemyTankInSight(state: BattleState, s: Soldier): boolean {
  for (const id of state.spottedVehicles[s.side]) {
    const v = state.vehicles.get(id);
    if (!v || v.state === 'knockedOut') continue;
    const def = VEHICLE_DEFS[v.defId];
    if (def && (def.kind === 'tank' || def.kind === 'spg')) return true;
  }
  return false;
}

function computeSurrounded(state: BattleState, s: Soldier): boolean {
  const rangeTiles = 60 / TILE_M;
  const quadrants = new Set<number>();
  for (const b of s.mind.beliefs) {
    if (b.confidence < 0.5) continue;
    if (dist(b.pos, s.pos) > rangeTiles) continue;
    const dx = b.pos.x - s.pos.x;
    const dy = b.pos.y - s.pos.y;
    const q = dx >= 0 ? (dy >= 0 ? 0 : 1) : (dy >= 0 ? 3 : 2);
    quadrants.add(q);
  }
  return quadrants.size >= 3;
}

function computeHelpless(s: Soldier): boolean {
  const noAmmo = s.ammo <= 0 && s.ammoReserve <= 0;
  const pinnedNoCover = s.mind.state === 'pinned' && (s.cover ?? 0) < 0.15;
  return noAmmo || pinnedNoCover;
}

function stepContinuousStress(state: BattleState, s: Soldier, team: Team | undefined, dt: number): number {
  let positive = 0;
  const mind = s.mind;

  if (team && enemyTankInSight(state, s) && !teamHasAT(state, team)) positive += 0.6 * dt;

  mind.surrounded = computeSurrounded(state, s);
  if (mind.surrounded) positive += 2 * dt;

  mind.helpless = computeHelpless(s);
  if (mind.helpless) positive += 1 * dt;

  if (s.fatigue > 70) positive += 0.5 * dt;

  positive *= traitStressMul(mind.trait);

  const leader = team ? state.soldiers.get(team.leaderId) : undefined;
  const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
  const leaderNear10 = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 10 : false;

  // Balance tuning: decay rates raised (3/6/9, was 2/4/6) to match the halved stress inputs above
  // and let stress/fear actually fall between engagements instead of only ever ratcheting up.
  let decay = 3;
  if (mind.threatLevel < 0.3 && state.time - mind.lastIncomingAt >= 10) decay = 6;
  if (leaderNear10 && mind.state === 'calm') decay = 9;

  return positive - decay * dt;
}

// --------------------------------------------------------------- state machine
const SEVERE_ACTIVITY: Partial<Record<MentalState, Activity>> = {
  pinned: 'pinned', cowering: 'cowering', panicked: 'panicked', broken: 'routed', berserk: 'berserk',
};

function resumeFromOrder(state: BattleState, s: Soldier, team: Team | undefined): void {
  s.stance = 'crouching';
  s.path = [];
  const order = team?.order;
  if (order && (order.type === 'move' || order.type === 'moveFast' || order.type === 'sneak')) {
    s.path = findPath(state.map, s.pos, order.target, 'infantry');
    s.activity = order.type === 'moveFast' ? 'movingFast' : order.type === 'sneak' ? 'sneaking' : 'moving';
  } else if (order && order.type === 'ambush') {
    s.activity = 'ambushing';
    s.stance = 'prone';
  } else if (order && order.type === 'fire') {
    s.activity = 'firing';
  } else {
    s.activity = 'defending';
  }
}

function escalate(mind: SoldierMind, experience: number, morale: number, suppression: number, hasThreatSignal: boolean): boolean {
  const before = mind.state;
  const stoicShield = mind.trait === 'stoic' && experience > 60;
  if (mind.state === 'calm' && hasThreatSignal) mind.state = 'alert';
  if (mind.state === 'alert' && mind.threatLevel > 0.5) mind.state = 'wary';
  if ((mind.state === 'wary' || mind.state === 'alert') && mind.fear > 40) mind.state = 'shaken';
  if (mind.state === 'shaken' && suppression > 60) mind.state = 'pinned';
  // Raw suppression pins regardless of fear: a man under a hail of MG fire gets his head down
  // even if he is not (yet) frightened. Panic still needs the fear/morale gates below.
  if ((mind.state === 'calm' || mind.state === 'alert' || mind.state === 'wary') && suppression > 60) mind.state = 'pinned';
  if (mind.state === 'pinned' && (suppression > 85 || mind.fear > 70)) mind.state = 'cowering';
  // Balance tuning: the design brief's "fear>80 && (experience<50 || morale<25)" panic gate let
  // ~75% of the roster (experience is spawned 20-60, so <50 is most soldiers) panic the instant
  // fear crossed 80 under sustained fire, and — because fear rarely dips for 5 continuous seconds
  // while still under fire — panicked recovery below almost never triggered, so whichever side took
  // the early casualties spiralled into permanent silence (a one-way ratchet). Requiring BOTH low
  // experience AND (low morale or very high fear) narrows this to genuinely green, badly-shaken
  // troops, matching the harness's balance targets.
  if (!stoicShield && mind.state === 'cowering' && experience < 40 && (mind.fear > 90 || morale < 20)) mind.state = 'panicked';
  if (mind.state === 'panicked' && morale < 10) mind.state = 'broken';
  return mind.state !== before;
}

function recover(mind: SoldierMind, t: SoldierTrack, suppression: number, morale: number, leaderFactor: number, dt: number): boolean {
  const before = mind.state;
  const need = (base: number) => base * leaderFactor;
  switch (mind.state) {
    case 'broken':
      if (morale >= 35) mind.state = 'panicked';
      break;
    case 'panicked':
      if (mind.fear < 60) {
        t.panicLowFear += dt;
        if (t.panicLowFear >= need(3)) { mind.state = 'cowering'; t.panicLowFear = 0; }
      } else t.panicLowFear = 0;
      break;
    case 'cowering':
      if (suppression < 70) mind.state = 'pinned';
      break;
    case 'pinned':
      if (suppression < 40) mind.state = 'shaken';
      break;
    case 'shaken':
      if (mind.fear < 30) {
        t.shakenLowFear += dt;
        if (t.shakenLowFear >= need(3)) { mind.state = 'wary'; t.shakenLowFear = 0; }
      } else t.shakenLowFear = 0;
      break;
    case 'wary':
      if (mind.threatLevel < 0.3) mind.state = 'alert';
      break;
    case 'alert': {
      const hasBelief = mind.beliefs.some((b) => b.confidence > 0.3);
      if (!hasBelief) {
        t.calmNoThreat += dt;
        if (t.calmNoThreat >= need(20)) { mind.state = 'calm'; t.calmNoThreat = 0; }
      } else t.calmNoThreat = 0;
      break;
    }
    default: break;
  }
  return mind.state !== before;
}

const GUN_CREW_TYPES = new Set(['atgun', 'mortar']);

function panicMessageFor(team: Team, s: Soldier, entering: boolean): string {
  if (GUN_CREW_TYPES.has(team.type)) {
    return entering ? `${s.rank}. ${s.name} abandons the gun!` : `${s.rank}. ${s.name} mans the gun.`;
  }
  return entering ? `${s.rank}. ${s.name} is panicking.` : `${s.rank}. ${s.name} has rallied.`;
}

function maybeRally(state: BattleState, s: Soldier, team: Team | undefined, track: MindTrack): void {
  if (!team) return;
  const leader = state.soldiers.get(team.leaderId);
  if (!leader || leader.id === s.id) return;
  if (leader.health === 'dead' || leader.health === 'incapacitated') return;
  if (leader.experience < 50) return;
  if (dist(leader.pos, s.pos) * TILE_M > 10) return;
  const last = track.lastRallyAt.get(team.id) ?? -Infinity;
  if (state.time - last < 30) return;
  track.lastRallyAt.set(team.id, state.time);
  for (const id of team.soldierIds) {
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    if (dist(o.pos, leader.pos) * TILE_M > 10) continue;
    addStress(o.mind, -30);
    o.morale = clamp(o.morale + 5, 0, 100);
  }
  personalityMessage(state, track, team, `${leader.rank}. ${leader.name} rallies his men.`, 'good');
}

function syncActivityForState(state: BattleState, s: Soldier, team: Team | undefined, prevState: MentalState, track: MindTrack): void {
  const mind = s.mind;
  const wasSevere = SEVERE_ACTIVITY[prevState] !== undefined;
  const isSevere = SEVERE_ACTIVITY[mind.state] !== undefined;

  if (isSevere) {
    s.activity = SEVERE_ACTIVITY[mind.state]!;
    if (mind.state === 'panicked' || mind.state === 'cowering' || mind.state === 'pinned') s.path = [];
    if (mind.state === 'pinned' || mind.state === 'cowering') s.stance = 'prone';
  } else if (wasSevere) {
    resumeFromOrder(state, s, team);
  }

  if (!team) return;
  if (prevState !== mind.state && (mind.state === 'panicked' || mind.state === 'cowering')) {
    maybeRally(state, s, team, track);
  }
  if (prevState !== 'panicked' && mind.state === 'panicked') {
    personalityMessage(state, track, team, panicMessageFor(team, s, true), 'bad');
  } else if (prevState === 'panicked' && mind.state !== 'panicked') {
    personalityMessage(state, track, team, panicMessageFor(team, s, false), 'good');
  }
}

function stepOneMind(state: BattleState, rng: Rng, dt: number, s: Soldier, track: MindTrack): void {
  const mind = s.mind;
  const team = state.teams.get(s.teamId);
  const t = getSoldierTrack(track, s.id);

  let hesitDt = dt;
  if (s.fatigue > 70) hesitDt = dt * 0.5; // fatigue doubles hesitation duration -> halves the decay rate
  mind.hesitation = Math.max(0, mind.hesitation - hesitDt);

  // Retry a refused order once hesitation has run out (spec §4: "hesitates before retrying"),
  // provided the order has not been replaced and the soldier is not in a severe state.
  if (mind.pendingOrderAt !== undefined && mind.hesitation === 0 && team) {
    if (!team.order || team.order.issuedAt !== mind.pendingOrderAt) mind.pendingOrderAt = undefined;
    else if (SEVERE_ACTIVITY[mind.state] === undefined && mind.state !== 'berserk' && s.health !== 'dead' && s.health !== 'incapacitated') {
      applyOrderToSoldier(state, team, s, rng);
    }
  }

  if (mind.state === 'berserk') {
    const until = track.berserkUntil.get(s.id) ?? 0;
    if (state.time >= until) {
      mind.state = 'alert';
      mind.stateSince = state.time;
      track.berserkUntil.delete(s.id);
      syncActivityForState(state, s, team, 'berserk', track);
    } else {
      decayThreatAndBeliefs(state, dt, s, t);
      return;
    }
  }

  const prevState = mind.state;

  const delta = stepContinuousStress(state, s, team, dt);
  mind.stress = clamp(mind.stress + delta, 0, 100);
  if (t.buddyFearUntil > state.time) {
    mind.fear = clamp(mind.stress * (1.0 - s.experience / 200 - mind.motivation / 400) - (s.morale - 50) / 5 + 20, 0, 100);
  } else {
    mind.fear = clamp(mind.stress * (1.0 - s.experience / 200 - mind.motivation / 400) - (s.morale - 50) / 5, 0, 100);
  }

  if (mind.fear > 60) s.morale = clamp(s.morale - 0.3 * dt, 0, 100);
  else if (mind.fear < 20) s.morale = clamp(s.morale + 0.2 * dt, 0, 100);

  const leader = team ? state.soldiers.get(team.leaderId) : undefined;
  const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
  const leaderNear15 = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 15 : false;
  let mDelta = 0;
  if (leaderNear15 && state.sides[s.side].morale > 50) mDelta += 0.02 * dt;
  if (!leaderAlive) mDelta -= 0.05 * dt;
  if (mind.helpless) mDelta -= 0.1 * dt;
  mind.motivation = clamp(mind.motivation + mDelta, 0, 100);

  decayThreatAndBeliefs(state, dt, s, t);

  const leaderNear10 = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 10 : false;
  const leaderFactor = leaderNear10 ? 0.5 : (leaderAlive ? 1 : 2);

  const hasThreatSignal = mind.beliefs.length > 0 || mind.threatLevel > 0.05 || (state.time - mind.lastIncomingAt) < 5;
  const escalated = escalate(mind, s.experience, s.morale, s.suppression, hasThreatSignal);
  if (!escalated) recover(mind, t, s.suppression, s.morale, leaderFactor, dt);

  // ---- gun crews (spec §11): inexperienced abandon early, veterans serve to the last round.
  if (team && GUN_CREW_TYPES.has(team.type)) {
    if (s.experience < 40 && mind.fear > 70 && mind.state !== 'panicked' && mind.state !== 'broken') {
      mind.state = 'panicked';
    } else if (s.experience >= 60 && severityIdx(mind.state) > severityIdx('pinned')) {
      mind.state = 'pinned';
    }
  }

  if (mind.state !== prevState) mind.stateSince = state.time;
  syncActivityForState(state, s, team, prevState, track);
}

// -------------------------------------------------------------- team-level passes
function stepMgAnchors(state: BattleState, dt: number): void {
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    let gunner: Soldier | null = null;
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      const w = WEAPONS[s.weaponId];
      if (w && (w.cls === 'lmg' || w.cls === 'hmg')) { gunner = s; break; }
    }
    if (!gunner || gunner.activity !== 'firing') continue;
    for (const id of team.soldierIds) {
      if (id === gunner.id) continue;
      const o = state.soldiers.get(id);
      if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
      if (dist(o.pos, gunner.pos) * TILE_M <= 6) addStress(o.mind, -1 * dt);
    }
  }
}

const GUN_WEAPON_CLASSES = new Set<WeaponClass>(['atgun', 'mortar', 'lmg', 'hmg']);

/** Promote the next living crewman to the crew-served weapon 2-6 s after the gunner falls. */
function stepGunTakeover(state: BattleState, track: MindTrack): void {
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    if (!GUN_CREW_TYPES.has(team.type) && team.type !== 'mg') continue;
    const gunnerId = team.soldierIds.find((id) => {
      const s = state.soldiers.get(id);
      const w = s ? WEAPONS[s.weaponId] : undefined;
      return !!w && GUN_WEAPON_CLASSES.has(w.cls);
    });
    if (gunnerId == null) continue;
    const gunner = state.soldiers.get(gunnerId);
    const gunnerDown = !gunner || gunner.health === 'dead' || gunner.health === 'incapacitated';
    if (!gunnerDown) { track.gunTakeoverAt.delete(team.id); continue; }

    const nextId = team.soldierIds.find((id) => {
      if (id === gunnerId) return false;
      const s = state.soldiers.get(id);
      return !!s && s.health !== 'dead' && s.health !== 'incapacitated';
    });
    if (nextId == null) { track.gunTakeoverAt.delete(team.id); continue; }

    let at = track.gunTakeoverAt.get(team.id);
    if (at === undefined) {
      const next = state.soldiers.get(nextId)!;
      const delay = clamp(2 + (100 - next.experience) / 25, 2, 6);
      at = state.time + delay;
      track.gunTakeoverAt.set(team.id, at);
    }
    if (state.time >= at) {
      const next = state.soldiers.get(nextId)!;
      const g = gunner!;
      const tmpW = next.weaponId; next.weaponId = g.weaponId; g.weaponId = tmpW;
      const tmpA = next.ammo; next.ammo = g.ammo; g.ammo = tmpA;
      personalityMessage(state, track, team, `${next.rank}. ${next.name} mans the gun.`, 'info');
      track.gunTakeoverAt.delete(team.id);
    }
  }
}

/** Most experienced survivor takes over 10 s after the leader dies; the interim adds stress and
 * a "who's in charge?" obedience penalty (read by orders.ts via `isLeaderless`). */
function stepLeaderSuccession(state: BattleState, dt: number, track: MindTrack): void {
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    const leader = state.soldiers.get(team.leaderId);
    const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
    if (leaderAlive) { track.leaderDeadSince.delete(team.id); continue; }
    if (team.soldierIds.length === 0) continue;

    let since = track.leaderDeadSince.get(team.id);
    if (since === undefined) { since = state.time; track.leaderDeadSince.set(team.id, since); }

    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
      addStress(s.mind, 0.5 * dt);
    }

    if (state.time - since >= 10) {
      let best: Soldier | null = null;
      for (const id of team.soldierIds) {
        const s = state.soldiers.get(id);
        if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
        if (!best || s.experience > best.experience) best = s;
      }
      if (best) {
        team.leaderId = best.id;
        best.isLeader = true;
        personalityMessage(state, track, team, `${best.rank}. ${best.name} takes command.`, 'info');
      }
      track.leaderDeadSince.delete(team.id);
    }
  }
}

/** True while a team has no living leader (spec §11 "who's in charge?"): orders.ts applies an
 * obedience penalty during this window. */
export function isLeaderless(state: BattleState, team: Team): boolean {
  const leader = state.soldiers.get(team.leaderId);
  return !leader || leader.health === 'dead' || leader.health === 'incapacitated';
}

/** Advance every living, uncrewed soldier's mind by dt. Vehicle crews share the commander's mind
 * and are stepped separately by vehicle.ts (spec §10). */
export function stepMinds(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);
  stepMgAnchors(state, dt);
  stepGunTakeover(state, track);
  stepLeaderSuccession(state, dt, track);
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null) continue;
    if (s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') continue;
    stepOneMind(state, rng, dt, s, track);
  }
}

export { getTrack as _getMindTrack };
