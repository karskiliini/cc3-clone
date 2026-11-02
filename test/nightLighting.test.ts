import { expect, it } from 'vitest';
import { PointLight } from 'three';
import { makeState, addTank } from './vehicleDamageHelpers';
import { buildHeightField, heightAt, groundAt, canopyAt } from '@/sim/heightField';
import { intersectVehicle } from '@/sim/hullAim';
import { multiply, yawQuat } from '@/sim/hullMath';
import { createHullBody } from '@/sim/hullPhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { nightBoxHit, nightHeightBounds, nightOccluders, projectNightPoint, NIGHT_EMITTER_OFFSETS } from '@/render/nightLighting';
import { VehicleScene, SUN_INTENSITY } from '@/render/vehicle3d/vehicleScene';
import { toScreen, viewProjection } from '@/render/vehicle3d/projection';
import { TILE_M, VIEW_H, VIEW_W } from '@/shared/types';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';

function fixture() {
  const s = makeState(), map = s.map;
  map.width = map.height = 32; map.tiles = Array(32 * 32).fill('open');
  map.buildingId = new Int16Array(32 * 32).fill(-1); map.windows = new Uint8Array(32 * 32); map.smoke = new Float32Array(32 * 32);
  map.ground = new Float32Array(32 * 32).fill(3);
  map.def = { ...map.def, width: 32, height: 32 }; map.heightField = buildHeightField(map);
  return s;
}

it('render hull/turret shadows intersect the same pitched, rolled, turreted solids as simulation', () => {
  const s = fixture(), { v } = addTank(s, 't34_76', { x: 12, y: 13 }, .3);
  const def = VEHICLE_DEFS[v.defId];
  for (const physical of [false, true]) {
    if (physical) {
      v.body = createHullBody(def, v.pos, .3, () => ({ heightM: 3, normal: { x: 0, y: 0, z: 1 } }));
      v.body.orientation = multiply(yawQuat(.3), { x: Math.sin(.12), y: 0, z: 0, w: Math.cos(.12) });
    }
    v.turretFacing = 1.1;
    const before = hashState({ state: s, rng: new Rng(5) }), boxes = nightOccluders(s, 'soviet');
    expect(boxes).toHaveLength(2);
    for (const x of [-5, 0, 5]) for (const y of [-4, 0, 4]) {
      const origin = { x: v.pos.x * TILE_M + x, y: v.pos.y * TILE_M + y, z: 20 };
      const direction = { x: -x * .9, y: -y * .9, z: -18 };
      const hit = intersectVehicle(v, def, { origin, direction }, false, heightAt(s.map.heightField!, v.pos.x, v.pos.y));
      const t = Math.min(...boxes.map(box => nightBoxHit(origin, direction, box)));
      if (!hit) expect(t).toBe(Infinity);
      else expect(t * Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(hit.distance, 10);
    }
    expect(hashState({ state: s, rng: new Rng(5) })).toBe(before);
  }
});

it('a hidden moving hull cannot acquire a visible renderer shadow proxy', () => {
  const s = fixture(), { v } = addTank(s, 't34_76', { x: 12, y: 13 });
  expect(nightOccluders(s, 'german')).toHaveLength(0);
  v.pos.x += 3; expect(nightOccluders(s, 'german')).toHaveLength(0);
  s.spottedVehicles.german.add(v.id); expect(nightOccluders(s, 'german')).toHaveLength(2);
  v.turretBlown = true; expect(nightOccluders(s, 'german')).toHaveLength(1);
});

it('flare, aircraft and vehicle light coordinates share the existing 12-degree projection', () => {
  const cam = { x: 10, y: 13, zoom: 2 }, p = { x: 45, y: 70, z: 100 };
  const point = projectNightPoint(cam, p), actual = toScreen(viewProjection(cam, VIEW_W, VIEW_H), [p.x, p.z, p.y], VIEW_W, VIEW_H);
  expect(point.x).toBeCloseTo(actual.x, 10); expect(point.y).toBeCloseTo(actual.y, 10);
});

it('night replaces sunlight with canonical moving point lights and restores day cleanly', () => {
  const scene = new VehicleScene({ get: () => null });
  scene.setNightLighting(true, [{ x: 20, y: 30, z: 80, strength: 1 }]); scene.fitSun(0, 0, 20);
  expect(scene.night).toBe(true); expect(scene.sun.visible).toBe(false); expect(scene.sun.castShadow).toBe(false);
  const point = scene.scene.children.filter((c): c is PointLight => c instanceof PointLight);
  expect(point[0].position.toArray()).toEqual([20, 80, 30]); expect(point[0].intensity).toBeGreaterThan(0);
  scene.setNightLighting(true, [{ x: 22, y: 31, z: 25, strength: .5 }]);
  expect(point[0].position.toArray()).toEqual([22, 25, 31]);
  scene.setNightLighting(false, []);
  expect(scene.sun.visible).toBe(true); expect(scene.sun.castShadow).toBe(true); expect(scene.sun.intensity).toBe(SUN_INTENSITY);
  expect(point.every(p => p.intensity === 0)).toBe(true);
});

it('accelerator bounds retain tall sub-cell roofs and canopy interpolation across block corners', () => {
  const state = fixture(), f = state.map.heightField!;
  // Neighbouring corners straddle four 4 m bound cells. A bound without its
  // bilinear halo would incorrectly skip the rising edge of these obstructions.
  f.height[7 * f.w + 7] = 11; f.height[12 * f.w + 15] = 16;
  f.ground[8 * f.w + 8] = 9; f.canopy[8 * f.w + 8] = 5;
  const before = { height: f.height.slice(), ground: f.ground.slice(), canopy: f.canopy.slice(), version: f.version };
  const b = nightHeightBounds(f);
  expect(b.maximum).toBe(16);
  for (let y = 0; y < 10; y += .125) for (let x = 0; x < 10; x += .125) {
    const actual = Math.max(heightAt(f, x / TILE_M, y / TILE_M), groundAt(f, x / TILE_M, y / TILE_M) + canopyAt(f, x / TILE_M, y / TILE_M));
    const bound = b.data[Math.floor(y / b.stepM) * b.width + Math.floor(x / b.stepM)];
    expect(bound).toBeGreaterThanOrEqual(actual);
  }
  expect({ height: f.height, ground: f.ground, canopy: f.canopy, version: f.version }).toEqual(before);
});

it('the cheaper render emitter preserves the canonical emitter centre and penumbra spread', () => {
  const canonical = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const moments = (points: readonly (readonly number[])[]) => [
    points.reduce((s, p) => s + p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1], 0) / points.length,
    points.reduce((s, p) => s + p[0] * p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1] * p[1], 0) / points.length,
    points.reduce((s, p) => s + p[0] * p[1], 0) / points.length,
  ];
  const expected = moments(canonical);
  moments(NIGHT_EMITTER_OFFSETS).forEach((moment, i) => expect(moment).toBeCloseTo(expected[i], 12));
});
