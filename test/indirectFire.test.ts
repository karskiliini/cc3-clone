import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain, Vec2 } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepCombat, getCombatInstrumentation, mortarDispersionM, mortarObservation, mortarWalkState } from '@/sim/combat';
import {
  stepCrewWeapons, crewWeaponStatus, layTimeS, loadTimeS, fireMissionWait, MISSION_NEW_AIM_M,
} from '@/sim/crewWeapon';
import { createMind } from '@/sim/mind';
import { hasLOS } from '@/sim/los';

const W = 400, H = 40;
const WALL_X = 30;

function makeState(): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  for (let y = 0; y < H; y++) tiles[y * W + WALL_X] = 'buildingStone'; // blocks LOS end to end
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 150, y: 30, w: 5, h: 5 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200,
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
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 100,
  };
}

function soldier(id: number, teamId: number, pos: Vec2, weaponId: string, over: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side: 'german', name: 'T', rank: 'Gefr', weaponId, ammo: 1000, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'crouching',
    activity: 'defending', pos, facing: 2, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(80), ...over,
  };
}

function team(id: number, type: Team['type'], ids: number[]): Team {
  return {
    id, defId: 'test', side: 'german', name: `Team ${id}`, type, soldierIds: ids, leaderId: ids[0],
    vehicleId: null, order: null, facing: 2, experience: 50, morale: 80, status: 'Idle',
    pos: { x: 0, y: 0 }, outOfAction: false, kills: 0, aiObjective: null,
  };
}

/** A German 81 mm mortar team west of the wall: gunner (id 1) and leader (id 2). */
function mortarSetup(): { state: BattleState; mortar: Team; gunner: Soldier } {
  const state = makeState();
  const gunner = soldier(1, 1, { x: 10, y: 20 }, 'mortar81');
  const leader = soldier(2, 1, { x: 9, y: 21 }, 'kar98k', { isLeader: true });
  state.soldiers.set(1, gunner);
  state.soldiers.set(2, leader);
  const mortar = team(1, 'mortar', [2, 1]);
  mortar.crewWeapon = {
    weaponId: 'mortar81', pos: { x: 10.8, y: 20.2 }, facing: Math.PI / 2, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0,
  };
  state.teams.set(1, mortar);
  return { state, mortar, gunner };
}

function addSpotter(state: BattleState, pos: Vec2): Soldier {
  const s = soldier(10, 5, pos, 'kar98k', { isLeader: true });
  state.soldiers.set(10, s);
  state.teams.set(5, team(5, 'rifle', [10]));
  return s;
}

/** Steps the crew-weapon and combat systems; returns HE impact points and their times. */
const HOME = new WeakMap<Soldier, Vec2>();
function run(state: BattleState, rng: Rng, seconds: number): { pos: Vec2; t: number }[] {
  const out: { pos: Vec2; t: number }[] = [];
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    state.time += SIM_DT;
    stepCrewWeapons(state, SIM_DT);
    stepCombat(state, rng, SIM_DT);
    for (const e of state.explosions) if (e.kind === 'he') out.push({ pos: e.pos, t: state.time });
    state.explosions.length = 0;
    state.tracers.length = 0;
    state.events.length = 0;
    // keep the test observers steady: no one panics, runs from falling shells, or is thrown or
    // stunned by a blast (knockback would drift the spotted enemy out of the target area and
    // change the observation tier, which is real behaviour but not what these tests measure)
    for (const s of state.soldiers.values()) {
      s.suppression = 0; s.mind.stress = 0; s.activity = 'defending'; s.health = 'healthy';
      let home = HOME.get(s);
      if (!home) { home = { x: s.pos.x, y: s.pos.y }; HOME.set(s, home); }
      if (s.blast) { s.pos = { x: home.x, y: home.y }; s.blast = undefined; s.stunnedUntil = undefined; }
    }
  }
  return out;
}

