import { expect, it } from 'vitest';
import { makeState } from './vehicleDamageHelpers';
import { buildHeightField, canopyAt, getHeightField, setTileProfile } from '@/sim/heightField';
import { groundProbe, groundVersion } from '@/sim/hullGround';

it('sees authored height edits and a changed revision', () => {
  const map = makeState().map, field = getHeightField(map), before = groundVersion(map);
  setTileProfile(field, 10, 10, 0.4);
  const hit = groundProbe(map)(21, 21);
  expect(hit.heightM).toBeCloseTo(0.4);
  expect(hit.normal.z).toBeGreaterThan(0);
  expect(groundVersion(map)).toBeGreaterThan(before);
});

it('returns finite upward normals on all map edges', () => {
  const map = makeState().map, probe = groundProbe(map);
  for (const [x, y] of [[0, 0], [-1, 0], [map.width * 2, map.height * 2], [map.width * 2 + 1, 0]]) {
    const hit = probe(x, y);
    expect(Number.isFinite(hit.heightM)).toBe(true);
    for (const n of [hit.normal.x, hit.normal.y, hit.normal.z]) expect(Number.isFinite(n)).toBe(true);
    expect(hit.normal.z).toBeGreaterThan(0);
  }
});

it('synchronizes appended crater marks before returning the wake revision', () => {
  const map = makeState().map, probe = groundProbe(map), before = groundVersion(map);
  map.craterMarks = [{ x: 10.5, y: 10.5, sizeM: 2.5, kind: 'shell' }];
  const changed = groundVersion(map);
  expect(changed).toBeGreaterThan(before);
  expect(probe(21, 21).heightM).toBeLessThan(-0.75);
  const hit = probe(21, 21);
  expect(groundVersion(map)).toBe(changed);
  expect(probe(21, 21)).toEqual(hit);
});

it('a retained probe observes appended crater marks without a revision read', () => {
  const map = makeState().map, probe = groundProbe(map);
  expect(probe(21, 21).heightM).toBe(0);
  map.craterMarks = [{ x: 10.5, y: 10.5, sizeM: 2.5, kind: 'shell' }];
  expect(probe(21, 21).heightM).toBeLessThan(-0.75);
});

it('track-only marks leave hull support and its revision unchanged', () => {
  const map = makeState().map, probe = groundProbe(map), before = groundVersion(map);
  const hit = probe(21, 21);
  map.craterMarks = [{ x: 10.5, y: 10.5, sizeM: 2.5, kind: 'track' }];
  expect(groundVersion(map)).toBe(before);
  expect(probe(21, 21)).toEqual(hit);
});

it('a retained probe samples the current field after it is rebuilt', () => {
  const map = makeState().map, probe = groundProbe(map);
  setTileProfile(getHeightField(map), 10, 10, 0.4);
  expect(probe(21, 21).heightM).toBeCloseTo(0.4);
  const sleepingRevision = groundVersion(map);
  map.heightField = buildHeightField(map);
  expect(groundVersion(map)).toBeGreaterThan(sleepingRevision);
  setTileProfile(map.heightField, 10, 10, 0.8);
  expect(groundVersion(map)).toBeGreaterThan(sleepingRevision);
  expect(probe(21, 21).heightM).toBeCloseTo(0.8);
  expect(groundVersion(map)).toBe(map.heightField.version);
});

it('combines landform and features and normalizes a known metre-space slope', () => {
  const map = makeState().map;
  map.ground = new Float32Array(map.width * map.height).fill(3);
  const field = getHeightField(map), profile = new Float32Array(16);
  // h = 2 + 0.5 * local x metres + 0.25 * local y metres, at sample centres.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    profile[y * 4 + x] = 2 + 0.5 * (x * 0.5 + 0.25) + 0.25 * (y * 0.5 + 0.25);
  }
  const before = groundVersion(map);
  setTileProfile(field, 10, 10, profile);
  const hit = groundProbe(map)(21, 21);
  expect(hit.heightM).toBeCloseTo(5.75);
  expect(hit.normal.x).toBeCloseTo(-0.4364357805, 8);
  expect(hit.normal.y).toBeCloseTo(-0.2182178902, 8);
  expect(hit.normal.z).toBeCloseTo(0.8728715609, 8);
  expect(groundVersion(map)).toBeGreaterThan(before);
});

