import type {
  Activity, BattleState, Health, Side, Soldier, Team, TeamMoraleWord, TeamStatusWord, Vec2,
} from '@/shared/types';
import { SIDES, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist } from '@/shared/math';
import { findPath } from './path';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';

// ---------------------------------------------------------------- tracking
interface MoraleTrack {
  lastHealth: Map<number, Health>;
  tankScareAt: Map<number, number>;
  berserkUntil: Map<number, number>;
  teamLastStatus: Map<number, TeamStatusWord>;
}

const tracks = new WeakMap<BattleState, MoraleTrack>();

function getTrack(state: BattleState): MoraleTrack {
  let t = tracks.get(state);
  if (!t) {
    t = {
      lastHealth: new Map(),
      tankScareAt: new Map(),
      berserkUntil: new Map(),
      teamLastStatus: new Map(),
    };
    tracks.set(state, t);
  }
  return t;
}

export function moraleWord(m: number): TeamMoraleWord {
  if (m >= 85) return 'Fanatic';
  if (m >= 65) return 'Confident';
  if (m >= 45) return 'Steady';
  if (m >= 25) return 'Shaken';
  return 'Broken';
}

const BROKEN_ACTIVITIES: Activity[] = ['cowering', 'pinned', 'panicked', 'routed'];

function aliveTeammatesWithin(state: BattleState, s: Soldier, team: Team, radiusTiles: number): number {
  let n = 0;
  for (const id of team.soldierIds) {
    if (id === s.id) continue;
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    if (dist(o.pos, s.pos) <= radiusTiles) n++;
  }
  return n;
}

function nearestEnemySoldierDistTiles(state: BattleState, s: Soldier): number {
  const spotted = state.spotted[s.side];
  let best = Infinity;
  for (const id of spotted) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const d = dist(e.pos, s.pos);
    if (d < best) best = d;
  }
  return best;
}

function nearestEnemyTankDistTiles(state: BattleState, s: Soldier): number {
  const spotted = state.spottedVehicles[s.side];
  let best = Infinity;
  for (const id of spotted) {
    const v = state.vehicles.get(id);
    if (!v || v.state === 'knockedOut') continue;
    const def = VEHICLE_DEFS[v.defId];
    if (!def || def.kind !== 'tank') continue;
    const d = dist(v.pos, s.pos);
    if (d < best) best = d;
  }
  return best;
}

function applyTeamMoraleHit(state: BattleState, team: Team, amount: number): void {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    s.morale = clamp(s.morale - amount, 0, 100);
  }
}

function maybeBerserk(state: BattleState, rng: Rng, team: Team, track: MoraleTrack): void {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (s.activity === 'berserk' || s.activity === 'surrendered') continue;
    if (s.experience > 70 && s.morale > 60 && rng.chance(0.05)) {
      s.activity = 'berserk';
      track.berserkUntil.set(s.id, state.time + 20);
      const nearestId = nearestSpottedEnemyId(state, s);
      if (nearestId != null) {
        const enemy = state.soldiers.get(nearestId);
        if (enemy) {
          s.targetPoint = { ...enemy.pos };
          s.path = findPath(state.map, s.pos, enemy.pos, 'infantry');
        }
      }
    }
  }
}

