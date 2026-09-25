import { describe, it, expect } from 'vitest';
import { makeState, addTank, soldier } from './vehicleDamageHelpers';
import { inCoaxMgArc } from '@/sim/combat';
import { VEHICLE_DEFS } from '@/data/units';
const DEG = Math.PI / 180;

const at = (v: { pos: { x: number; y: number } }, deg: number, m: number) => ({
  x: v.pos.x + Math.sin(deg * DEG) * (m / 2),
  y: v.pos.y - Math.cos(deg * DEG) * (m / 2),
});

describe('coax MG field of fire (item 016)', () => {
  it('turreted tank: the coax fires within ±30 deg of the TURRET facing, not the hull', () => {
    const state = makeState(1943);
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 50);
    // hull faces north, turret slewed 60 deg east
    v.turretFacing = 60 * DEG;
    expect(inCoaxMgArc(v, at(v, 50, 200))).toBe(true);
    expect(inCoaxMgArc(v, at(v, 70, 200))).toBe(true);
    expect(inCoaxMgArc(v, at(v, 90, 200))).toBe(false); // past the ±30 arc
    expect(inCoaxMgArc(v, at(v, 0, 200))).toBe(false); // dead ahead of the hull, off the turret bearing
  });
  it('casemate gun (SU-85): the coax fires along the hull axis within the gun arc', () => {
    const state = makeState(1943);
    const { v } = addTank(state, 'su85', { x: 200.5, y: 200.5 }, 0, 50);
    v.turretFacing = v.hullFacing;
    expect(inCoaxMgArc(v, at(v, 5, 200))).toBe(true);
    // outside the 10 deg gun arc (0.9x)
    expect(inCoaxMgArc(v, at(v, 20, 200))).toBe(false);
  });
});
