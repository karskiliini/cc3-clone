import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { applyOrder } from '@/sim/orders';
import { stepVehicles } from '@/sim/vehicle';
import { stepCombat } from '@/sim/combat';
import { bowGunner, crewEffects, ensureSeats, seatOccupant, stepCrewSeats, vehicleLoader } from '@/sim/vehicleDamage';
import { syncVehicleCrewDuties, vehicleCrewDuty } from '@/sim/vehicleCrewDuty';
import { activityWord, soldierRoleWord, weaponReadout } from '@/ui/hud/soldierMonitor';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { addTank, makeState } from './vehicleDamageHelpers';

function scene(def = 'pz4gh') {
  const state = makeState(), rng = new Rng(5);
  const crew = addTank(state, def, { x: 30.5, y: 40.5 }, 0, 60);
  const seats = ensureSeats(state, crew.v);
  return { state, rng, seats, ...crew };
}

describe('crew jobs and role readouts', () => {
  it('driving and shooting keeps the driver at the controls and the loader/gunner at their own jobs', () => {
    const { state, v, team, seats, rng } = scene();
    applyOrder(state, team, { type: 'moveFast', target: { x: 30.5, y: 10.5 }, issuedAt: 0 }, rng);
    for (let i = 0; i < 10; i++) { state.time += 0.1; stepVehicles(state, rng, 0.1); stepCombat(state, rng, 0.1); }
    const driver = state.soldiers.get(seats.driver!)!;
    v.gunState = 'loading'; v.loadedRound = 'ap'; v.mainFireTimer = 2; v.loadProgress = 0.4;
    v.gunLay = { key: 'p', aim: { x: 30.5, y: 5 }, designateLeftS: 0, fineLeftS: 3, totalS: 3 }; v.layProgress = 0.3;
    // A stale infantry task must never turn the mounted driver into an aiming gunner.
    driver.crewTask = { id: 'lay', progress: 0, walking: false }; driver.activity = 'firing';
    syncVehicleCrewDuties(state, v);
    expect(v.speed).toBeGreaterThan(0.1);
    expect(vehicleCrewDuty(state, v, driver)).toBe('driving');
    expect(driver.activity).toBe('moving'); expect(driver.crewTask).toBeUndefined(); expect(driver.aiming).toBeUndefined();
    expect(activityWord(driver, team, v, 'Driver', state)).toBe('Driving');
    expect(activityWord(state.soldiers.get(seats.gunner!)!, team, v, 'Gunner', state)).toBe('Aiming 30%');
    expect(activityWord(state.soldiers.get(seats.loader!)!, team, v, 'Loader', state)).toBe('Loading AP 40%');
    v.speed = 0; expect(activityWord(driver, team, v, 'Driver', state)).toBe('Waiting');
  });

  it('an idle loader waits and a commander watches; generic Fire activity does not make all crew fire', () => {
    const { state, v, team, seats } = scene();
    for (const s of state.soldiers.values()) s.activity = 'firing';
    expect(activityWord(state.soldiers.get(seats.loader!)!, team, v, 'Loader', state)).toBe('Watching');
    expect(activityWord(state.soldiers.get(seats.commander!)!, team, v, 'Commander', state)).toBe('Watching');
    expect(activityWord(state.soldiers.get(seats.driver!)!, team, v, 'Driver', state)).toBe('Waiting');
  });

  it('a casualty replacement is unavailable during the seat transfer and takes the new role only after it finishes', () => {
    const { state, v, team, seats } = scene();
    state.soldiers.get(seats.driver!)!.health = 'dead';
    stepCrewSeats(state, v);
    const sw = v.seatSwap!, man = state.soldiers.get(sw.soldierId)!;
    expect(sw.role).toBe('driver'); expect(seatOccupant(state, v, 'driver')).toBeNull();
    expect(activityWord(man, team, v, 'Driver', state)).toBe('Changing seat');
    expect(crewEffects(state, v).gunner?.id).not.toBe(man.id);
    state.time = sw.until; stepCrewSeats(state, v); v.speed = 1;
    expect(soldierRoleWord(v, [...state.soldiers.values()], 0, man, state)).toBe('Driver');
    expect(activityWord(man, team, v, 'Driver', state)).toBe('Driving');
  });

  it('does not use a driver as an implicit gunner or loader in an under-crewed vehicle', () => {
    const { state, v, seats } = scene();
    const driver = seats.driver!; v.seats = { driver };
    expect(crewEffects(state, v).gunner).toBeNull(); expect(vehicleLoader(state, v)).toBeNull();
  });

  it('two-man crew casualties retain their original role labels and bailed-out men show their handheld weapons', () => {
    const { state, v, team, crew, seats } = scene('t70');
    const driver = state.soldiers.get(seats.driver!)!; driver.health = 'dead'; v.seats = {};
    expect(soldierRoleWord(v, crew, 1, driver, state)).toBe('Driver');
    const commander = crew[0]; commander.vehicleId = null;
    expect(soldierRoleWord(v, crew, 0, commander, state)).toBe('Crew');
    expect(weaponReadout(commander, team, undefined, 'Crew').glyph).not.toBe('tankgun');
  });

  it('an unmanned turret does not traverse just because a Fire point was ordered', () => {
    const { state, v, seats, crew, rng } = scene();
    for (const s of crew) if (s.id !== seats.driver) s.health = 'incapacitated';
    v.targetPoint = { x: 50.5, y: 40.5 };
    state.time += 0.1; stepVehicles(state, rng, 0.1);
    expect(v.turretFacing).toBe(0);
  });

  it('a lone gunner does not traverse toward a fresh Fire point while his hands are loading', () => {
    const { state, v, rng } = scene('t70');
    v.mainFireTimer = 3; v.gunState = 'loading'; v.loadedRound = 'he';
    v.targetPoint = { x: 50.5, y: 40.5 };
    state.time += 0.1; stepVehicles(state, rng, 0.1);
    expect(v.turretFacing).toBe(0);
  });

  it('radioman shows the bow gun and its own ammunition, not the coax belt', () => {
    const { state, v, team, seats } = scene(); v.bowAmmo = 73; v.coaxAmmo = 222;
    const s = state.soldiers.get(seats.radioOp!)!;
    const ro = weaponReadout(s, team, v, 'Radioman');
    expect(ro.rounds).toBe(73); expect(ro.label).toBeTruthy();
    expect(WEAPONS[VEHICLE_DEFS[v.defId].bowWeaponId!]).toBeDefined();
  });
});