function nearestSpottedEnemyId(state: BattleState, s: Soldier): number | null {
  const spotted = state.spotted[s.side];
  let best: number | null = null;
  let bestD = Infinity;
  for (const id of spotted) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const d = dist(e.pos, s.pos);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function resumeSoldier(state: BattleState, s: Soldier, team: Team | undefined): void {
  s.stance = 'crouching';
  if (team && team.order && (team.order.type === 'move' || team.order.type === 'moveFast' || team.order.type === 'sneak')) {
    s.path = findPath(state.map, s.pos, team.order.target, 'infantry');
    s.activity = team.order.type === 'moveFast' ? 'movingFast' : team.order.type === 'sneak' ? 'sneaking' : 'moving';
  } else {
    s.activity = 'defending';
  }
}

function stepSoldierState(state: BattleState, s: Soldier, dt: number, track: MoraleTrack): void {
  const team = state.teams.get(s.teamId);
  const leader = team ? state.soldiers.get(team.leaderId) : undefined;
  const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
  const leaderNearM = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 10 : false;
  const leaderNotSuppressed = leaderAlive && leader ? leader.suppression <= 60 : false;

  // -------------------------------------------------------- suppression decay
  const decayRate = leaderNearM && leaderNotSuppressed ? 8 : 5;
  s.suppression = clamp(s.suppression - decayRate * dt, 0, 100);

  // ------------------------------------------------------------- morale rate
  if (s.suppression > 60) {
    s.morale = clamp(s.morale - 0.5 * dt, 0, 100);
  } else if (s.activity === 'panicked' && nearestEnemySoldierDistTiles(state, s) * TILE_M > 100) {
    s.morale = clamp(s.morale + 1 * dt, 0, 100);
  } else if (leaderAlive) {
    s.morale = clamp(s.morale + 0.3 * dt, 0, 100);
  } else {
    s.morale = clamp(s.morale + 0.15 * dt, 0, 100);
  }

  // -------------------------------------------------------------- tank scare
  const tankDistM = nearestEnemyTankDistTiles(state, s) * TILE_M;
  if (tankDistM <= 100) {
    const last = track.tankScareAt.get(s.id) ?? -Infinity;
    if (state.time - last >= 10) {
      s.morale = clamp(s.morale - 5, 0, 100);
      track.tankScareAt.set(s.id, state.time);
    }
  }

  // ------------------------------------------------------------ berserk end
  if (s.activity === 'berserk') {
    const until = track.berserkUntil.get(s.id) ?? 0;
    if (state.time >= until) {
      s.activity = 'idle';
      track.berserkUntil.delete(s.id);
    } else {
      return; // berserk soldiers ignore other state transitions
    }
  }

  // -------------------------------------------------------- state cascade
  if (s.morale < 10) {
    if (s.activity !== 'routed') { s.activity = 'routed'; s.stance = 'standing'; }
  } else if (s.suppression > 85) {
    if (s.activity !== 'cowering') { s.activity = 'cowering'; s.stance = 'prone'; s.path = []; }
  } else if (s.suppression > 60) {
    if (s.activity !== 'pinned') { s.activity = 'pinned'; s.stance = 'prone'; s.path = []; }
  } else if (s.morale < 25) {
    if (s.activity !== 'panicked') { s.activity = 'panicked'; s.stance = 'standing'; }
  } else {
    // possible recovery from a broken state
    const wasCoweringOrPinned = s.activity === 'cowering' || s.activity === 'pinned';
    const wasPanickedOrRouted = s.activity === 'panicked' || s.activity === 'routed';
    if (wasCoweringOrPinned && s.suppression < 40 && s.morale >= 25) {
      resumeSoldier(state, s, team);
    } else if (wasPanickedOrRouted && s.morale >= 35) {
      if (s.suppression > 60) { s.activity = 'pinned'; s.stance = 'prone'; }
      else resumeSoldier(state, s, team);
    }
  }

  // ------------------------------------------------------------- surrender
  if (s.activity !== 'surrendered' && s.activity !== 'dead' && s.activity !== 'incapacitated') {
    if (s.morale < 15 && team) {
      const teammatesNear = aliveTeammatesWithin(state, s, team, 6);
      const enemyDist = nearestEnemySoldierDistTiles(state, s);
      if (teammatesNear === 0 && enemyDist <= 4) {
        s.activity = 'surrendered';
        s.stance = 'standing';
        s.path = [];
      }
    }
  }

  // -------------------------------------------------------------- fatigue
  if (s.activity === 'idle' || s.activity === 'defending') {
    s.fatigue = clamp(s.fatigue - 1 * dt, 0, 100);
  }
}

function detectCasualtiesAndApply(state: BattleState, rng: Rng, track: MoraleTrack): void {
  for (const s of state.soldiers.values()) {
    const last = track.lastHealth.get(s.id);
    if (last !== s.health) {
      track.lastHealth.set(s.id, s.health);
      if (last !== undefined && last !== s.health && (s.health === 'dead' || s.health === 'incapacitated' || s.health === 'wounded')) {
        const team = state.teams.get(s.teamId);
        if (team) {
          const isKIA = s.health === 'dead' || s.health === 'incapacitated';
          let amount = isKIA ? 15 : 8;
          if (s.isLeader) amount *= 2;
          applyTeamMoraleHit(state, team, amount);
          if (isKIA) maybeBerserk(state, rng, team, track);
        }
      }
    }
  }
}

const ACTIVITY_TO_STATUS: Partial<Record<Activity, TeamStatusWord>> = {
  idle: 'Idle',
  moving: 'Moving',
  movingFast: 'Moving Fast',
  sneaking: 'Sneaking',
  firing: 'Firing',
  reloading: 'Firing',
  defending: 'Defending',
  ambushing: 'Ambushing',
  hiding: 'Idle',
  cowering: 'Cowering',
  pinned: 'Pinned',
  panicked: 'Panicked',
  routed: 'Routed',
  berserk: 'Firing',
  surrendered: 'Surrendered',
};

function computeTeamStatus(state: BattleState, team: Team): { status: TeamStatusWord; outOfAction: boolean; morale: number } {
  const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  if (vehicle && (vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned')) {
    return { status: 'Knocked Out', outOfAction: true, morale: 0 };
  }
  const alive = soldiers.filter((s) => s.health !== 'dead' && s.health !== 'incapacitated');
  if (alive.length === 0) return { status: 'Destroyed', outOfAction: true, morale: 0 };

  const morale = alive.reduce((sum, s) => sum + s.morale, 0) / alive.length;
  const actingAlive = alive.filter((s) => s.activity !== 'routed' && s.activity !== 'surrendered');
  const outOfAction = actingAlive.length === 0;

  if (alive.every((s) => s.activity === 'surrendered')) return { status: 'Surrendered', outOfAction, morale };
  if (alive.every((s) => s.activity === 'routed')) return { status: 'Routed', outOfAction, morale };
  if (morale < 25) return { status: 'Broken', outOfAction, morale };

  const counts = new Map<Activity, number>();
  for (const s of alive) counts.set(s.activity, (counts.get(s.activity) ?? 0) + 1);
  let best: Activity = 'idle';
  let bestN = -1;
  for (const [a, n] of counts) {
    if (n > bestN) { best = a; bestN = n; }
  }
  return { status: ACTIVITY_TO_STATUS[best] ?? 'Idle', outOfAction, morale };
}

function teamCenterPos(state: BattleState, team: Team): Vec2 {
  const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s && s.health !== 'dead');
  if (soldiers.length > 0) {
    const sum = soldiers.reduce((acc, s) => ({ x: acc.x + s.pos.x, y: acc.y + s.pos.y }), { x: 0, y: 0 });
    return { x: sum.x / soldiers.length, y: sum.y / soldiers.length };
  }
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    if (v) return v.pos;
  }
  return team.pos;
}

