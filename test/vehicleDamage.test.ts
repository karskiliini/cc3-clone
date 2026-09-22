// Locational vehicle damage (req_ammo_damage C): zones, crew roles, equipment states.
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import {
  resolveVehicleHit, locateHit, isHullDown, TURRET_ZONES, seatOccupant, crewEffects, stepCrewSeats, ensureDamage,
  vehicleDamageView, stepVehicleDamage, isImmobile, vehicleLayout, seatRoles, FIRE_BAIL_S, SEAT_SWAP_S,
  LOADER_DOWN_RELOAD_MUL, RADIO_OUT_ORDER_DELAY_S, sightAccuracyMul, sideShare, type HitLocation,
} from '@/sim/vehicleDamage';
import { applyHESplash, stepCombat } from '@/sim/combat';
import { stepVehicles } from '@/sim/vehicle';
import { applyOrder, stepAttackOrders, delayedOrderOf } from '@/sim/orders';
import { setTile } from '@/sim/map';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';

const SHOOTER = { x: 100, y: 0 }; // due north of a tank at (100,100) facing north = dead ahead, 200 m
const big = WEAPONS.kwk42_75;

function fresh(defId: string, hullFacing = 0, experience = 60): { state: BattleState; v: Vehicle; crew: Soldier[] } {
  const state = makeState();
  const t = addTank(state, defId, { x: 100, y: 100 }, hullFacing, experience);
  return { state, v: t.v, crew: t.crew };
}
function hit(state: BattleState, rng: Rng, v: Vehicle, location: HitLocation, weapon = big) {
  return resolveVehicleHit(state, rng, v, { weapon, round: 'ap', shooterPos: SHOOTER, shooterSide: v.side === 'german' ? 'soviet' : 'german', distM: 200, location });
}
const down = (s: Soldier) => s.health === 'dead' || s.health === 'incapacitated';

describe('crew seats', () => {
  it('layout defaults by class and crew size', () => {
    expect(seatRoles(VEHICLE_DEFS.panther)).toEqual(['commander', 'gunner', 'loader', 'driver', 'radioOp']);
    expect(seatRoles(VEHICLE_DEFS.t34_76)).toEqual(['commander', 'loader', 'driver', 'radioOp']); // two-man turret
    expect(seatRoles(VEHICLE_DEFS.t26)).toEqual(['commander', 'loader', 'driver']);
    expect(vehicleLayout(VEHICLE_DEFS.pz4gh).transmission).toBe('front');
    expect(vehicleLayout(VEHICLE_DEFS.t34_76).transmission).toBe('rear');
    expect(vehicleLayout(VEHICLE_DEFS.su76).openTop).toBe(true);
    expect(vehicleLayout(VEHICLE_DEFS.tiger).openTop).toBe(false);
    const { state, v, crew } = fresh('t34_76');
    expect(seatOccupant(state, v, 'gunner')!.id).toBe(crew[0].id); // the commander lays the gun
  });
});

