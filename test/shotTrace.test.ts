import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { traceRound } from '@/sim/shotTrace';
import { hasLOS, hasLineOfFire } from '@/sim/los';
import { tileStanding } from '@/sim/growth';
import { makeState } from './vehicleDamageHelpers';

const from = { x: 10.5, y: 10.5 }, to = { x: 30.5, y: 10.5 };

describe('rounds through vegetation', () => {
  it('cuts low growth along the physical path and reduces its concealment', () => {
    const state = makeState();
    for (let x = 11; x < 30; x++) state.map.tiles[10 * state.map.width + x] = 'crops';
    traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 0.4, targetM: 0.4 });
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBeLessThan(1);
    expect(state.sparks.some((s) => s.kind === 'leaf')).toBe(true);
  });

  it('does not cut growth below an elevated round', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 20] = 'crops';
    traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 2.2, targetM: 2.2 });
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBe(1);
  });

  it('can deflect a bullet, records a bent path, and removes a repeatedly hit hedge', () => {
    const state = makeState();
    state.time = 50;
    const index = 10 * state.map.width + 20;
    state.map.tiles[index] = 'hedge';
    const rng = new Rng(8);
    let deflected = false;
    for (let i = 0; i < 150; i++) {
      const shot = traceRound(state, rng, from, to, WEAPONS.mg34, { eyeM: 1, targetM: 1 });
      if (shot.deflected) {
        deflected = true;
        expect(shot.points.length).toBeGreaterThan(2);
        expect(shot.impact.y).not.toBe(to.y);
      }
    }
    expect(deflected).toBe(true);
    expect(state.map.tiles[index]).toBe('open');
    expect(state.map.dirtyTiles).toContain(index);
    expect(state.sparks.some((s) => s.kind === 'ricochet' && s.t === 50)).toBe(true);
  });

  it('a shell fells an intervening tree and bursts there', () => {
    const state = makeState();
    const index = 10 * state.map.width + 20;
    state.map.tiles[index] = 'woods';
    const shot = traceRound(state, new Rng(1), from, to, WEAPONS.kwk40_75);
    expect(state.map.tiles[index]).toBe('open');
    expect(shot.blocked).toBe(true);
    expect(Math.floor(shot.impact.x)).toBe(20);
  });

  it('kinetic AP shot can cut through a tree without acquiring an HE burst', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 20] = 'woods';
    // Combat passes the actual round profile: AP/APCR have no explosive radius.
    const shot = traceRound(state, new Rng(1), from, to, { ...WEAPONS.kwk40_75, heRadiusM: 0 });
    expect(state.map.tiles[10 * state.map.width + 20]).toBe('open');
    expect(shot.blocked).toBe(false);
    expect(shot.impact).toEqual(to);
  });

  it('rounds stop at hard cover before touching growth behind it', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 15] = 'buildingStone';
    state.map.tiles[10 * state.map.width + 20] = 'crops';
    const shot = traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 0.4, targetM: 0.4 });
    expect(shot.blocked).toBe(true);
    expect(Math.floor(shot.impact.x)).toBe(15);
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBe(1);
  });

  it('permits concealed fire but still rejects intervening hills and walls', () => {
    const state = makeState(), map = state.map;
    map.tiles[10 * map.width + 20] = 'woods';
    expect(hasLOS(map, from, to)).toBe(false);
    expect(hasLineOfFire(map, from, to)).toBe(true);
    map.tiles[10 * map.width + 25] = 'stonewall';
    expect(hasLineOfFire(map, from, to)).toBe(false);
    map.tiles[10 * map.width + 25] = 'open';
    map.ground = new Float32Array(map.width * map.height);
    map.ground[10 * map.width + 25] = 10;
    expect(hasLineOfFire(map, from, to)).toBe(false);
  });

  it('replays the same physical paths and vegetation changes with the same seed', () => {
    const run = () => {
      const state = makeState();
      state.map.tiles[10 * state.map.width + 20] = 'woods';
      const rng = new Rng(42);
      const shots = Array.from({ length: 12 }, () => traceRound(state, rng, from, to, WEAPONS.mg34));
      return { shots, sparks: state.sparks, tile: state.map.tiles[10 * state.map.width + 20] };
    };
    expect(run()).toEqual(run());
  });
});

it('retains absolute physical heights at obstruction and every deflected leg endpoint', () => {
  const state = makeState();
  state.map.tiles[10 * state.map.width + 15] = 'buildingStone';
  const shot = traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeZ: 10, targetZ: 2 });
  const f = (shot.impact.x - from.x) / (to.x - from.x);
  expect(shot.impactZ).toBeCloseTo(10 + (2 - 10) * f, 12);
  expect(shot.pointsZ).toEqual([10, shot.impactZ]);
  state.map.tiles[10 * state.map.width + 15] = 'open';
  let seen = false;
  for (let seed = 1; seed < 60 && !seen; seed++) {
    state.map.tiles[10 * state.map.width + 20] = 'woods';
    const deflected = traceRound(state, new Rng(seed), from, to, { ...WEAPONS.mg34, heRadiusM: 0 }, { eyeZ: 2, targetZ: 1 });
    if (!deflected.deflected) continue;
    seen = true;
    expect(deflected.pointsZ).toHaveLength(deflected.points.length);
    expect(deflected.pointsZ[0]).toBe(2); expect(deflected.pointsZ.at(-1)).toBe(deflected.impactZ);
    expect(deflected.pointsZ.every(z => z >= 1 && z <= 2)).toBe(true);
  }
  expect(seen).toBe(true);
});

