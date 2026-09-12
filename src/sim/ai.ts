import type {
  BattleState, Order, OrderType, Rect, Side, Soldier, Team, Vec2, Vehicle,
} from '@/shared/types';
import { otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { inBounds, coverAt } from './map';
import { isPassable } from './path';
import { hasLOS } from './los';

export interface AIBattle {
  issueOrder(teamId: number, order: Order): void;
  deployTeam?(teamId: number, pos: Vec2): boolean;
}

// ------------------------------------------------------------------ helpers
function zoneCentre(zone: Rect): Vec2 {
  return { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
}

function teamsCentre(state: BattleState, side: Side): Vec2 {
  const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
  if (!teams.length) return zoneCentre(state.map.def.deployZones[side]);
  const sum = teams.reduce((acc, t) => ({ x: acc.x + t.pos.x, y: acc.y + t.pos.y }), { x: 0, y: 0 });
  return { x: sum.x / teams.length, y: sum.y / teams.length };
}

function nearestSpottedVehicle(state: BattleState, side: Side, rangeM: number): Vehicle | null {
  const centre = teamsCentre(state, side);
  let best: Vehicle | null = null;
  let bestD = Infinity;
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    if (!v || v.state === 'knockedOut') continue;
    const d = dist(centre, v.pos) * TILE_M;
    if (d > rangeM) continue;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function nearestSpottedSoldier(state: BattleState, side: Side): Soldier | null {
  const centre = teamsCentre(state, side);
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(centre, s.pos);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function findClusterTarget(state: BattleState, side: Side): Vec2 | null {
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

function teamHasLOSToEnemy(state: BattleState, team: Team, enemyPos: Vec2): boolean {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (hasLOS(state.map, s.pos, enemyPos)) return true;
  }
  return false;
}

function bestCoverWithin(state: BattleState, centre: Vec2, radiusTiles: number, rng: Rng): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0, radiusTiles);
    const x = Math.floor(centre.x + Math.cos(ang) * r);
    const y = Math.floor(centre.y + Math.sin(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    const score = coverAt(state.map, pos);
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? centre;
}

function nearRoadTile(state: BattleState, x: number, y: number): number {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(state.map, nx, ny)) continue;
      const t = state.map.tiles[ny * state.map.width + nx];
      if (t === 'dirtroad' || t === 'pavedroad') return 1;
    }
  }
  return 0;
}

function goodCoverNearRoad(state: BattleState, centre: Vec2, rng: Rng): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 15);
    const x = Math.floor(centre.x + Math.cos(ang) * r);
    const y = Math.floor(centre.y + Math.sin(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    const score = coverAt(state.map, pos) + nearRoadTile(state, x, y) * 0.5;
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? centre;
}

function chooseWaypoint(state: BattleState, from: Vec2, objective: Vec2, rng: Rng): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(2, 25);
    const x = Math.floor(from.x + Math.cos(ang) * r);
    const y = Math.floor(from.y + Math.sin(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    const cover = coverAt(state.map, pos);
    const dObj = dist(pos, objective);
    const score = cover * 2 - dObj / 50;
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? objective;
}

function nearestAttackingInfantryTeam(teams: Team[], vehicleTeam: Team): Team | null {
  let best: Team | null = null;
  let bestD = Infinity;
  for (const t of teams) {
    if (t.vehicleId != null) continue;
    const d = dist(t.pos, vehicleTeam.pos);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// -------------------------------------------------------------- order gate
interface OrderRecord { key: string; at: number }
const lastOrderTracks = new WeakMap<BattleState, Map<number, OrderRecord>>();
const callCounters = new WeakMap<BattleState, Map<Side, number>>();

function getOrderTrack(state: BattleState): Map<number, OrderRecord> {
  let t = lastOrderTracks.get(state);
  if (!t) { t = new Map(); lastOrderTracks.set(state, t); }
  return t;
}

function tryIssueOrder(state: BattleState, battle: AIBattle, track: Map<number, OrderRecord>, team: Team, order: Order): void {
  const key = `${order.type}:${Math.round(order.target.x)},${Math.round(order.target.y)}`;
  const last = track.get(team.id);
  if (last && last.key === key && state.time - last.at < 15) return;
  battle.issueOrder(team.id, order);
  track.set(team.id, { key, at: state.time });
}

// -------------------------------------------------------------------- deploy
export function aiDeploy(state: BattleState, side: Side, rng: Rng, battle: AIBattle): void {
  const zone = state.map.def.deployZones[side];
  const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
  const placed: Vec2[] = [];

  for (const team of teams) {
    const isVehicle = team.vehicleId != null;
    const mover = isVehicle ? 'vehicle' : 'infantry';
    let best: Vec2 | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < 40; i++) {
      const x = Math.floor(rng.range(zone.x, zone.x + zone.w));
      const y = Math.floor(rng.range(zone.y, zone.y + zone.h));
      if (!inBounds(state.map, x, y)) continue;
      if (!isPassable(state.map, x, y, mover)) continue;
      const pos = { x: x + 0.5, y: y + 0.5 };
      if (!isVehicle) {
        const spread = placed.length ? Math.min(...placed.map((p) => dist(p, pos))) : 999;
        if (spread < 4) continue;
      }
      const score = isVehicle ? nearRoadTile(state, x, y) : coverAt(state.map, pos) >= 0.3 ? 1 + coverAt(state.map, pos) : coverAt(state.map, pos);
      if (score > bestScore) { bestScore = score; best = pos; }
    }

    if (!best) {
      for (let i = 0; i < 60 && !best; i++) {
        const x = Math.floor(rng.range(zone.x, zone.x + zone.w));
        const y = Math.floor(rng.range(zone.y, zone.y + zone.h));
        if (isPassable(state.map, x, y, mover)) best = { x: x + 0.5, y: y + 0.5 };
      }
    }

    if (best) {
      placed.push(best);
      battle.deployTeam?.(team.id, best);
    }
  }
}

// ------------------------------------------------------------------ step ai
export function stepAI(state: BattleState, rng: Rng, battle: AIBattle, side: Side): void {
  let counters = callCounters.get(state);
  if (!counters) { counters = new Map(); callCounters.set(state, counters); }
  const n = (counters.get(side) ?? 0) + 1;
  counters.set(side, n);
  if (state.config.difficulty === 'easy' && n % 2 === 0) return;

  const track = getOrderTrack(state);
  const enemy = otherSide(side);
  const myTeams = Array.from(state.teams.values()).filter((t) => t.side === side && !t.outOfAction);
  if (myTeams.length === 0) return;

  const enemyZoneCentre = zoneCentre(state.map.def.deployZones[enemy]);
  const ownZoneCentre = zoneCentre(state.map.def.deployZones[side]);

  const vls = state.map.victoryLocations
    .filter((vl) => vl.owner !== side)
    .slice()
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return dist(ownZoneCentre, { x: a.x, y: a.y }) - dist(ownZoneCentre, { x: b.x, y: b.y });
    });
  const ownedVLs = state.map.victoryLocations.filter((vl) => vl.owner === side);

  const defendersCount = Math.max(1, Math.round(myTeams.length / 3));
  const priorityDefend = myTeams.filter((t) => t.type === 'mg' || t.type === 'atgun' || t.type === 'mortar');
  const defenders = new Set<number>();
  for (const t of priorityDefend) { if (defenders.size < defendersCount) defenders.add(t.id); }
  for (const t of myTeams) { if (defenders.size < defendersCount) defenders.add(t.id); }

  let vlIdx = 0;
  const vehicleTeams: Team[] = [];

  for (const team of myTeams) {
    if (team.status === 'Pinned' || team.status === 'Cowering') continue;

    if (team.status === 'Broken' || team.status === 'Panicked' || team.status === 'Routed') {
      tryIssueOrder(state, battle, track, team, { type: 'move', target: ownZoneCentre, issuedAt: state.time });
      continue;
    }

    if (team.type === 'atgun' || team.type === 'atteam') {
      const vehicle = nearestSpottedVehicle(state, side, 9999);
      if (vehicle) {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...vehicle.pos }, issuedAt: state.time });
      } else {
        const pos = goodCoverNearRoad(state, enemyZoneCentre, rng);
        team.aiObjective = pos;
        tryIssueOrder(state, battle, track, team, { type: 'ambush', target: enemyZoneCentre, issuedAt: state.time });
      }
      continue;
    }

    if (team.type === 'mortar') {
      const cluster = findClusterTarget(state, enemy);
      if (cluster) {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...cluster }, issuedAt: state.time });
      } else if (ownedVLs.length) {
        const contested = ownedVLs.reduce((best, vl) => (!best || vl.value > best.value ? vl : best));
        tryIssueOrder(state, battle, track, team, { type: 'smoke', target: { x: contested.x, y: contested.y }, issuedAt: state.time });
      }
      continue;
    }

    if (team.vehicleId != null) {
      vehicleTeams.push(team);
      continue;
    }

    // infantry: defenders vs attackers
    if (defenders.has(team.id)) {
      const vl = ownedVLs.length ? ownedVLs[vlIdx % ownedVLs.length] : null;
      vlIdx++;
      const pos = vl ? bestCoverWithin(state, { x: vl.x, y: vl.y }, 8, rng) : team.pos;
      team.aiObjective = pos;
      tryIssueOrder(state, battle, track, team, { type: 'defend', target: enemyZoneCentre, issuedAt: state.time });
      continue;
    }

    const objective = vls.length ? { x: vls[vlIdx % vls.length].x, y: vls[vlIdx % vls.length].y } : enemyZoneCentre;
    vlIdx++;
    team.aiObjective = objective;

    const nearestEnemy = nearestSpottedSoldier(state, side);
    const nearestEnemyDistM = nearestEnemy ? dist(teamsCentre(state, side), nearestEnemy.pos) * TILE_M : Infinity;

    if (nearestEnemy && nearestEnemyDistM <= 120 && teamHasLOSToEnemy(state, team, nearestEnemy.pos)) {
      if (rng.chance(0.3)) {
        tryIssueOrder(state, battle, track, team, { type: 'defend', target: { ...nearestEnemy.pos }, issuedAt: state.time });
      } else {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...nearestEnemy.pos }, issuedAt: state.time });
      }
      continue;
    }

    const waypoint = chooseWaypoint(state, team.pos, objective, rng);
    let orderType: OrderType = 'move';
    if (nearestEnemyDistM > 150) orderType = 'moveFast';
    else if (nearestEnemyDistM <= 60) orderType = 'sneak';
    if (state.config.difficulty === 'hard' && orderType === 'move') orderType = 'moveFast';
    tryIssueOrder(state, battle, track, team, { type: orderType, target: waypoint, issuedAt: state.time });
  }

  // vehicles move with nearest attacking infantry team and engage
  for (const team of vehicleTeams) {
    const vehicle = state.vehicles.get(team.vehicleId!);
    if (!vehicle || vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned') continue;

    const enemyVehicle = nearestSpottedVehicle(state, side, 300);
    const enemySoldier = nearestSpottedSoldier(state, side);
    const target = enemyVehicle ?? enemySoldier;

    if (vehicle.state === 'immobilized') {
      if (target) tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...target.pos }, issuedAt: state.time });
      continue;
    }

    if (target && dist(vehicle.pos, target.pos) * TILE_M <= 300) {
      tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...target.pos }, issuedAt: state.time });
      continue;
    }

    const infTeam = nearestAttackingInfantryTeam(myTeams, team);
    const objective = infTeam?.aiObjective ?? enemyZoneCentre;
    team.aiObjective = objective;
    const orderType: OrderType = state.config.difficulty === 'hard' ? 'moveFast' : 'move';
    tryIssueOrder(state, battle, track, team, { type: orderType, target: objective, issuedAt: state.time });
  }
}
