import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { dist } from '@/shared/math';
import { Rng } from '@/shared/rng';
import { findPath, isPassable } from '@/sim/path';
import { crossedCells } from '@/sim/vehicleCorridor';
import { takeHullDrive } from '@/sim/hullDrive';
import { stepVehicles } from '@/sim/vehicle';
import { isTrenchApproachEntry, isTrenchApproachPoint, prepareTrenchApproaches } from '@/sim/vehicleTrenchApproach';
import { addTank, makeState } from './vehicleDamageHelpers';

function flatTrench() {
  const state = makeState();
  state.map.def = { ...state.map.def, vectors: [{ kind: 'line', terrain: 'trench', width: 1,
    points: [{ x: 10, y: 20 }, { x: 40, y: 20 }] }] };
  for (let x = 10; x <= 40; x++) state.map.tiles[20 * state.map.width + x] = 'trench';
  return state;
}

describe('a tracked vehicle follows a complete trench crossing', () => {
  for (const defId of ['pz4gh', 'tiger']) {
    it(`${defId} consumes a reached sparse entry and physically crosses to the original destination`, () => {
      const state = flatTrench(), def = VEHICLE_DEFS[defId];
      const goal = { x: 25.5, y: 27.5 };
      const route = findPath(state.map, { x: 25.5, y: 14.5 }, goal, 'vehicle', 2000, undefined, { def });
      const first = route.findIndex(p => isTrenchApproachPoint(state.map, def, p));
      expect(first).toBeGreaterThanOrEqual(0);
      const entry = route[first], exit = route[first + 1];
      expect(state.map.tiles[Math.floor(entry.y) * state.map.width + Math.floor(entry.x)]).toBe('open');
      expect(state.map.tiles[Math.floor(exit.y) * state.map.width + Math.floor(exit.x)]).toBe('open');
      if (defId === 'tiger') expect(dist(entry, exit)).toBeGreaterThan(6);
      const { v, team } = addTank(state, defId, entry, Math.PI);
      v.path = route.slice(first);
      team.order = { type: 'move', target: goal, issuedAt: 0 };
      const rng = new Rng(3);
      state.time += 0.1; stepVehicles(state, rng, 0.1);
      expect(v.path[0]).toBe(exit);
      expect(takeHullDrive(v).speedMs).toBeGreaterThan(0);
      for (let i = 0; i < 19; i++) { state.time += 0.1; stepVehicles(state, rng, 0.1); }
      expect(v.pos.y).toBeGreaterThan(entry.y + 0.5);
      for (let i = 0; i < 330 && v.path.length; i++) { state.time += 0.1; stepVehicles(state, rng, 0.1); }
      expect(v.path).toHaveLength(0);
      expect(dist(v.pos, goal)).toBeLessThan(1.2);
    });
  }

  it('retains the requested endpoint when it lies within the far bank clearance', () => {
    const state = flatTrench(), def = VEHICLE_DEFS.pz4gh;
    const goal = { x: 25.5, y: 21.5 };
    const route = findPath(state.map, { x: 25.5, y: 14.5 }, goal, 'vehicle', 2000, undefined, { def });
    expect(route.at(-1)).toEqual(goal);
    expect(route.some(p => p.y > goal.y && isTrenchApproachPoint(state.map, def, p))).toBe(true);
  });
});