import { createHullBody } from '@/sim/hullPhysics';
import { intersectVehicle, type HullRay } from '@/sim/hullAim';
import { VEHICLE_DEFS } from '@/data/units';
import { addTank } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';

it('recomputes finite vehicle contact after deflection and returns the actual incoming leg', () => {
  const weapon = { ...WEAPONS.kwk40_75, heRadiusM: 0 }, heights = { eyeZ: 1, targetZ: 1 };
  let tested = false;
  for (let seed = 1; seed < 200 && !tested; seed++) {
    const baseline = makeState(); baseline.map.tiles[10 * baseline.map.width + 15] = 'woods';
    const bent = traceRound(baseline, new Rng(seed), from, to, weapon, heights, { atPolicy: 'ap' });
    if (!bent.deflected || Math.abs(bent.impact.y - from.y) < 2) continue;
    const a = bent.points[1], end = bent.points[2];
    const state = makeState(); state.map.tiles[10 * state.map.width + 15] = 'woods';
    const pos = { x: a.x + (end.x - a.x) * 0.8, y: a.y + (end.y - a.y) * 0.8 };
    const { v } = addTank(state, 't70', pos, Math.PI / 2); const def = VEHICLE_DEFS.t70;
    v.body = createHullBody(def, pos, v.hullFacing, flat);
    const query = (ray: HullRay, maxDistance: number) => { const hit = intersectVehicle(v, def, ray); return hit && hit.distance <= maxDistance ? { vehicle: v, hit } : null; };
    expect(query({ origin: { x: from.x * 2, y: from.y * 2, z: 1 }, direction: { x: (to.x - from.x) * 2, y: 0, z: 0 } }, (to.x - from.x) * 2)).toBeNull();
    const shot = traceRound(state, new Rng(seed), from, to, weapon, heights, { atPolicy: 'ap', vehicleContact: query });
    expect(shot.deflected).toBe(true); expect(shot.vehicleContact?.vehicle.id).toBe(v.id);
    expect(shot.vehicleContact?.ray.origin.x).toBeCloseTo(a.x * 2, 10); expect(shot.vehicleContact?.ray.origin.y).toBeCloseTo(a.y * 2, 10);
    expect(shot.impactZ).toBe(1); expect(shot.impact.x).toBeLessThan(end.x); tested = true;
  }
  expect(tested).toBe(true);
});
it('retains default infantry terrain/RNG behavior when the optional contact query misses', () => {
  const run = (query: boolean) => {
    const state = makeState(); state.map.tiles[10 * state.map.width + 20] = 'woods';
    const rng = new Rng(8); const shot = traceRound(state, rng, from, to, WEAPONS.mg34, {}, query ? { vehicleContact: () => null } : {});
    return { shot, rng: rng.state(), tiles: state.map.tiles, sparks: state.sparks };
  };
  expect(run(true)).toEqual(run(false));
});

it('gives terrain the exact contact-distance tie and stops at earlier ground without querying effects behind it', () => {
  const state = makeState(), pos = { x: 15.5, y: 10.5 }, { v } = addTank(state, 't70', pos);
  const def = { ...VEHICLE_DEFS.t70, widthM: 2, hasTurret: false }; v.body = createHullBody(def, pos, 0, flat);
  const query = (ray: HullRay, maxDistance: number) => { const hit = intersectVehicle(v, def, ray); return hit && hit.distance <= maxDistance ? { vehicle: v, hit } : null; };
  state.map.tiles[10 * state.map.width + 15] = 'buildingStone'; const rng = new Rng(7), before = rng.state();
  const tie = traceRound(state, rng, from, to, { ...WEAPONS.kwk40_75, heRadiusM: 0 }, { eyeZ: 1, targetZ: 1 }, { atPolicy: 'ap', vehicleContact: query });
  expect(tie.impact.x).toBe(15); expect(tie.vehicleContact).toBeUndefined(); expect(tie.blocked).toBe(true);
  expect(state.sparks.map(s => s.kind)).toEqual(['stone']); expect(rng.state()).toBe(before);
  state.map.tiles[10 * state.map.width + 15] = 'open'; state.map.ground = new Float32Array(state.map.width * state.map.height); state.map.ground[10 * state.map.width + 13] = 5;
  const ground = traceRound(state, rng, from, to, { ...WEAPONS.kwk40_75, heRadiusM: 0 }, { eyeZ: 1, targetZ: 1 }, { atPolicy: 'ap', vehicleContact: query });
  expect(Math.floor(ground.impact.x)).toBe(13); expect(ground.vehicleContact).toBeUndefined(); expect(rng.state()).toBe(before);
});
