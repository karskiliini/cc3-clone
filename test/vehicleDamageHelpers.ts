// Shared fixtures for the ammunition / aim point / vehicle damage tests.
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain, Vec2, Vehicle } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { createMind } from '@/sim/mind';

export const W = 400, H = 400;

export function makeState(year = 1943): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 390, y: 390, w: 5, h: 5 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 1000,
  };
}

export function soldier(id: number, teamId: number, side: Team['side'], pos: Vec2, weaponId: string, over: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side, name: `Man${id}`, rank: 'Gefr', weaponId, ammo: 20, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'crouching',
    activity: 'idle', pos: { ...pos }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(80), ...over,
  };
}

export function mkTeam(id: number, type: Team['type'], ids: number[], side: Team['side'], pos: Vec2): Team {
  return {
    id, defId: 'test', side, name: `Team ${id}`, type, soldierIds: ids, leaderId: ids[0],
    vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle',
    pos: { ...pos }, outOfAction: false, kills: 0, aiObjective: null,
  };
}

/** A fully crewed vehicle of `defId` (crew in seat order) with its team. */
export function addTank(state: BattleState, defId: string, pos: Vec2, hullFacing = 0, experience = 50, side?: Team['side']): { v: Vehicle; team: Team; crew: Soldier[] } {
  const def = VEHICLE_DEFS[defId];
  const s: Team['side'] = side ?? (['pz3j', 'pz4f1', 'pz4gh', 'stug3g', 'panther', 'tiger', 'sdkfz251', 'marder3'].includes(defId) ? 'german' : 'soviet');
  const teamId = state.nextId++;
  const vid = state.nextId++;
  const crew: Soldier[] = [];
  for (let i = 0; i < def.crew; i++) {
    const m = soldier(state.nextId++, teamId, s, pos, s === 'german' ? 'pistol_p38' : 'pistol_tt', { vehicleId: vid, experience, isLeader: i === 0 });
    state.soldiers.set(m.id, m);
    crew.push(m);
  }
  const team = mkTeam(teamId, def.kind === 'tank' ? 'tank' : def.kind === 'spg' ? 'spg' : 'halftrack', crew.map((c) => c.id), s, pos);
  team.vehicleId = vid;
  state.teams.set(teamId, team);
  const v: Vehicle = {
    id: vid, teamId, side: s, defId, pos: { ...pos }, hullFacing, turretFacing: hullFacing, state: 'ok',
    mainAmmo: def.mainAmmo, coaxAmmo: 250, path: [], speed: 0, targetVehicleId: null, targetSoldierId: null,
    targetPoint: null, mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0,
  };
  state.vehicles.set(vid, v);
  return { v, team, crew };
}

/** A gun team of `n` men (the first is the gunner, the last the leader) round an emplaced gun at
 * `pivot`, muzzle towards `facing` (0 = north). */
export function addGun(state: BattleState, weaponId: string, pivot: Vec2, n = 3, over: Partial<Soldier> = {}, side: Team['side'] = 'german'): { team: Team; men: Soldier[]; gunner: Soldier } {
  const teamId = state.nextId++;
  const men: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const s = soldier(state.nextId++, teamId, side, { x: pivot.x - 1 + i * 0.9, y: pivot.y + 2.2 }, i === 0 ? weaponId : 'kar98k', { isLeader: n > 1 && i === n - 1, ...(i === 0 ? over : {}) });
    men.push(s);
    state.soldiers.set(s.id, s);
  }
  const team = mkTeam(teamId, 'atgun', [men[n - 1].id, ...men.slice(0, n - 1).map((s) => s.id)], side, pivot);
  team.crewWeapon = {
    weaponId, pos: { ...pivot }, facing: 0, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: men[0].id, abandoned: false, abandonedAt: 0, setAt: 0,
  };
  state.teams.set(teamId, team);
  return { team, men, gunner: men[0] };
}
