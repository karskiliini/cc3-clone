import { describe, it, expect } from 'vitest';
import { makeState, addTank } from './vehicleDamageHelpers';
import { driveReversingProbe } from '@/sim/vehicle';

/** A tank reversing away from a threat near the map edge never leaves the battlefield. */
describe('vehicles never drive off the map (user report: tank fled off-screen)', () => {
  it('a panic reverse at the north edge stops at the border', () => {
    const state = makeState(1943);
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 3 }, 0, 50); // hull facing north (toward y=0)
    // threat south of it, cover target further north — past the edge: the hull reverses north
    for (let t = 0; t < 60; t++) driveReversingProbe(state, v, 8, { x: 200.5, y: 20 }, { x: 200.5, y: -20 }, 1 / 30);
    expect(v.pos.y).toBeGreaterThanOrEqual(0);
    expect(v.pos.y).toBeLessThan(400);
    expect(v.pos.x).toBeGreaterThanOrEqual(0);
    expect(v.pos.x).toBeLessThan(400);
  });

  it('a panic reverse at the south edge stops at the border', () => {
    const state = makeState(1943);
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 396 }, Math.PI, 50); // hull facing south
    for (let t = 0; t < 60; t++) driveReversingProbe(state, v, 8, { x: 200.5, y: 380 }, { x: 200.5, y: 420 }, 1 / 30);
    expect(v.pos.y).toBeGreaterThanOrEqual(0);
    expect(v.pos.y).toBeLessThan(400);
  });

  it('an ordered move along the border stops instead of stepping out', () => {
    const state = makeState(1943);
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 2 }, 0, 50);
    // hull faces north; a waypoint off the map edge: the straight-line branch must refuse the step
    for (let t = 0; t < 120; t++) driveReversingProbe(state, v, 0, { x: 200.5, y: -10 }, { x: 200.5, y: -10 }, 1 / 30);
    expect(v.pos.y).toBeGreaterThanOrEqual(0);
  });
});