describe('one man cannot load and aim simultaneously', () => {
  it('a lone commander/gunner loads first, then resumes fine aiming', () => {
    const { state, v, team, seats, rng } = scene('t70');
    team.order = { type: 'fire', target: { x: 30.5, y: 10.5 }, issuedAt: 0 }; v.targetPoint = team.order.target;
    v.loadedRound = 'he'; v.mainFireTimer = 2; v.loadTotalS = 2; v.gunState = 'loading';
    v.gunLay = { key: 'p', aim: { ...team.order.target }, designateLeftS: 0, fineLeftS: 3, totalS: 3 };
    state.time += 0.1; stepCombat(state, rng, 0.1);
    expect(v.mainFireTimer).toBeLessThan(2); expect(v.gunLay!.fineLeftS).toBe(3);
    expect(activityWord(state.soldiers.get(seats.commander!)!, team, v, 'Commander', state)).toMatch(/^Loading/);
    v.mainFireTimer = 0;
    state.time += 0.1; stepCombat(state, rng, 0.1);
    expect(v.gunLay!.fineLeftS).toBeLessThan(3);
  });

  it('separate loader and gunner work in parallel, and only the actual gunner fires', () => {
    const { state, v, team, seats, rng } = scene();
    team.order = { type: 'fire', target: { x: 30.5, y: 10.5 }, issuedAt: 0 }; v.targetPoint = team.order.target;
    v.loadedRound = 'he'; v.mainFireTimer = 2; v.loadTotalS = 2; v.gunState = 'loading';
    v.gunLay = { key: 'p', aim: { ...team.order.target }, designateLeftS: 0, fineLeftS: 3, totalS: 3 };
    state.time += 0.1; stepCombat(state, rng, 0.1);
    expect(v.mainFireTimer).toBeLessThan(2); expect(v.gunLay!.fineLeftS).toBeLessThan(3);
    for (let i = 0; i < 150 && v.lastMainShotAt == null; i++) { state.time += 0.1; stepCombat(state, rng, 0.1); }
    expect(v.lastMainShotAt).toBeDefined();
    expect(state.soldiers.get(seats.gunner!)!.lastFiredAt).toBe(v.lastMainShotAt);
    expect(state.soldiers.get(seats.driver!)!.lastFiredAt).toBeLessThan(0);
  });

  it('a separate bow gunner can work on the move; a driver-operated bow gun waits for a halt', () => {
    const { state, v, seats } = scene(); v.speed = 2;
    expect(bowGunner(state, v)?.id).toBe(seats.radioOp);
    const fixed = scene('is2'); fixed.v.speed = 2;
    expect(bowGunner(fixed.state, fixed.v)).toBeNull(); fixed.v.speed = 0;
    expect(bowGunner(fixed.state, fixed.v)?.id).toBe(fixed.seats.driver);
  });
});
