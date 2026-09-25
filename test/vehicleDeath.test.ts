import { describe, it, expect } from 'vitest';
import { rollDeathOutcome, vehicleDamageView } from '@/sim/vehicleDamage';
import { VEHICLE_DEFS } from '@/data/units';
import { Rng } from '@/shared/rng';
import type { Vehicle } from '@/shared/types';

function fakeVehicle(defId = 'pz4gh'): Vehicle {
  const def = VEHICLE_DEFS[defId];
  return {
    id: 1, teamId: 1, side: 'german', defId, pos: { x: 10, y: 10 }, hullFacing: 0, turretFacing: 0,
    state: 'knockedOut', mainAmmo: 10, coaxAmmo: 100, bowAmmo: 100, path: [], speed: 0,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, bowFireTimer: 0, burnTimer: 0, hits: 0,
  } as Vehicle;
}

const rngOf = (seq: number[]) => { let i = 0; return { next: () => seq[i++ % seq.length] }; };

describe('death outcome roll (item 011)', () => {
  it('covers the weighted set for a crew-aboard kill and never leaves the outcome unset', () => {
    const rng = new Rng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = fakeVehicle();
      rollDeathOutcome(rng, v, VEHICLE_DEFS['pz4gh'], true);
      expect(v.deathOutcome).toBeDefined();
      seen.add(v.deathOutcome!);
    }
    // the requested variety actually occurs
    for (const o of ['fire', 'hatchBlown', 'turretBlown', 'stopped', 'gunSag']) expect(seen.has(o)).toBe(true);
  });

  it('an empty hull usually just stops, sometimes blows', () => {
    const rng = new Rng(5);
    let stopped = 0, other = 0;
    for (let i = 0; i < 200; i++) {
      const v = fakeVehicle();
      rollDeathOutcome(rng, v, VEHICLE_DEFS['pz4gh'], false);
      if (v.deathOutcome === 'stopped') stopped++; else other++;
    }
    expect(stopped).toBeGreaterThan(other); // the empty hull's majority outcome is the quiet stop
  });

  it('hatchBlown and fire outcomes light the wreck for the renderer', () => {
    const v = fakeVehicle();
    rollDeathOutcome(rngOf([0.3]), v, VEHICLE_DEFS['pz4gh'], true); // fire band
    expect(vehicleDamageView(v).engineFire).toBe(true);
    const w = fakeVehicle();
    rollDeathOutcome(rngOf([0.55]), w, VEHICLE_DEFS['pz4gh'], true); // hatch band
    expect(vehicleDamageView(w).hatchesBlown).toBe(true);
    expect(w.hatchesBlown).toBe(true);
  });

  it('turretBlown sets the turret state the renderer already knows', () => {
    const v = fakeVehicle();
    rollDeathOutcome(rngOf([0.7]), v, VEHICLE_DEFS['pz4gh'], true);
    expect(v.turretBlown).toBe(true);
    expect(vehicleDamageView(v).turretBlown).toBe(true);
  });

  it('a casemate never gets a turret outcome', () => {
    for (let i = 0; i < 100; i++) {
      const v = fakeVehicle('su76');
      rollDeathOutcome({ next: Math.random }, v, VEHICLE_DEFS['su76'], true);
      expect(v.deathOutcome).not.toBe('turretBlown');
    }
  });
});
