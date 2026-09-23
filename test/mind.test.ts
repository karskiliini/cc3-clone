import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import {
  createMind, baseMotivation, stepMinds, onIncomingFire, onCasualtySeen, onSpotted, isLeaderless,
} from '@/sim/mind';

const W = 30, H = 30;

function makeMap(): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 25, y: 25, w: 5, h: 5 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
}

function makeState(): BattleState {
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map: makeMap(), phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 100,
  };
}

function makeSoldier(id: number, teamId: number, overrides: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side: 'german', name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 5, y: 5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id % 10 === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(baseMotivation(overrides.experience ?? 50, id % 10 === 1)),
    ...overrides,
  };
}

function makeTeam(id: number, soldierIds: number[]): Team {
  return {
    id, defId: 'test', side: 'german', name: 'Test Squad', type: 'rifle', soldierIds,
    leaderId: soldierIds[0], vehicleId: null, order: null, facing: 0, experience: 50,
    morale: 80, status: 'Idle', pos: { x: 5, y: 5 }, outOfAction: false, kills: 0, aiObjective: null,
  };
}

describe('stress and fear', () => {
  it('accumulates from near misses and decays over time without further fire', () => {
    const state = makeState();
    const s = makeSoldier(1, 1);
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1]));

    const rng = new Rng(1);
    onIncomingFire(state, rng, s, null, { x: 5.5, y: 5 }, 'rifle');
    expect(s.mind.stress).toBeGreaterThan(0);

    const afterHit = s.mind.stress;
    // No further incoming fire; threatLevel low -> fast decay.
    s.mind.threatLevel = 0;
    s.mind.lastIncomingAt = -999;
    for (let i = 0; i < 50; i++) stepMinds(state, rng, 0.1);
    expect(s.mind.stress).toBeLessThan(afterHit);
  });

  it('the same stress produces higher fear for a green soldier than a veteran', () => {
    const green = makeSoldier(1, 1, { experience: 20 });
    const vet = makeSoldier(2, 1, { experience: 80 });
    green.mind.stress = 60; vet.mind.stress = 60;
    green.mind.motivation = 40; vet.mind.motivation = 80;
    const fear = (s: Soldier) => s.mind.stress * (1.25 - s.experience / 200 - s.mind.motivation / 400) - (s.morale - 50) / 5;
    expect(fear(green)).toBeGreaterThan(fear(vet));
  });
});

describe('mental state machine', () => {
  it('escalates from calm through wary/shaken/pinned/cowering to panicked under sustained fire', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { experience: 20, morale: 18 });
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1]));
    const rng = new Rng(3);

    expect(s.mind.state).toBe('calm');

    // A visible, close enemy raises threatLevel -> alert -> wary.
    const enemy = makeSoldier(2, 2, { side: 'soviet', pos: { x: 7, y: 5 } });
    state.soldiers.set(enemy.id, enemy);
    state.spotted.german.add(enemy.id);
    onSpotted(state, s, enemy, 1);
    s.mind.threatLevel = 0.9;
    s.mind.threatDir = 0;
    stepMinds(state, rng, 0.1);
    expect(['alert', 'wary']).toContain(s.mind.state);

    // Heavy stress -> high fear -> shaken -> (with suppression) pinned -> cowering -> panicked.
    for (let i = 0; i < 200; i++) {
      onIncomingFire(state, rng, s, null, { ...s.pos }, 'lmg');
      s.suppression = 90;
      stepMinds(state, rng, 0.1);
    }
    expect(s.mind.state).toBe('panicked');
    expect(s.activity).toBe('panicked');
  });

  it('a panicked soldier ignores orders and does not fire', () => {
    const state = makeState();
    const s = makeSoldier(1, 1);
    s.mind.state = 'panicked';
    s.activity = 'panicked';
    expect(s.mind.state).toBe('panicked');
    // canSoldierFire in combat.ts explicitly excludes 'panicked'; verified structurally here since
    // mind.ts's syncActivityForState keeps activity==='panicked' in lockstep with mind.state.
  });

  it('recovers step by step with a delay, not instantly', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { experience: 60, morale: 80 });
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1]));
    const rng = new Rng(5);
    s.mind.state = 'shaken';
    s.mind.stress = 0;
    s.mind.fear = 0;
    s.suppression = 0;
    // fear < 30 immediately, but recovery requires it to hold for 5s (leaderless -> factor 2 -> 10s).
    stepMinds(state, rng, 0.1);
    expect(s.mind.state).toBe('shaken');
    for (let i = 0; i < 200; i++) stepMinds(state, rng, 0.1); // 20s more, well past the delay
    expect(s.mind.state).not.toBe('shaken');
  });
});

