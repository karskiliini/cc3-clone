import { hullParams } from '@/data/vehiclePhysics';
import { getHeightField, setTileProfile } from '@/sim/heightField';
import { expect, it, vi } from 'vitest';
import * as hullPhysics from '@/sim/hullPhysics';
import { groundProbe } from '@/sim/hullGround';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';
import { beginHullDrive, requestHullDrive, takeHullDrive } from '@/sim/hullDrive';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { wrapAngle } from '@/shared/math';
import { FROZEN_TURRET_HULL_LAY, hullTurnNow, isVehicleReversing, onVehicleNearMiss, placeVehicleBody, stepVehicleCollisions, stepVehicles, vehicleBlockingAt } from '@/sim/vehicle';
import { ensureDamage, trackPullRad } from '@/sim/vehicleDamage';
import { MINE_AT, MINE_NONE, mineAt, setMineAt } from '@/sim/mines';

it('merges requests without moving the actual hull and resets each tick', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 10, y: 10 });
  const before = { ...v.pos };
  beginHullDrive(v);
  requestHullDrive(v, { speedMs: 2, brake: false });
  requestHullDrive(v, { yawRateRadS: 0.2 });
  expect(takeHullDrive(v)).toEqual({ speedMs: 2, yawRateRadS: 0.2, brake: false });
  expect(v.pos).toEqual(before);
  expect(v.hullFacing).toBe(0);
  beginHullDrive(v);
  expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
});

it('records forward and reverse path speeds in metres per second', () => {
  for (const backing of [false, true]) {
    const state = makeState(), { v, team } = addTank(state, 't34_76', { x: 20, y: 20 });
    const target = { x: 20, y: backing ? 30 : 10 };
    team.order = { type: 'move', target, issuedAt: 0 };
    v.path = [target];
    const before = { ...v.pos };
    stepVehicles(state, new Rng(1), SIM_DT);
    const drive = takeHullDrive(v);
    expect(Math.abs(v.speed)).toBeGreaterThan(0);
    expect(Math.abs(v.speed)).toBeLessThan(Math.abs(drive.speedMs));
    expect(drive.brake).toBe(false);
    expect(backing ? drive.speedMs < 0 : drive.speedMs > 0).toBe(true);
    expect(Math.sign(before.y - v.pos.y)).toBe(Math.sign(drive.speedMs));
    expect(Math.abs((before.y - v.pos.y) * TILE_M)).toBeLessThan(Math.abs(drive.speedMs * SIM_DT));
  }
});

it('combines steering and damaged-track pull without losing speed', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  ensureDamage(v).trackL = 'damaged';
  v.path = [{ x: 20.5, y: 10 }];
  const rate = hullTurnNow(state, v, VEHICLE_DEFS[v.defId]).rate;
  const pull = trackPullRad(v);
  stepVehicles(state, new Rng(1), SIM_DT);
  const drive = takeHullDrive(v);
  // A damaged left track requires the long left turn to reach a bearing to the right.
  expect(drive.yawRateRadS).toBeCloseTo(-rate + pull, 12);
  expect(v.speed).toBeGreaterThan(0);
  expect(v.speed).toBeLessThan(drive.speedMs);
  expect(drive.speedMs).toBeGreaterThan(0);
  expect(Math.sign(v.hullFacing)).toBe(Math.sign(drive.yawRateRadS));
  expect(Math.abs(v.hullFacing)).toBeLessThan(Math.abs(drive.yawRateRadS * SIM_DT));
  expect(drive.brake).toBe(false);
});

it('requests creep and give-way through their early-return branches', () => {
  for (const branch of ['creep', 'giveWay']) {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    if (branch === 'creep') { v.creepForGun = true; v.creepAim = { x: 20, y: 10 }; }
    else { v.path = [{ x: 20, y: 10 }]; v.giveWayUntil = 1; }
    const y = v.pos.y;
    stepVehicles(state, new Rng(1), SIM_DT);
    const drive = takeHullDrive(v);
    expect(Math.abs(v.speed)).toBeGreaterThan(0);
    expect(Math.abs(v.speed)).toBeLessThan(Math.abs(drive.speedMs));
    expect(branch === 'creep' ? drive.speedMs > 0 : drive.speedMs < 0).toBe(true);
    expect(Math.sign(y - v.pos.y)).toBe(Math.sign(drive.speedMs));
    expect(Math.abs((y - v.pos.y) * TILE_M)).toBeLessThan(Math.abs(drive.speedMs * SIM_DT));
    expect(drive.brake).toBe(false);
  }
});

