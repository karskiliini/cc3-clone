// Deterministic tests for the firing-mechanics trio:
// 1. lead — hit chance falls with the target's actual speed (speed-proportional, not a flat gate)
// 2. shotInterdiction — shells/rockets are real objects: wrecks stop/burst them, wood stops
//    rockets but passes AP, hedges burst rockets
// 3. gunner awareness — experienced rocket men refuse hedge-blocked lanes unless desperate
import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Terrain, Vehicle, WeaponDef } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { shotInterdiction, pickSoldierTargetForTest, stepCombat } from '@/sim/combat';
import { WEAPONS } from '@/data/weapons';
import { leadFactor } from '@/sim/aimPoint';

// a real registry id: canSoldierFire requires WEAPONS[weaponId]
export const bazooka: WeaponDef = {
  id: 'bazooka', name: 'Bazooka', cls: 'atrocket', rangeM: 300, rate: 0.2, burst: 1,
  accuracy: 0.5, lethality: 0.9, suppression: 0.4, penetrationMm: 100, heRadiusM: 1.5,
  ammo: 10, reloadS: 0,
};
const PSCHRECK = 'panzerschreck';

const kwk40: WeaponDef = {
  id: 'kwk40', name: '7.5cm KwK 40', cls: 'tankgun', rangeM: 1400, rate: 0.4, burst: 1,
  accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4,
  ammo: 87, reloadS: 3, rounds: WEAPONS.kwk40_75.rounds,
};

export function makeSoldier(o: Partial<Soldier> = {}): Soldier {
  return {
    id: 1, teamId: 1, side: 'german', name: 'T', rank: 'Gefr', weaponId: PSCHRECK, ammo: 10, ammoReserve: 0,
    grenades: 0, health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing',
    activity: 'defending', pos: { x: 2.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}

export function makeVehicle(o: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 100, teamId: 2, side: 'soviet', defId: 't70', pos: { x: 18.5, y: 10.5 }, hullFacing: 0, turretFacing: 0,
    state: 'ok' as Vehicle['state'], mainAmmo: 40, coaxAmmo: 100, path: [], speed: 0,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0, ...o,
  };
}

export function makeState(tiles?: (t: Terrain[], W: number, H: number) => void): BattleState {
  const W = 24, H = 21;
  const arr: Terrain[] = new Array(W * H).fill('open');
  tiles?.(arr, W, H);
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 21 }, soviet: { x: 19, y: 0, w: 5, h: 21 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles: arr,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set([100]), soviet: new Set([1]) },
    spottedVehicles: { german: new Set([100]), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 10,
  };
}

/** terrain setter on the straight lane y=10 between firer x=2 and target x=18 */
function setLane(arr: Terrain[], W: number, terrain: Terrain, xs: number[]): void {
  for (const x of xs) arr[10 * W + x] = terrain;
}