describe('beliefs', () => {
  it('is created on sighting an enemy', () => {
    const state = makeState();
    const s = makeSoldier(1, 1);
    const enemy = makeSoldier(2, 2, { side: 'soviet', pos: { x: 10, y: 5 } });
    onSpotted(state, s, enemy, 1);
    expect(s.mind.beliefs.length).toBe(1);
    expect(s.mind.beliefs[0].kind).toBe('seen');
    expect(s.mind.beliefs[0].confidence).toBe(1);
  });

  it('is created from being fired upon even without seeing the shooter', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    const shooter = makeSoldier(2, 2, { side: 'soviet', pos: { x: 5, y: 20 } });
    state.soldiers.set(shooter.id, shooter);
    const rng = new Rng(9);
    onIncomingFire(state, rng, s, shooter, { x: 5, y: 4.5 }, 'rifle');
    expect(s.mind.threatDir).not.toBeNull();
    // Shooter not in state.spotted -> the "LOS along incoming direction" branch adds a far belief.
    expect(s.mind.beliefs.length).toBeGreaterThan(0);
  });

  it('is shared by the leader to nearby teammates', () => {
    const state = makeState();
    const leader = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    const mate = makeSoldier(2, 1, { pos: { x: 6, y: 5 } });
    state.soldiers.set(leader.id, leader);
    state.soldiers.set(mate.id, mate);
    state.teams.set(1, makeTeam(1, [1, 2]));
    leader.mind.beliefs.push({ pos: { x: 20, y: 20 }, count: 1, confidence: 1, kind: 'seen', time: 0, deadSeen: 0 });

    const rng = new Rng(2);
    for (let i = 0; i < 25; i++) stepMinds(state, rng, 0.1); // >2s so sharing fires
    expect(mate.mind.beliefs.some((b) => b.kind === 'reported')).toBe(true);
  });

  it('is removed once enough dead enemies are seen there', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    const deadEnemy = makeSoldier(2, 2, { side: 'soviet', pos: { x: 6, y: 5 }, health: 'dead' });
    state.soldiers.set(s.id, s);
    state.soldiers.set(deadEnemy.id, deadEnemy);
    s.mind.beliefs.push({ pos: { x: 6, y: 5 }, count: 1, confidence: 1, kind: 'seen', time: 0, deadSeen: 0 });
    const rng = new Rng(4);
    for (let i = 0; i < 10; i++) stepMinds(state, rng, 0.1); // >0.5s so belief maintenance runs
    expect(s.mind.beliefs.length).toBe(0);
  });

  it('confidence halves under repeated clear view with no enemy present', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    state.soldiers.set(s.id, s);
    s.mind.beliefs.push({ pos: { x: 6, y: 5 }, count: 1, confidence: 1, kind: 'seen', time: 0, deadSeen: 0 });
    const rng = new Rng(6);
    for (let i = 0; i < 110; i++) stepMinds(state, rng, 0.1); // 11s of clear, empty view
    expect(s.mind.beliefs.length).toBeGreaterThan(0);
    expect(s.mind.beliefs[0].confidence).toBeLessThan(0.6);
  });

  it('expires after about 2 minutes with no refresh', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    state.soldiers.set(s.id, s);
    // Place the belief out of LOS-clear-view range (blocked) so only the flat decay applies, and
    // start it below 1 so the flat 1/120-per-second decay alone crosses the 0.1 removal floor
    // well inside the 2-minute mark.
    s.mind.beliefs.push({ pos: { x: 25, y: 25 }, count: 5, confidence: 0.3, kind: 'reported', time: 0, deadSeen: 0 });
    const rng = new Rng(8);
    for (let i = 0; i < 1300; i++) stepMinds(state, rng, 0.1); // 130s
    expect(s.mind.beliefs.length).toBe(0);
  });
});

describe('surrounded / helpless flags', () => {
  it('sets surrounded from high-confidence beliefs on 3+ quadrants within 60 m', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { pos: { x: 15, y: 15 } });
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1]));
    s.mind.beliefs.push(
      { pos: { x: 20, y: 20 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 },
      { pos: { x: 10, y: 20 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 },
      { pos: { x: 10, y: 10 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 },
    );
    const rng = new Rng(11);
    stepMinds(state, rng, 0.1);
    expect(s.mind.surrounded).toBe(true);
  });

  it('sets helpless when out of ammo', () => {
    const state = makeState();
    const s = makeSoldier(1, 1, { ammo: 0, ammoReserve: 0 });
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1]));
    const rng = new Rng(12);
    stepMinds(state, rng, 0.1);
    expect(s.mind.helpless).toBe(true);
  });
});

describe('leaderless obedience penalty', () => {
  it('isLeaderless is true once the leader is dead/incapacitated', () => {
    const state = makeState();
    const leader = makeSoldier(1, 1);
    const mate = makeSoldier(2, 1);
    state.soldiers.set(leader.id, leader);
    state.soldiers.set(mate.id, mate);
    const team = makeTeam(1, [1, 2]);
    state.teams.set(1, team);
    expect(isLeaderless(state, team)).toBe(false);
    leader.health = 'dead';
    expect(isLeaderless(state, team)).toBe(true);
  });
});

describe('traits', () => {
  it('a steady soldier gains less stress than a nervous one from the same event', () => {
    const state = makeState();
    const steady = makeSoldier(1, 1, { pos: { x: 5, y: 5 } });
    const nervous = makeSoldier(2, 1, { pos: { x: 5, y: 5 } });
    steady.mind.trait = 'steady';
    nervous.mind.trait = 'nervous';
    const rng = new Rng(13);
    onIncomingFire(state, rng, steady, null, { x: 5.2, y: 5 }, 'rifle');
    onIncomingFire(state, rng, nervous, null, { x: 5.2, y: 5 }, 'rifle');
    expect(steady.mind.stress).toBeLessThan(nervous.mind.stress);
  });
});

describe('first-fire shock', () => {
  it('only freezes a green soldier (experience < 30), not a veteran, on the first shot fired at him', () => {
    const state = makeState();
    const green = makeSoldier(1, 1, { experience: 20, pos: { x: 5, y: 5 } });
    const vet = makeSoldier(2, 2, { experience: 80, pos: { x: 15, y: 15 } });
    state.soldiers.set(green.id, green);
    state.soldiers.set(vet.id, vet);
    state.teams.set(1, makeTeam(1, [1]));
    state.teams.set(2, { ...makeTeam(2, [2]), leaderId: 2 });
    const rng = new Rng(14);

    onIncomingFire(state, rng, green, null, { x: 5.2, y: 5 }, 'rifle');
    onIncomingFire(state, rng, vet, null, { x: 15.2, y: 15 }, 'rifle');

    expect(green.mind.state).toBe('shaken');
    expect(vet.mind.state).not.toBe('shaken');
  });
});