it('keeps standing frozen-turret and combat hull assist as active yaw requests', () => {
  for (const frozen of [false, true]) {
    const state = makeState(), { v } = addTank(state, 'tiger', { x: 20, y: 20 });
    v.targetPoint = { x: 30, y: 20 };
    if (frozen) ensureDamage(v).traverse = 'destroyed';
    else v.gunLay = { key: 'p', aim: { ...v.targetPoint }, designateLeftS: 0, fineLeftS: 1, totalS: 1 };
    const rate = hullTurnNow(state, v, VEHICLE_DEFS[v.defId]).rate;
    stepVehicles(state, new Rng(1), SIM_DT);
    const drive = takeHullDrive(v);
    expect(drive.speedMs).toBe(0);
    expect(drive.yawRateRadS).toBeCloseTo(rate * (frozen ? FROZEN_TURRET_HULL_LAY : 1), 12);
    expect(drive.brake).toBe(false); // braking the solver would suppress this stationary pivot
    expect(Math.sign(v.hullFacing)).toBe(Math.sign(drive.yawRateRadS));
    expect(Math.abs(v.hullFacing)).toBeLessThan(Math.abs(drive.yawRateRadS * SIM_DT));
    if (frozen) expect(wrapAngle(v.turretFacing - v.hullFacing)).toBe(0);
  }
});

it('starts every vehicle fresh before cover minds and retains their reverse request', () => {
  const state = makeState();
  const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
  const { v: dead } = addTank(state, 't34_76', { x: 20, y: 20 });
  dead.state = 'knockedOut';
  state.map.tiles[199 * state.map.width + 201] = 'buildingStone';
  for (let y = 200; y <= 203; y++) state.map.tiles[y * state.map.width + 201] = 'water';
  onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 204.5, y: 184.5 });
  const rng = new Rng(9);
  let reversed = false;
  for (let tick = 0; tick < 80 && !reversed; tick++) {
    requestHullDrive(v, { speedMs: 99, yawRateRadS: 88, brake: false });
    requestHullDrive(dead, { speedMs: 99, yawRateRadS: 88, brake: false });
    state.time += SIM_DT;
    stepVehicles(state, rng, SIM_DT);
    expect(takeHullDrive(dead)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
    const drive = takeHullDrive(v);
    expect(Math.abs(drive.yawRateRadS)).toBeLessThanOrEqual(VEHICLE_DEFS.pz4gh.hullTurnDegS! * Math.PI / 180 + 1e-12);
    if (v.speed < 0) {
      expect(Math.abs(v.speed)).toBeGreaterThan(0);
      expect(Math.abs(v.speed)).toBeLessThan(Math.abs(drive.speedMs));
      expect(drive.brake).toBe(false);
      reversed = true;
    }
  }
  expect(reversed).toBe(true);
});

it('clears the preceding drive request on a fire-halt early return', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  v.path = [{ x: 20, y: 10 }];
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(takeHullDrive(v).speedMs).toBeGreaterThan(0);
  const before = { ...v.pos }, speed = v.speed;
  v.fireHaltUntil = 1;
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
  expect(v.speed).toBeGreaterThan(0);
  expect(v.speed).toBeLessThan(speed);
  expect(before.y - v.pos.y).toBeLessThan(speed * SIM_DT / TILE_M);
});

