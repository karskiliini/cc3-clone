import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { Rng } from '@/shared/rng';
import { createHullBody } from '@/sim/hullPhysics';
import { getHeightField, heightAt, setTileProfile, refreshTiles, syncCraterMarks, applyCrater } from '@/sim/heightField';
import { hashState } from '@/sim/stateHash';
import { onVehicleNearMiss, stepVehicles } from '@/sim/vehicle';
import { makeState, addTank } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';

function nextBit(n: number): number {
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, n); data.setBigUint64(0, data.getBigUint64(0) + 1n);
  return data.getFloat64(0);
}
function leaves(value: any, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, v]) => typeof v === 'number' || typeof v === 'boolean'
    ? [[...prefix, key]] : v && typeof v === 'object' ? leaves(v, [...prefix, key]) : []);
}
const specimen = createHullBody(VEHICLE_DEFS.t34_76, { x: 20, y: 20 }, 0.3, flat);
describe('physical state hashing', () => {
  for (const path of leaves(specimen)) it(`sees an exact-bit change in body.${path.join('.')}`, () => {
    const state = makeState(), rng = new Rng(1), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.body = structuredClone(specimen);
    const before = hashState({ state, rng });
    const obj = path.slice(0, -1).reduce((v: any, k) => v[k], v.body);
    const key = path.at(-1)!, old = obj[key]; obj[key] = typeof old === 'boolean' ? !old : nextBit(old);
    expect(hashState({ state, rng })).not.toBe(before);
  });
  it('sees body presence, contact count and gun elevation without initializing absent state', () => {
    const state = makeState(), rng = new Rng(4), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    const snapshot = structuredClone(v), random = rng.state(), before = hashState({ state, rng });
    expect(v).toEqual(snapshot); expect(state.map.heightField).toBeUndefined(); expect(rng.state()).toBe(random);
    v.body = structuredClone(specimen); const present = hashState({ state, rng }); expect(present).not.toBe(before);
    v.body.suspensionTravel.push(0); expect(hashState({ state, rng })).not.toBe(present);
    const contacts = hashState({ state, rng }); v.gunElevationRad = Number.MIN_VALUE;
    expect(hashState({ state, rng })).not.toBe(contacts);
  });
  const memory = { nearMiss: { pos: { x: 1, y: 2 }, weapon: WEAPONS.pak40, at: 2 },
    cover: { target: { x: 4, y: 5 }, route: [{ x: 3, y: 4 }], backing: true, bankStaging: { x: 2, y: 3 },
      bankApproach: true, fleeingSince: 1, cooldownUntil: 5, searchAfter: 6, fleeAnchor: { x: 7, y: 8 } },
    blockedSince: 2, firingSpotLook: { at: 2, target: { x: 3, y: 4 } }, backingOnMove: true, kTurning: true };
  for (const path of leaves(memory)) it(`sees navigation.${path.join('.')}`, () => {
    const state = makeState(), rng = new Rng(1), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.navigation = structuredClone(memory); const before = hashState({ state, rng });
    const obj = path.slice(0, -1).reduce((v: any, k) => v[k], v.navigation);
    const key = path.at(-1)!, old = obj[key]; obj[key] = typeof old === 'boolean' ? !old : nextBit(old);
    expect(hashState({ state, rng })).not.toBe(before);
  });
  it('sees a same-length route edit, surface revision and breach override', () => {
    const state = makeState(), rng = new Rng(1), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.path = [{ x: 22, y: 25 }]; const first = hashState({ state, rng }); v.path[0].x = nextBit(22);
    expect(hashState({ state, rng })).not.toBe(first);
    const field = getHeightField(state.map), before = hashState({ state, rng });
    setTileProfile(field, 20, 20, 0.1); expect(hashState({ state, rng })).not.toBe(before);
    const profile = hashState({ state, rng }); state.map.heightOverrides!.set(1, 0.5);
    expect(hashState({ state, rng })).not.toBe(profile);
  });
});

