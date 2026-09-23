// Knocked down -> DAZED -> RECOVERING (user request 2026-09-17; sim/daze.ts). Deterministic.
import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, CrewTaskId, GameMap, MapDef, Soldier, Team, Terrain, Vec2, WeaponDef } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { applyBlastKnockback, blastForce, isStunned, stepCombat } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { stepCrewWeapons, isAbleCrewman } from '@/sim/crewWeapon';
import { applyOrder } from '@/sim/orders';
import { createMind, stepMinds } from '@/sim/mind';
import { ableToLoot } from '@/sim/pickup';
import { coverScore } from '@/sim/cover';
import {
  DAZE_CAP_S, DAZE_CRAWL_RADIUS_M, RECOVER_FACTOR_MIN, applyDaze, dazeDurationS, dazeVisionFactor, isDazed, recoverDurationS,
  recoveryFactor, stepDazed,
} from '@/sim/daze';
import { actionFor, moodFor } from '@/render/soldierAnim';
import { MONITOR_STATUS_WORDS } from '@/ui/hud/soldierMonitor';
import { Battle } from '@/sim/battle';

const W = 40, H = 40;

function makeSoldier(o: Partial<Soldier> = {}): Soldier {
  return {
    id: 1, teamId: 1, side: 'soviet', name: 'T', rank: 'Pvt', weaponId: 'mosin', ammo: 5, ammoReserve: 20, grenades: 2,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 10.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [],
    reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}
function makeState(): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer', paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 3, h: 3 }, soviet: { x: 36, y: 36, w: 3, h: 3 } }, attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles, buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } };
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
function mkTeam(id: number, type: Team['type'], ids: number[], side: Team['side']): Team {
  return {
    id, defId: 'test', side, name: `Team ${id}`, type, soldierIds: ids, leaderId: ids[0], vehicleId: null, order: null, facing: 0,
    experience: 50, morale: 80, status: 'Idle', pos: { x: 0, y: 0 }, outOfAction: false, kills: 0, aiObjective: null,
  };
}
const mortar: WeaponDef = {
  id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0, suppression: 0.6,
  penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8,
};

/** A man knocked down by a mortar bomb 1 m away. */
function blasted(o: Partial<Soldier> = {}): { state: BattleState; s: Soldier } {
  const state = makeState();
  const s = makeSoldier({ pos: { x: 11, y: 10.5 }, ...o });
  state.soldiers.set(s.id, s);
  state.teams.set(1, mkTeam(1, 'rifle', [s.id], 'soviet'));
  applyBlastKnockback(state, new Rng(11), s, { x: 10.5, y: 10.5 }, mortar);
  return { state, s };
}

describe('daze: how long', () => {
  it('a knock-down dazes the survivor for 6-20 s x experience after the stun, then he recovers for 10-30 s', () => {
    const { state, s } = blasted();
    expect(s.stunnedUntil).toBeDefined();
    expect(s.dazedUntil).toBeGreaterThan(s.stunnedUntil!);
    const daze = s.dazedUntil! - s.stunnedUntil!;
    expect(daze).toBeGreaterThanOrEqual(6 * 0.5);
    expect(daze).toBeLessThanOrEqual(20 * 1.5 * 1.4);
    expect(s.shakenUntil! - s.dazedUntil!).toBeCloseTo(recoverDurationS(s), 6);
    expect(isDazed(s, state.time)).toBe(true);
    expect(isDazed(s, s.dazedUntil! + 0.01)).toBe(false);
  });

  it('veteran < regular < recruit for the same blast; a bigger blast, a wound and low morale lengthen it', () => {
    const d = (o: Partial<Soldier>) => { const { s } = blasted(o); return s.dazedUntil! - s.stunnedUntil!; };
    const vet = d({ experience: 85 }), reg = d({ experience: 50 }), rec = d({ experience: 15 });
    expect(vet).toBeLessThan(reg);
    expect(reg).toBeLessThan(rec);
    expect(rec / vet).toBeCloseTo(3, 1); // x1.5 .. x0.5
    const base = makeSoldier();
    expect(dazeDurationS(base, 1.2, false)).toBeGreaterThan(dazeDurationS(base, 0.4, false));
    expect(dazeDurationS(base, 0.8, true)).toBeGreaterThan(dazeDurationS(base, 0.8, false));
    expect(dazeDurationS(makeSoldier({ health: 'wounded' }), 0.8, false)).toBeGreaterThan(dazeDurationS(base, 0.8, false));
    expect(dazeDurationS(makeSoldier({ morale: 20 }), 0.8, false)).toBeGreaterThan(dazeDurationS(makeSoldier({ morale: 95 }), 0.8, false));
    expect(recoverDurationS(makeSoldier({ experience: 85 }))).toBe(10);
    expect(recoverDurationS(makeSoldier({ experience: 15 }))).toBe(30);
  });

  it('a second blast extends the daze, capped at 45 s from now', () => {
    const { state, s } = blasted({ experience: 15 });
    const first = s.dazedUntil!;
    state.time += 3;
    applyBlastKnockback(state, new Rng(12), s, { x: s.pos.x - 0.5, y: s.pos.y }, mortar);
    expect(s.dazedUntil!).toBeGreaterThan(first + 5);
    for (let i = 0; i < 6; i++) applyDaze(state, s, 1.5, false);
    expect(s.dazedUntil! - state.time).toBeCloseTo(DAZE_CAP_S, 6);
    expect(s.shakenUntil!).toBeGreaterThan(s.dazedUntil!);
  });

  it('the dead and the incapacitated are not dazed', () => {
    const { s } = blasted({ health: 'incapacitated' });
    expect(s.dazedUntil).toBeUndefined();
  });
});

describe('daze: what he cannot do', () => {
  it('a dazed man does not fire, throw, reload or loot, sees little, and fires again afterwards', () => {
    const { state, s } = blasted({ grenades: 2 });
    const enemy = makeSoldier({ id: 3, teamId: 3, side: 'german', weaponId: 'kar98k', grenades: 0, pos: { x: 22, y: 10.5 } });
    state.soldiers.set(3, enemy);
    state.teams.set(3, mkTeam(3, 'rifle', [3], 'german'));
    state.spotted.soviet.add(3);
    state.time = s.stunnedUntil! + 0.05; // up from the knock-down, still dazed
    expect(isStunned(s, state.time)).toBe(false);
    expect(isDazed(s, state.time)).toBe(true);
    expect(ableToLoot(state, s)).toBe(false);
    expect(dazeVisionFactor(s, state.time)).toBeLessThanOrEqual(0.3);
    s.activity = 'reloading'; s.reloadTimer = 0.2; s.ammo = 0;
    const rng = new Rng(9);
    const stepAll = () => { stepMovement(state, rng, 0.1); stepCombat(state, rng, 0.1); state.time += 0.1; enemy.health = 'healthy'; enemy.stunnedUntil = undefined; };
    while (state.time < s.dazedUntil! - 0.2) stepAll();
    expect(s.lastFiredAt).toBe(-999);
    expect(s.grenades).toBe(2);
    expect(s.ammo).toBe(0); // the reload did not run
    // his head clears: he fights again
    s.activity = 'defending'; s.ammo = 5; s.stance = 'crouching';
    for (let i = 0; i < 300 && s.lastFiredAt < 0; i++) stepAll();
    expect(s.lastFiredAt).toBeGreaterThan(s.dazedUntil!);
    expect(dazeVisionFactor(s, s.shakenUntil! + 1)).toBe(1);
  });

  it('a dazed man takes no movement order; it stays pending and he takes it up when the daze ends', () => {
    const state = makeState();
    const a = makeSoldier({ id: 1, isLeader: true }), b = makeSoldier({ id: 2, pos: { x: 11.5, y: 11.5 } });
    for (const m of [a, b]) { m.mind.motivation = 100; m.experience = 60; state.soldiers.set(m.id, m); }
    const team = mkTeam(1, 'rifle', [1, 2], 'soviet');
    state.teams.set(1, team);
    b.stunnedUntil = state.time + 0.5;
    applyDaze(state, b, 0.8, false);
    const rng = new Rng(5);
    applyOrder(state, team, { type: 'move', target: { x: 30.5, y: 30.5 }, issuedAt: state.time }, rng, true);
    expect(b.path.length).toBe(0);
    expect(b.mind.pendingOrderAt).toBe(state.time);
    const at = { ...b.pos };
    // trees all round him: he is not in the open, so he does not crawl either
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) state.map.tiles[(11 + dy) * W + 11 + dx] = 'woods';
    const end = b.dazedUntil!;
    while (state.time < end - 0.1) { stepMovement(state, rng, SIM_DT); stepMinds(state, rng, SIM_DT); state.time += SIM_DT; }
    expect(dist(b.pos, at)).toBeLessThan(0.3);
    expect(b.activity).not.toBe('moving');
    for (let i = 0; i < 20 / SIM_DT && b.path.length === 0; i++) { stepMovement(state, rng, SIM_DT); stepMinds(state, rng, SIM_DT); state.time += SIM_DT; }
    expect(b.path.length).toBeGreaterThan(0);
    expect(b.activity).toBe('moving');
  });

  it('non-veterans come out of it at least shaken; a dazed man reads "Dazed" / cowering, crawling = panicked', () => {
    const { state, s } = blasted({ experience: 40 });
    const vetRun = blasted({ experience: 85 });
    const rng = new Rng(2);
    state.time = s.stunnedUntil! + 0.05; vetRun.state.time = vetRun.s.stunnedUntil! + 0.05;
    stepMinds(state, rng, SIM_DT); stepMinds(vetRun.state, rng, SIM_DT);
    expect(s.mind.state).toBe('shaken');
    expect(vetRun.s.mind.state).not.toBe('shaken');
    expect(s.mind.stress).toBeGreaterThanOrEqual(40);
    expect(MONITOR_STATUS_WORDS).toContain('Dazed');
    expect(moodFor(s, state.time)).toBe('cowering');
    expect(actionFor(s, state.time, 'prone')).toBe('hide');
    s.path = [{ x: 20, y: 20 }];
    expect(moodFor(s, state.time, 0.3)).toBe('panicked');
    expect(actionFor(s, state.time, 'prone', 0.3)).toBe('crawl');
    expect(moodFor(s, state.time, 0)).toBe('cowering'); // a leftover path alone is not crawling
    expect(moodFor(s, s.dazedUntil! + 1)).not.toBe('cowering');
  });
});

