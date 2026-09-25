import { describe, it, expect } from 'vitest';
import { resolveVehicleHit } from '@/sim/vehicleDamage';
import { VEHICLE_DEFS } from '@/data/units';
import type { Vehicle, WeaponDef } from '@/shared/types';
import { Rng } from '@/shared/rng';

function wreck(mainAmmo: number): { state: any; v: Vehicle } {
  const v: Vehicle = {
    id: 1, teamId: 1, side: 'german', defId: 'pz4gh', pos: { x: 10, y: 10 }, hullFacing: 0, turretFacing: 0,
    state: 'knockedOut', mainAmmo, coaxAmmo: 100, bowAmmo: 100, path: [], speed: 0,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, bowFireTimer: 0, burnTimer: 0, hits: 0,
  } as Vehicle;
  const state: any = { time: 10, teams: new Map(), map: { width: 24, height: 24, tiles: new Array(576).fill('open'), buildingId: new Int16Array(576).fill(-1), windows: new Uint8Array(576), smoke: new Float32Array(576), craters: [], ground: undefined }, vehicles: new Map([[1, v]]), events: [] };
  return { state, v };
}
const apGun: WeaponDef = { id: 'kwk40_75', name: '7.5 cm KwK 40', cls: 'tankgun', rangeM: 1500, rate: 0.2, burst: 1, accuracy: 0.7, lethality: 0.8, suppression: 0.4, penetrationMm: 120, heRadiusM: 3, ammo: 0, reloadS: 6, rounds: { ap: 12, he: 6 } };

describe('knocked-out wrecks remain ammunition hazards (item 013)', () => {
  it('an AP hit on a full rack can ignite the wreck (burning + rack fire)', () => {
    let ignited = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const { state, v } = wreck(90);
      const r = resolveVehicleHit(state, new Rng(seed), v, {
        weapon: apGun, round: 'ap', shooterPos: { x: 4, y: 10 }, shooterSide: 'soviet', distM: 400,
      });
      if (v.state === 'burning' && v.cookOff?.rackFire) ignited++;
    }
    expect(ignited).toBeGreaterThan(20); // rackP ≈ 0.38 × turret exposure 1.0
  });

  it('an empty wreck never ignites from a rack hit', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { state, v } = wreck(0);
      resolveVehicleHit(state, new Rng(seed), v, {
        weapon: apGun, round: 'ap', shooterPos: { x: 4, y: 10 }, shooterSide: 'soviet', distM: 400,
      });
      expect(v.state).toBe('knockedOut');
      expect(v.cookOff?.rackFire ?? false).toBe(false);
    }
  });

  it('a fuller rack ignites more often than a nearly empty one', () => {
    const rate = (ammo: number) => {
      let n = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const { state, v } = wreck(ammo);
        resolveVehicleHit(state, new Rng(seed), v, { weapon: apGun, round: 'ap', shooterPos: { x: 4, y: 10 }, shooterSide: 'soviet', distM: 400 });
        if (v.state === 'burning') n++;
      }
      return n;
    };
    expect(rate(90)).toBeGreaterThan(rate(5));
  });

  it('a burning wreck is inert to further hits', () => {
    const { state, v } = wreck(50);
    v.state = 'burning';
    const r = resolveVehicleHit(state, new Rng(1), v, { weapon: apGun, round: 'ap', shooterPos: { x: 4, y: 10 }, shooterSide: 'soviet', distM: 400 });
    expect(r.outcome).toBe('none');
  });
});

describe('rack ignition requires penetration (013 gate)', () => {
  const weakGun: WeaponDef = { id: 'ptrd', name: 'PTRD', cls: 'atrifle', rangeM: 500, rate: 0.2, burst: 1, accuracy: 0.6, lethality: 0.5, suppression: 0.3, penetrationMm: 10, heRadiusM: 0, ammo: 0, reloadS: 20, rounds: { ap: 30, he: 0 } };
  it('a bounced shot never lights the rack', () => {
    let ignited = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state, v } = wreck(90);
      resolveVehicleHit(state, new Rng(seed), v, { weapon: weakGun, round: 'ap', shooterPos: { x: 4, y: 10 }, shooterSide: 'soviet', distM: 100 });
      if (v.state === 'burning') ignited++;
    }
    expect(ignited).toBe(0); // 10 mm vs 80 mm glacis: everything bounces
  });
});