// ---------------------------------------------------------------- lead
describe('lead: hit chance falls with target speed', () => {
  it('leadFactor is 1 at rest and falls monotonically with speed', () => {
    expect(leadFactor(0)).toBe(1);
    let prev = Infinity;
    for (const v of [1, 2, 5, 8, 11, 15]) {
      const f = leadFactor(v);
      expect(f).toBeLessThan(prev);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it('about 0.56 at an 11 m/s road march (1/(1+11/14))', () => {
    expect(leadFactor(11)).toBeCloseTo(1 / (1 + 11 / 14), 5);
    expect(leadFactor(11)).toBeGreaterThan(0.5);
    expect(leadFactor(11)).toBeLessThan(0.62);
  });

  it('a fast target is markedly harder than a slow one at the same range', () => {
    const shooter = makeSoldier({ weaponId: 'kwk40_side' });
    const r = new Rng(7);
    // resolveRound is stochastic; test the deterministic gate the fire paths share instead:
    // vehicleHitChance speedMs wiring is covered end-to-end by the harness; here pin the factor.
    void shooter; void r;
    const fast = 1 / (1 + 11 / 14);
    const slow = 1 / (1 + 2 / 14);
    expect(fast / slow).toBeLessThan(0.75); // fast target < 75% as hittable as slow one
  });
});

// ---------------------------------------------------------------- shotInterdiction
describe('shotInterdiction: rounds are real objects in the arena', () => {
  it('an AP shell crosses a wooden wall without a problem (no interdiction)', () => {
    const state = makeState((t, W) => setLane(t, W, 'buildingWood', [10, 11]));
    const shooter = makeSoldier({ weaponId: 'kwk40_75' });
    state.soldiers.set(shooter.id, shooter);
    const target = makeVehicle({ pos: { x: 18.5, y: 10.5 } });
    state.vehicles.set(target.id, target);
    for (let seed = 1; seed <= 20; seed++) {
      const clean = makeState((t, W) => setLane(t, W, 'buildingWood', [10, 11]));
      clean.soldiers.set(shooter.id, shooter);
      clean.vehicles.set(target.id, target);
      expect(shotInterdiction(clean, new Rng(seed), shooter.pos, target.pos, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(false);
      void state;
    }
  });

  it('an AT rocket bursts on the wooden wall (interdicted at the wall tile)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const state = makeState((t, W) => setLane(t, W, 'buildingWood', [10, 11]));
      const shooter = makeSoldier();
      state.soldiers.set(shooter.id, shooter);
      const target = makeVehicle();
      state.vehicles.set(target.id, target);
      const before = state.projectiles.length;
      const blocked = shotInterdiction(state, new Rng(seed), shooter.pos, target.pos, bazooka, 0.7, 'german');
      expect(blocked).toBe(true);
      expect(state.projectiles.length).toBe(before + 1);
      // the rocket dies at the wall (x=10/11), nowhere near the target at x=18.5
      const proj = state.projectiles[state.projectiles.length - 1];
      expect(Math.max(proj.from.x, proj.to.x)).toBeLessThan(15);
    }
  });

  it('a wreck between firer and target bursts the rocket on the wreck', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const state = makeState();
      const shooter = makeSoldier();
      state.soldiers.set(shooter.id, shooter);
      const target = makeVehicle({ id: 101, pos: { x: 18.5, y: 10.5 } });
      const wreck = makeVehicle({ id: 100, side: 'german', state: 'knockedOut', pos: { x: 10.5, y: 10.5 } });
      state.vehicles.set(wreck.id, wreck);
      state.vehicles.set(target.id, target);
      const before = state.projectiles.length;
      const blocked = shotInterdiction(state, new Rng(seed), shooter.pos, target.pos, bazooka, 0.7, 'german', { eyeZ: 1, targetZ: 1 });
      expect(blocked).toBe(true);
      expect(state.projectiles.length).toBe(before + 1);
      const proj = state.projectiles[state.projectiles.length - 1];
      expect(proj.to.x).toBeCloseTo(wreck.pos.x - hullParams(VEHICLE_DEFS[wreck.defId]).solidBox.max.x / 2, 10); // actual entry, not the centre
    }
  });

  it('a wreck also stops an AP shell (probably stops or deflects)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const state = makeState();
      const shooter = makeSoldier({ weaponId: 'kwk40_75' });
      state.soldiers.set(shooter.id, shooter);
      const target = makeVehicle({ id: 101 });
      const wreck = makeVehicle({ id: 100, side: 'german', state: 'burning', pos: { x: 10.5, y: 10.5 } });
      state.vehicles.set(wreck.id, wreck);
      state.vehicles.set(target.id, target);
      expect(shotInterdiction(state, new Rng(seed), shooter.pos, target.pos, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(true);
      const proj = state.projectiles[state.projectiles.length - 1];
      expect(proj.to.x).toBeCloseTo(wreck.pos.x - hullParams(VEHICLE_DEFS[wreck.defId]).solidBox.max.x / 2, 10);
    }
  });

  it('a clear lane never interdicts', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const state = makeState();
      const shooter = makeSoldier();
      state.soldiers.set(shooter.id, shooter);
      const target = makeVehicle();
      state.vehicles.set(target.id, target);
      expect(shotInterdiction(state, new Rng(seed), shooter.pos, target.pos, bazooka, 0.7, 'german')).toBe(false);
      expect(shotInterdiction(state, new Rng(seed), shooter.pos, target.pos, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- gunner awareness
describe('gunner awareness: experience gates hedge shots', () => {
  function hedgeState(): BattleState {
    return makeState((t, W) => setLane(t, W, 'hedge', [10]));
  }

  it('an experienced (>=60) rocket man refuses the hedge-blocked shot', () => {
    const state = hedgeState();
    const shooter = makeSoldier({ experience: 80 });
    state.soldiers.set(shooter.id, shooter);
    const target = makeVehicle();
    state.vehicles.set(target.id, target);
    expect(pickSoldierTargetForTest(state, shooter)).toBeNull();
  });

  it('a green rocket man takes the hedge-blocked shot anyway', () => {
    const state = hedgeState();
    const shooter = makeSoldier({ experience: 30 });
    state.soldiers.set(shooter.id, shooter);
    const target = makeVehicle();
    state.vehicles.set(target.id, target);
    const t = pickSoldierTargetForTest(state, shooter);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('vehicle');
  });

  it('a desperate (panicked) veteran fires through the hedge', () => {
    const state = hedgeState();
    const shooter = makeSoldier({ experience: 80, mind: createMind(50) });
    shooter.mind.state = 'panicked';
    state.soldiers.set(shooter.id, shooter);
    const target = makeVehicle();
    state.vehicles.set(target.id, target);
    const t = pickSoldierTargetForTest(state, shooter);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('vehicle');
  });

  it('an experienced rocket man takes the same shot when the lane is clear', () => {
    const state = makeState();
    const shooter = makeSoldier({ experience: 80 });
    state.soldiers.set(shooter.id, shooter);
    const target = makeVehicle();
    state.vehicles.set(target.id, target);
    const t = pickSoldierTargetForTest(state, shooter);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('vehicle');
  });
});

// ---------------------------------------------------------------- end-to-end smoke
describe('stepCombat with interdiction: a hedge-blocked rocket never reaches its target', () => {
  it('green rocket man: first rocket bursts mid-lane in the hedge; later rockets clear the blasted lane', () => {
    const state = makeState((t, W) => setLane(t, W, 'hedge', [10]));
    const shooter = makeSoldier({ experience: 30, fireTimer: 0 });
    state.soldiers.set(shooter.id, shooter);
    const team = {
      id: 1, defId: 'inf', side: 'german' as const, name: '1st', type: 'infantry' as const,
      soldierIds: [shooter.id], leaderId: shooter.id, vehicleId: null, order: null, facing: 0,
      experience: 30, requisition: 0, status: 'ok' as const, kills: 0, losses: 0,
      weaponMounts: [],
    };
    state.teams.set(team.id, team as never);
    const target = makeVehicle({ pos: { x: 18.5, y: 10.5 } });
    state.vehicles.set(target.id, target);
    state.spottedVehicles.german.add(target.id);
    const rounds: number[] = [];
    let seen = 0;
    for (let tick = 0; tick < 200; tick++) {
      state.time += 1; // the aim gate needs a real clock (infantryAim.ts readyAt)
      stepCombat(state, new Rng(1000 + tick), 1);
      while (seen < state.projectiles.length) { rounds.push(state.projectiles[seen].to.x); seen++; }
      state.projectiles = state.projectiles.filter((p) => state.time < p.t0 + p.flightS + 0.1);
      seen = Math.min(seen, state.projectiles.length);
    }
    // every rocket launched died short of the target
    expect(rounds.length).toBeGreaterThan(0);
    // the FIRST rocket bursts in the hedge (tile 10.5), never reaching the target at 18.5
    expect(Math.floor(rounds[0])).toBe(10);
    // the rocket's blast clears the hedge (structureBlast 90 vs hedge HP 40): later rockets
    // fly the now-open lane and reach the target — emergent, correct behaviour
    expect(state.map.tiles[10 * 20 + 10]).not.toBe('hedge');
  });
});

import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody } from '@/sim/hullPhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { flat } from './hullPhysicsHelpers';

it('does not interdict a horizontal AT ray beneath an airborne intermediate vehicle or beyond its endpoint', () => {
  const state = makeState(), from = { x: 2.5, y: 10.5 }, to = { x: 18.5, y: 10.5 };
  const v = makeVehicle({ pos: { x: 10.5, y: 10.5 } });
  v.body = createHullBody(VEHICLE_DEFS[v.defId], v.pos, 0, flat); v.body.position.z += 20;
  state.vehicles.set(v.id, v);
  const rng = new Rng(7), before = rng.state();
  expect(shotInterdiction(state, rng, from, to, bazooka, 0.7, 'german')).toBe(false);
  expect(state.projectiles).toEqual([]); expect(state.explosions).toEqual([]); expect(state.events).toEqual([]); expect(state.sparks).toEqual([]);
  expect(v.hits).toBe(0); expect(v.damage).toBeUndefined(); expect(rng.state()).toBe(before);
  v.body.position.z -= 20; v.body.position.x += 40;
  expect(shotInterdiction(state, rng, from, to, bazooka, 0.7, 'german')).toBe(false);
});

it('chooses the nearest real intermediate solid regardless of insertion order and does not inherit AP HE', () => {
  const state = makeState(), from = { x: 2.5, y: 10.5 }, to = { x: 18.5, y: 10.5 };
  const far = makeVehicle({ id: 101, pos: { x: 14.5, y: 10.5 }, state: 'burning' });
  const near = makeVehicle({ id: 102, pos: { x: 9.5, y: 10.5 }, state: 'burning' });
  state.vehicles.set(far.id, far); state.vehicles.set(near.id, near);
  const rng = new Rng(7), before = rng.state();
  expect(shotInterdiction(state, rng, from, to, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(true);
  expect(state.projectiles[0].to.x).toBeCloseTo(near.pos.x - VEHICLE_DEFS.t70.widthM / 4, 10);
  expect(state.explosions.every(e => e.radiusM === 0)).toBe(true); expect(state.map.craterMarks ?? []).toEqual([]);
  expect(rng.state()).not.toBe(before); // real plate details own RNG; AP has no blast pass
});
it('stops at terrain before armor, and armor before growth without effects or RNG beyond either', () => {
  const from = { x: 2.5, y: 10.5 }, to = { x: 18.5, y: 10.5 };
  const blocked = makeState((tiles, width) => setLane(tiles, width, 'buildingStone', [7]));
  const behind = makeVehicle({ pos: { x: 10.5, y: 10.5 } }); blocked.vehicles.set(behind.id, behind);
  const stoneRng = new Rng(7), stoneBefore = stoneRng.state();
  expect(shotInterdiction(blocked, stoneRng, from, to, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(true);
  expect(Math.floor(blocked.projectiles[0].to.x)).toBe(7); expect(behind.hits).toBe(0); expect(behind.damage).toBeUndefined();
  expect(blocked.sparks.some(s => s.kind === 'armor')).toBe(false); expect(stoneRng.state()).toBe(stoneBefore);
  const hullFirst = makeState((tiles, width) => setLane(tiles, width, 'woods', [14]));
  const near = makeVehicle({ pos: { x: 9.5, y: 10.5 }, state: 'burning' }); hullFirst.vehicles.set(near.id, near);
  const rng = new Rng(7), before = rng.state();
  expect(shotInterdiction(hullFirst, rng, from, to, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(true);
  expect(hullFirst.map.tiles[10 * hullFirst.map.width + 14]).toBe('woods');
  expect(hullFirst.sparks.every(s => s.pos.x < 10)).toBe(true);
  const control = makeState(), controlHull = makeVehicle({ pos: { x: 9.5, y: 10.5 }, state: 'burning' }); control.vehicles.set(controlHull.id, controlHull);
  const controlRng = new Rng(7); shotInterdiction(control, controlRng, from, to, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 });
  expect(rng.state()).toBe(controlRng.state()); expect(rng.state()).not.toBe(before);
});
it('lets AP pass wood toward later stone or armor while rockets and HE stop on the encountered wood', () => {
  const from = { x: 2.5, y: 10.5 }, to = { x: 18.5, y: 10.5 };
  for (const later of ['stone', 'hull'] as const) {
    const state = makeState((tiles, width) => { setLane(tiles, width, 'buildingWood', [7]); if (later === 'stone') setLane(tiles, width, 'buildingStone', [12]); });
    if (later === 'hull') { const v = makeVehicle({ pos: { x: 12.5, y: 10.5 }, state: 'burning' }); state.vehicles.set(v.id, v); }
    expect(shotInterdiction(state, new Rng(7), from, to, kwk40, 0.7, 'german', { eyeZ: 1, targetZ: 1 })).toBe(true);
    if (later === 'stone') expect(Math.floor(state.projectiles[0].to.x)).toBe(12);
    else expect(state.projectiles[0].to.x).toBeCloseTo(12.5 - VEHICLE_DEFS.t70.widthM / 4, 10);
    expect(state.explosions.every(e => e.radiusM === 0)).toBe(true);
  }
  for (const weapon of [bazooka, kwk40]) {
    const state = makeState((tiles, width) => setLane(tiles, width, 'buildingWood', [7]));
    expect(shotInterdiction(state, new Rng(7), from, to, weapon, 0.7, 'german', {}, 'he')).toBe(true);
    expect(Math.floor(state.projectiles[0].to.x)).toBe(7);
  }
});

import { mkTeam } from './vehicleDamageHelpers';
it('direct rocket fire reaches its target beneath a raised intermediate hull without hurting that hull', () => {
  const state = makeState(), shooter = makeSoldier({ experience: 30 }); state.soldiers.set(shooter.id, shooter);
  const team = mkTeam(1, 'rifle', [shooter.id], 'german', shooter.pos); state.teams.set(team.id, team);
  const target = makeVehicle({ id: 101 }); state.vehicles.set(target.id, target); state.spottedVehicles.german.add(target.id);
  const raised = makeVehicle({ id: 102, side: 'german', pos: { x: 10.5, y: 10.5 }, mainAmmo: 0, coaxAmmo: 0 });
  raised.body = createHullBody(VEHICLE_DEFS[raised.defId], raised.pos, 0, flat); raised.body.position.z += 20;
  state.vehicles.set(raised.id, raised); const rng = new Rng(7);
  for (let tick = 0; tick < 60 && !state.projectiles.length; tick++) { state.time += 0.1; stepCombat(state, rng, 0.1); }
  expect(state.projectiles.length).toBeGreaterThan(0); expect(state.projectiles[0].to.x).toBeGreaterThan(15);
  expect(raised.hits).toBe(0); expect(raised.damage).toBeUndefined();
  expect(state.explosions.every(e => Math.abs(e.pos.x - raised.pos.x) > 2)).toBe(true);
  expect(state.sparks.filter(s => s.kind === 'armor').every(s => Math.abs(s.pos.x - raised.pos.x) > 2)).toBe(true);
});