describe('daze: the crawl for cover', () => {
  function openWithWall(): { state: BattleState; s: Soldier } {
    const state = makeState();
    // a stone wall 3 tiles (6 m) east of him, the enemy beyond it
    for (let y = 5; y < 16; y++) state.map.tiles[y * W + 14] = 'stonewall';
    const s = makeSoldier({ pos: { x: 10.5, y: 10.5 }, experience: 15 });
    s.mind.threatDir = Math.PI / 2; s.mind.threatLevel = 0.8; // fire from the east
    state.soldiers.set(1, s);
    state.teams.set(1, mkTeam(1, 'rifle', [1], 'soviet'));
    s.stunnedUntil = state.time + 0.1;
    applyDaze(state, s, 1.5, true);
    return { state, s };
  }

  it('a dazed man in the open crawls, prone and slowly, to better cover within 12 m and then lies still', () => {
    const { state, s } = openWithWall();
    const start = { ...s.pos };
    const threats = [{ dirRad: Math.PI / 2, weight: 1 }];
    const cover0 = coverScore(state.map, s.pos, threats);
    const rng = new Rng(4);
    let maxStep = 0, arrivedAt = -1;
    const end = s.dazedUntil!;
    expect(end - state.time).toBeGreaterThan(25);
    while (state.time < end - 0.1) {
      const p = { ...s.pos };
      s.mind.threatDir = Math.PI / 2; s.mind.threatLevel = 0.8;
      stepMovement(state, rng, SIM_DT); stepMinds(state, rng, SIM_DT); state.time += SIM_DT;
      maxStep = Math.max(maxStep, dist(p, s.pos) * TILE_M / SIM_DT);
      if (arrivedAt < 0 && s.dazeCrawl && s.dazeCrawl.path.length === 0 && dist(s.pos, start) > 1) arrivedAt = state.time;
    }
    expect(arrivedAt).toBeGreaterThan(0);
    expect(s.stance).toBe('prone');
    expect(maxStep).toBeLessThan(0.45); // a slow crawl, m/s
    expect(dist(s.pos, start) * TILE_M).toBeLessThanOrEqual(DAZE_CRAWL_RADIUS_M);
    expect(coverScore(state.map, s.pos, threats)).toBeGreaterThan(cover0 + 0.3);
    expect(Math.floor(s.pos.x)).toBe(13); // behind the wall, on his own side of it
    // ...and then he lies still
    const rest = { ...s.pos };
    expect(arrivedAt).toBeLessThan(end - 3);
    expect(dist(s.pos, rest)).toBe(0);
    expect(s.path.length).toBe(0);
  });

  it('he stays put when nothing within 12 m is better, and when he already has cover', () => {
    const state = makeState();
    const s = makeSoldier({ pos: { x: 20.5, y: 20.5 } });
    state.soldiers.set(1, s);
    s.stunnedUntil = state.time; applyDaze(state, s, 1, false);
    const rng = new Rng(4);
    for (let i = 0; i < 80; i++) { stepDazed(state, rng, SIM_DT); state.time += SIM_DT; }
    expect(s.pos).toEqual({ x: 20.5, y: 20.5 });
    expect(s.stance).toBe('prone');
  });
});