describe('indirect fire: mortars', () => {
  it('fires at an ordered point it cannot see, within range', () => {
    const { state, mortar } = mortarSetup();
    const target = { x: 100, y: 20 }; // 180 m, behind the wall
    for (const s of state.soldiers.values()) expect(hasLOS(state.map, s.pos, target)).toBe(false);
    mortar.order = { type: 'fire', target, issuedAt: 0 };
    const hits = run(state, new Rng(3), 30);
    expect(hits.length).toBeGreaterThan(0);
    expect(getCombatInstrumentation(state).mortarRoundsFiredBySide.german).toBe(hits.length);
    for (const h of hits) expect(dist(h.pos, target) * TILE_M).toBeLessThan(60);
  });

  it('does not fire inside its minimum range', () => {
    const { state, mortar } = mortarSetup();
    mortar.order = { type: 'fire', target: { x: 35, y: 20 }, issuedAt: 0 }; // 50 m < 60 m
    expect(run(state, new Rng(3), 40)).toHaveLength(0);
    expect(mortar.crewWeapon!.mission).toBeUndefined();
  });

  it('the first round waits for lay + load; later rounds on the same target only for the rate of fire', () => {
    const { state, mortar, gunner } = mortarSetup();
    const target = { x: 100, y: 20 };
    mortar.order = { type: 'fire', target, issuedAt: 0 };
    const hits = run(state, new Rng(5), 24);
    const prep = layTimeS('mortar81', gunner.experience, 180, 0) + loadTimeS('mortar81', gunner.experience);
    expect(prep).toBeGreaterThan(8);
    expect(hits[0].t).toBeGreaterThanOrEqual(prep - 0.05);
    expect(hits[0].t).toBeLessThan(prep + 0.6);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1].t - hits[0].t).toBeLessThan(1 / 0.15 + 0.6);
  });

  it('shows Aiming then Loading as the team status while preparing', () => {
    const { state, mortar } = mortarSetup();
    mortar.order = { type: 'fire', target: { x: 100, y: 20 }, issuedAt: 0 };
    run(state, new Rng(5), 1);
    expect(crewWeaponStatus(mortar)).toBe('Aiming');
    run(state, new Rng(5), 6.5);
    expect(crewWeaponStatus(mortar)).toBe('Loading');
  });

  function addEnemy(state: BattleState, pos: Vec2): Soldier {
    const e = soldier(50, 50, pos, 'kar98k', { side: 'soviet' });
    state.soldiers.set(50, e);
    const et = team(50, 'rifle', [50]); et.side = 'soviet';
    state.teams.set(50, et);
    state.spotted.german.add(50);
    return e;
  }

  it('observation tiers: spotted target lands tighter than observed area, which beats unobserved fire', () => {
    const target = { x: 100, y: 20 };
    const sample = (tier: 'spotted' | 'area' | 'none'): { mean: number; first: number } => {
      const { state, mortar } = mortarSetup();
      if (tier !== 'none') addSpotter(state, { x: 100, y: 2 }); // 36 m off, clear view of the target
      if (tier === 'spotted') addEnemy(state, { x: 101, y: 21 });
      expect(mortarObservation(state, mortar, target).obs).toBe(tier);
      mortar.order = { type: 'fire', target, issuedAt: 0 };
      const hits = run(state, new Rng(11), 80 * 7);
      expect(hits.length).toBeGreaterThan(60);
      const mean = hits.reduce((a, h) => a + dist(h.pos, target), 0) / hits.length * TILE_M;
      return { mean, first: hits[0].t };
    };
    const spotted = sample('spotted');
    const area = sample('area');
    const blind = sample('none');
    expect(spotted.mean).toBeLessThan(area.mean * 0.85);
    expect(area.mean).toBeLessThan(blind.mean * 0.8);
    // an outside spotter's correction delays the first round
    expect(spotted.first).toBeGreaterThan(blind.first + 1.9);
    // the model: walk-in 1.6 -> 1.0 when spotted, only to 1.4 on bare ground, none unobserved
    expect(mortarDispersionM(200, 'spotted', 0)).toBeCloseTo(mortarDispersionM(200, 'area', 0), 5);
    expect(mortarDispersionM(200, 'spotted', 3) / mortarDispersionM(200, 'spotted', 0)).toBeCloseTo(1 / 1.6, 5);
    expect(mortarDispersionM(200, 'area', 9) / mortarDispersionM(200, 'area', 0)).toBeCloseTo(1.4 / 1.6, 5);
    expect(mortarDispersionM(200, 'none', 0)).toBe(mortarDispersionM(200, 'none', 10));
  });

  it("losing the spotter's line of sight mid-mission drops the tier and restarts walk-in", () => {
    const { state, mortar } = mortarSetup();
    const target = { x: 100, y: 20 };
    addSpotter(state, { x: 100, y: 2 });
    addEnemy(state, { x: 101, y: 21 });
    mortar.order = { type: 'fire', target, issuedAt: 0 };
    run(state, new Rng(2), 30);
    expect(mortarWalkState(mortar)!.tier).toBe('spotted');
    expect(mortarWalkState(mortar)!.rounds).toBeGreaterThanOrEqual(2);
    for (let x = 90; x <= 110; x++) state.map.tiles[10 * W + x] = 'buildingStone'; // wall between spotter and target
    const before = getCombatInstrumentation(state).mortarRoundsFiredBySide.german;
    for (let i = 0; i < 100 && getCombatInstrumentation(state).mortarRoundsFiredBySide.german === before; i++) run(state, new Rng(2), SIM_DT);
    expect(mortarWalkState(mortar)).toEqual({ tier: 'none', rounds: 1 });
  });

  it('a panicked or cowering soldier is no spotter; nor is one beyond 600 m', () => {
    const { state, mortar } = mortarSetup();
    const target = { x: 100, y: 20 };
    const spotter = addSpotter(state, { x: 100, y: 2 });
    expect(mortarObservation(state, mortar, target).obs).toBe('area');
    spotter.activity = 'panicked';
    expect(mortarObservation(state, mortar, target).obs).toBe('none');
    spotter.activity = 'defending'; spotter.mind.state = 'cowering';
    expect(mortarObservation(state, mortar, target).obs).toBe('none');
    spotter.mind.state = 'pinned';
    const pinned = mortarObservation(state, mortar, target);
    expect(pinned.obs).toBe('area');
    expect(pinned.mul).toBeCloseTo(1.3, 5);

    const far = mortarSetup();
    const t2 = { x: 60, y: 20 };
    const s2 = addSpotter(far.state, { x: 60 + 305, y: 20 }); // 610 m down an open row
    expect(mortarObservation(far.state, far.mortar, t2).obs).toBe('none');
    s2.pos = { x: 60 + 125, y: 20 }; // 250 m: counts, a little less precise than a close spotter
    const near = mortarObservation(far.state, far.mortar, t2);
    expect(near.obs).toBe('area');
    expect(near.mul).toBeGreaterThan(1);
    expect(near.mul).toBeLessThan(1.25);
  });

  it('set-up still blocks firing', () => {
    const { state, mortar } = mortarSetup();
    mortar.crewWeapon!.phase = 'settingUp';
    mortar.crewWeapon!.timer = 1000;
    mortar.crewWeapon!.phaseTotal = 1000;
    mortar.order = { type: 'fire', target: { x: 100, y: 20 }, issuedAt: 0 };
    expect(run(state, new Rng(3), 40)).toHaveLength(0);
  });

  it('a cowering crew aborts the mission and does not fire', () => {
    const { state, mortar, gunner } = mortarSetup();
    mortar.order = { type: 'fire', target: { x: 100, y: 20 }, issuedAt: 0 };
    run(state, new Rng(3), 3);
    expect(mortar.crewWeapon!.mission).toBeDefined();
    gunner.activity = 'cowering';
    stepCrewWeapons(state, SIM_DT);
    expect(mortar.crewWeapon!.mission).toBeUndefined();
    stepCombat(state, new Rng(3), SIM_DT);
    expect(getCombatInstrumentation(state).mortarRoundsFiredBySide.german).toBe(0);
  });

  it('fires on an attack-unit target spotted by a friendly, and on a strong belief when idle', () => {
    const { state, mortar } = mortarSetup();
    addEnemy(state, { x: 100, y: 22 });
    mortar.order = { type: 'fire', target: { x: 100, y: 22 }, targetTeamId: 50, lastSeenAt: 0, lastKnownPos: { x: 100, y: 22 }, issuedAt: 0 };
    const keep = () => { mortar.order!.lastSeenAt = state.time; };
    let n = 0;
    for (let i = 0; i < 200; i++) { keep(); n += run(state, new Rng(i), SIM_DT).length; }
    expect(n).toBeGreaterThan(0);

    const idle = mortarSetup();
    idle.gunner.mind.beliefs.push({ pos: { x: 90, y: 15 }, count: 3, confidence: 0.9, kind: 'fired', time: 0, deadSeen: 0 });
    idle.mortar.order = { type: 'defend', target: { x: 90, y: 15 }, issuedAt: 0 };
    const hits = run(idle.state, new Rng(4), 40);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(dist(h.pos, { x: 90, y: 15 }) * TILE_M).toBeLessThan(80);
  });
});

