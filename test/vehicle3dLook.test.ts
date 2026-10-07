import { describe, it, expect } from 'vitest';
import { modelNodes, vehiclePose, RECOIL_M, type VehicleLook } from '@/render/vehicle3d/look';

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
  it('recoil rocks the hull back along its facing by half the recoil distance', () => {
    const p = vehiclePose(look({ recoil: 1 }), true, { x: 0, y: 0 });
    expect(p.hullPos[2]).toBeCloseTo(40 + RECOIL_M * 0.5, 9);  // facing north: back = south
  });
  it('a blown turret lies at its landing point, pivot on the ground', () => {
    const p = vehiclePose(look({ turretBlown: true, turretLanding: { posTiles: { x: 12, y: 21 }, dirRad: 0.7 } }), true, { x: 0, y: 0.4 });
    expect(p.turretPivot).toEqual([24, 0, 42]);
    expect(p.turretYaw).toBeCloseTo(-0.7, 12);
  });
  it('a turretless vehicle has no turret pivot', () => {
    expect(vehiclePose(look({ defId: 'stug3g' }), false, null).turretPivot).toBeNull();
  });
});
