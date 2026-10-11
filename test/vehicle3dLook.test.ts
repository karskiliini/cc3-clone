import { describe, it, expect } from 'vitest';
import { modelNodes, vehiclePose, type VehicleLook } from '@/render/vehicle3d/look';

function look(over: Partial<VehicleLook> = {}): VehicleLook {
  return {
    id: 1, defId: 't34_76', posTiles: { x: 10, y: 20 }, hullRad: 0, turretRad: 0, ko: false, liveButLeft: false,
    turretBlown: false, brokenTrack: null, turretLanding: null, season: 'summer', recoil: 0, ...over,
  };
}
const ALL = new Set(['hull_ok', 'hull_ko', 'hull_blown', 'hull_trackL', 'hull_trackR', 'turret_ok', 'turret_ko', 'turret_blown']);

describe('modelNodes mirrors the sprite entry choice', () => {
  it('live', () => expect(modelNodes(look(), ALL, true)).toEqual({ hull: 'hull_ok', turret: 'turret_ok', winterHull: false, winterTurret: false }));
  it('knocked out', () => expect(modelNodes(look({ ko: true }), ALL, true)).toMatchObject({ hull: 'hull_ko', turret: 'turret_ko' }));
  it('blown turret wins over everything', () => expect(modelNodes(look({ ko: true, turretBlown: true, brokenTrack: 'R' }), ALL, true)).toMatchObject({ hull: 'hull_blown', turret: 'turret_blown' }));
  it('thrown tracks only on a live hull; both = L', () => {
    expect(modelNodes(look({ brokenTrack: 'R' }), ALL, true).hull).toBe('hull_trackR');
    expect(modelNodes(look({ brokenTrack: 'both' }), ALL, true).hull).toBe('hull_trackL');
    expect(modelNodes(look({ brokenTrack: 'L', ko: true }), ALL, true).hull).toBe('hull_ko');
  });
  it('wheeled vehicles without track nodes fall back to the ok hull', () => {
    const wheeled = new Set(['hull_ok', 'hull_ko']);
    expect(modelNodes(look({ brokenTrack: 'L' }), wheeled, false)).toEqual({ hull: 'hull_ok', turret: null, winterHull: false, winterTurret: false });
  });
  it('winter: whitewash for live looks only, when the vehicle has a winter model', () => {
    expect(modelNodes(look({ season: 'winter' }), ALL, true)).toMatchObject({ winterHull: true, winterTurret: true });
    expect(modelNodes(look({ season: 'winter', ko: true }), ALL, true)).toMatchObject({ winterHull: false, winterTurret: false });
    expect(modelNodes(look({ season: 'winter' }), ALL, false)).toMatchObject({ winterHull: false, winterTurret: false });
    expect(modelNodes(look({ season: 'autumn' }), ALL, true)).toMatchObject({ winterHull: false, winterTurret: false });
  });
});

describe('vehiclePose', () => {
  it('places the hull at its tile position in metres, yaw = -facing', () => {
    const p = vehiclePose(look({ hullRad: 1.2, turretRad: 2 }), true, { x: 0, y: 0.4 });
    expect(p.hullPos).toEqual([20, 0, 40]);
    expect(p.hullYaw).toBeCloseTo(-1.2, 12);
    expect(p.turretYaw).toBeCloseTo(-2, 12);
  });
  it('the turret pivot rotates with the hull (forward offset, facing east)', () => {
    const p = vehiclePose(look({ hullRad: Math.PI / 2 }), true, { x: 0, y: 0.5 });
    expect(p.turretPivot![0]).toBeCloseTo(20.5, 9);
    expect(p.turretPivot![2]).toBeCloseTo(40, 9);
  });
  it('recoil leaves the hull origin stationary', () => {
    const p = vehiclePose(look({ recoil: 1 }), true, { x: 0, y: 0 });
    expect(p.hullPos[2]).toBeCloseTo(40, 9);  // facing north: back = south
  });
  it('a blown turret lies at its landing point, pivot on the ground', () => {
    const p = vehiclePose(look({ turretBlown: true, turretLanding: { posTiles: { x: 12, y: 21 }, dirRad: 0.7 } }), true, { x: 0, y: 0.4 });
    expect(p.turretPivot).toEqual([24, 0, 42]);
    expect(p.turretYaw).toBeCloseTo(-0.7, 12);
  });
  it('a blown turret without a landing lies beside the hull like the sprite (no pivot offset)', () => {
    const p = vehiclePose(look({ turretBlown: true }), true, { x: 0, y: 0.4 });
    expect(p.turretPivot![0]).toBeCloseTo(20 + 2.2 * 0.9, 9);
    expect(p.turretPivot![2]).toBeCloseTo(40 - 1.0 * 0.9, 9);
    expect(p.turretYaw).toBeCloseTo(-2.3, 12);
  });
  it('a turretless vehicle has no turret pivot', () => {
    expect(vehiclePose(look({ defId: 'stug3g' }), false, null).turretPivot).toBeNull();
  });
});

import { Quaternion, Vector3 } from 'three';
import { threeQuaternion, vehicleLook, vehicleScreenPoint } from '@/render/vehicle3d/look';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody } from '@/sim/hullPhysics';
import { addTank, makeState } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';