describe('penetrations by zone', () => {
  it('a penetrating turret-front hit can kill gunner and loader but never the driver', () => {
    const rng = new Rng(5);
    let gunner = 0, loader = 0, driver = 0, radio = 0;
    for (let i = 0; i < 400; i++) {
      const { state, v, crew } = fresh('pz4gh');
      const drv = seatOccupant(state, v, 'driver')!, rop = seatOccupant(state, v, 'radioOp')!;
      const g = seatOccupant(state, v, 'gunner')!, l = seatOccupant(state, v, 'loader')!;
      const r = hit(state, rng, v, { zone: 'turretFront', face: 'front' });
      expect(r.penetrated).toBe(true);
      if (r.outcome === 'explosion' || r.outcome === 'fire') continue; // those take everyone
      if (down(g)) gunner++;
      if (down(l)) loader++;
      if (drv.health !== 'healthy') driver++;
      if (rop.health !== 'healthy') radio++;
      void crew;
    }
    expect(gunner).toBeGreaterThan(20);
    expect(loader).toBeGreaterThan(20);
    expect(driver).toBe(0);
    expect(radio).toBe(0);
  });

  it('a lower-hull front hit can wreck a Pz IV transmission and immobilise it; the same hit on a T-34 cannot (rear drive)', () => {
    const rng = new Rng(8);
    let pz = 0, t34 = 0;
    for (let i = 0; i < 300; i++) {
      const a = fresh('pz4gh');
      hit(a.state, rng, a.v, { zone: 'hullFrontLower', face: 'front' });
      if (a.v.damage?.transmission === 'destroyed') { pz++; expect(isImmobile(a.v)).toBe(true); expect(['immobilized', 'knockedOut', 'burning', 'abandoned']).toContain(a.v.state); }
      const b = fresh('t34_76');
      hit(b.state, rng, b.v, { zone: 'hullFrontLower', face: 'front' });
      if ((b.v.damage?.transmission ?? 'ok') !== 'ok') t34++;
    }
    expect(pz).toBeGreaterThan(40);
    expect(t34).toBe(0);
  });

  it('an engine-deck penetration can start a fire, and a fire forces the crew out within seconds', () => {
    const rng = new Rng(12);
    let fires = 0, bailed = 0;
    for (let i = 0; i < 200; i++) {
      const { state, v, crew } = fresh('t34_76');
      const r = hit(state, rng, v, { zone: 'engineDeck', face: 'rear' });
      if (r.outcome === 'explosion') continue;
      if (r.outcome !== 'fire') { expect(crew.every((c) => c.health === 'healthy')).toBe(true); continue; } // nobody sits in the engine bay
      fires++;
      expect(v.state).toBe('burning');
      expect(state.messages.some((m) => m.text.includes('Engine on fire — bail out!'))).toBe(v.side === state.config.playerSide);
      state.time += FIRE_BAIL_S + 0.1;
      stepVehicleDamage(state, rng, v);
      const out = crew.filter((c) => !down(c));
      expect(out.every((c) => c.vehicleId === null && c.activity === 'panicked')).toBe(true);
      if (out.length > 0) bailed++;
    }
    expect(fires).toBeGreaterThan(40);
    expect(bailed).toBeGreaterThan(30);
  });

  it('an ammunition explosion kills the crew and blows the turret off', () => {
    const rng = new Rng(2);
    let boom = 0;
    for (let i = 0; i < 300; i++) {
      const { state, v, crew } = fresh('pz4gh');
      const r = hit(state, rng, v, { zone: 'hullSide', face: 'side' });
      if (r.outcome !== 'explosion') continue;
      boom++;
      expect(crew.every((c) => c.health === 'dead')).toBe(true);
      expect(v.state).toBe('burning');
      expect(v.turretBlown).toBe(true);
      expect(vehicleDamageView(v).turretKey).toBe('turret.blown');
      expect(state.events.some((e) => e.kind === 'vehicleKO')).toBe(true);
      expect(state.messages.some((m) => m.text.endsWith('Ammunition explodes!'))).toBe(true);
    }
    // most rack hits now burn first (sim/vehicleExplosion.ts: 15-25 % of destroyed tanks end catastrophically)
    expect(boom).toBeGreaterThan(10);
  });

  it('a hit that does not get through can still jam the ring, break the sight or spall, and shakes the crew', () => {
    const rng = new Rng(3);
    let jam = 0, sight = 0;
    for (let i = 0; i < 600; i++) {
      const { state, v } = fresh('kv1');
      const r = hit(state, rng, v, { zone: i % 2 ? 'turretFront' : 'mantlet', face: 'front' }, WEAPONS.pak38);
      expect(r.penetrated).toBe(false);
      expect(['ok', 'immobilized', 'abandoned']).toContain(v.state);
      if ((v.damage?.traverse ?? 'ok') !== 'ok') jam++;
      if ((v.damage?.sight ?? 'ok') !== 'ok') sight++;
    }
    expect(jam).toBeGreaterThan(5);
    expect(sight).toBeGreaterThan(5);
  });
});