it('resumes physical cover memory and stamped terrain from a copied tick boundary', () => {
  const state = makeState(), rng = new Rng(3), { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 });
  state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
  onVehicleNearMiss(state, v, WEAPONS.pak40, { x: 200.5, y: 192.5 });
  for (let i = 0; i < 12; i++) { state.time += 0.1; stepVehicles(state, rng, 0.1); }
  expect(v.navigation?.cover?.target).toBeTruthy();
  const originalField = getHeightField(state.map);
  setTileProfile(originalField, 210, 210, 0.65);
  const shaped = new Float32Array(16).fill(0.35); shaped[5] = 0.7;
  setTileProfile(originalField, 212, 210, shaped);
  const revision = originalField.version;
  expect(heightAt(originalField, 210.5, 210.5)).toBeCloseTo(0.65);
  const def = state.map.def;
  const data = structuredClone({ ...state, map: { ...state.map, def: undefined } });
  const copy: typeof state = { ...data, map: { ...data.map, def } };
  const restoredRng = new Rng(rng.state());
  const field = copy.map.heightField!;
  expect(getHeightField(copy.map)).toBe(field);
  expect(field.version).toBe(revision);
  expect(heightAt(field, 210.5, 210.5)).toBeCloseTo(0.65);
  refreshTiles(state.map, [210 * state.map.width + 211]);
  refreshTiles(copy.map, [210 * copy.map.width + 211]);
  expect(copy.map.heightField!.base).toEqual(state.map.heightField!.base);
  expect(heightAt(field, 210.5, 210.5)).toBe(heightAt(state.map.heightField!, 210.5, 210.5));
  expect(heightAt(field, 210.5, 210.5)).toBeGreaterThan(0.5);
  expect(heightAt(field, 200.5, 200.5)).toBe(heightAt(state.map.heightField!, 200.5, 200.5));
  for (let i = 0; i < 80; i++) {
    state.time += 0.1; copy.time += 0.1;
    stepVehicles(state, rng, 0.1); stepVehicles(copy, restoredRng, 0.1);
    expect(copy.vehicles.get(v.id)).toEqual(v);
    expect(hashState({ state: copy, rng: restoredRng })).toBe(hashState({ state, rng }));
  }
});

it('hash distinguishes equal-revision surfaces with equal counts of different edits', () => {
  const state = makeState(), rng = new Rng(1);
  const f = getHeightField(state.map); setTileProfile(f, 20, 20, 0.2);
  const one = hashState({ state, rng });
  state.map.heightProfiles = new Map([[20 * state.map.width + 20, new Float32Array(16).fill(0.3)]]);
  expect(hashState({ state, rng })).not.toBe(one);
  state.map.craterMarks = [{ x: 30, y: 30, sizeM: 2, kind: 'shell' }];
  const a = hashState({ state, rng }); state.map.craterMarks[0].x += 0.5;
  expect(hashState({ state, rng })).not.toBe(a);
});

it('hashes direct crater inputs and their order relative to map marks', () => {
  const a = makeState(), b = makeState(), rng = new Rng(1);
  const af = getHeightField(a.map), bf = getHeightField(b.map);
  applyCrater(af, { x: 20, y: 20 }, 2); applyCrater(bf, { x: 21, y: 20 }, 2);
  expect(af.version).toBe(bf.version);
  expect(hashState({ state: a, rng })).not.toBe(hashState({ state: b, rng }));
  a.map.craterMarks = [{ x: 20, y: 20, sizeM: 3, kind: 'shell' }];
  b.map.craterMarks = structuredClone(a.map.craterMarks);
  syncCraterMarks(a.map, af); syncCraterMarks(b.map, bf);
  expect(af.directCraterEdits).toHaveLength(1);
  expect(bf.directCraterEdits).toHaveLength(1);
});

it('retains the direct-versus-mark crater application boundary', () => {
  const a = makeState(), b = makeState(), rng = new Rng(1);
  a.map.craterMarks = [{ x: 20, y: 20, sizeM: 3, kind: 'shell' }];
  b.map.craterMarks = structuredClone(a.map.craterMarks);
  // Build without pending marks, then add the same canonical mark in both scenes.
  const marks = a.map.craterMarks; a.map.craterMarks = []; b.map.craterMarks = [];
  const af = getHeightField(a.map), bf = getHeightField(b.map);
  a.map.craterMarks = marks; b.map.craterMarks = structuredClone(marks);
  applyCrater(af, { x: 20, y: 20 }, 2); syncCraterMarks(a.map, af);
  syncCraterMarks(b.map, bf); applyCrater(bf, { x: 20, y: 20 }, 2);
  expect(af.version).toBe(bf.version); expect(af.marksApplied).toBe(bf.marksApplied);
  expect(af.directCraterEdits![0].marksApplied).toBe(0);
  expect(bf.directCraterEdits![0].marksApplied).toBe(1);
  expect(hashState({ state: a, rng })).not.toBe(hashState({ state: b, rng }));
});

it('a lazy initial surface cache alone cannot change a fingerprint', () => {
  const state = makeState(), rng = new Rng(3), before = hashState({ state, rng });
  getHeightField(state.map);
  expect(hashState({ state, rng })).toBe(before);
});