it('moves a crossing along the existing bank route when the first far-bank connector is obstructed', () => {
  const state = flatTrench(), def = VEHICLE_DEFS.pz4gh;
  state.map.tiles[23 * state.map.width + 24] = 'water';
  const start = { x: 20.5, y: 14.5 };
  const original = [{ x: 20.5, y: 17.5 }, { x: 21.5, y: 18.5 }, { x: 22.5, y: 19.5 },
    { x: 23.5, y: 20.5 }, { x: 24.5, y: 21.5 }, { x: 25.5, y: 22.5 },
    { x: 26.5, y: 23.5 }, { x: 27.5, y: 24.5 }, { x: 27.5, y: 26.5 }];
  const clear = (a: {x:number;y:number}, b: {x:number;y:number}) =>
    crossedCells(a, b, (x, y) => isPassable(state.map, x, y, 'vehicle', def));
  const route = prepareTrenchApproaches(state.map, def, start, original, clear);
  const first = route.findIndex(p => isTrenchApproachPoint(state.map, def, p));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(route[first].x).toBeGreaterThan(24);
  expect(route[first + 1].x).toBe(route[first].x);
  expect(route.at(-1)).toEqual(original.at(-1));
  for (let i = 0; i < route.length; i++) expect(clear(i ? route[i-1] : start, route[i])).toBe(true);
});

it('prepares a crossing that follows several points exactly on the trench before leaving its far side', () => {
  const state = flatTrench(), def = VEHICLE_DEFS.pz4gh;
  const original = [{ x: 25.5, y: 18.5 }, { x: 25.5, y: 20 }, { x: 26.5, y: 20 },
    { x: 27.5, y: 20 }, { x: 27.5, y: 23.5 }, { x: 27.5, y: 26.5 }];
  const route = prepareTrenchApproaches(state.map, def, { x: 25.5, y: 14.5 }, original, () => true);
  const first = route.findIndex(p => isTrenchApproachPoint(state.map, def, p));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(route[first].y).toBeLessThan(20);
  expect(route[first + 1].y).toBeGreaterThan(20);
  expect(route[first].x).toBe(route[first + 1].x);
  expect(route.at(-1)).toEqual(original.at(-1));
});

it('preserves A* traffic avoidance when connecting a prepared crossing back to its route', () => {
  const state = flatTrench(), def = VEHICLE_DEFS.pz4gh;
  const start = { x: 20.5, y: 14.5 }, goal = { x: 30.5, y: 27.5 };
  const avoided = (x: number, y: number) => x >= 24 && x <= 26 && y >= 23 && y <= 25;
  const route = findPath(state.map, start, goal, 'vehicle', 2000, (x, y) => avoided(x, y) ? 40 : 0, { def });
  expect(route.some(p => isTrenchApproachPoint(state.map, def, p))).toBe(true);
  expect(route.at(-1)).toEqual(goal);
  for (let i = 0; i < route.length; i++) expect(crossedCells(i ? route[i - 1] : start, route[i],
    (x, y) => !avoided(x, y))).toBe(true);
});

it('keeps one aligned crossing until the whole hull clears two overlapping trench banks', () => {
  const state = flatTrench(), def = VEHICLE_DEFS.pz4gh;
  state.map.def.vectors!.push({ kind: 'line', terrain: 'trench', width: 1,
    points: [{ x: 10, y: 22 }, { x: 40, y: 22 }] });
  for (let x = 10; x <= 40; x++) state.map.tiles[22 * state.map.width + x] = 'trench';
  const start = { x: 25.5, y: 14.5 }, goal = { x: 25.5, y: 28.5 };
  const route = findPath(state.map, start, goal, 'vehicle', 2000, undefined, { def });
  const endpoints = route.filter(p => isTrenchApproachPoint(state.map, def, p));
  expect(endpoints).toHaveLength(2);
  expect(endpoints[0].y).toBeLessThan(18);
  expect(endpoints[1].y).toBeGreaterThan(24);
  expect(isTrenchApproachEntry(state.map, def, endpoints[0], endpoints[1])).toBe(true);
  const { v, team } = addTank(state, 'pz4gh', endpoints[0], Math.PI);
  v.path = route.slice(route.indexOf(endpoints[0]));
  team.order = { type: 'move', target: goal, issuedAt: 0 };
  const rng = new Rng(3);
  for (let i = 0; i < 400 && v.path.length; i++) { state.time += 0.1; stepVehicles(state, rng, 0.1); }
  expect(v.path).toHaveLength(0);
  expect(dist(v.pos, goal)).toBeLessThan(1.2);
});
