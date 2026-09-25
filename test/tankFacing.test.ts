// Play-feedback regressions (2026-09-26):
//  1. "when I press defend, and a new direction, the tank immediately jumps to that direction"
//  2. "a tiger tank tends to turn its back and the back of its turret to the most dangerous enemy"
import { describe, it, expect } from 'vitest';
import type { BattleState, Vehicle } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { angleTo, wrapAngle } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { stepCombat } from '@/sim/combat';
import { stepVehicles, isVehicleReversing } from '@/sim/vehicle';
import { applyOrder } from '@/sim/orders';
import { setTile } from '@/sim/map';
import { makeState, addTank, addGun } from './vehicleDamageHelpers';

const DEG = Math.PI / 180;
const off = (a: number, b: number): number => Math.abs(wrapAngle(a - b));
const at = (deg: number, r: number): { x: number; y: number } => ({ x: 200 + Math.sin(deg * DEG) * r, y: 200 - Math.cos(deg * DEG) * r });

function step(state: BattleState, rng: Rng): void {
  state.time += SIM_DT;
  stepVehicles(state, rng, SIM_DT);
  stepCombat(state, rng, SIM_DT);
}

describe('a Defend/Ambush order in battle never snaps a vehicle round', () => {
  for (const type of ['defend', 'ambush'] as const) {
    it(`${type}: the Tiger's hull and turret come round at their real rates`, () => {
      const state = makeState();
      expect(state.phase).toBe('running');
      const { v, team } = addTank(state, 'tiger', { x: 200, y: 200 }, 0);
      const rng = new Rng(1);
      applyOrder(state, team, { type, target: at(150, 20), issuedAt: 0 }, rng);
      // nothing moved at issue time
      expect(v.hullFacing).toBe(0);
      expect(v.turretFacing).toBe(0);
      const def = VEHICLE_DEFS.tiger;
      const hullMax = def.hullTurnDegS! * DEG * SIM_DT, turretMax = (def.hullTurnDegS! + def.turretTraverseDegS!) * DEG * SIM_DT;
      for (let i = 0; i < 40 / SIM_DT; i++) {
        const h = v.hullFacing, t = v.turretFacing;
        step(state, rng);
        expect(off(v.hullFacing, h)).toBeLessThanOrEqual(hullMax + 1e-9);
        expect(off(v.turretFacing, t)).toBeLessThanOrEqual(turretMax + 1e-9);
      }
      // ... and it does get there
      expect(off(v.hullFacing, 150 * DEG)).toBeLessThan(5 * DEG);
      expect(off(v.turretFacing, 150 * DEG)).toBeLessThan(5 * DEG);
    });
  }

  it('the deploy-phase snap (G23) still applies before the battle starts', () => {
    const state = makeState();
    state.phase = 'deploy';
    const { v, team } = addTank(state, 'tiger', { x: 200, y: 200 }, 0);
    applyOrder(state, team, { type: 'defend', target: at(90, 20), issuedAt: 0 }, new Rng(1));
    expect(off(v.hullFacing, 90 * DEG)).toBeLessThan(1e-6);
    expect(off(v.turretFacing, 90 * DEG)).toBeLessThan(1e-6);
  });

  it('a crew-served gun is not pivoted instantly in battle (the crew lays it round)', () => {
    const state = makeState();
    const { team } = addGun(state, 'pak40', { x: 200, y: 200 });
    applyOrder(state, team, { type: 'defend', target: at(90, 20), issuedAt: 0 }, new Rng(1));
    expect(team.crewWeapon!.facing).toBe(0);
  });
});

/** A Tiger at the centre, hull north, an enemy tank that cannot fire back (so the duel runs its
 * course) `deg` off the bow at `r` tiles, both spotted. */
function tigerVersus(enemyId: string, deg: number, r: number): { state: BattleState; v: Vehicle; e: Vehicle } {
  const state = makeState(1944);
  const { v } = addTank(state, 'tiger', { x: 200.5, y: 200.5 }, 0, 50, 'german');
  const { v: e } = addTank(state, enemyId, at(deg, r), wrapAngle(deg * DEG + Math.PI), 50, 'soviet');
  state.spottedVehicles.german.add(e.id);
  state.spottedVehicles.soviet.add(v.id);
  return { state, v, e };
}

describe('a Tiger faces the most dangerous enemy with its FRONT, hull and turret', () => {
  for (const deg of [90, 180, -120]) {
    it(`an enemy tank ${deg} deg off the bow: hull and gun both end up on it`, () => {
      const { state, v, e } = tigerVersus('is2', deg, 150);
      e.mainAmmo = 0; // it cannot answer: the Tiger stands and fights (no flight to cover)
      const rng = new Rng(3);
      for (let i = 0; i < 40 / SIM_DT; i++) step(state, rng);
      const bearing = angleTo(v.pos, e.pos);
      expect(off(v.hullFacing, bearing)).toBeLessThan(10 * DEG);
      expect(off(v.turretFacing, bearing)).toBeLessThan(5 * DEG);
    });
  }

  it('an enemy that fires on it: the Tiger engages and brings its front round', () => {
    const { state, v, e } = tigerVersus('t34_85', 180, 180);
    const rng = new Rng(5);
    let prevErr = Infinity;
    for (let i = 0; i < 32 / SIM_DT && v.state === 'ok'; i++) {
      step(state, rng);
      // the hull never swings AWAY from it (the error only ever shrinks or holds)
      const err = off(v.hullFacing, angleTo(v.pos, e.pos));
      expect(err).toBeLessThanOrEqual(prevErr + 1e-3);
      prevErr = err;
    }
    expect(v.state).toBe('ok');
    expect(e.lastMainShotAt).toBeDefined(); // it was shot at
    expect(v.lastMainShotAt).toBeDefined(); // and it answered
    expect(off(v.hullFacing, angleTo(v.pos, e.pos))).toBeLessThan(10 * DEG);
    expect(off(v.turretFacing, angleTo(v.pos, e.pos))).toBeLessThan(5 * DEG);
  });

  for (const [deg, label] of [[0, 'dead ahead'], [90, 'off the flank']] as const) {
    it(`backing into cover from a threat ${label} keeps the front toward it (never turns tail)`, () => {
      const { state, v, e } = tigerVersus('is2', deg, 30);
      // woods on the far side of the Tiger from the threat
      const c = at(deg + 180, 8);
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) setTile(state.map, Math.floor(c.x) + dx, Math.floor(c.y) + dy, 'woods');
      const rng = new Rng(3);
      let reversed = false, worst = 0;
      for (let i = 0; i < 18 / SIM_DT && v.state === 'ok' && e.state === 'ok'; i++) {
        step(state, rng);
        if (!isVehicleReversing(state, v)) continue;
        if (v.speed < 0) reversed = true;
        // once the hull has had time to come round to the threat (90 deg at 12 deg/s)
        if (state.time > 8) worst = Math.max(worst, off(v.hullFacing, angleTo(v.pos, e.pos)));
      }
      expect(reversed).toBe(true);
      expect(worst).toBeLessThan(Math.PI / 2);
    });
  }
});