it('crushes accepted tiles, runs over the accepted sweep, then rolls its fractional mine tile once', () => {
  const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 20.5, y: 22.1 });
  v.path = [{ x: 20, y: 20 }];
  state.map.tiles[22 * state.map.width + 20] = 'fence';
  setMineAt(state.map, 20, 21, MINE_AT);
  const enemy = soldier(20, 21, 'soviet', { x: 20.5, y: 21 }, 'mosin', { stance: 'prone' });
  state.soldiers.set(enemy.id, enemy);
  state.teams.set(21, mkTeam(21, 'rifle', [20], 'soviet', enemy.pos));
  const rng = new Rng(1), expectedRng = new Rng(1);
  const chance = rng.chance.bind(rng);
  let mineRolls = 0;
  rng.chance = (probability) => {
    expect(probability).toBe(0.8);
    // The mine's random draw follows crushing and overrun at the accepted position.
    expect(state.map.tiles[22 * state.map.width + 20]).toBe('open');
    expect(enemy.health).toBe('dead');
    expect(Math.floor(v.pos.y)).toBe(21);
    mineRolls++;
    return chance(probability);
  };
  for (let i = 0; i < 20 && mineRolls === 0; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
  expectedRng.next();
  expect(mineRolls).toBe(1);
  expect(rng.state()).toBe(expectedRng.state());
  expect(mineAt(state.map, 20, 21)).toBe(MINE_NONE);
  expect(v.state).toBe('immobilized');
  expect(state.events.filter((event) => event.kind === 'kill')).toHaveLength(1);
});

// Task 5B: authoritative-body assertions precede backend activation.
it('derives public position and speed from one physical tick, including passengers', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  v.path = [{ x: 20, y: 10 }];
  const rider = soldier(99, 98, 'german', v.pos, 'kar98k'); rider.vehicleId = v.id;
  state.soldiers.set(rider.id, rider); state.teams.set(98, mkTeam(98, 'rifle', [99], 'german', v.pos));
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(v.body).toBeDefined();
  expect(v.pos).toEqual({ x: v.body!.position.x / TILE_M, y: v.body!.position.y / TILE_M });
  expect(v.speed).toBeCloseTo(-v.body!.velocity.y, 12);
  expect(20 - v.pos.y).toBeGreaterThan(0);
  expect((20 - v.pos.y) * TILE_M).toBeLessThan(takeHullDrive(v).speedMs * SIM_DT);
  expect(rider.pos).toEqual(v.pos); expect(state.teams.get(98)!.pos).toEqual(v.pos);
});

it('settles wrecks and abandoned hulls despite driver early returns', () => {
  for (const kind of ['knockedOut', 'abandoned', 'burning', 'immobilized'] as const) {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.state = kind;
    stepVehicles(state, new Rng(1), SIM_DT);
    expect(v.body).toBeDefined();
    v.body!.position.z += 2; v.body!.asleep = false;
    const z = v.body!.position.z;
    stepVehicles(state, new Rng(1), SIM_DT);
    expect(v.body!.position.z).toBeLessThan(z);
    expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
  }
});

it('steps every valid body exactly once per tick, including reverse cover and dead hulls', () => {
  const state = makeState();
  for (const kind of ['ok', 'knockedOut', 'abandoned', 'burning', 'immobilized'] as const) {
    const { v } = addTank(state, 't34_76', { x: 20 + state.vehicles.size * 10, y: 20 });
    v.state = kind; v.path = [{ x: v.pos.x, y: 10 }];
  }
  const spy = vi.spyOn(hullPhysics, 'stepHullBody');
  try {
    stepVehicles(state, new Rng(1), SIM_DT);
    expect(spy).toHaveBeenCalledTimes(state.vehicles.size);
    expect(new Set(spy.mock.calls.map(call => call[0])).size).toBe(state.vehicles.size);
  } finally { spy.mockRestore(); }
});

it('stops large physical candidates at building boundaries and keeps remote mines untouched', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 20.00000001 });
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -100; v.path = [{ x: 20.5, y: 10 }];
  state.map.tiles[19 * state.map.width + 20] = 'buildingStone';
  setMineAt(state.map, 20, 18, MINE_AT);
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(v.pos.y).toBeGreaterThanOrEqual(20);
  expect(v.body!.velocity.y).toBe(0);
  expect(mineAt(state.map, 20, 18)).toBe(MINE_AT);
  expect(v.state).toBe('ok');
});

it('sequential accepted movement prevents head-on hull crossing at high speed', () => {
  const state = makeState();
  const { v: a } = addTank(state, 't34_76', { x: 20, y: 20 });
  const { v: b } = addTank(state, 't34_76', { x: 20, y: 25 }, Math.PI);
  for (const v of [a, b]) placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, v.hullFacing, groundProbe(state.map));
  a.body!.velocity.y = 100; b.body!.velocity.y = -100;
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(a.pos.y).toBeLessThan(b.pos.y);
  expect((b.pos.y - a.pos.y) * TILE_M).toBeGreaterThan(VEHICLE_DEFS.t34_76.lengthM);
});