describe('hit location', () => {
  it('shifts from the front plate to the side with the attack bearing, and the turret has its own facing', () => {
    expect(sideShare(0)).toBe(0);
    expect(sideShare((30 * Math.PI) / 180)).toBe(0);
    expect(sideShare(Math.PI / 2)).toBe(1);
    expect(sideShare(Math.PI)).toBe(0);
    const { v } = fresh('pz4gh');
    v.turretFacing = Math.PI / 2; // turret traversed right: the shooter ahead sees its left side
    const rng = new Rng(1);
    const zones = new Set<string>();
    for (let i = 0; i < 2000; i++) zones.add(locateHit(rng, v, VEHICLE_DEFS.pz4gh, SHOOTER).zone);
    expect(zones.has('turretSide')).toBe(true);
    expect(zones.has('turretFront')).toBe(false);
    expect(zones.has('hullFrontUpper')).toBe(true);
    expect(zones.has('hullSide')).toBe(false);
  });

  it('a hull-down tank only takes turret-zone hits', () => {
    const { state, v } = fresh('t34_76');
    expect(isHullDown(state, v, SHOOTER)).toBe(false);
    for (let dx = -1; dx <= 1; dx++) setTile(state.map, 100 + dx, 99, 'stonewall');
    expect(isHullDown(state, v, SHOOTER)).toBe(true);
    const rng = new Rng(4);
    for (let i = 0; i < 300; i++) {
      const s2 = makeState();
      for (let dx = -1; dx <= 1; dx++) setTile(s2.map, 100 + dx, 99, 'stonewall');
      const t = addTank(s2, 't34_76', { x: 100, y: 100 }, 0);
      const r = resolveVehicleHit(s2, rng, t.v, { weapon: big, round: 'ap', shooterPos: SHOOTER, shooterSide: 'german', distM: 200 });
      expect(TURRET_ZONES.has(r.location.zone), r.location.zone).toBe(true);
    }
  });
});

