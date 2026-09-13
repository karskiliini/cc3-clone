import type {
  Activity, BattleState, Health, Side, Soldier, Team, TeamMoraleWord, TeamStatusWord, Vec2,
} from '@/shared/types';
import { SIDES, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';

// ============================================================================
// morale.ts — team-level morale aggregation, casualty morale hits, tank-scare,
// surrender, and team/side status caching. Per-SOLDIER psychology (stress,
// fear, the mental-state machine, beliefs) lives in mind.ts (spec §1-8); this
// module only keeps the team-wide bookkeeping and the exported names other
// modules rely on (stepMorale, moraleWord, team status caching).
// ============================================================================

// ---------------------------------------------------------------- tracking
interface MoraleTrack {
  lastHealth: Map<number, Health>;
  tankScareAt: Map<number, number>;
  teamLastStatus: Map<number, TeamStatusWord>;
}

const tracks = new WeakMap<BattleState, MoraleTrack>();

function getTrack(state: BattleState): MoraleTrack {
  let t = tracks.get(state);
  if (!t) {
    t = { lastHealth: new Map(), tankScareAt: new Map(), teamLastStatus: new Map() };
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

function stepSoldierMorale(state: BattleState, s: Soldier, dt: number, track: MoraleTrack): void {
  // Vehicle crew are shielded by armor: their morale/suppression is driven by vehicle.ts's crew
  // mind (spec §10), not by exposed-infantry mechanics.
  if (s.vehicleId != null) return;

  const team = state.teams.get(s.teamId);
  const leader = team ? state.soldiers.get(team.leaderId) : undefined;
  const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
  const leaderNearM = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 10 : false;
  const leaderNotSuppressed = leaderAlive && leader ? leader.suppression <= 60 : false;

  // -------------------------------------------------------- suppression decay
  const decayRate = leaderNearM && leaderNotSuppressed ? 8 : 5;
  s.suppression = clamp(s.suppression - decayRate * dt, 0, 100);

  // -------------------------------------------------------------- tank scare
  const tankDistM = nearestEnemyTankDistTiles(state, s) * TILE_M;
  if (tankDistM <= 100) {
    const last = track.tankScareAt.get(s.id) ?? -Infinity;
    if (state.time - last >= 10) {
      s.morale = clamp(s.morale - 5, 0, 100);
      track.tankScareAt.set(s.id, state.time);
    }
  }

  // ------------------------------------------------------------- surrender
  // Broken (mind.state) AND surrounded AND (no ammo or an enemy within 3 tiles) -> surrendered
  // (spec §11); experienced soldiers (>=60) need the enemy within 2 tiles instead of 3.
  if (s.activity !== 'surrendered' && s.activity !== 'dead' && s.activity !== 'incapacitated') {
    if (s.mind.state === 'broken' && s.mind.surrounded) {
      const enemyDist = nearestEnemySoldierDistTiles(state, s) * TILE_M;
      const threshold = s.experience >= 60 ? 2 : 3;
      const noAmmo = s.ammo <= 0 && s.ammoReserve <= 0;
      if (noAmmo || enemyDist <= threshold) {
        s.activity = 'surrendered';
        s.stance = 'standing';
        s.path = [];
        if (s.side === state.config.playerSide) {
          addMessage(state, `${team?.name ?? 'Report'}\n${s.rank}. ${s.name} surrenders.`, 'bad');
        }
      }
    }
  }

  // -------------------------------------------------------------- fatigue
  if (s.activity === 'idle' || s.activity === 'defending') {
    s.fatigue = clamp(s.fatigue - 1 * dt, 0, 100);
  }
}

function detectCasualtiesAndApply(state: BattleState, track: MoraleTrack): void {
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

  // Team status derives from the majority MENTAL STATE (spec §7): activity mirrors mind.state 1:1
  // for the severe states (pinned/cowering/panicked/broken->routed), so a majority-of-activity
  // check here is equivalent and avoids a second soldiers.map pass.
  const majority = (pred: (s: Soldier) => boolean): boolean => alive.filter(pred).length * 2 > alive.length;
  if (majority((s) => s.activity === 'surrendered')) return { status: 'Surrendered', outOfAction, morale };
  if (majority((s) => s.activity === 'routed')) return { status: 'Routed', outOfAction, morale };
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
    if (status === 'Pinned') return `${teamName}\nWe're pinned down.`;
    if (status === 'Broken') return `${teamName}\nWe're breaking!`;
    if (status === 'Routed') return `${teamName}\nWe're running!`;
    if (status === 'Destroyed') return `${teamName}\n${teamName} has been destroyed.`;
    return null;
  }
  if (status === 'Routed' || status === 'Destroyed') return 'Enemy\nEnemy team is routing.';
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

/** Team-wide morale bookkeeping (spec's design brief §6.7 + this feature's spec's §1-8 "morale
 * additionally drifts" hooks live in mind.ts's stepOneMind, which runs earlier in the pipeline).
 * Per-soldier psychology/state-machine is mind.ts's job; this only aggregates. */
export function stepMorale(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  detectCasualtiesAndApply(state, track);

  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') continue;
    stepSoldierMorale(state, s, dt, track);
  }

  updateTeamCaches(state, track);
  updateSideMorale(state);
}