it('overrun eligibility covers the accepted path while drawing once per soldier', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 30.5 });
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -120; v.path = [{ x: 20.5, y: 10.5 }];
  const enemy = soldier(99, 98, 'german', { x: 20.5, y: 27.5 }, 'mosin');
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'german', enemy.pos));
  const rng = new Rng(1); let draws = 0;
  rng.chance = () => { if (v.pos.y < 26) draws++; return false; };
  stepVehicles(state, rng, SIM_DT);
  expect(v.pos.y).toBeLessThan(26);
  expect(enemy.health).toBe('dead');
  expect(draws).toBe(1);
});

it('retains fast accepted overrun segments when a later building stop leaves low final speed', () => {
  for (const stance of ['prone', 'crouching'] as const) {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 30.5 });
    placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
    v.body!.velocity.y = -120; v.path = [{ x: 20.5, y: 10.5 }];
    state.map.tiles[25 * state.map.width + 20] = 'buildingStone';
    const enemy = soldier(99, 98, 'german', { x: 20.5, y: 27.5 }, 'mosin', { stance });
    state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'german', enemy.pos));
    const rng = new Rng(1); let draws = 0, lookaheadDraws = 0;
    rng.chance = () => { if (v.pos.y < 27) draws++; else lookaheadDraws++; return false; };
    stepVehicles(state, rng, SIM_DT);
    expect(v.pos.y).toBeGreaterThanOrEqual(26); expect(v.pos.y).toBeLessThan(27);
    expect(Math.abs(v.speed)).toBeLessThan(0.5);
    expect(enemy.health).toBe('dead');
    expect(draws).toBe(stance === 'prone' ? 0 : 1);
    expect(lookaheadDraws).toBe(stance === 'prone' ? 0 : 1);
    expect(state.events.filter(event => event.kind === 'kill')).toHaveLength(1);
  }
});

it('keeps ordinary tracked overrun and one real mine roll while coasting through a route pivot', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 22.2 });
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -10; v.path = [{ x: 30.5, y: 22.2 }];
  setMineAt(state.map, 20, 21, MINE_AT);
  const enemy = soldier(99, 98, 'german', { x: 20.5, y: 21.9 }, 'mosin', { stance: 'prone' });
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'german', enemy.pos));
  const rng = new Rng(1), expectedRng = new Rng(1), chance = rng.chance.bind(rng);
  let draws = 0;
  rng.chance = probability => {
    expect(probability).toBe(0.8); expect(enemy.health).toBe('dead');
    draws++; return chance(probability);
  };
  stepVehicles(state, rng, SIM_DT);
  expect(takeHullDrive(v).speedMs).toBe(0); expect(takeHullDrive(v).yawRateRadS).toBeGreaterThan(0);
  expect(v.pos.y).toBeLessThan(22); expect(v.speed).toBeGreaterThan(0.5);
  expect(enemy.health).toBe('dead'); expect(mineAt(state.map, 20, 21)).toBe(MINE_NONE);
  expect(draws).toBe(1); expectedRng.next(); expect(rng.state()).toBe(expectedRng.state());
  expect(state.events.filter(event => event.kind === 'kill')).toHaveLength(1);
});

it('keeps cover-pivot overrun while retaining the cover branch mine policy', () => {
  const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, Math.PI, 60);
  state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, Math.PI, groundProbe(state.map));
  v.body!.velocity.y = 10;
  setMineAt(state.map, 200, 200, MINE_AT);
  const enemy = soldier(99, 98, 'soviet', { x: 200.5, y: 200.8 }, 'mosin', { stance: 'prone' });
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'soviet', enemy.pos));
  onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 200.5, y: 192.5 });
  const rng = new Rng(3); let draws = 0; rng.chance = () => { draws++; return false; };
  stepVehicles(state, rng, SIM_DT);
  expect(isVehicleReversing(state, v)).toBe(true);
  expect(takeHullDrive(v).speedMs).toBe(0); expect(Math.abs(takeHullDrive(v).yawRateRadS)).toBeGreaterThan(0);
  expect(v.pos.y).toBeGreaterThan(200.5); expect(v.speed).toBeGreaterThan(0.5);
  expect(enemy.health).toBe('dead'); expect(draws).toBe(0);
  expect(mineAt(state.map, 200, 200)).toBe(MINE_AT);
});

