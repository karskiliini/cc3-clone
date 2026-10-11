import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams, resolveVehiclePhysics, VEHICLE_PHYSICS_PROVENANCE } from '@/data/vehiclePhysics';
import { Battle } from '@/sim/battle';
import { hashState } from '@/sim/stateHash';
import type { HullBody, VehicleDef } from '@/shared/types';

it('every vehicle has finite, independent physical data and coherent CG-local bounds', () => {
  for (const d of Object.values(VEHICLE_DEFS)) {
    const p = hullParams(d), other = hullParams(d);
    expect(p.massKg).toBeGreaterThan(0);
    expect(p.contacts.length).toBeGreaterThan(2);
    for (const n of [p.massT, p.massKg, p.cgHeightM, p.hullHeightM, p.clearanceM,
      p.inertia.x, p.inertia.y, p.inertia.z, p.suspension.springKNm, p.suspension.travelM]) {
      expect(Number.isFinite(n), d.id).toBe(true);
      expect(n, d.id).toBeGreaterThan(0);
    }
    expect(d.driveKind, d.id).toBe(p.driveKind);
    expect(d.massT, d.id).toBe(p.massT);
    expect(d.hullHeightM, d.id).toBe(p.hullHeightM);
    expect(p.modelOriginLocal).toEqual({ x: 0, y: 0, z: -p.cgHeightM });
    expect(p.solidBox.min.z - p.modelOriginLocal.z).toBeCloseTo(p.clearanceM, 12);
    expect(p.solidBox.max.z - p.modelOriginLocal.z).toBeCloseTo(p.clearanceM + p.hullHeightM, 12);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Number.isFinite(p.solidBox.min[axis])).toBe(true);
      expect(Number.isFinite(p.solidBox.max[axis])).toBe(true);
      expect(p.solidBox.max[axis]).toBeGreaterThan(p.solidBox.min[axis]);
    }
    for (const c of p.contacts) {
      for (const n of Object.values(c.local)) expect(Number.isFinite(n)).toBe(true);
      expect(c.local.z).toBeCloseTo(-p.cgHeightM - 0.35 * p.suspension.travelM + (c.horn ? 0.2 : 0), 12);
    }
    expect(p.contacts).not.toBe(other.contacts);
    expect(p.contacts[0].local).not.toBe(other.contacts[0].local);
    expect(p.suspension).not.toBe(other.suspension);
    expect(p.solidBox.min).not.toBe(other.solidBox.min);
    expect(p.armor.belly).toBe(d.armor.belly ?? d.armor.top);
    expect(VEHICLE_PHYSICS_PROVENANCE[d.id]).toBeDefined();
  }
});

it('tracks have twelve resting supports and raised front/rear horns', () => {
  const p = hullParams(VEHICLE_DEFS.t34_76), supports = p.contacts.filter(c => !c.horn);
  expect(supports).toHaveLength(12);
  expect(p.contacts.filter(c => c.horn)).toHaveLength(4);
  for (const side of [-1, 1]) {
    const run = supports.filter(c => c.side === side);
    expect(run[0].local.x).toBeCloseTo(side * 1.26, 12);
    expect(run[0].local.y).toBeCloseTo(-2.412, 12);
    expect(run[5].local.y).toBeCloseTo(2.412, 12);
  }
  p.contacts.filter(c => c.horn).forEach((c, i) => expect(c.local.y).toBeCloseTo([-3.216, 3.216, -3.216, 3.216][i], 12));
  expect(p.massKg).toBe(26000);
  // 26 tonnes / 12 supports / 0.098 m compression at equilibrium.
  expect(p.suspension.springKNm).toBeCloseTo(216.8877551020408, 10);
  expect(p.suspension.damping).toBe(0.9);
});

