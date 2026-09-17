// Tests for sim/vehicleVision.ts: a tank's eyes are its living crew, not one point at its centre.
import { describe, it, expect } from 'vitest';
import type { BattleState, Vec2, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { observerStandingSpotScore, type Spotter } from '@/sim/spotting';
import { vehicleEyes, isButtonedUp, BUTTON_UP_SUPPRESSION } from '@/sim/vehicleVision';
import { makeState, addTank } from './vehicleDamageHelpers';

/** Best certain-spot score of any of this vehicle's living eyes against `target`. */
function bestScore(state: BattleState, v: Vehicle, target: Vec2): number {
  let best = 0;
  for (const eye of vehicleEyes(state, v)) {
    const sp: Spotter = { pos: eye.pos, soldier: null, vehicleEye: eye };
    best = Math.max(best, observerStandingSpotScore(state, sp, target));
  }
  return best;
}

const CERTAIN = 0.5;

/** Metres -> tiles offset from `pos` along +x (east, since hull facing 0 = north = -y). */
function eastOf(pos: Vec2, metres: number): Vec2 { return { x: pos.x + metres / TILE_M, y: pos.y }; }
/** Metres -> tiles offset from `pos` along -y (north = facing 0). */
function aheadOf(pos: Vec2, metres: number): Vec2 { return { x: pos.x, y: pos.y - metres / TILE_M }; }

// pz4gh (5-man crew) seat order matches sim/vehicleDamage.ts's `seatRoles` for a 5-crew tank:
// commander, gunner, loader, driver, radioOp — same order `addTank` assigns its crew array in.
const [COMMANDER, GUNNER, LOADER, DRIVER, RADIO_OP] = [0, 1, 2, 3, 4];

function buttonUp(commander: { suppression: number }): void {
  commander.suppression = BUTTON_UP_SUPPRESSION;
}

describe('vehicleEyes', () => {
  it('a buttoned-up tank spots an enemy ahead along the turret at range, but not a man 40m to its side', () => {
    const state = makeState();
    const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
    buttonUp(crew[COMMANDER]);
    expect(isButtonedUp(state, crew[COMMANDER])).toBe(true);

    const ahead = aheadOf(v.pos, 200); // dead ahead, along the turret, well inside the gunner's sight range
    const flank = eastOf(v.pos, 40); // 40m to the side

    expect(bestScore(state, v, ahead)).toBeGreaterThanOrEqual(CERTAIN);
    expect(bestScore(state, v, flank)).toBeLessThan(CERTAIN);
  });

  it('the same flank point IS certainly spotted by an unbuttoned commander', () => {
    const state = makeState();
    const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
    // default fixture crew: suppression 0, lastIncomingAt way in the past -> unbuttoned
    expect(isButtonedUp(state, crew[COMMANDER])).toBe(false);

    const flank = eastOf(v.pos, 40);
    expect(bestScore(state, v, flank)).toBeGreaterThanOrEqual(CERTAIN);
  });

  it('with the commander dead the flank is blind even unbuttoned', () => {
    const state = makeState();
    const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
    crew[COMMANDER].health = 'dead';

    const flank = eastOf(v.pos, 40);
    expect(bestScore(state, v, flank)).toBe(0);
  });

  it('with the whole turret crew dead, only the forward hull wedge sees (short range)', () => {
    const state = makeState();
    const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
    crew[COMMANDER].health = 'dead';
    crew[GUNNER].health = 'dead';
    crew[LOADER].health = 'dead';
    const eyes = vehicleEyes(state, v);
    expect(eyes.map((e) => e.role).sort()).toEqual(['driver', 'radioOp']);

    const nearAhead = aheadOf(v.pos, 100); // well inside the driver's short range
    const farAhead = aheadOf(v.pos, 200);  // the gunner's long range, but the hull crew's is short
    const flank = eastOf(v.pos, 40);

    expect(bestScore(state, v, nearAhead)).toBeGreaterThanOrEqual(CERTAIN);
    expect(bestScore(state, v, farAhead)).toBe(0);
    expect(bestScore(state, v, flank)).toBe(0);
  });

  it('with the driver and bow gunner also dead, the vehicle has no eyes at all', () => {
    const state = makeState();
    const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
    for (const s of crew) s.health = 'dead';
    expect(vehicleEyes(state, v)).toEqual([]);
    expect(bestScore(state, v, aheadOf(v.pos, 50))).toBe(0);
  });

  it('eye positions and facings rotate with hull and turret facing independently', () => {
    const state = makeState();
    const hullFacing = Math.PI / 2; // east
    const { v } = addTank(state, 'pz4gh', { x: 100, y: 100 }, hullFacing);
    v.turretFacing = Math.PI; // traversed to face south, independent of the hull

    const eyes = vehicleEyes(state, v);
    const commander = eyes.find((e) => e.role === 'commander')!;
    const gunner = eyes.find((e) => e.role === 'gunner')!;
    const driver = eyes.find((e) => e.role === 'driver')!;

    // the turret ring sits on the hull, so its POSITION follows the hull facing (east)...
    expect(commander.pos.x).toBeGreaterThan(v.pos.x);
    expect(commander.pos.y).toBeCloseTo(v.pos.y, 5);
    // ...but the eye itself LOOKS along the turret facing (south), not the hull's
    expect(commander.facing).toBeCloseTo(Math.PI, 6);
    expect(gunner.facing).toBeCloseTo(Math.PI, 6);

    // the hull crew's position AND facing follow the hull (east)
    expect(driver.pos.x).toBeGreaterThan(v.pos.x);
    expect(driver.pos.y).toBeCloseTo(v.pos.y, 5);
    expect(driver.facing).toBeCloseTo(hullFacing, 6);

    // turret ring and hull-front offsets both grow with hull length off the same hull facing
    expect(commander.pos.x - v.pos.x).toBeGreaterThan(0);
    expect(driver.pos.x - v.pos.x).toBeGreaterThan(commander.pos.x - v.pos.x);
  });

  it('an unrecognised defId falls back to no eyes (spotting.ts falls back to the old point spotter)', () => {
    const state = makeState();
    const v: Vehicle = {
      id: 999, teamId: 1, side: 'german', defId: 'not-a-real-vehicle', pos: { x: 0, y: 0 },
      hullFacing: 0, turretFacing: 0, state: 'ok', mainAmmo: 0, coaxAmmo: 0, path: [], speed: 0,
      targetVehicleId: null, targetSoldierId: null, targetPoint: null, mainFireTimer: 0,
      coaxFireTimer: 0, burnTimer: 0, hits: 0,
    };
    expect(vehicleEyes(state, v)).toEqual([]);
  });
});