it('keeps the active cover braking profile without ordinary mine checks while coasting over a soldier', () => {
  const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
  for (let x = 200; x <= 201; x++) state.map.tiles[204 * state.map.width + x] = 'buildingStone';
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = 10; v.holdUntil = 0.5;
  setMineAt(state.map, 200, 200, MINE_AT);
  const friend = soldier(97, 96, v.side, { ...v.pos }, 'kar98k');
  const enemy = soldier(99, 98, 'soviet', { x: 200.5, y: 200.8 }, 'mosin');
  state.soldiers.set(friend.id, friend); state.teams.set(96, mkTeam(96, 'rifle', [97], v.side, friend.pos));
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'soviet', enemy.pos));
  onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 200.5, y: 192.5 });
  const rng = new Rng(3), probabilities: number[] = [];
  rng.chance = probability => { probabilities.push(probability); return false; };
  stepVehicles(state, rng, SIM_DT);
  expect(isVehicleReversing(state, v)).toBe(true); expect(takeHullDrive(v).speedMs).toBe(0);
  expect(v.holdUntil).toBeGreaterThan(state.time); expect(v.pos.y).toBeGreaterThan(200.5);
  expect(Math.abs(v.speed)).toBeGreaterThan(0.5); expect(enemy.health).toBe('dead');
  expect(friend.health).toBe('healthy'); expect(probabilities).toEqual([0.85]);
  expect(mineAt(state.map, 200, 200)).toBe(MINE_AT);
  expect(state.events.filter(event => event.kind === 'kill')).toHaveLength(1);
});

it('keeps wheeled completion overrun before crushing and retains its mine policy while braking', () => {
  const state = makeState(), { v } = addTank(state, 'sdkfz251', { x: 20.5, y: 22.2 });
  v.path = [{ x: 20.5, y: 22.1 }];
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -10;
  state.map.tiles[22 * state.map.width + 20] = 'fence';
  setTileProfile(getHeightField(state.map), 20, 22, 0);
  setMineAt(state.map, 20, 21, MINE_AT);
  const enemy = soldier(99, 98, 'soviet', { x: 20.5, y: 21.9 }, 'mosin');
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'soviet', enemy.pos));
  const rng = new Rng(1); let draws = 0, lookaheadDraws = 0;
  rng.chance = () => {
    expect(state.map.tiles[22 * state.map.width + 20]).toBe('fence');
    if (v.pos.y < 22) draws++; else lookaheadDraws++;
    return false;
  };
  stepVehicles(state, rng, SIM_DT);
  expect(v.path).toHaveLength(0); expect(takeHullDrive(v).speedMs).toBe(0);
  expect(v.pos.y).toBeLessThan(22); expect(v.speed).toBeGreaterThan(0.5);
  expect(enemy.health).toBe('dead'); expect(draws).toBe(1); expect(lookaheadDraws).toBe(1);
  expect(state.map.tiles[22 * state.map.width + 20]).toBe('open');
  expect(mineAt(state.map, 20, 21)).toBe(MINE_AT);
  expect(state.events.filter(event => event.kind === 'kill')).toHaveLength(1);
});

for (const kind of ['knockedOut', 'abandoned', 'burning'] as const) {
  it(`carries the ${kind} turret physically without actively traversing to its target`, () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.state = kind; v.targetPoint = { x: 30, y: 20 }; v.turretFacing = 0.3;
    placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
    v.body!.angularVelocity.z = 0.4;
    stepVehicles(state, new Rng(1), SIM_DT);
    expect(Math.abs(v.hullFacing)).toBeGreaterThan(0);
    expect(wrapAngle(v.turretFacing - v.hullFacing)).toBeCloseTo(0.3, 12);
  });
}

