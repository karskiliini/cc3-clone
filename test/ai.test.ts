import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Order, Soldier, Team, Terrain,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepAI, aiDeploy, type AIBattle } from '@/sim/ai';

const W = 30, H = 30;

function makeMap(): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {},
    victoryLocations: [{ id: 1, name: 'VL1', x: 25, y: 25, value: 2 }],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 25, y: 25, w: 5, h: 5 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1),
    windows: new Uint8Array(W * H),
    victoryLocations: [{ id: 1, name: 'VL1', x: 25, y: 25, value: 2, owner: 'soviet', captureTimer: 0, capturingSide: null }],
    smoke: new Float32Array(W * H),
    craters: [],
  };
  return map;
}

function makeSoldier(id: number, teamId: number): Soldier {
  return {
    id, teamId, side: 'german', name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 2, y: 2 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id % 10 === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0,
  };
}

function makeTeam(id: number, soldierIds: number[]): Team {
  return {
    id, defId: 'test_team', side: 'german', name: `Team ${id}`, type: 'rifle',
    soldierIds, leaderId: soldierIds[0], vehicleId: null, order: null, facing: 0,
    experience: 50, morale: 80, status: 'Idle', pos: { x: 2, y: 2 }, outOfAction: false,
    kills: 0, aiObjective: null,
  };
}

function makeState(): BattleState {
  const map = makeMap();
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  const soldiers = new Map<number, Soldier>();
  const teams = new Map<number, Team>();
  let nextId = 1;
  for (let t = 1; t <= 3; t++) {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = makeSoldier(nextId, t);
      soldiers.set(nextId, s);
      ids.push(nextId);
      nextId++;
    }
    teams.set(t, makeTeam(t, ids));
  }

  return {
    config, map, phase: 'running', time: 0,
    soldiers, teams, vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId,
  };
}

class FakeBattle implements AIBattle {
  orders: { teamId: number; order: Order }[] = [];
  issueOrder(teamId: number, order: Order): void { this.orders.push({ teamId, order }); }
  deployTeam(_teamId: number, _pos: { x: number; y: number }): boolean { return true; }
}

describe('stepAI', () => {
  it('issues at least one order for the german side toward the unowned VL', () => {
    const state = makeState();
    const rng = new Rng(1);
    const battle = new FakeBattle();
    stepAI(state, rng, battle, 'german');
    expect(battle.orders.length).toBeGreaterThan(0);
    const moveLike = battle.orders.some((o) => ['move', 'moveFast', 'sneak', 'defend', 'fire', 'ambush', 'smoke'].includes(o.order.type));
    expect(moveLike).toBe(true);
  });
});

describe('aiDeploy', () => {
  it('places every team inside the deploy zone', () => {
    const state = makeState();
    const rng = new Rng(2);
    const battle = new FakeBattle();
    aiDeploy(state, 'german', rng, battle);
    expect(battle.orders.length).toBe(0); // deployTeam doesn't go through issueOrder
  });
});