it('tree canopy supplies no hull support while a feature does', () => {
  const map = makeState().map;
  map.tiles[10 * map.width + 10] = 'woods';
  const field = getHeightField(map), probe = groundProbe(map);
  expect(canopyAt(field, 10.5, 10.5)).toBeGreaterThan(7);
  const hit = probe(21, 21);
  expect(hit.heightM).toBe(0);
  expect(hit.normal.x).toBeCloseTo(0);
  expect(hit.normal.y).toBeCloseTo(0);
  expect(hit.normal.z).toBe(1);
  setTileProfile(field, 10, 10, 1.8);
  expect(probe(21, 21).heightM).toBeCloseTo(1.8);
});

it('clamps out-of-bounds positions and derivative samples to the map edges', () => {
  const map = makeState().map, field = getHeightField(map), profile = new Float32Array(16);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) profile[y * 4 + x] = x + y;
  for (const [x, y] of [[0, 0], [map.width - 1, 0], [0, map.height - 1], [map.width - 1, map.height - 1]]) {
    setTileProfile(field, x, y, profile);
  }
  const probe = groundProbe(map);
  expect(probe(-20, 1)).toEqual(probe(0, 1));
  expect(probe(1, -20)).toEqual(probe(1, 0));
  expect(probe(map.width * 2 + 20, 1)).toEqual(probe(map.width * 2, 1));
  expect(probe(1, map.height * 2 + 20)).toEqual(probe(1, map.height * 2));
});

it('initial fields have deterministic revision one even with authored crater marks', () => {
  for (const withCrater of [false, true]) {
    const map = makeState().map;
    if (withCrater) map.craterMarks = [{ x: 10.5, y: 10.5, sizeM: 2.5, kind: 'shell' }];
    expect(groundVersion(map)).toBe(1);
    expect(groundVersion(map)).toBe(1);
    if (withCrater) expect(groundProbe(map)(21, 21).heightM).toBeLessThan(-0.75);
  }
});

it('reattaches a restored physical field without losing its profile or changing its revision', () => {
  const map = makeState().map;
  setTileProfile(getHeightField(map), 10, 10, 0.4);
  const before = groundVersion(map), copy = structuredClone(getHeightField(map));
  // Restoring changes object identity, not geometry: keep the serialized surface.
  map.heightField = copy;
  expect(getHeightField(map)).toBe(copy);
  expect(groundVersion(map)).toBe(before);
  expect(groundProbe(map)(21, 21).heightM).toBeCloseTo(0.4);
});


it('tick-local uniform proofs match live five-point probes exactly across edges and mixed surfaces', () => {
  const map = makeState().map, field = getHeightField(map);
  for (const base of [0, -0, 7.25]) {
    field.height.fill(base);
    for (let y = 12; y < 45; y++) for (let x = 9; x < 39; x++)
      field.height[y * field.w + x] = (x - 18) * 0.125 + y * 0.03125;
    for (const [i, value] of [NaN, Infinity, -Infinity].entries()) field.height[(60 + i) * field.w + 50] = value;
    const live = groundProbe(map), tick = groundProbe(map, 'tick');
    let seed = 982451653;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const points = [[0, 0], [-0, -0], [-1, -1], [map.width * 2, map.height * 2],
      [map.width * 2 + 1, map.height * 2 + 1], [0.5, 0.5], [1.9999999999999998, 2], [2, 2], [2.0000000000000004, 2],
      [25, 30], [25, 30.5], [25, 31], [NaN, 1], [Infinity, -Infinity]];
    for (let i = 0; i < 5000; i++) points.push([random() * (map.width * 2 + 2) - 1, random() * (map.height * 2 + 2) - 1]);
    for (const [x, y] of points) {
      const a = live(x, y), b = tick(x, y);
      expect(Object.is(a.heightM, b.heightM)).toBe(true);
      for (const axis of ['x', 'y', 'z'] as const) expect(Object.is(a.normal[axis], b.normal[axis])).toBe(true);
    }
  }
});

it('a fresh completion probe sees terrain changes after a previous flat proof', () => {
  const map = makeState().map;
  expect(groundProbe(map, 'tick')(21, 21).heightM).toBe(0);
  setTileProfile(getHeightField(map), 10, 10, 0.4);
  expect(groundProbe(map, 'tick')(21, 21)).toEqual(groundProbe(map)(21, 21));
  expect(groundProbe(map, 'tick')(21, 21).heightM).toBeCloseTo(0.4);
});
