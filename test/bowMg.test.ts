// The hull machine gun (VehicleDef.bowWeaponId): the radio operator's gun, along the hull.
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { BOW_MG_AMMO, inBowMgArc, stepCombat } from '@/sim/combat';
import { bowGunner, ensureDamage, ensureSeats, seatOccupant } from '@/sim/vehicleDamage';
import { stepVehicles } from '@/sim/vehicle';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';

const DEG = Math.PI / 180;
/** A Pz IV at (100,100) facing north, its turret crew's weapons out of it (no main gun or coax
 * rounds), and a spotted Soviet rifle squad `distM` away at `bearingDeg` off the hull. */
function scene(bearingDeg: number, defId = 'pz4gh', distM = 120): { state: BattleState; v: Vehicle; crew: Soldier[]; men: Soldier[] } {
  const state = makeState(1943);
  const { v, crew } = addTank(state, defId, { x: 100.5, y: 100.5 }, 0, 60);
  v.mainAmmo = 0; v.coaxAmmo = 0;
  const a = bearingDeg * DEG, r = distM / TILE_M;
  const at = { x: v.pos.x + Math.sin(a) * r, y: v.pos.y - Math.cos(a) * r };
  const men: Soldier[] = [];
  for (let i = 0; i < 6; i++) {
    const m = soldier(state.nextId++, 500, 'soviet', { x: at.x + (i - 2.5) * 0.6, y: at.y }, 'mosin', { stance: 'standing' });
    state.soldiers.set(m.id, m); men.push(m);
    state.spotted.german.add(m.id);
  }
  state.teams.set(500, mkTeam(500, 'rifle', men.map((m) => m.id), 'soviet', at));
  return { state, v, crew, men };
}
function run(state: BattleState, seconds: number, seed = 3, vehicles = false): void {
  const rng = new Rng(seed);
  for (let i = 0; i < seconds / SIM_DT; i++) {
    state.time += SIM_DT;
    if (vehicles) stepVehicles(state, rng, SIM_DT);
    stepCombat(state, rng, SIM_DT);
    state.events.length = 0; state.tracers.length = 0; state.explosions.length = 0; state.flashes.length = 0;
  }
}
const fired = (v: Vehicle): number => BOW_MG_AMMO - (v.bowAmmo ?? BOW_MG_AMMO);

describe('bow MG', () => {
  it('only the tanks that had one carry it', () => {
    const has = Object.values(VEHICLE_DEFS).filter((d) => d.bowWeaponId).map((d) => d.id).sort();
    expect(has).toEqual(['flammpanzer3', 'is2', 'kv1', 'panther', 'pantherA', 'pantherD', 'pz3j', 'pz4f1', 'pz4g', 'pz4gh', 'sherman76', 't34_76', 't34_85', 'tiger', 'tiger2']);
    for (const d of Object.values(VEHICLE_DEFS)) if (d.bowWeaponId) expect(WEAPONS[d.bowWeaponId]).toBeTruthy();
  });

  it('fires at infantry ahead of the hull and hurts or suppresses them', () => {
    const { state, v, men } = scene(0);
    run(state, 20);
    expect(fired(v)).toBeGreaterThan(20);
    expect(men.some((m) => m.health !== 'healthy' || m.suppression > 0)).toBe(true);
  });

  it('does not fire at infantry 40 degrees off the hull, whatever the turret does; it does once the hull faces them', () => {
    const { state, v, men } = scene(40);
    v.turretFacing = 40 * DEG; // the turret bears, the hull does not
    expect(inBowMgArc(v, men[0].pos)).toBe(false);
    run(state, 20);
    expect(fired(v)).toBe(0);
    v.hullFacing = 40 * DEG;
    run(state, 10);
    expect(fired(v)).toBeGreaterThan(0);
  });

  it('the arc is about 15 degrees either side, out to the coax\'s range', () => {
    const { v } = scene(0);
    const at = (deg: number, m: number) => ({ x: v.pos.x + Math.sin(deg * DEG) * (m / TILE_M), y: v.pos.y - Math.cos(deg * DEG) * (m / TILE_M) });
    expect(inBowMgArc(v, at(14, 200))).toBe(true);
    expect(inBowMgArc(v, at(-14, 200))).toBe(true);
    expect(inBowMgArc(v, at(17, 200))).toBe(false);
    expect(inBowMgArc(v, at(180, 50))).toBe(false);
    expect(inBowMgArc(v, at(0, 390))).toBe(true);
    expect(inBowMgArc(v, at(0, 420))).toBe(false);
  });

  it('never fires at a vehicle', () => {
    const { state, v, men } = scene(0);
    for (const m of men) { m.health = 'dead'; }
    const enemy = addTank(state, 't70', { x: 100.5, y: 60.5 }, Math.PI, 50);
    state.spottedVehicles.german.add(enemy.v.id);
    for (const c of enemy.crew) state.spotted.german.add(c.id); // even if its crew were somehow "spotted"
    run(state, 15);
    expect(fired(v)).toBe(0);
  });

  it('is silent with the radio operator dead', () => {
    const { state, v } = scene(0);
    seatOccupant(state, v, 'radioOp')!.health = 'dead';
    expect(bowGunner(state, v)).toBeNull();
    run(state, 20);
    expect(fired(v)).toBe(0);
  });

  it('is silent once the radio operator has taken the driver\'s seat', () => {
    const { state, v } = scene(0);
    const radioOp = seatOccupant(state, v, 'radioOp')!;
    seatOccupant(state, v, 'driver')!.health = 'dead';
    // the crew reshuffles (vehicleDamage.ts stepCrewSeats): the radio operator moves over
    let t = 0;
    while (ensureSeats(state, v).driver !== radioOp.id && t < 60) { run(state, 1, 5, true); t++; }
    expect(ensureSeats(state, v).driver).toBe(radioOp.id);
    expect(seatOccupant(state, v, 'radioOp')).toBeNull();
    const before = fired(v);
    run(state, 20, 6, true);
    expect(fired(v)).toBe(before);
  });

  it('is silent with the mount destroyed, and with no rounds left', () => {
    const a = scene(0);
    ensureDamage(a.v).bowMg = 'destroyed';
    run(a.state, 20);
    expect(fired(a.v)).toBe(0);
    const b = scene(0);
    b.v.bowAmmo = 3;
    run(b.state, 20);
    expect(b.v.bowAmmo).toBe(0);
  });

  it('the IS-2\'s fixed hull gun is the driver\'s; a StuG has none', () => {
    const is2 = scene(0, 'is2');
    expect(bowGunner(is2.state, is2.v)).toBe(seatOccupant(is2.state, is2.v, 'driver'));
    const stug = scene(0, 'stug3g');
    expect(bowGunner(stug.state, stug.v)).toBeNull();
    // (the StuG scene's infantry are its own side's enemies all the same: it just has no bow gun)
    run(stug.state, 10);
    expect(fired(stug.v)).toBe(0);
  });

  it('is deterministic', () => {
    const once = (): string => { const { state, v, men } = scene(5); run(state, 15, 11); return JSON.stringify([v.bowAmmo, men.map((m) => [m.health, m.suppression])]); };
    expect(once()).toBe(once());
  });
});