it('halftracks keep rear supports behind their front wheels, including the single Kettenkrad wheel', () => {
  for (const id of ['sdkfz251', 'kettenkrad']) {
    const p = hullParams(VEHICLE_DEFS[id]);
    const rear = p.contacts.filter(c => !c.horn && !c.steer);
    expect(rear).toHaveLength(12);
    expect(rear[0].local.y).toBe(0);
    expect(rear[5].local.y).toBeCloseTo(0.36 * p.lengthM, 12);
    expect(p.contacts.filter(c => c.horn).map(c => c.local.y))
      .toEqual([-0.12 * p.lengthM, 0.48 * p.lengthM, -0.12 * p.lengthM, 0.48 * p.lengthM]);
    expect(p.contacts.filter(c => c.steer)).toHaveLength(id === 'kettenkrad' ? 1 : 2);
    for (const c of p.contacts.filter(c => c.steer)) expect(c.local.y).toBeCloseTo(-0.36 * p.lengthM, 12);
  }
  expect(hullParams(VEHICLE_DEFS.sdkfz251).cgHeightM).toBe(1.45);
  expect(hullParams(VEHICLE_DEFS.kv1).cgHeightM).toBe(1.1);
  expect(hullParams(VEHICLE_DEFS.sdkfz251).slopeTipDeg).toBeLessThan(35);
  expect(hullParams(VEHICLE_DEFS.kv1).slopeTipDeg).toBeGreaterThan(35);
});

it('wheeled exceptions use their model axles instead of the legacy kind', () => {
  const k = hullParams(VEHICLE_DEFS.kubelwagen), b = hullParams(VEHICLE_DEFS.bm13);
  expect(k.driveKind).toBe('wheeled'); expect(b.driveKind).toBe('wheeled');
  expect(k.contacts).toHaveLength(4); expect(b.contacts).toHaveLength(6);
  expect(k.contacts.map(c => c.local.y)).toEqual([-0.93, 0.93, -0.93, 0.93]);
  b.contacts.forEach((c, i) => expect(c.local.y).toBeCloseTo([-2.2, 0.95, 2, -2.2, 0.95, 2][i], 12));
  expect(k.contacts.filter(c => c.steer)).toHaveLength(2);
  expect(b.contacts.filter(c => c.driven)).toHaveLength(4);
});

it('model hull roof is independent of CG and excludes turret geometry', () => {
  const p = hullParams(VEHICLE_DEFS.kv1);
  expect(p.solidBox.min.z).toBeCloseTo(-0.65, 12);
  expect(p.solidBox.max.z).toBeCloseTo(0.52, 12);
  expect(p.hullHeightM).toBeCloseTo(1.17, 12);
});

// Independent source-derived roof fixtures from vehicles.py; each model fails separately.
// SU-76 rotated front-plate top: 1.695 + 0.525*cos(22°) + 0.02*sin(22°)
// = 2.189263655515882 m, rounded upward to a conservative 2.19 m hull envelope.
it.each([
  ['t34_76', 1.52], ['t34_85', 1.52], ['ot34', 1.52], // raised engine cover
  ['t28', 1.97], ['sherman76', 1.97], // driver cab / hoods
  ['su76', 2.19], // rotated fixed front armor plate
  ['is3', 1.52], // integral armor ridge: zr + 0.02
  ['is1', 1.58], ['is2', 1.58], // armored visor plug: zr - 0.05 + 0.16/2
] as const)('hull bounds include integral raised structural armor on %s', (id, roof) => {
  const p = hullParams(VEHICLE_DEFS[id]);
  const actualRoof = p.solidBox.max.z - p.modelOriginLocal.z;
  expect(actualRoof).toBeCloseTo(roof, 12);
  if (id === 'su76') expect(actualRoof).toBeGreaterThanOrEqual(2.189263655515882);
});

it('legacy literals resolve explicit overrides, fallback mass, box inertia and belly armor', () => {
  const d: VehicleDef = { id: 'legacy', name: 'fixture', kind: 'tank', lengthM: 4, widthM: 2,
    hullHeightM: 1, cgHeightM: 0.9, massT: 12, suspension: { springKNm: 100, damping: 0.8, travelM: 0.3 },
    speedRoadMs: 4, speedOffroadMs: 2, armor: { front: 10, side: 10, rear: 10, top: 3 },
    mainWeaponId: null, coaxWeaponId: null, hasTurret: false, crew: 2, mainAmmo: 0 };
  const p = hullParams(d);
  expect(resolveVehiclePhysics(d).massT).toBe(12);
  expect(p.inertia).toEqual({ x: 17000, y: 5000, z: 20000 });
  expect(p.armor.belly).toBe(3);
  expect(p.suspension).toEqual({ springKNm: 100, damping: 0.8, travelM: 0.3 });
  expect(hullParams({ ...d, massT: undefined }).massT).toBe(16);
  expect(hullParams({ ...d, massT: undefined, armor: { front: 0, side: 0, rear: 0, top: 0 } }).massT).toBe(2.4);
  expect(() => hullParams({ ...d, massT: 0 })).toThrow();
  expect(() => hullParams({ ...d, widthM: NaN })).toThrow();
  expect(() => hullParams({ ...d, suspension: { ...d.suspension!, travelM: 0 } })).toThrow();
});