describe('daze: crew-served weapons', () => {
  function gun(n: number): { state: BattleState; team: Team; men: Soldier[] } {
    const state = makeState();
    const men: Soldier[] = [];
    const PIVOT: Vec2 = { x: 20, y: 20 };
    for (let i = 0; i < n; i++) {
      const s = makeSoldier({ id: i + 1, side: 'german', weaponId: i === 0 ? 'pak40' : 'kar98k', stance: 'crouching', activity: 'idle', pos: { x: PIVOT.x - 1 + i * 0.9, y: PIVOT.y + 2.2 }, isLeader: i === n - 1 });
      men.push(s); state.soldiers.set(s.id, s);
    }
    const team = mkTeam(1, 'atgun', [men[n - 1].id, ...men.slice(0, n - 1).map((m) => m.id)], 'german');
    team.crewWeapon = { weaponId: 'pak40', pos: { ...PIVOT }, facing: 0, phase: 'settingUp', timer: 0, phaseTotal: 0, gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0 };
    state.teams.set(1, team);
    return { state, team, men };
  }

  it('a dazed crewman is not able; his task is reassigned to another man', () => {
    const { state, team, men } = gun(3);
    const cw = team.crewWeapon!;
    for (let i = 0; i < 20; i++) { state.time += SIM_DT; stepCrewWeapons(state, SIM_DT); }
    const tasks = Object.keys(cw.workers ?? {}) as CrewTaskId[];
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0];
    const loader = state.soldiers.get(cw.workers![task]!)!;
    loader.stunnedUntil = state.time; applyDaze(state, loader, 1.2, false);
    expect(isAbleCrewman(state, loader)).toBe(false);
    for (let i = 0; i < 5; i++) { state.time += SIM_DT; stepCrewWeapons(state, SIM_DT); }
    const still = (cw.open ?? []).includes(task);
    expect(still).toBe(true);
    expect(cw.workers![task]).toBeDefined();
    expect(cw.workers![task]).not.toBe(loader.id);
    expect(Object.values(cw.workers!)).not.toContain(loader.id);
    expect(men.some((m) => m.id === cw.workers![task])).toBe(true);
    expect(isAbleCrewman(state, loader)).toBe(false);
    state.time = loader.dazedUntil! + 0.01;
    expect(isAbleCrewman(state, loader)).toBe(true);
  });

  it('a recovering man works a task more slowly', () => {
    const timeToFirstTask = (recovering: boolean): number => {
      const { state, team, men } = gun(1);
      if (recovering) { men[0].dazedUntil = state.time; men[0].shakenUntil = state.time + 1000; }
      const t0 = state.time;
      while ((team.crewWeapon!.done ?? []).length === 0 && state.time - t0 < 120) { state.time += SIM_DT; stepCrewWeapons(state, SIM_DT); }
      return state.time - t0;
    };
    expect(timeToFirstTask(true)).toBeGreaterThan(timeToFirstTask(false) * 1.15);
  });
});

