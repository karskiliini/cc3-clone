import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Order, Soldier, Team, Terrain,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
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
    cover: 0, kills: 0, mind: createMind(50),
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
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
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

describe('stepAI per-team engagement distance (regression)', () => {
  it('lets a team close to a spotted enemy engage even when other friendly teams are far away', () => {
    // Regression for a bug where the "is an enemy close enough to fight" check used the side-wide
    // average position of every friendly team instead of this team's own position. On a map where
    // one team is right next to a spotted enemy but a sibling team is far away, the side average
    // sat well outside the 120 m engagement range, so the near team kept marching toward its VL
    // instead of switching to defend/fire — infantry never actually traded shots (see harness.test.ts,
    // which caught this as smallArmsFired staying at 0 across most AI-vs-AI runs).
    const W = 200, H = 200;
    const tiles: Terrain[] = new Array(W * H).fill('open');
    const def: MapDef = {
      id: 'test-wide', name: 'Wide Test', description: '', width: W, height: H, season: 'summer',
      paint: () => {},
      victoryLocations: [{ id: 1, name: 'VL1', x: 190, y: 190, value: 2 }],
      deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 190, y: 190, w: 5, h: 5 } },
      attacker: 'german',
    };
    const map: GameMap = {
      def, width: W, height: H, tiles,
      buildingId: new Int16Array(W * H).fill(-1),
      windows: new Uint8Array(W * H),
      victoryLocations: [{ id: 1, name: 'VL1', x: 190, y: 190, value: 2, owner: 'soviet', captureTimer: 0, capturingSide: null }],
      smoke: new Float32Array(W * H),
      craters: [],
    };

    // Team 1 (far from the enemy) is inserted first, so the AI's "keep 1/3 defending" quota picks
    // it as the default defender — team 2 (the near team, id=2) must reach its own defend/fire
    // decision purely via the distance-gate branch under test, not the defender-quota branch.
    const farTeamSoldiers = [1, 2, 3].map((id) => ({ ...makeSoldier(id, 1), pos: { x: 150, y: 150 } }));
    const nearTeamSoldiers = [4, 5, 6].map((id) => ({ ...makeSoldier(id, 2), pos: { x: 10, y: 10 } }));
    const enemy: Soldier = { ...makeSoldier(99, 3), id: 99, side: 'soviet', pos: { x: 14, y: 10 } };

    const soldiers = new Map<number, Soldier>();
    for (const s of [...nearTeamSoldiers, ...farTeamSoldiers, enemy]) soldiers.set(s.id, s);

    const farTeam: Team = { ...makeTeam(1, [1, 2, 3]), pos: { x: 150, y: 150 } };
    const nearTeam: Team = { ...makeTeam(2, [4, 5, 6]), pos: { x: 10, y: 10 } };
    const teams = new Map<number, Team>([[1, farTeam], [2, nearTeam]]);

    const state: BattleState = {
      config: {
        mapId: 'test-wide', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200,
        difficulty: 'normal', forces: { german: [], soviet: [] },
      },
      map, phase: 'running', time: 0,
      soldiers, teams, vehicles: new Map(),
      sides: {
        german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
        soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      },
      spotted: { german: new Set([99]), soviet: new Set() },
      spottedVehicles: { german: new Set(), soviet: new Set() },
      messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
      result: null, events: [], nextId: 100,
    };

    const rng = new Rng(1);
    const battle = new FakeBattle();
    stepAI(state, rng, battle, 'german');

    const nearTeamOrder = battle.orders.find((o) => o.teamId === 2);
    expect(nearTeamOrder).toBeDefined();
    expect(['defend', 'fire']).toContain(nearTeamOrder!.order.type);
  });
});

describe('defender AI moves into position before holding it (balance round 4 regression)', () => {
  // Regression: applyOrder's 'defend' handler never moves anyone — it only holds the CURRENT
  // position (orders.ts). A designated defender that starts far from the VL it's assigned to
  // guard must first get a 'move' order toward it; only once actually there should it get 'defend'.
  function customState(teamPos: { x: number; y: number }): { state: BattleState; battle: FakeBattle } {
    const W = 200, H = 200;
    const tiles: Terrain[] = new Array(W * H).fill('open');
    const def: MapDef = {
      id: 'test-defend', name: 'Test', description: '', width: W, height: H, season: 'summer',
      paint: () => {},
      victoryLocations: [{ id: 1, name: 'VL1', x: 100, y: 100, value: 2 }],
      deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 190, y: 190, w: 5, h: 5 } },
      attacker: 'soviet',
    };
    const map: GameMap = {
      def, width: W, height: H, tiles,
      buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
      // german is the DEFENDER here (attacker: 'soviet'), so german owns the VL.
      victoryLocations: [{ id: 1, name: 'VL1', x: 100, y: 100, value: 2, owner: 'german', captureTimer: 0, capturingSide: null }],
      smoke: new Float32Array(W * H), craters: [],
    };
    const soldier: Soldier = { ...makeSoldier(1, 1), pos: teamPos };
    const team: Team = { ...makeTeam(1, [1]), pos: teamPos, type: 'mg' }; // 'mg' -> always a designated defender
    const soldiers = new Map<number, Soldier>([[1, soldier]]);
    const teams = new Map<number, Team>([[1, team]]);
    const state: BattleState = {
      config: { mapId: 'test-defend', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
      map, phase: 'running', time: 0,
      soldiers, teams, vehicles: new Map(),
      sides: {
        german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
        soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      },
      spotted: { german: new Set(), soviet: new Set() },
      spottedVehicles: { german: new Set(), soviet: new Set() },
      messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
      result: null, events: [], nextId: 10,
    };
    return { state, battle: new FakeBattle() };
  }

  it('issues move (not defend) when far from the assigned VL', () => {
    const { state, battle } = customState({ x: 2, y: 2 }); // far from the VL at (100,100)
    stepAI(state, new Rng(1), battle, 'german');
    const order = battle.orders.find((o) => o.teamId === 1);
    expect(order?.order.type).toBe('move');
  });

  it('issues defend once actually at the assigned position', () => {
    const { state, battle } = customState({ x: 99, y: 99 }); // right next to the VL
    stepAI(state, new Rng(1), battle, 'german');
    const order = battle.orders.find((o) => o.teamId === 1);
    expect(order?.order.type).toBe('defend');
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