it('keeps accepted braking movement below the overrun speed threshold ineligible', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 22.2 });
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -0.3; v.fireHaltUntil = 1;
  const enemy = soldier(99, 98, 'german', { ...v.pos }, 'mosin', { stance: 'prone' });
  state.soldiers.set(enemy.id, enemy); state.teams.set(98, mkTeam(98, 'rifle', [99], 'german', enemy.pos));
  const rng = new Rng(1); let draws = 0; rng.chance = () => { draws++; return false; };
  stepVehicles(state, rng, SIM_DT);
  expect(v.pos.y).toBeLessThan(22.2); expect(Math.abs(v.speed)).toBeLessThan(0.5);
  expect(enemy.health).toBe('healthy'); expect(enemy.crushed).toBeUndefined(); expect(draws).toBe(0);
});

it('still clamps dead casemate guns to the actual final hull arc', () => {
  for (const kind of ['knockedOut', 'abandoned', 'burning'] as const) {
    const state = makeState(), { v } = addTank(state, 'stug3g', { x: 20, y: 20 });
    v.state = kind; v.targetPoint = { x: 30, y: 20 }; v.turretFacing = 0.8;
    placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
    v.body!.angularVelocity.z = 0.4;
    stepVehicles(state, new Rng(1), SIM_DT);
    expect(wrapAngle(v.turretFacing - v.hullFacing)).toBeCloseTo(VEHICLE_DEFS.stug3g.gunArcDeg! * Math.PI / 180, 12);
  }
});

it('overrides a request when burning starts after mind decisions', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  v.path = [{ x: 20, y: 10 }]; v.engineOnFire = true; v.engineFireTimer = 8;
  const rng = new Rng(1); rng.chance = () => true;
  const spy = vi.spyOn(hullPhysics, 'stepHullBody');
  try {
    stepVehicles(state, rng, SIM_DT);
    expect(v.state).toBe('burning');
    expect(spy.mock.calls[0][2]).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it('uses each actual substep origin for an already-overlapping hull', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const { v: other } = addTank(state, 't34_76', { x: 20, y: 20 });
  expect(vehicleBlockingAt(state, v, { x: 20.1, y: 20 })).toBeNull();
  expect(vehicleBlockingAt(state, v, { x: 20.1, y: 20 }, { x: 20.2, y: 20 })).toBe(other);
});

it('refreshes the ground revision just before a sleeping hull integrates', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 20.5 });
  stepVehicles(state, new Rng(1), SIM_DT);
  v.body!.asleep = true;
  const before = v.body!.position.z;
  const field = getHeightField(state.map); setTileProfile(field, 20, 20, 1);
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(v.body!.groundVersion).toBe(field.version);
  expect(v.body!.asleep).toBe(false);
  expect(v.body!.position.z).toBeGreaterThan(before);
});

it('preserves the body object and non-XY state during overlap separation', () => {
  const state = makeState(), { v: a } = addTank(state, 't34_76', { x: 20, y: 20 });
  const { v: b } = addTank(state, 't34_76', { x: 20.2, y: 20 });
  for (const v of [a, b]) placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  const body = a.body!, z = body.position.z, orientation = { ...body.orientation };
  body.velocity.x = 2; body.asleep = true;
  stepVehicleCollisions(state, new Rng(1), SIM_DT);
  expect(a.body).toBe(body); expect(body.position.x).toBeLessThan(40);
  expect(body.position.z).toBe(z); expect(body.orientation).toEqual(orientation);
  expect(body.velocity.x).toBe(0); expect(body.asleep).toBe(false);
  expect(a.pos.x).toBe(body.position.x / TILE_M);
});

it('crushes the accepted hull footprint during a yaw-only pivot and protects buildings', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 20.5 });
  state.map.tiles[19 * state.map.width + 21] = 'fence';
  state.map.tiles[19 * state.map.width + 20] = 'buildingStone';
  // Isolate accepted rotation/eligibility from the separate high-feature support test.
  const field = getHeightField(state.map);
  setTileProfile(field, 21, 19, 0); setTileProfile(field, 20, 19, 0);
  v.path = [{ x: 30.5, y: 20.5 }];
  const before = { ...v.pos };
  setMineAt(state.map, 21, 19, MINE_AT);
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(takeHullDrive(v).speedMs).toBe(0);
  expect(v.hullFacing).toBeGreaterThan(0);
  expect(v.pos).toEqual(before);
  expect(state.map.tiles[19 * state.map.width + 21]).toBe('open');
  expect(state.map.tiles[19 * state.map.width + 20]).toBe('buildingStone');
  expect(mineAt(state.map, 21, 19)).toBe(MINE_AT);
});