function messageForTransition(side: Side, playerSide: Side, teamName: string, status: TeamStatusWord): string | null {
  if (side === playerSide) {
    if (status === 'Pinned') return `${teamName} is pinned down`;
    if (status === 'Broken') return `${teamName} has broken`;
    if (status === 'Routed') return `${teamName} is routing`;
    if (status === 'Destroyed') return `${teamName} has been destroyed`;
    return null;
  }
  if (status === 'Routed' || status === 'Destroyed') return 'Enemy team is routing';
  return null;
}

function updateTeamCaches(state: BattleState, track: MoraleTrack): void {
  for (const team of state.teams.values()) {
    const { status, outOfAction, morale } = computeTeamStatus(state, team);
    team.morale = morale;
    team.status = status;
    team.outOfAction = outOfAction;
    team.pos = teamCenterPos(state, team);

    const last = track.teamLastStatus.get(team.id);
    if (last !== status) {
      track.teamLastStatus.set(team.id, status);
      if (status === 'Pinned' || status === 'Broken' || status === 'Routed' || status === 'Destroyed') {
        const msg = messageForTransition(team.side, state.config.playerSide, team.name, status);
        if (msg) addMessage(state, msg, team.side === state.config.playerSide ? 'bad' : 'good');
        if (status === 'Broken' || status === 'Routed') {
          state.events.push({ kind: 'teamBroken', teamId: team.id, side: team.side });
        }
      }
    }
  }
}

function updateSideMorale(state: BattleState): void {
  for (const side of SIDES) {
    const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
    const nonDestroyed = teams.filter((t) => t.status !== 'Destroyed');
    let totalWeight = 0;
    let weighted = 0;
    for (const t of nonDestroyed) {
      const alive = t.soldierIds
        .map((id) => state.soldiers.get(id))
        .filter((s): s is Soldier => !!s && s.health !== 'dead' && s.health !== 'incapacitated').length;
      totalWeight += alive;
      weighted += t.morale * alive;
    }
    const base = totalWeight > 0 ? weighted / totalWeight : 0;
    const oOACount = teams.filter((t) => t.outOfAction).length;
    const fraction = teams.length > 0 ? oOACount / teams.length : 0;
    state.sides[side].morale = clamp(base - 10 * fraction, 0, 100);
  }
}

export function stepMorale(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  detectCasualtiesAndApply(state, rng, track);

  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') continue;
    stepSoldierState(state, s, dt, track);
  }

  updateTeamCaches(state, track);
  updateSideMorale(state);
}
