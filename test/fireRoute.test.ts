// Routes ordered while something burns go round the fire when they can (a path COST, never a block).
import { describe, it, expect } from 'vitest';
import type { Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { findPath } from '@/sim/path';
import { setTile } from '@/sim/map';
import { fireHazardCost, routeVia } from '@/sim/orders';
import { FIRE_HAZARD_M } from '@/sim/vehicleExplosion';
import { makeState, addTank } from './vehicleDamageHelpers';

const FROM: Vec2 = { x: 100.5, y: 140.5 }, TO: Vec2 = { x: 100.5, y: 60.5 }, HULK: Vec2 = { x: 100.5, y: 100.5 };
const closest = (path: Vec2[], p: Vec2): number => Math.min(...path.map((q) => dist(q, p))) * TILE_M;

describe('routes and burning vehicles', () => {
  it('nothing burning: no extra cost at all, and the route is the plain A* one', () => {
    const state = makeState();
    addTank(state, 't34_76', HULK);
    expect(fireHazardCost(state, 'infantry')).toBeUndefined();
    expect(routeVia(state, FROM, [TO], 'infantry')).toEqual(findPath(state.map, FROM, TO, 'infantry'));
  });

  it('infantry and a halftrack bend round a burning tank; a closed-up tank drives straight past', () => {
    const state = makeState();
    addTank(state, 't34_76', HULK).v.state = 'burning';
    expect(closest(findPath(state.map, FROM, TO, 'infantry'), HULK)).toBeLessThan(3);
    const foot = routeVia(state, FROM, [TO], 'infantry');
    expect(closest(foot, HULK)).toBeGreaterThanOrEqual(FIRE_HAZARD_M - TILE_M);
    expect(dist(foot[foot.length - 1], TO)).toBeLessThan(1);
    const soft = routeVia(state, FROM, [TO], 'vehicle', true);
    expect(closest(soft, HULK)).toBeGreaterThanOrEqual(FIRE_HAZARD_M - TILE_M);
    const armour = routeVia(state, FROM, [TO], 'vehicle');
    expect(closest(armour, HULK)).toBeLessThan(3);
    // waypoint routes too
    const via = routeVia(state, FROM, [{ x: 100.5, y: 125.5 }, TO], 'infantry');
    expect(closest(via, HULK)).toBeGreaterThanOrEqual(FIRE_HAZARD_M - TILE_M);
  });

  it('with no way round (a gap in a long water barrier, the hulk burning in it) the route still goes through', () => {
    const state = makeState();
    for (let x = 0; x < state.map.width; x++) if (Math.abs(x - 100) > 2) setTile(state.map, x, 100, 'water');
    addTank(state, 't34_76', HULK).v.state = 'burning';
    const foot = routeVia(state, FROM, [TO], 'infantry');
    expect(foot.length).toBeGreaterThan(0);
    expect(dist(foot[foot.length - 1], TO)).toBeLessThan(1);
    expect(closest(foot, HULK)).toBeLessThan(FIRE_HAZARD_M / 2);
  });

  it('is deterministic', () => {
    const run = (): string => { const state = makeState(); addTank(state, 't34_76', HULK).v.state = 'burning'; return JSON.stringify(routeVia(state, FROM, [TO], 'infantry')); };
    expect(run()).toBe(run());
  });
});