it('crushes an actual fence contact before its centre enters that tile', () => {
  const state = makeState(), { v } = addTank(state, 'stug3g', { x: 20.5, y: 20.5 }, Math.PI / 2);
  for (let x = 10; x < 30; x++) state.map.tiles[21 * state.map.width + x] = 'fence';
  v.path = [{ x: 20.5, y: 30.5 }];
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(Math.floor(v.pos.y)).toBe(20);
  expect(state.map.tiles[21 * state.map.width + 20]).toBe('open');
});

it('keeps ordinary tracked consequences while a live hull coasts through a short halt', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 22.2 });
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
  v.body!.velocity.y = -10; v.fireHaltUntil = 1; v.path = [{ x: 20.5, y: 10.5 }];
  setMineAt(state.map, 20, 21, MINE_AT);
  const rng = new Rng(1); let draws = 0; rng.chance = () => { draws++; return true; };
  stepVehicles(state, rng, SIM_DT);
  expect(takeHullDrive(v).speedMs).toBe(0);
  expect(v.pos.y).toBeLessThan(22);
  expect(mineAt(state.map, 20, 21)).toBe(MINE_NONE);
  expect(draws).toBe(1); expect(v.state).toBe('immobilized');
});


it('keeps a friendly hold active during cover driving after physical speed falls below overrun threshold', () => {
  const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
  // A distant screen leaves the actual held hull on flat open ground.
  for (let x = 200; x <= 201; x++) state.map.tiles[204 * state.map.width + x] = 'buildingStone';
  const friend = soldier(99, 98, v.side, { ...v.pos }, 'kar98k');
  state.soldiers.set(friend.id, friend); state.teams.set(98, mkTeam(98, 'rifle', [99], v.side, friend.pos));
  placeVehicleBody(v, VEHICLE_DEFS[v.defId], v.pos, v.hullFacing, groundProbe(state.map));
  v.body!.velocity.y = 0.2; v.holdUntil = 0.5;
  onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 200.5, y: 192.5 });
  const rng = new Rng(9);
  for (let i = 0; i < 30; i++) {
    state.time += SIM_DT; stepVehicles(state, rng, SIM_DT);
    expect(isVehicleReversing(state, v)).toBe(true);
    expect(takeHullDrive(v).speedMs).toBe(0);
    expect(friend.health).toBe('healthy'); expect(friend.crushed).toBeUndefined();
  }
  expect(Math.hypot(v.body!.velocity.x, v.body!.velocity.y)).toBeLessThan(0.005);
  friend.pos = { x: 190, y: 190 };
  state.time += SIM_DT; stepVehicles(state, rng, SIM_DT);
  expect(v.holdUntil).toBeUndefined(); expect(takeHullDrive(v).speedMs).toBeLessThan(0);
});

it('crushes eligible accepted-start terrain during standing gun-assist and frozen-turret pivots without RNG', () => {
  for (const frozen of [false, true]) {
    const state = makeState(), { v } = addTank(state, 'tiger', { x: 20.5, y: 20.5 });
    state.map.tiles[19 * state.map.width + 21] = 'fence';
    setTileProfile(getHeightField(state.map), 21, 19, 0);
    v.targetPoint = { x: 30.5, y: 20.5 };
    if (frozen) ensureDamage(v).traverse = 'destroyed';
    else v.gunLay = { key: 'p', aim: { ...v.targetPoint }, designateLeftS: 0, fineLeftS: 1, totalS: 1 };
    const rng = new Rng(1); let draws = 0;
    rng.chance = () => { draws++; return false; };
    stepVehicles(state, rng, SIM_DT);
    expect(takeHullDrive(v).speedMs).toBe(0); expect(takeHullDrive(v).yawRateRadS).toBeGreaterThan(0);
    expect(state.map.tiles[19 * state.map.width + 21]).toBe('open'); expect(draws).toBe(0);
  }
});

