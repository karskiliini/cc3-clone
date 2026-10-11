import { expect, it } from 'vitest';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';
import { beginHullDrive, requestHullDrive, takeHullDrive } from '@/sim/hullDrive';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { wrapAngle } from '@/shared/math';
import { FROZEN_TURRET_HULL_LAY, hullTurnNow, onVehicleNearMiss, stepVehicles } from '@/sim/vehicle';
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
    expect(drive.speedMs).toBe(v.speed);
    expect(drive.brake).toBe(false);
    expect(backing ? drive.speedMs < 0 : drive.speedMs > 0).toBe(true);
    expect((before.y - v.pos.y) * TILE_M).toBeCloseTo(drive.speedMs * SIM_DT, 12);
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
  expect(drive.speedMs).toBe(v.speed);
  expect(drive.speedMs).toBeGreaterThan(0);
  expect(v.hullFacing).toBeCloseTo(drive.yawRateRadS * SIM_DT, 12);
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
    expect(drive.speedMs).toBe(v.speed);
    expect(branch === 'creep' ? drive.speedMs > 0 : drive.speedMs < 0).toBe(true);
    expect((y - v.pos.y) * TILE_M).toBeCloseTo(drive.speedMs * SIM_DT, 12);
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
    expect(v.hullFacing).toBeCloseTo(drive.yawRateRadS * SIM_DT, 12);
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
      expect(drive.speedMs).toBe(v.speed);
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
  const before = { ...v.pos };
  v.fireHaltUntil = 1;
  stepVehicles(state, new Rng(1), SIM_DT);
  expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
  expect(v.pos).toEqual(before);
});

it('crushes the origin tile, runs over the accepted hull position, then rolls its mine once', () => {
  const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 20, y: 22 });
  v.path = [{ x: 20, y: 20 }];
  state.map.tiles[22 * state.map.width + 20] = 'fence';
  setMineAt(state.map, 20, 20, MINE_AT);
  const enemy = soldier(20, 21, 'soviet', { x: 20, y: 20 }, 'mosin', { stance: 'prone' });
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
    expect(v.pos).toEqual({ x: 20, y: 20 });
    mineRolls++;
    return chance(probability);
  };
  stepVehicles(state, rng, 1);
  expectedRng.next();
  expect(mineRolls).toBe(1);
  expect(rng.state()).toBe(expectedRng.state());
  expect(mineAt(state.map, 20, 20)).toBe(MINE_NONE);
  expect(v.state).toBe('immobilized');
  expect(state.events.filter((event) => event.kind === 'kill')).toHaveLength(1);
});
