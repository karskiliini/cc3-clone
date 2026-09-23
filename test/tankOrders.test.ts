import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { angleTo, dist, wrapAngle } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { hasLineOfFire, EYE_VEHICLE_M } from '@/sim/los';
import { findPath } from '@/sim/path';
import { gunArcRad } from '@/sim/gunTiming';
import { isVehicleReversing, onVehicleNearMiss, stepVehicles } from '@/sim/vehicle';
import type { BattleState, Vec2 } from '@/shared/types';
import { addTank, makeState } from './vehicleDamageHelpers';

function run(state: BattleState, seconds: number, each?: () => void): void {
  const rng = new Rng(5);
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    state.time += SIM_DT;
    stepVehicles(state, rng, SIM_DT);
    each?.();
  }
}

describe('tank crews carry out their orders', () => {
  it('a tank driving to where it was sent keeps going when an AT gun opens up, instead of hiding', () => {
    const state = makeState();
    const { v, team } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60, 'german');
    state.map.tiles[200 * state.map.width + 202] = 'buildingStone'; // cover it would otherwise use
    const goal = { x: 200.5, y: 170.5 };
    team.order = { type: 'move', target: goal, issuedAt: state.time };
    v.path = findPath(state.map, v.pos, goal, 'vehicle');
    onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 200.5, y: 185.5 });
    const start = dist(v.pos, goal);
    run(state, 10, () => expect(isVehicleReversing(state, v)).toBe(false));
    expect(dist(v.pos, goal)).toBeLessThan(start - 5);
  });

  it('a StuG told to fire at a target off to its side turns the whole vehicle to bring the gun on', () => {
    const state = makeState();
    const { v, team } = addTank(state, 'stug3g', { x: 200.5, y: 200.5 }, 0, 60, 'german');
    const target = { x: 230.5, y: 200.5 }; // due east, 90 degrees off the hull
    team.order = { type: 'fire', target, issuedAt: state.time };
    v.targetPoint = target;
    run(state, 12);
    expect(Math.abs(wrapAngle(angleTo(v.pos, target) - v.hullFacing))).toBeLessThanOrEqual(gunArcRad(VEHICLE_DEFS.stug3g));
  });

  it('with no line of fire to its target, the crew drives to a nearby spot that has one', () => {
    const state = makeState();
    const W = state.map.width;
    const { v, team } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60, 'german');
    // a long wall between the tank and the target, open beyond its west end
    for (let x = 192; x <= 212; x++) state.map.tiles[195 * W + x] = 'buildingStone';
    const target: Vec2 = { x: 200.5, y: 160.5 };
    const eye = { eyeM: EYE_VEHICLE_M };
    expect(hasLineOfFire(state.map, v.pos, target, eye)).toBe(false);
    team.order = { type: 'fire', target, issuedAt: state.time };
    v.targetPoint = target;
    let clear = false;
    run(state, 40, () => { if (!clear && v.path.length === 0 && hasLineOfFire(state.map, v.pos, target, eye)) clear = true; });
    expect(clear).toBe(true);
    expect(dist(v.pos, { x: 200.5, y: 200.5 })).toBeLessThan(26); // a spot nearby, not a long drive
  });
});

describe('hulls keep apart', () => {
  it('a tank sent onto the spot where another stands stops beside it and never drives over it', () => {
    const state = makeState();
    const { v: a, team } = addTank(state, 't34_76', { x: 200.5, y: 220.5 }, 0, 60, 'soviet');
    const { v: b } = addTank(state, 't34_76', { x: 200.5, y: 200.5 }, 0, 60, 'soviet');
    team.order = { type: 'move', target: { ...b.pos }, issuedAt: state.time };
    a.path = findPath(state.map, a.pos, b.pos, 'vehicle');
    let closest = Infinity;
    run(state, 20, () => { closest = Math.min(closest, dist(a.pos, b.pos)); });
    expect(closest).toBeGreaterThan(1.9); // tiles: hull radii of two T-34s (about 2.4 m each)
    expect(a.path).toHaveLength(0);       // it counts as arrived next to the other
    expect(dist(a.pos, b.pos)).toBeLessThan(4);
  });

  it('two tanks crossing paths head-on get round each other to their goals', () => {
    const state = makeState();
    const { v: a, team: ta } = addTank(state, 'pz4gh', { x: 200.5, y: 230.5 }, 0, 60, 'german');
    const { v: b, team: tb } = addTank(state, 'pz4gh', { x: 200.5, y: 190.5 }, Math.PI, 60, 'german');
    const ga = { x: 200.5, y: 185.5 }, gb = { x: 200.5, y: 235.5 };
    ta.order = { type: 'move', target: ga, issuedAt: state.time };
    tb.order = { type: 'move', target: gb, issuedAt: state.time };
    a.path = findPath(state.map, a.pos, ga, 'vehicle');
    b.path = findPath(state.map, b.pos, gb, 'vehicle');
    let closest = Infinity;
    run(state, 60, () => { closest = Math.min(closest, dist(a.pos, b.pos)); });
    expect(closest).toBeGreaterThan(1.9);
    expect(dist(a.pos, ga)).toBeLessThan(2);
    expect(dist(b.pos, gb)).toBeLessThan(2);
  });
});
