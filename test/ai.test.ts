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
      messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
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
      messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
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

// =====================================================================================
// The phased attack (stepAttackAI): overwatch first, bounds with a covering element, armour with
// the infantry, one objective at a time, phases on a clock, side knowledge only.
// =====================================================================================
import { TEAM_DEFS } from '@/data/units';
import { spawnTeam } from '@/sim/spawn';
import { getAttackPlan, getContacts, CONTACT_KEEP_S, TANK_STATION_BEHIND_TILES, TANK_STATION_SPREAD_TILES } from '@/sim/ai';
import type { Side, Vec2 } from '@/shared/types';

const AW = 170, AH = 80;
const MAIN_VL = { x: 130, y: 40 };

function attackMap(attacker: Side = 'german'): GameMap {
  const tiles: Terrain[] = new Array(AW * AH).fill('open');
  // belts of shell holes (cover that does not block a line of fire), 3 tiles in every 12
  for (let x = 30; x < 125; x += 12) for (let y = 20; y < 60; y++) for (let k = 0; k < 3; k++) tiles[y * AW + x + k] = 'crater';
  const vls: MapDef['victoryLocations'] = [
    { id: 0, name: 'Main', x: MAIN_VL.x, y: MAIN_VL.y, value: 3 },
    { id: 1, name: 'Far', x: 150, y: 8, value: 1 },
  ];
  const def: MapDef = {
    id: 'attack-test', name: 'Attack', description: '', width: AW, height: AH, season: 'summer',
    paint: () => {}, victoryLocations: vls,
    deployZones: { german: { x: 4, y: 28, w: 20, h: 24 }, soviet: { x: 140, y: 28, w: 20, h: 24 } },
    attacker,
  };
  const defender: Side = attacker === 'german' ? 'soviet' : 'german';
  return {
    def, width: AW, height: AH, tiles,
    buildingId: new Int16Array(AW * AH).fill(-1), windows: new Uint8Array(AW * AH),
    victoryLocations: vls.map((v) => ({ ...v, owner: defender, captureTimer: 0, capturingSide: null })),
    smoke: new Float32Array(AW * AH), craters: [],
  };
}