describe('crew casualties by role', () => {
  it('dead gunner: the commander takes over after the swap, with worse accuracy', () => {
    const { state, v } = fresh('pz4gh');
    const g = seatOccupant(state, v, 'gunner')!;
    const cmd = seatOccupant(state, v, 'commander')!;
    expect(crewEffects(state, v).gunnerMul).toBe(1);
    g.health = 'dead';
    stepCrewSeats(state, v);
    expect(crewEffects(state, v).gunner).toBeNull(); // the gun is silent while he moves over
    state.time += SEAT_SWAP_S.gunner + 0.1;
    stepCrewSeats(state, v);
    const e = crewEffects(state, v);
    expect(e.gunner!.id).toBe(cmd.id);
    expect(e.gunnerMul).toBeLessThan(0.85);
  });

  it('dead driver: the tank stops until another crewman takes the seat (10-15 s), then drives on', () => {
    const { state, v } = fresh('pz4gh');
    const rng = new Rng(1);
    v.path = [{ x: 100, y: 40 }];
    for (let i = 0; i < 20; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(v.speed).toBeGreaterThan(0);
    const y0 = v.pos.y;
    seatOccupant(state, v, 'driver')!.health = 'dead';
    expect(SEAT_SWAP_S.driver).toBeGreaterThanOrEqual(10);
    expect(SEAT_SWAP_S.driver).toBeLessThanOrEqual(15);
    const stopAt = state.time;
    while (state.time - stopAt < SEAT_SWAP_S.driver - 1) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(v.speed).toBe(0);
    expect(Math.abs(v.pos.y - y0)).toBeLessThan(0.2);
    while (state.time - stopAt < SEAT_SWAP_S.driver + 3) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(v.speed).toBeGreaterThan(0);
    expect(seatOccupant(state, v, 'radioOp')).toBeNull(); // the man beside him took the seat
  });

  it('dead loader: reload x1.8; dead commander: slower target changes (his eye is lost in vehicleVision, no extra multiplier)', () => {
    const { state, v } = fresh('panther');
    seatOccupant(state, v, 'loader')!.health = 'dead';
    expect(crewEffects(state, v).reloadMul).toBe(LOADER_DOWN_RELOAD_MUL);
    expect(LOADER_DOWN_RELOAD_MUL).toBe(1.8);
    seatOccupant(state, v, 'commander')!.health = 'incapacitated';
    const e = crewEffects(state, v);
    expect(e.commanderUp).toBe(false);
    expect('spotMul' in e).toBe(false);
    expect(e.retargetS).toBeGreaterThan(0);
  });

  it('a tank with the loader down fires measurably slower', () => {
    const shots = (killLoader: boolean): number => {
      const state = makeState();
      const t = addTank(state, 'pz4gh', { x: 100, y: 100 }, 0);
      const e = addTank(state, 'kv1', { x: 100, y: 20 }, Math.PI); // cannot be hurt much frontally at 160 m by... it can; keep it alive
      state.spottedVehicles.german.add(e.v.id);
      if (killLoader) seatOccupant(state, t.v, 'loader')!.health = 'dead';
      let n = 0;
      const rng = new Rng(3);
      for (let i = 0; i < 60 / SIM_DT; i++) {
        state.time += SIM_DT;
        stepCombat(state, rng, SIM_DT);
        for (const ev of state.events) if (ev.kind === 'shot' && ev.weaponId === 'kwk40_75') n++;
        state.events.length = 0;
        e.v.state = 'ok'; e.v.damage = undefined; e.v.bailBy = undefined;
        for (const c of e.crew) { c.health = 'healthy'; c.vehicleId = e.v.id; c.activity = 'idle'; }
        // the dead loader's seat stays empty in this measurement
        t.v.seatSwap = undefined;
      }
      return n;
    };
    const full = shots(false), slow = shots(true);
    expect(full).toBeGreaterThan(slow);
    expect(slow / full).toBeLessThan(0.7);
  });
});

describe('equipment states', () => {
  it('a destroyed track, engine or transmission immobilises; a damaged engine halves the speed', () => {
    for (const sys of ['trackL', 'trackR', 'engine', 'transmission'] as const) {
      const { v } = fresh('t34_76');
      ensureDamage(v)[sys] = 'destroyed';
      expect(isImmobile(v)).toBe(true);
    }
    const speedOf = (damaged: boolean): number => {
      const { state, v } = fresh('t34_76');
      if (damaged) ensureDamage(v).engine = 'damaged';
      v.path = [{ x: 100, y: 10 }];
      const rng = new Rng(1);
      for (let i = 0; i < 30; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
      return v.speed;
    };
    expect(speedOf(true)).toBeCloseTo(speedOf(false) * 0.5, 5);
    const { v } = fresh('t34_76');
    ensureDamage(v).engine = 'damaged';
    expect(vehicleDamageView(v).engineSmoke).toBe(true);
    expect(vehicleDamageView(v).systems.map((s) => s.word)).toEqual(['Engine damaged']);
  });

  it('a destroyed traverse freezes the turret: the hull has to turn to lay the gun', () => {
    const lay = (frozen: boolean): { hull: number; rel: number; t: number } => {
      const { state, v } = fresh('pz4gh');
      if (frozen) ensureDamage(v).traverse = 'destroyed';
      v.targetPoint = { x: 160, y: 100 }; // due east
      const rng = new Rng(1);
      let t = 0;
      while (t < 30 && Math.abs(v.turretFacing - Math.PI / 2) > 0.05) { state.time += SIM_DT; t += SIM_DT; stepVehicles(state, rng, SIM_DT); }
      return { hull: v.hullFacing, rel: v.turretFacing - v.hullFacing, t };
    };
    const free = lay(false), stuck = lay(true);
    expect(free.hull).toBeCloseTo(0, 5);          // only the turret turned
    expect(stuck.rel).toBeCloseTo(0, 5);          // the turret went nowhere on its own
    expect(stuck.hull).toBeGreaterThan(1.4);      // the hull did the laying
    // historical rates: the Pz IV's turret traverses 14 deg/s, its hull lays the gun at half of 18 deg/s
    expect(stuck.t).toBeGreaterThan(free.t * 1.4);  // slower
  });

  it('sight damaged: accuracy x0.6; destroyed: point-blank fire only; main gun destroyed: MG only', () => {
    const { state, v } = fresh('pz4gh');
    ensureDamage(v).sight = 'damaged';
    expect(sightAccuracyMul(v, 400)).toBeCloseTo(0.6, 5);
    ensureDamage(v).sight = 'destroyed';
    expect(sightAccuracyMul(v, 400)).toBe(0);
    expect(sightAccuracyMul(v, 60)).toBeGreaterThan(0);
    ensureDamage(v).sight = 'ok';
    ensureDamage(v).mainGun = 'destroyed';
    const e = addTank(state, 't26', { x: 100, y: 40 }, Math.PI);
    state.spottedVehicles.german.add(e.v.id);
    const rng = new Rng(1);
    let main = 0;
    for (let i = 0; i < 300; i++) { state.time += SIM_DT; stepCombat(state, rng, SIM_DT); for (const ev of state.events) if (ev.kind === 'shot' && ev.weaponId === 'kwk40_75') main++; state.events.length = 0; }
    expect(main).toBe(0);
  });

  it('radio destroyed: orders are acted on after a delay', () => {
    const { state, v } = fresh('pz4gh');
    const team = state.teams.get(v.teamId)!;
    ensureDamage(v).radio = 'destroyed';
    const rng = new Rng(1);
    applyOrder(state, team, { type: 'move', target: { x: 100, y: 50 }, issuedAt: state.time }, rng);
    expect(v.path).toHaveLength(0);
    expect(delayedOrderOf(state, team.id)?.type).toBe('move');
    state.time += RADIO_OUT_ORDER_DELAY_S - 1; stepAttackOrders(state, rng);
    expect(v.path).toHaveLength(0);
    state.time += 1.5; stepAttackOrders(state, rng);
    expect(v.path.length).toBeGreaterThan(0);
    expect(team.order?.type).toBe('move');
  });
});

describe('open-topped vehicles', () => {
  it('a mortar burst beside an SU-76 hurts its crew; the same burst does nothing to a closed T-34 crew', () => {
    let open = 0, closed = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const defId of ['su76', 't34_76'] as const) {
        const state = makeState();
        const t = addTank(state, defId, { x: 100, y: 100 }, 0);
        applyHESplash(state, new Rng(seed), { x: 101.2, y: 100.4 }, WEAPONS.mortar81, 'german');
        const hurt = t.crew.filter((c) => c.health !== 'healthy').length;
        if (defId === 'su76') open += hurt; else closed += hurt;
      }
    }
    expect(open).toBeGreaterThan(5);
    expect(closed).toBe(0);
  }, 60000);

  it('a bomb on the roof: through an open top always, through a Tiger\'s roof never', () => {
    const rng = new Rng(7);
    const a = fresh('marder3');
    expect(resolveVehicleHit(a.state, rng, a.v, { weapon: WEAPONS.mortar81, shooterPos: null, shooterSide: 'soviet', distM: 0, fromAbove: true }).penetrated).toBe(true);
    const b = fresh('tiger');
    expect(resolveVehicleHit(b.state, rng, b.v, { weapon: WEAPONS.mortar82, shooterPos: null, shooterSide: 'soviet', distM: 0, fromAbove: true }).penetrated).toBe(false);
  });
});