it('scales ordinary signed speed once by actual roll but retains the pure recovery override', () => {
  const spy = vi.spyOn(hullPhysics, 'stepHullBody').mockImplementation(() => {});
  try {
    for (const branch of ['forward', 'reverse', 'creep', 'recovery']) {
      const speeds: number[] = [];
      for (const roll of [0, 0.2]) {
        const state = makeState(), { v, team } = addTank(state, 't34_76', { x: 20, y: 20 });
        v.body = hullPhysics.createHullBody(VEHICLE_DEFS[v.defId], v.pos, 0, groundProbe(state.map));
        v.body.orientation = { x: 0, y: -Math.sin(roll / 2), z: 0, w: Math.cos(roll / 2) };
        const target = { x: 20, y: branch === 'reverse' ? 30 : 10 };
        team.order = { type: 'move', target, issuedAt: 0 }; v.path = [target];
        if (branch === 'creep') { v.creepForGun = true; v.creepAim = target; }
        if (branch === 'recovery') v.body.hungUp = true;
        stepVehicles(state, new Rng(1), SIM_DT);
        const call = spy.mock.calls.at(-1)!;
        speeds.push(call[2].speedMs);
      }
      if (branch === 'recovery') expect(speeds).toEqual([-1, -1]);
      else {
        expect(Math.abs(speeds[0])).toBeGreaterThan(0);
        const tip = hullParams(VEHICLE_DEFS.t34_76).slopeTipDeg * Math.PI / 180;
        expect(speeds[1]).toBeCloseTo(speeds[0] * (1 - 0.6 * 0.2 / tip), 12);
      }
    }
  } finally { spy.mockRestore(); }
});

it('converts exactly one private raw input while keeping desired requests and original signed speed', () => {
  const spy = vi.spyOn(hullPhysics, 'stepHullBody');
  try {
    for (const gear of [-1, 1]) for (const damage of [false, true]) {
      const state = makeState(), {v, team} = addTank(state, 'pz4gh', {x:20,y:20});
      const target = {x:20-gear*.2,y:20-gear*10}; v.path=[target]; team.order={type:'move',target,issuedAt:0};
      if(damage) ensureDamage(v).trackL='damaged';
      spy.mockClear(); stepVehicles(state,new Rng(3),SIM_DT);
      expect(spy).toHaveBeenCalledTimes(1);
      const desired=takeHullDrive(v),raw=spy.mock.calls[0][2],p=hullParams(VEHICLE_DEFS.pz4gh);
      const regular=p.contacts.filter(c=>!c.horn), gain=regular.reduce((s,c)=>s+c.local.x*c.side*.42*p.widthM,0)/regular.reduce((s,c)=>s+c.local.x**2+c.local.y**2,0);
      expect(raw.yawRateRadS).toBeCloseTo(desired.yawRateRadS/gain,12);
      expect(raw.speedMs).toBe(desired.speedMs); expect(Math.sign(raw.speedMs)).toBe(gear);
      expect(raw).not.toBe(desired); // public request is never converted or mutated
    }
  } finally {spy.mockRestore();}
});

it('keeps full brake, disabled and wheel-steered requests raw through one integration', () => {
  const spy=vi.spyOn(hullPhysics,'stepHullBody');
  try {
    for(const mode of ['brake','dead','crew','wheel','recovery']){
      const state=makeState(),{v,team,crew}=addTank(state,mode==='wheel'?'sdkfz251':'pz4gh',{x:20,y:20});
      placeVehicleBody(v,VEHICLE_DEFS[v.defId],v.pos,0,groundProbe(state.map));
      const target={x:21,y:10};if(mode!=='brake'){v.path=[target];team.order={type:'move',target,issuedAt:0};}
      if(mode==='dead')v.state='knockedOut';if(mode==='crew')for(const c of crew)c.health='dead';
      if(mode==='recovery'){v.body!.hungUp=true;v.body!.hungS=2;}
      spy.mockClear();stepVehicles(state,new Rng(3),SIM_DT);expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toEqual(takeHullDrive(v));
      if(mode==='recovery')expect(Math.abs(takeHullDrive(v).speedMs)).toBe(1);
    }
  }finally{spy.mockRestore();}
});
