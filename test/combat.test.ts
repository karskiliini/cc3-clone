import { describe, it, expect } from 'vitest';
import type { Soldier, WeaponDef } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { hitChance, penetrates } from '@/sim/combat';

function makeSoldier(overrides: Partial<Soldier> = {}): Soldier {
  return {
    id: 1,
    teamId: 1,
    side: 'german',
    name: 'Test',
    rank: 'Gefr',
    weaponId: 'kar98k',
    ammo: 5,
    ammoReserve: 20,
    grenades: 0,
    health: 'healthy',
    morale: 80,
    fatigue: 0,
    suppression: 0,
    experience: 50,
    stance: 'standing',
    activity: 'defending',
    pos: { x: 0, y: 0 },
    facing: 0,
    targetSoldierId: null,
    targetVehicleId: null,
    targetPoint: null,
    path: [],
    reloadTimer: 0,
    fireTimer: 0,
    animFrame: 0,
    isLeader: false,
    vehicleId: null,
    formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999,
    cover: 0,
    kills: 0,
    ...overrides,
  };
}

const rifle: WeaponDef = {
  id: 'kar98k', name: 'Kar98k', cls: 'rifle', rangeM: 400, rate: 0.4, burst: 1,
  accuracy: 0.35, lethality: 0.55, suppression: 0.15, penetrationMm: 0, heRadiusM: 0,
  ammo: 5, reloadS: 3,
};

const kwk40_75: WeaponDef = {
  id: 'kwk40_75', name: '7.5cm KwK 40', cls: 'tankgun', rangeM: 1400, rate: 0.4, burst: 1,
  accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4,
  ammo: 87, reloadS: 3,
};

describe('hitChance', () => {
  it('decreases with distance', () => {
    const shooter = makeSoldier();
    const near = hitChance(rifle, 50, 0, 'standing', shooter, false);
    const far = hitChance(rifle, 350, 0, 'standing', shooter, false);
    expect(far).toBeLessThan(near);
  });

  it('decreases with target cover', () => {
    const shooter = makeSoldier();
    const noCover = hitChance(rifle, 100, 0, 'standing', shooter, false);
    const withCover = hitChance(rifle, 100, 0.8, 'standing', shooter, false);
    expect(withCover).toBeLessThan(noCover);
  });

  it('decreases when target is prone vs standing', () => {
    const shooter = makeSoldier();
    const standing = hitChance(rifle, 100, 0, 'standing', shooter, false);
    const prone = hitChance(rifle, 100, 0, 'prone', shooter, false);
    expect(prone).toBeLessThan(standing);
  });

  it('is 0 beyond weapon range', () => {
    const shooter = makeSoldier();
    expect(hitChance(rifle, 500, 0, 'standing', shooter, false)).toBe(0);
  });
});

describe('penetrates', () => {
  it('kwk40_75 penetrates 45mm at 500m', () => {
    const rng = new Rng(42);
    expect(penetrates(kwk40_75, 500, 45, rng)).toBe(true);
  });

  it('kwk40_75 does not penetrate 100mm at 1000m', () => {
    const rng = new Rng(42);
    expect(penetrates(kwk40_75, 1000, 100, rng)).toBe(false);
  });
});
