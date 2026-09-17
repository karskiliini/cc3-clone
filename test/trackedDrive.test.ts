// User report: ordered through a 90 degree turn, a tank started sliding straight at the target
// while its hull still pointed 30+ degrees away. A tracked vehicle must travel along its own
// heading, driving forward while it keeps turning.
import { describe, it, expect } from 'vitest';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { wrapAngle } from '@/shared/math';
import { stepVehicles } from '@/sim/vehicle';
import { makeState, addTank } from './vehicleDamageHelpers';

const DEG = Math.PI / 180;

function drive(defId: string, path: { x: number; y: number }[]): { maxSlipDeg: number; arrived: boolean; seconds: number } {
  const state = makeState();
  const { v } = addTank(state, defId, { x: 200, y: 200 }, 0, 50); // facing north
  v.path = path.map((p) => ({ ...p }));
  const rng = new Rng(3);
  let maxSlip = 0, t = 0;
  while (t < 240 && v.path.length > 0) {
    const before = { ...v.pos };
    state.time += SIM_DT; t += SIM_DT;
    stepVehicles(state, rng, SIM_DT);
    const dx = v.pos.x - before.x, dy = v.pos.y - before.y;
    const moved = Math.hypot(dx, dy);
    // ignore the last snap onto the final waypoint (a few centimetres)
    if (moved > 0.02 && v.path.length > 0) {
      const travel = Math.atan2(dx, -dy);
      maxSlip = Math.max(maxSlip, Math.abs(wrapAngle(travel - v.hullFacing)) / DEG);
    }
  }
  return { maxSlipDeg: maxSlip, arrived: v.path.length === 0, seconds: t };
}

describe('tracked vehicles never slip sideways', () => {
  for (const defId of ['pz4gh', 't34_76', 'kv1', 'tiger']) {
    it(`${defId}: drives an L-shaped route along its own heading and arrives`, () => {
      // north 20 tiles, then a right-angle turn east for 20 tiles
      const r = drive(defId, [{ x: 200, y: 180 }, { x: 220, y: 180 }]);
      expect(r.arrived).toBe(true);
      expect(r.maxSlipDeg).toBeLessThan(8);
      expect(r.seconds).toBeLessThan(120);
    });
  }

  it('a target 90 degrees off from a standstill: turns, then drives, never crabbing', () => {
    const r = drive('pz4gh', [{ x: 225, y: 200 }]); // due east while facing north
    expect(r.arrived).toBe(true);
    expect(r.maxSlipDeg).toBeLessThan(8);
  });

  it('closely spaced waypoints on a curve do not make it orbit', () => {
    const pts = []; for (let i = 1; i <= 12; i++) pts.push({ x: 200 + Math.sin(i * 0.13) * 30, y: 200 - (1 - Math.cos(i * 0.13)) * -30 - i * 0 });
    const r = drive('t34_76', pts.map((p, i) => ({ x: 200 + 30 * (1 - Math.cos(i * 0.13 + 0.13)), y: 200 - 30 * Math.sin(i * 0.13 + 0.13) })));
    expect(r.arrived).toBe(true);
    expect(r.maxSlipDeg).toBeLessThan(8);
  });
});