describe('daze: recovery', () => {
  it('the penalty is 0.7 while dazed and fades linearly to 1 over the recovery', () => {
    const { s } = blasted();
    const d = s.dazedUntil!, r = s.shakenUntil!;
    expect(recoveryFactor(makeSoldier(), 50)).toBe(1);
    expect(recoveryFactor(s, d - 1)).toBe(RECOVER_FACTOR_MIN);
    expect(recoveryFactor(s, d)).toBeCloseTo(RECOVER_FACTOR_MIN, 6);
    expect(recoveryFactor(s, (d + r) / 2)).toBeCloseTo(0.85, 6);
    expect(recoveryFactor(s, r - 0.001)).toBeLessThan(1);
    expect(recoveryFactor(s, r)).toBe(1);
    let prev = 0;
    for (let t = d; t <= r; t += 1) { const f = recoveryFactor(s, t); expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
  });
});

describe('daze: determinism', () => {
  it('the same blast and the same steps give the same state', () => {
    const run = (): string => {
      const state = makeState();
      for (let y = 5; y < 16; y++) state.map.tiles[y * W + 14] = 'stonewall';
      const men = [0, 1, 2, 3].map((i) => makeSoldier({ id: i + 1, experience: 20 + i * 20, pos: { x: 10.5 + i * 0.4, y: 10.5 + i * 0.7 } }));
      for (const m of men) { m.mind.threatDir = Math.PI / 2; m.mind.threatLevel = 0.7; state.soldiers.set(m.id, m); }
      state.teams.set(1, mkTeam(1, 'rifle', [1, 2, 3, 4], 'soviet'));
      const rng = new Rng(21);
      for (const m of men) applyBlastKnockback(state, rng, m, { x: 10.2, y: 10.2 }, mortar);
      for (let i = 0; i < 40 / SIM_DT; i++) { stepMovement(state, rng, SIM_DT); stepMinds(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT); state.time += SIM_DT; }
      return JSON.stringify(men.map((m) => [m.pos.x.toFixed(6), m.pos.y.toFixed(6), m.dazedUntil, m.shakenUntil, m.stance, m.activity, m.mind.state, m.mind.stress.toFixed(4)]));
    };
    expect(run()).toBe(run());
  });

  it('a whole battle with the same seed ends in the same state', () => {
    const config: BattleConfig = {
      mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 150, difficulty: 'normal', aiBothSides: true,
      forces: { german: ['ger_rifle_41', 'ger_mortar81'], soviet: ['sov_rifle_41', 'sov_mortar82'] },
    } as BattleConfig;
    const run = (): string => {
      const b = new Battle(config);
      b.start();
      for (let i = 0; i < 90 / SIM_DT; i++) b.step(SIM_DT);
      return JSON.stringify([...b.state.soldiers.values()].map((s) => [s.id, s.pos.x.toFixed(5), s.pos.y.toFixed(5), s.health, s.dazedUntil ?? 0, s.ammo]));
    };
    expect(run()).toBe(run());
  });
});

describe('daze: force', () => {
  it('knock-down forces are inside the range the daze scales over', () => {
    expect(blastForce(mortar, 0.5)).toBeGreaterThan(0.2);
    expect(blastForce(mortar, 0.5)).toBeLessThanOrEqual(1.5);
  });
});
