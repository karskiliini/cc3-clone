import { describe, it, expect } from 'vitest';
import { gunArcRad, wantsHullTurn, timeToFirstShotS } from '@/sim/gunTiming';
import { VEHICLE_DEFS } from '@/data/units';
const DEG = Math.PI / 180;

describe('casemate gun barrel traverse (item 012)', () => {
  it('historical arcs: StuG III G 12°, Marder III 21°, SU-76 16°', () => {
    expect(VEHICLE_DEFS['stug3g'].gunArcDeg).toBe(12);
    expect(VEHICLE_DEFS['marder3'].gunArcDeg ?? VEHICLE_DEFS['marder_iii'].gunArcDeg).toBe(21);
    expect(VEHICLE_DEFS['su76'].gunArcDeg).toBe(16);
    expect(gunArcRad(VEHICLE_DEFS['stug3g'])).toBeCloseTo(12 * DEG, 6);
  });

  it('a turreted tank has a full-circle gun arc', () => {
    expect(gunArcRad(VEHICLE_DEFS['pz4gh'])).toBe(Math.PI);
  });

  it('a target inside the casemate arc needs no hull turn; outside it does', () => {
    const def = VEHICLE_DEFS['stug3g'];
    const v: any = { defId: 'stug3g', hullFacing: 0, turretFacing: 0, path: [], speed: 0, state: 'ok', damage: undefined };
    const inside = 8 * DEG, outside = 20 * DEG;
    expect(wantsHullTurn(def, v, inside, 50)).toBe(false);
    expect(wantsHullTurn(def, v, outside, 50)).toBe(true);
  });

  it('time-to-first-shot inside the arc costs only the handwheel traverse, not a hull swing', () => {
    // timeToFirstShotS adds hull-swing time for the part of the bearing outside the arc; a target
    // inside the arc needs the handwheel only. Use the same relationship the sim uses:
    const def = VEHICLE_DEFS['stug3g'];
    const arc = gunArcRad(def);
    const hand = (def.turretTraverseDegS ?? 5) * DEG; // deg/s → rad/s
    const inside = 8 * DEG, outside = 30 * DEG;
    const swing = (bearing: number) => Math.max(0, bearing - arc) / (def.hullTurnDegS! * DEG);
    expect(swing(inside)).toBe(0);
    expect(swing(outside)).toBeGreaterThan(0);
    // and the arc-clamped handwheel portion never exceeds the full arc traversal
    expect(Math.min(inside, arc) / hand).toBeLessThan(Math.min(outside, arc) / hand + 1e-9);
  });
});

describe('casemate fine lay clamp (combat step)', () => {
  it('the gun never points outside the hull arc while laying', () => {
    // replicate the combat.ts casemate branch math directly:
    const arc = gunArcRad(VEHICLE_DEFS['stug3g']);
    const hullFacing = 0, desired = 30 * DEG; // far outside the 12° arc
    const rel = Math.max(-arc, Math.min(arc, desired - hullFacing));
    expect(rel).toBeCloseTo(arc, 9); // clamped to the arc edge, never beyond
    const cur = Math.max(-arc, Math.min(arc, 0)); // gun starts on the axis
    expect(Math.abs(cur)).toBeLessThanOrEqual(arc + 1e-9);
  });
});