describe('determinism', () => {
  it('the same seed gives the same duel, hit for hit', () => {
    const duel = (): string => {
      const state = makeState(1943);
      const a = addTank(state, 'pz4gh', { x: 100, y: 150 }, 0, 70);
      const b = addTank(state, 't34_76', { x: 110, y: 60 }, Math.PI, 70);
      state.spottedVehicles.german.add(b.v.id);
      state.spottedVehicles.soviet.add(a.v.id);
      const e = soldier(9000, 9000, 'soviet', { x: 95, y: 120 }, 'ptrd', { experience: 80 });
      state.soldiers.set(e.id, e); state.teams.set(9000, mkTeam(9000, 'atteam', [9000], 'soviet', e.pos));
      state.spotted.german.add(9000);
      const rng = new Rng(77);
      for (let i = 0; i < 90 / SIM_DT; i++) { state.time += SIM_DT; stepCombat(state, rng, SIM_DT); stepVehicles(state, rng, SIM_DT); state.events.length = 0; state.tracers.length = 0; state.explosions.length = 0; }
      return JSON.stringify([Array.from(state.vehicles.values()), Array.from(state.soldiers.values()).map((s) => [s.id, s.health, s.vehicleId, s.pos]), state.messages]);
    };
    expect(duel()).toBe(duel());
  });
});
