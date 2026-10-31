import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { makeReplayLog, runReplay, runTicks } from '@/sim/replay';
import { applyOrder, stepOrderWaypoints } from '@/sim/orders';
import { findPath } from '@/sim/path';
import { VEHICLE_DEFS } from '@/data/units';
import { stepVehicles } from '@/sim/vehicle';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';
import { SIM_DT } from '@/shared/types';
import { appendDrawnPoint } from '@/ui/drawnRoute';
import { addTank, makeState, W } from './vehicleDamageHelpers';

function scenario(def = 'pz4gh') {
  const state = makeState(), rng = new Rng(12);
  const { v, team } = addTank(state, def, { x: 100, y: 100 }, Math.PI / 2);
  const order = { type: 'move' as const, routeMode: 'drawn' as const, issuedAt: 0,
    waypoints: [{ x: 105, y: 100 }, { x: 105, y: 95 }], target: { x: 110, y: 95 } };
  applyOrder(state, team, order, rng);
  return { state, rng, v, team, order };
}
describe('drawn routes', () => {
  it('keeps the exact supplied geometry, independently of solver reachability', () => {
    const { state, rng, team, v } = scenario();
    for (let y = 0; y < 400; y++) state.map.tiles[y * W + 103] = 'water';
    const points = [{ x: 104.1, y: 100.3 }, { x: 110.2, y: 100.8 }];
    applyOrder(state, team, { type: 'move', routeMode: 'drawn', target: points[1], waypoints: [points[0]], issuedAt: 0 }, rng);
    expect(v.path).toEqual(points);
    points[0].x = 999;
    expect(v.path[0].x).toBe(104.1);
    state.time = 10; stepOrderWaypoints(state);
    expect(team.order?.waypoints).toEqual([{ x: 104.1, y: 100.3 }]);
  });
  it.each(['pz4gh', 'sdkfz251'])('%s actually follows both right-angle bends and finishes', def => {
    const { state, rng, v, team } = scenario(def);
    // A solver with an exhausted search budget cannot deliver this route; the driver
    // still traverses the supplied geometry using the production physical simulation.
    expect(findPath(state.map, v.pos, { x: 110, y: 95 }, 'vehicle', 1, undefined, { def: VEHICLE_DEFS[def] })).toEqual([]);
    let maxXBeforeCorner = 0; const visited: number[] = [];
    for (let i = 0; i < 1800 && v.path.length; i++) {
      if (v.path.some(p => p.x === 105 && p.y === 100)) maxXBeforeCorner = Math.max(maxXBeforeCorner, v.pos.x);
      const n = v.path.length;
      stepVehicles(state, rng, SIM_DT); state.time += SIM_DT; stepOrderWaypoints(state);
      if (n > v.path.length) visited.push(Math.hypot(v.pos.x - 105, v.pos.y - (n === 3 ? 100 : 95)));
    }
    expect(visited.slice(0, 2)).toHaveLength(2);
    for (const distance of visited.slice(0, 2)) expect(distance).toBeLessThan(0.5);
    expect(maxXBeforeCorner).toBeLessThan(107);
    expect(v.path).toEqual([]);
    expect(Math.hypot(v.pos.x - 110, v.pos.y - 95)).toBeLessThan(0.8);
    expect(team.order?.waypoints).toEqual([]);
  });
  it('does not discard or route around an occupied endpoint', () => {
    const { state, rng, team, v } = scenario();
    addTank(state, 'pz4gh', { x: 106, y: 100 }, Math.PI / 2);
    applyOrder(state, team, { type: 'move', routeMode: 'drawn', target: { x: 106, y: 100 }, issuedAt: 0 }, rng);
    for (let i = 0; i < 180; i++) { stepVehicles(state, rng, SIM_DT); state.time += SIM_DT; }
    expect(v.path).toEqual([{ x: 106, y: 100 }]);
    expect(v.pos.x).toBeLessThan(105);
  });
  it('stops at impassable terrain without discarding bends or inventing a detour', () => {
    const { state, rng, v, team } = scenario();
    for (let y = 0; y < 400; y++) state.map.tiles[y * W + 103] = 'water';
    const path = structuredClone(v.path);
    for (let i = 0; i < 180; i++) {
      stepVehicles(state, rng, SIM_DT); state.time += SIM_DT; stepOrderWaypoints(state);
    }
    expect(v.pos.x).toBeLessThan(103);
    expect(v.path).toEqual(path);
    expect(team.order?.waypoints).toEqual(path.slice(0, -1));
  });
  it('rejects malformed geometry and leaves the preceding route intact', () => {
    const { state, rng, team, v } = scenario(); const old = team.order, path = v.path;
    applyOrder(state, team, { type: 'move', routeMode: 'drawn', target: { x: NaN, y: 100 }, issuedAt: 0 }, rng);
    expect(team.order).toBe(old); expect(v.path).toBe(path);
  });
  it('hashes the routing mode and replays the same physics deterministically', () => {
    const a = scenario(), b = scenario();
    const automatic = hashState(a); delete a.team.order!.routeMode;
    expect(hashState(a)).not.toBe(automatic); a.team.order!.routeMode = 'drawn';
    for (let i = 0; i < 90; i++) {
      for (const s of [a, b]) { stepVehicles(s.state, s.rng, SIM_DT); s.state.time += SIM_DT; stepOrderWaypoints(s.state); }
    }
    expect(hashState(a)).toBe(hashState(b));
  });
  it('preserves corners while reducing collinear samples and rejects overflow', () => {
    const points: { x: number; y: number }[] = [];
    for (const p of [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }]) appendDrawnPoint(points, p);
    expect(points).toEqual([{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }]);
    while (points.length < 512) points.push({ x: points.length, y: points.length % 2 });
    expect(appendDrawnPoint(points, { x: 600, y: 3 })).toBe(false);
    expect(points.length).toBe(512);
  });
});


it('saves and replays drawn route commands through JSON with an identical tick hash chain', () => {
  const battle = new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1941,
    seed: 15, durationS: 600, difficulty: 'normal', forces: { german: ['ger_pz3j'], soviet: ['sov_rifle_41'] } });
  const team = battle.selectableTeams('german')[0];
  const p = team.pos;
  battle.submit('german', { type: 'order', teamId: team.id, order: {
    type: 'move', routeMode: 'drawn', issuedAt: 0,
    waypoints: [{ x: p.x + 3, y: p.y }], target: { x: p.x + 3, y: p.y - 3 },
  } });
  battle.submit('german', { type: 'ready' });
  const chain = runTicks(battle, 90);
  const log = JSON.parse(JSON.stringify(makeReplayLog(battle)));
  expect(log.commands.find((c: { type: string }) => c.type === 'order').order.routeMode).toBe('drawn');
  expect(runReplay(log).chain).toEqual(chain);
});
