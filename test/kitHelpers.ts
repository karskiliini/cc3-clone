// Shared scaffolding for test/debris.test.ts and test/items.test.ts: a small open map, soldiers
// and teams built by hand (spec 2026-09-17 §8 / §9).
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain, WeaponDef } from '@/shared/types';
import { createMind } from '@/sim/mind';

export const W = 40, H = 40;

export function makeSoldier(o: Partial<Soldier> = {}): Soldier {
  return {
    id: 1, teamId: 1, side: 'soviet', name: 'T', rank: 'Pvt', weaponId: 'mosin', ammo: 5, ammoReserve: 30, grenades: 2,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle',
    pos: { x: 10.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [],
    reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}

export function makeState(): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer', paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 34, y: 34, w: 5, h: 5 } }, attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles, buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = { mapId: 'test', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } };
  return {
    config, map, phase: 'running', time: 10, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], result: null, events: [], nextId: 100,
  };
}

export function makeTeam(state: BattleState, id: number, soldiers: Soldier[], o: Partial<Team> = {}): Team {
  const team: Team = {
    id, defId: 'sov_rifle_43', side: soldiers[0]?.side ?? 'soviet', name: `Squad ${id}`, type: 'rifle', soldierIds: soldiers.map((s) => s.id),
    leaderId: soldiers[0]?.id ?? 0, vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'OK' as Team['status'],
    pos: { x: 10, y: 10 }, outOfAction: false, kills: 0, aiObjective: null, ...o,
  };
  state.teams.set(id, team);
  for (const s of soldiers) { s.teamId = id; state.soldiers.set(s.id, s); }
  return team;
}

export const mortar: WeaponDef = {
  id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0, suppression: 0.6,
  penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8,
};
export const grenade: WeaponDef = { ...mortar, id: 'grenade', cls: 'grenade', heRadiusM: 4 };