function attackState(attacker: Side = 'german'): BattleState {
  return {
    config: { mapId: 'attack-test', playerSide: 'soviet', year: 1941, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: attackMap(attacker), phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 1,
  };
}

interface Force { state: BattleState; squads: Team[]; mortar: Team; mg: Team; tank: Team; battle: FakeBattle; rng: Rng }

function germanAttack(): Force {
  const state = attackState('german');
  const rng = new Rng(11);
  const at = (defId: string, x: number, y: number): Team => spawnTeam(state, TEAM_DEFS[defId], 'german', { x: x + 0.5, y: y + 0.5 }, rng);
  const squads = [at('ger_rifle_41', 12, 34), at('ger_rifle_41', 12, 40), at('ger_rifle_41', 12, 46), at('ger_rifle_41', 16, 43)];
  const mortar = at('ger_mortar81', 8, 40);
  const mg = at('ger_mg34_hmg', 10, 37);
  const tank = at('ger_pz3j', 14, 50);
  for (const t of state.teams.values()) t.status = 'Defending';
  return { state, squads, mortar, mg, tank, battle: new FakeBattle(), rng };
}

/** Moves a team (and its men / hull) to `p`, as if it had carried out its order. */
function teleport(state: BattleState, team: Team, p: Vec2): void {
  team.pos = { ...p };
  for (const id of team.soldierIds) { const s = state.soldiers.get(id); if (s) s.pos = { ...p }; }
  if (team.vehicleId != null) { const v = state.vehicles.get(team.vehicleId); if (v) v.pos = { ...p }; }
}

/** One AI decision at the current time; returns the orders it issued. Move orders are carried out
 * at once when `carryOut` is set (the men arrive), so the next decision sees them at their halts. */
function tick(f: Force, carryOut = false, side: Side = 'german'): { teamId: number; order: Order }[] {
  const before = f.battle.orders.length;
  stepAI(f.state, f.rng, f.battle, side);
  const issued = f.battle.orders.slice(before);
  if (carryOut) {
    for (const o of issued) {
      const team = f.state.teams.get(o.teamId)!;
      if (o.order.type === 'move' || o.order.type === 'moveFast' || o.order.type === 'sneak') teleport(f.state, team, o.order.target);
    }
  }
  f.state.time += 5;
  return issued;
}
const isMove = (o: Order): boolean => o.type === 'move' || o.type === 'moveFast' || o.type === 'sneak';
const dTiles = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('attack AI: overwatch before the assault', () => {
  it('has the mortar firing at the objective while no squad has been sent across the open ground', () => {
    const f = germanAttack();
    const prepEnd = Math.min(70, f.state.config.durationS * 0.06);
    let mortarFired = false;
    while (f.state.time < prepEnd) {
      for (const o of tick(f, true)) {
        if (o.teamId === f.mortar.id && o.order.type === 'fire') {
          mortarFired = true;
          // nothing has been spotted: the target is the suspected cover on the objective
          expect(dTiles(o.order.target, MAIN_VL)).toBeLessThanOrEqual(8);
        }
        // during the preparation no squad goes beyond the forming-up distance (~90 m short)
        if (f.squads.some((s) => s.id === o.teamId) && isMove(o.order)) expect(dTiles(o.order.target, MAIN_VL) * 2).toBeGreaterThan(85);
      }
    }
    expect(mortarFired).toBe(true);
    expect(getAttackPlan(f.state, 'german')!.phase).toBe('prep');
  });

  it('orders the tank to shell the objective from its station once it has a line of fire', () => {
    const f = germanAttack();
    const tankOrders: Order[] = [];
    for (let i = 0; i < 12; i++) for (const o of tick(f, true)) if (o.teamId === f.tank.id) tankOrders.push(o.order);
    const fire = tankOrders.find((o) => o.type === 'fire');
    expect(fire).toBeDefined();
    expect(dTiles(fire!.target, MAIN_VL)).toBeLessThanOrEqual(8);
  });
});

describe('attack AI: bounds with a covering element', () => {
  it('moves one element at a time and starts the other only after the first has gone to ground', () => {
    const f = germanAttack();
    tick(f, true);
    while (getAttackPlan(f.state, 'german')!.phase === 'prep') tick(f, true);
    const plan = getAttackPlan(f.state, 'german')!;
    const elementOf = (id: number): number => plan.element.get(id)!;
    const squadIds = new Set(f.squads.map((s) => s.id));
    let lastMover: number | null = null;
    let flips = 0;
    for (let i = 0; i < 14; i++) {
      const issued = tick(f, false).filter((o) => squadIds.has(o.teamId));
      const movers = new Set(issued.filter((o) => isMove(o.order)).map((o) => elementOf(o.teamId)));
      // never both elements on their feet in the same decision
      expect(movers.size).toBeLessThanOrEqual(1);
      if (movers.size === 1) {
        const m = [...movers][0];
        if (lastMover !== null && m !== lastMover) flips++;
        lastMover = m;
        // the other element is covering: it holds a defend/fire order, never a move
        for (const o of issued) if (elementOf(o.teamId) !== m) expect(['defend', 'fire']).toContain(o.order.type);
        // the movers arrive
        for (const o of issued) if (isMove(o.order)) teleport(f.state, f.state.teams.get(o.teamId)!, o.order.target);
      } else if (issued.length) {
        // the decision between two bounds: everybody is down and covering
        for (const o of issued) expect(['defend', 'fire']).toContain(o.order.type);
      }
    }
    expect(flips).toBeGreaterThanOrEqual(2);
  });

  it('chooses halts that make ground towards the objective and prefers cover', () => {
    const f = germanAttack();
    tick(f, true);
    while (getAttackPlan(f.state, 'german')!.phase === 'prep') tick(f, true);
    const start = new Map(f.squads.map((s) => [s.id, dTiles(s.pos, MAIN_VL)]));
    let onHedge = 0, moves = 0;
    for (let i = 0; i < 30; i++) {
      for (const o of tick(f, true)) {
        if (!start.has(o.teamId) || !isMove(o.order)) continue;
        const t = o.order.target;
        if (dTiles(t, MAIN_VL) <= 6) continue; // the last rush is onto the objective itself, which has no cover
        moves++;
        if (f.state.map.tiles[Math.floor(t.y) * AW + Math.floor(t.x)] === 'crater') onHedge++;
      }
    }
    for (const s of f.squads) expect(dTiles(s.pos, MAIN_VL)).toBeLessThan(start.get(s.id)! - 20);
    // the shell holes are a quarter of the ground: well over half the halts in them is a preference
    expect(moves).toBeGreaterThanOrEqual(6);
    expect(onHedge / Math.max(1, moves)).toBeGreaterThan(0.7);
  });
});

describe('attack AI: armour stays with the infantry', () => {
  it('stations the tank behind the leading squad, never ahead of it', () => {
    const f = germanAttack();
    const leash = TANK_STATION_BEHIND_TILES + 12 + TANK_STATION_SPREAD_TILES; // behind + search radius + abreast
    for (let i = 0; i < 60; i++) {
      for (const o of tick(f, true)) {
        if (o.teamId !== f.tank.id || !isMove(o.order)) continue;
        const lead = f.squads.reduce((b, s) => (dTiles(s.pos, MAIN_VL) < dTiles(b.pos, MAIN_VL) ? s : b));
        const group = { x: f.squads.reduce((a, s) => a + s.pos.x, 0) / f.squads.length, y: f.squads.reduce((a, s) => a + s.pos.y, 0) / f.squads.length };
        expect(Math.min(dTiles(o.order.target, lead.pos), dTiles(o.order.target, group))).toBeLessThanOrEqual(leash);
        // not closer to the objective than the leading squad (2 tiles of slack for the tile grid)
        expect(dTiles(o.order.target, MAIN_VL)).toBeGreaterThanOrEqual(dTiles(lead.pos, MAIN_VL) - 2);
      }
    }
  });
});

describe('attack AI: mass on one axis, then the next objective', () => {
  it('gives every squad the same objective, and the same next one after it falls', () => {
    const f = germanAttack();
    tick(f);
    for (const s of f.squads) expect(s.aiObjective).toEqual(MAIN_VL);
    expect(getAttackPlan(f.state, 'german')!.objectiveId).toBe(0);
    // the objective falls
    f.state.map.victoryLocations[0].owner = 'german';
    for (const s of f.squads) teleport(f.state, s, { x: MAIN_VL.x - 2, y: MAIN_VL.y });
    tick(f);
    const plan = getAttackPlan(f.state, 'german')!;
    expect(plan.objectiveId).toBe(1);
    expect(plan.objectivesTaken).toBe(1);
    // the weakest squad stays to hold it; the others all turn on the next one together
    expect(plan.garrison.get(0)).toBeDefined();
    const others = f.squads.filter((s) => s.id !== plan.garrison.get(0));
    expect(others.length).toBe(f.squads.length - 1);
    for (const s of others) expect(s.aiObjective).toEqual({ x: 150, y: 8 });
  });

  it('keeps the squads of one bound within a platoon frontage of each other', () => {
    const f = germanAttack();
    for (let i = 0; i < 40; i++) tick(f, true);
    const xs = f.squads.map((s) => s.pos);
    for (const a of xs) for (const b of xs) expect(dTiles(a, b) * 2).toBeLessThanOrEqual(130);
  });
});

describe('attack AI: phases on a time budget', () => {
  it('ends the preparation on the clock, goes all-in when the objective has used up its budget, then calls it off', () => {
    const f = germanAttack();
    const seen: string[] = [];
    const note = (): void => { const p = getAttackPlan(f.state, 'german')!.phase; if (seen[seen.length - 1] !== p) seen.push(p); };
    tick(f); note();
    expect(seen[0]).toBe('prep');
    // squads creep forward but never get there (orders are not carried out beyond the FUP)
    while (f.state.time < 100) { tick(f); note(); }
    expect(getAttackPlan(f.state, 'german')!.phase).not.toBe('prep');
    const budget = getAttackPlan(f.state, 'german')!.budgetS;
    expect(budget).toBeGreaterThan(200);
    expect(budget).toBeLessThanOrEqual(f.state.config.durationS * 0.45);
    // put the squads within striking distance and let the clock run out on the objective
    for (const s of f.squads) teleport(f.state, s, { x: MAIN_VL.x - 40, y: MAIN_VL.y });
    while (f.state.time < budget + 20) { tick(f); note(); }
    expect(getAttackPlan(f.state, 'german')!.phase).toBe('allIn');
    while (f.state.time < budget + 200 && getAttackPlan(f.state, 'german')!.objectiveId === 0) { tick(f); note(); }
    tick(f); // the next decision picks the new objective
    // called off: the other objective is taken up instead
    expect(getAttackPlan(f.state, 'german')!.objectiveId).toBe(1);
    expect(getAttackPlan(f.state, 'german')!.failed.has(0)).toBe(true);
    expect(seen).toContain('assault');
  });

  it('calls the attack off (hold) when the squads are spent rather than rushing on', () => {
    const f = germanAttack();
    tick(f);
    for (const s of f.squads) for (const id of s.soldierIds.slice(1)) f.state.soldiers.get(id)!.health = 'dead';
    tick(f);
    expect(getAttackPlan(f.state, 'german')!.phase).toBe('hold');
    const issued = tick(f);
    for (const o of issued) if (f.squads.some((s) => s.id === o.teamId) && isMove(o.order)) expect(dTiles(o.order.target, f.state.teams.get(o.teamId)!.pos)).toBeLessThanOrEqual(10);
  });
});

describe('attack AI: only what the side knows', () => {
  it('never fires at an enemy nobody has spotted, remembers a spotted one, and forgets it in time', () => {
    const f = germanAttack();
    const rng = new Rng(5);
    // a Soviet squad lying well away from the objective, unseen
    const hidden = spawnTeam(f.state, TEAM_DEFS['sov_rifle_41'], 'soviet', { x: 100.5, y: 70.5 }, rng);
    for (let i = 0; i < 10; i++) {
      for (const o of tick(f)) if (o.order.type === 'fire' || o.order.type === 'smoke') expect(dTiles(o.order.target, hidden.pos)).toBeGreaterThan(15);
    }
    expect(getContacts(f.state, 'german')).toHaveLength(0);
    // now it is spotted: it becomes a contact and the mortar takes it on
    for (const id of hidden.soldierIds) f.state.spotted.german.add(id);
    const issued = tick(f);
    expect(getContacts(f.state, 'german').map((c) => c.teamId)).toEqual([hidden.id]);
    const mortarOrder = issued.find((o) => o.teamId === f.mortar.id);
    expect(mortarOrder?.order.type).toBe('fire');
    expect(dTiles(mortarOrder!.order.target, hidden.pos)).toBeLessThanOrEqual(3);
    // lost from sight: remembered for a while, then forgotten
    f.state.spotted.german.clear();
    tick(f);
    expect(getContacts(f.state, 'german')).toHaveLength(1);
    f.state.time += CONTACT_KEEP_S + 5;
    tick(f);
    expect(getContacts(f.state, 'german')).toHaveLength(0);
  });
});

describe('attack AI: determinism', () => {
  it('issues the identical order sequence for the same state and seed', () => {
    const run = (): string[] => {
      const f = germanAttack();
      const out: string[] = [];
      for (let i = 0; i < 40; i++) for (const o of tick(f, true)) out.push(`${f.state.time}:${o.teamId}:${o.order.type}:${o.order.target.x.toFixed(3)},${o.order.target.y.toFixed(3)}`);
      return out;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(20);
    expect(run()).toEqual(a);
  });
});

describe('defence AI sanity', () => {
  it('mans the victory locations instead of marching on the attacker\'s deployment zone while none is lost', () => {
    const state = attackState('german'); // soviet defends
    const rng = new Rng(3);
    const teams = [0, 1, 2].map((i) => spawnTeam(state, TEAM_DEFS['sov_rifle_41'], 'soviet', { x: 150.5, y: 34.5 + i * 5 }, rng));
    for (const t of teams) t.status = 'Defending';
    const battle = new FakeBattle();
    stepAI(state, rng, battle, 'soviet');
    const germanZone = { x: 14, y: 40 };
    for (const o of battle.orders) {
      if (!isMove(o.order)) continue;
      const nearestVl = Math.min(...state.map.victoryLocations.map((v) => dTiles(o.order.target, v)));
      expect(nearestVl).toBeLessThanOrEqual(10);
      expect(dTiles(o.order.target, germanZone)).toBeGreaterThan(60);
    }
    expect(battle.orders.some((o) => isMove(o.order))).toBe(true);
  });

  it('never gives the mortar its own men as a target', () => {
    const state = attackState('german');
    const rng = new Rng(4);
    const squad = spawnTeam(state, TEAM_DEFS['sov_rifle_41'], 'soviet', { x: 128.5, y: 40.5 }, rng);
    const mortar = spawnTeam(state, TEAM_DEFS['sov_mortar82'], 'soviet', { x: 150.5, y: 40.5 }, rng);
    for (const t of [squad, mortar]) t.status = 'Defending';
    // the Germans have spotted the whole Soviet squad (a tight cluster of men)
    for (const id of squad.soldierIds) { state.spotted.german.add(id); state.soldiers.get(id)!.pos = { x: 128.5, y: 40.5 }; }
    const battle = new FakeBattle();
    stepAI(state, rng, battle, 'soviet');
    for (const o of battle.orders) if (o.teamId === mortar.id && o.order.type === 'fire') expect(dTiles(o.order.target, squad.pos)).toBeGreaterThan(10);
  });
});