it.each([
  ['north', { x: 0, y: 0, z: 0, w: 1 }, [0, 0, -1], [0, 1, 0]],
  ['east', { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, [1, 0, 0], [0, 1, 0]],
  ['pitch', { x: 0.5, y: 0, z: 0, w: Math.sqrt(3) / 2 }, [0, -Math.sqrt(3) / 2, -0.5], [0, 0.5, -Math.sqrt(3) / 2]],
  ['roll', { x: 0, y: 0.5, z: 0, w: Math.sqrt(3) / 2 }, [0, 0, -1], [Math.sqrt(3) / 2, 0.5, 0]],
] as const)('maps canonical %s quaternion without handedness error', (_name, q, forward, up) => {
  const mapped = threeQuaternion(q);
  new Vector3(0, 0, -1).applyQuaternion(mapped).toArray().forEach((n, i) => expect(n).toBeCloseTo(forward[i], 12));
  new Vector3(0, 1, 0).applyQuaternion(mapped).toArray().forEach((n, i) => expect(n).toBeCloseTo(up[i], 12));
});

it('a pitched hull turns its turret by relative 90 degrees about hull-local up', () => {
  const p = vehiclePose(look({ bodyQuaternion: { x: 0.5, y: 0, z: 0, w: Math.sqrt(3) / 2 },
    worldCG: { x: 20, y: 40, z: 2 }, modelOriginLocal: { x: 0, y: 0, z: -1 }, turretRad: Math.PI / 2 }), true,
  { x: 0, y: 0.62 }, { x: 0, y: -0.62, z: 0 });
  expect(p.turretPivot![0]).toBeCloseTo(20);
  expect(p.turretPivot![1]).toBeCloseTo(1.5 - 0.62 * Math.sqrt(3) / 2);
  expect(p.turretPivot![2]).toBeCloseTo(40 + Math.sqrt(3) / 2 - 0.31);
  const q = new Quaternion().fromArray(p.turretQuaternion);
  expect(new Vector3(0, 0, -1).applyQuaternion(q).x).toBeCloseTo(1);
  expect(new Vector3(0, 1, 0).applyQuaternion(q).z).toBeCloseTo(-Math.sqrt(3) / 2);
});

it('detached turret pose keeps its own landing height and yaw when the body tilts', () => {
  const l = look({ bodyQuaternion: { x: 0.5, y: 0, z: 0, w: Math.sqrt(3) / 2 },
    turretBlown: true, turretLanding: { posTiles: { x: 12, y: 21 }, dirRad: Math.PI / 2 }, turretLandingGroundM: 7 });
  const p = vehiclePose(l, true, { x: 0, y: 0.62 });
  expect(p.turretPivot).toEqual([24, 7, 42]);
  const direction = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().fromArray(p.turretQuaternion));
  expect(direction.x).toBeCloseTo(1); expect(direction.y).toBeCloseTo(0);
});

it('copies body and contact travel using the existing loaded suspension datum', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId], p = hullParams(def);
  v.body = createHullBody(def, v.pos, 0, flat); v.gunElevationRad = 0.3;
  v.body.suspensionTravel = p.contacts.map(c => c.horn ? 999 : 0.35 * p.suspension.travelM + (c.side === -1 ? -0.02 : 0.03));
  const saved = JSON.stringify(v.body), l = vehicleLook(v, state);
  expect(l.gunElevationRad).toBe(0.3); expect(l.wheelTravelM!.L).toBeCloseTo(-0.02); expect(l.wheelTravelM!.R).toBeCloseTo(0.03);
  expect(l.worldCG).not.toBe(v.body.position); expect(l.bodyQuaternion).not.toBe(v.body.orientation);
  expect(l.posTiles).not.toBe(v.pos); l.bodyQuaternion!.x = 99; l.worldCG!.z = 99;
  expect(JSON.stringify(v.body)).toBe(saved); expect(state.map.heightField).toBeUndefined();
  v.body.suspensionTravel = p.contacts.map(() => 0.35 * p.suspension.travelM);
  expect(vehicleLook(v, state).wheelTravelM!.L).toBeCloseTo(0); expect(vehicleLook(v, state).wheelTravelM!.R).toBeCloseTo(0);
});

it('fallback and overlay screen anchors use rotated model origin and height', () => {
  const l = look({ bodyQuaternion: { x: 0.5, y: 0, z: 0, w: Math.sqrt(3) / 2 },
    worldCG: { x: 20, y: 40, z: 2 }, modelOriginLocal: { x: 0, y: 0, z: -1 } });
  const actual = vehicleScreenPoint({ x: 0, y: 0, zoom: 2 }, l);
  expect(actual.x).toBeCloseTo(400);
  expect(actual.y).toBeCloseTo((40 + Math.sqrt(3) / 2) * 20 - 1.5 * Math.sin(Math.PI / 15) * 20);
});

it('copies centreline support compression without contaminating either track bank', () => {
  const state = makeState(), { v } = addTank(state, 'kettenkrad', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId], p = hullParams(def);
  v.body = createHullBody(def, v.pos, 0, flat);
  const nominal = 0.35 * p.suspension.travelM;
  v.body.suspensionTravel = p.contacts.map(() => nominal);
  const centreIndex = p.contacts.findIndex(c => !c.horn && c.local.x === 0);
  const nominalLook = vehicleLook(v, state);
  expect(nominalLook.centreWheelTravelM).toEqual([{ yM: p.contacts[centreIndex].local.y, travelM: 0 }]);
  v.body.suspensionTravel[centreIndex] += 0.06;
  const saved = JSON.stringify(v.body), l = vehicleLook(v, state);
  expect(l.wheelTravelM!.L).toBeCloseTo(0); expect(l.wheelTravelM!.R).toBeCloseTo(0);
  expect(l.centreWheelTravelM![0].travelM).toBeCloseTo(0.06);
  l.centreWheelTravelM![0].travelM = 99;
  expect(JSON.stringify(v.body)).toBe(saved); expect(state.map.heightField).toBeUndefined();
});