function battle(): Battle {
  return new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7,
    durationS: 120, difficulty: 'normal', forces: { german: ['ger_pz3j'], soviet: [] } });
}
function body(): HullBody {
  return { position: { x: 1, y: 2, z: 3 }, velocity: { x: 1, y: 2, z: 3 },
    angularVelocity: { x: 1, y: 2, z: 3 }, orientation: { x: 1, y: 2, z: 3, w: 4 },
    suspensionTravel: [1, 2], asleep: false, hungUp: false, overturned: false,
    quietS: 1, tippedS: 2, hungS: 3, rockPhaseS: 4, rockTries: 1, groundVersion: 2 };
}
function nextBit(n: number): number {
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, n, true); view.setBigUint64(0, view.getBigUint64(0, true) + 1n, true);
  return view.getFloat64(0, true);
}

describe('optional body hashing', () => {
  it('distinguishes absent and present body and leaves body, ground and random stream alone', () => {
    const b = battle(), v = b.state.vehicles.values().next().value!;
    delete v.body; const absent = hashState(b); v.body = body();
    expect(hashState(b)).not.toBe(absent);
    const before = structuredClone(v.body), rng = b.rng.state(), ground = b.state.map.heightField;
    expect(hashState(b)).toBe(hashState(b));
    expect(v.body).toEqual(before); expect(b.rng.state()).toBe(rng); expect(b.state.map.heightField).toBe(ground);
    delete v.body; expect(hashState(b)).toBe(absent);
  });

  it('hashes the last float64 bit of every body component, timer, travel and gun elevation', () => {
    const b = battle(), v = b.state.vehicles.values().next().value!;
    v.body = body(); v.gunElevationRad = 1;
    const initial = hashState(b), baseline = structuredClone(v.body);
    const change = (mutate: (value: HullBody) => void): void => {
      v.body = structuredClone(baseline); mutate(v.body); expect(hashState(b)).not.toBe(initial);
    };
    for (const field of ['position', 'velocity', 'angularVelocity'] as const)
      for (const axis of ['x', 'y', 'z'] as const) change(value => { value[field][axis] = nextBit(value[field][axis]); });
    for (const axis of ['x', 'y', 'z', 'w'] as const) change(value => { value.orientation[axis] = nextBit(value.orientation[axis]); });
    for (const field of ['quietS', 'tippedS', 'hungS', 'rockPhaseS'] as const) change(value => { value[field] = nextBit(value[field]); });
    for (let i = 0; i < 2; i++) change(value => { value.suspensionTravel[i] = nextBit(value.suspensionTravel[i]); });
    v.body = structuredClone(baseline); v.gunElevationRad = nextBit(1); expect(hashState(b)).not.toBe(initial);
  });

  it('hashes each body flag, counter, revision, travel length and contact order', () => {
    const b = battle(), v = b.state.vehicles.values().next().value!;
    v.body = body(); const baseline = structuredClone(v.body), initial = hashState(b);
    for (const field of ['asleep', 'hungUp', 'overturned', 'rockTries', 'groundVersion'] as const) {
      v.body = structuredClone(baseline);
      if (typeof v.body[field] === 'boolean') (v.body[field] as boolean | number) = true;
      else (v.body[field] as boolean | number) = 3;
      expect(hashState(b), field).not.toBe(initial);
    }
    v.body = structuredClone(baseline); v.body.suspensionTravel.push(0); expect(hashState(b)).not.toBe(initial);
    v.body = structuredClone(baseline); v.body.suspensionTravel.reverse(); expect(hashState(b)).not.toBe(initial);
  });
});