describe('fire-mission preparation (crew-served direct fire)', () => {
  it('AT gun lay grows with traverse; HMG lays in about 2 s; green crews are slower than veterans', () => {
    expect(layTimeS('pak40', 50, 300, 0)).toBeCloseTo(1.5, 5);
    expect(layTimeS('pak40', 50, 300, Math.PI)).toBeCloseTo(4, 5);
    expect(layTimeS('mg42_hmg', 50, 300, 1)).toBeCloseTo(2, 5);
    expect(layTimeS('mortar81', 20, 500, 0)).toBeGreaterThan(layTimeS('mortar81', 90, 500, 0));
    expect(loadTimeS('pak40', 50)).toBeGreaterThanOrEqual(3);
    expect(loadTimeS('pak40', 50)).toBeLessThanOrEqual(4);
  });

  it('switching aim point more than 15 m starts a new lay; a moving tracked target only a short re-lay', () => {
    const { state, mortar, gunner } = mortarSetup();
    const cw = mortar.crewWeapon!;
    expect(fireMissionWait(state, mortar, gunner, { aim: { x: 100, y: 20 }, targetTeamId: 7 })).toBeGreaterThan(8);
    cw.firePhase = 'ready'; cw.mission!.timer = 0; cw.mission!.loaded = true; cw.mission!.rounds = 2;
    expect(fireMissionWait(state, mortar, gunner, { aim: { x: 100, y: 22 }, targetTeamId: 7 })).toBe(0);
    // tracked team moved 12 m: re-lay 1-2 s, mission (and its rounds) kept
    const relay = fireMissionWait(state, mortar, gunner, { aim: { x: 106, y: 20 }, targetTeamId: 7 });
    expect(relay).toBeGreaterThanOrEqual(1);
    expect(relay).toBeLessThanOrEqual(2);
    expect(cw.mission!.rounds).toBe(2);
    // a different point far away: a whole new mission
    cw.firePhase = 'ready'; cw.mission!.timer = 0;
    const far = { x: 106 + MISSION_NEW_AIM_M / TILE_M + 2, y: 20 };
    expect(fireMissionWait(state, mortar, gunner, { aim: far, targetTeamId: null })).toBeGreaterThan(8);
    expect(cw.mission!.rounds).toBe(0);
  });
});
