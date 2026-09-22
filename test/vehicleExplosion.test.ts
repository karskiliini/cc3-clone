// Catastrophic vehicle explosions: the ammunition-rack detonation as an area event, the delayed
// cook-off of a burning vehicle, burning hulks as a danger source (sim/vehicleExplosion.ts).
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { resolveVehicleHit, vehicleDamageView, type HitLocation } from '@/sim/vehicleDamage';
import {
  COOKOFF_FROM_S, COOKOFF_UNTIL_S, FIRE_HAZARD_M, FUEL_BLAST_RADIUS_M, detonateVehicle, explosionRadiusM, rackDetonationChance, stepCookOff,
} from '@/sim/vehicleExplosion';
import { stepVehicles } from '@/sim/vehicle';
import { stepMovement } from '@/sim/movement';
import { stepCoverSeeking, bestCoverNear } from '@/sim/coverSeek';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';

const M = 1 / TILE_M; // tiles per metre
const down = (s: Soldier): boolean => s.health === 'dead' || s.health === 'incapacitated';

/** `n` men of `side` on a ring `m` metres from `at`. */
function ring(state: BattleState, side: 'german' | 'soviet', at: { x: number; y: number }, m: number, n: number, phase = 0): Soldier[] {
  const teamId = state.nextId++;
  const men: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const s = soldier(state.nextId++, teamId, side, { x: at.x + Math.cos(a) * m * M, y: at.y + Math.sin(a) * m * M }, side === 'german' ? 'kar98k' : 'mosin', { stance: 'standing' });
    state.soldiers.set(s.id, s);
    men.push(s);
  }
  state.teams.set(teamId, mkTeam(teamId, 'rifle', men.map((s) => s.id), side, at));
  return men;
}

function burn(state: BattleState, rng: Rng, v: Vehicle, seconds: number): void {
  for (let t = 0; t < seconds && v.state === 'burning'; t++) { state.time += 1; v.burnTimer += 1; stepCookOff(state, rng, v); }
}

describe('ammunition-rack detonation', () => {
  it('a full load kills or wounds the men within 5 m, knocks down men at 10 m, harms both sides, leaves a crater and throws the turret', () => {
    let nearTotal = 0, nearDown = 0, farTotal = 0, farFloored = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const state = makeState();
      const { v, crew } = addTank(state, 'tiger', { x: 100, y: 100 });
      const near = [...ring(state, 'german', v.pos, 4, 3), ...ring(state, 'soviet', v.pos, 4.5, 3, 1)];
      const far = [...ring(state, 'german', v.pos, 10, 3, 0.5), ...ring(state, 'soviet', v.pos, 10, 3, 1.5)];
      const rng = new Rng(seed);
      expect(explosionRadiusM(state, v, VEHICLE_DEFS.tiger)).toBeCloseTo(18, 5);
      expect(detonateVehicle(state, rng, v, 'soviet')).toBe(true);

      for (const s of near) expect(s.health).not.toBe('healthy');
      expect(near.filter((s) => s.side === 'german').some((s) => s.health !== 'healthy')).toBe(true);
      expect(near.filter((s) => s.side === 'soviet').some((s) => s.health !== 'healthy')).toBe(true);
      nearTotal += near.length; nearDown += near.filter(down).length;
      for (const s of far) {
        farTotal++;
        // knocked down: stunned on the ground (or a casualty), and thrown away from the hull
        if (down(s) || (s.stunnedUntil != null && s.stunnedUntil > state.time && s.stance === 'prone')) farFloored++;
        expect(s.blast).toBeDefined();
      }
      expect(crew.every((c) => c.health === 'dead')).toBe(true);
      expect(v.state).toBe('burning');
      expect(v.turretBlown).toBe(true);
      expect(vehicleDamageView(v).turretKey).toBe('turret.blown');
      const landM = dist(v.turretLanding!, v.pos) * TILE_M;
      expect(landM).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(landM).toBeLessThanOrEqual(8 + 1e-9);
      // a big crater / scorch under the hull, and a crater tile
      const mark = (state.map.craterMarks ?? []).find((m) => m.kind === 'shell' && dist(m, v.pos) < 0.5);
      expect(mark && mark.sizeM >= 5).toBeTruthy();
      expect(state.map.craters.length).toBe(1);
      // heavy fragments 5-25 m out
      const parts = (state.debris ?? []).filter((d) => d.kind === 'plate' || d.kind === 'wheel' || d.kind === 'hatch');
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parts.length).toBeLessThanOrEqual(6);
      for (const p of parts) { const m = dist(p.pos, v.pos) * TILE_M; expect(m).toBeGreaterThanOrEqual(5 - 1e-6); expect(m).toBeLessThanOrEqual(25 + 1e-6); }
      const ev = state.events.find((e) => e.kind === 'vehicleExplosion')!;
      expect(ev.radiusM).toBeCloseTo(18, 1);
      expect(ev.turretLanding).toEqual(v.turretLanding);
      expect(state.messages.some((m) => m.text.endsWith('\nAmmunition explodes!'))).toBe(true);
      expect(v.mainAmmo).toBe(0);
    }
    expect(nearDown / nearTotal).toBeGreaterThan(0.7); // lethality is high inside 5 m
    expect(farFloored).toBe(farTotal);
  });

  it('lighter turrets fly further than heavy ones, a few rounds make a small blast', () => {
    const avg = (defId: string): number => {
      let sum = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const state = makeState();
        const { v } = addTank(state, defId, { x: 100, y: 100 });
        detonateVehicle(state, new Rng(seed), v, 'german');
        sum += dist(v.turretLanding!, v.pos) * TILE_M;
      }
      return sum / 40;
    };
    expect(avg('t70')).toBeGreaterThan(avg('tiger') + 1);
    const state = makeState();
    const { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
    v.mainAmmo = 3;
    const r = explosionRadiusM(state, v, VEHICLE_DEFS.pz4gh);
    expect(r).toBeGreaterThanOrEqual(8);
    expect(r).toBeLessThan(11);
  }, 60000);

  it('witnesses within 60 m who see it are shaken and suppressed; men behind a wall or far away are not', () => {
    const state = makeState();
    const { v } = addTank(state, 't34_76', { x: 100, y: 100 });
    const [seen] = ring(state, 'german', { x: 100 + 40 * M, y: 100 }, 0, 1);
    const [farOff] = ring(state, 'german', { x: 100 + 90 * M, y: 100 }, 0, 1);
    detonateVehicle(state, new Rng(3), v, 'german');
    expect(seen.mind.stress).toBeGreaterThan(5);
    expect(seen.suppression).toBeGreaterThan(10);
    expect(farOff.mind.stress).toBe(0);
    expect(farOff.suppression).toBe(0);
  });

  it('riders and men still climbing out are caught by it', () => {
    const state = makeState();
    const t = addTank(state, 'pz4gh', { x: 140, y: 100 });
    const rider = soldier(state.nextId++, 9000, 'german', t.v.pos, 'kar98k', { vehicleId: t.v.id, seat: 'passenger' });
    state.soldiers.set(rider.id, rider);
    state.teams.set(9000, mkTeam(9000, 'rifle', [rider.id], 'german', t.v.pos));
    (t.v.passengerIds ??= []).push(rider.id);
    const climber = t.crew[0];
    climber.vehicleId = null;
    climber.hatch = { vehicleId: t.v.id, hatch: 0, kind: 'bailout', from: { ...t.v.pos }, to: { x: t.v.pos.x + 1, y: t.v.pos.y }, start: 0, until: 5, panicked: true };
    detonateVehicle(state, new Rng(4), t.v, 'soviet');
    expect(rider.health).toBe('dead');
    expect(climber.hatch).toBeUndefined();
    expect(climber.health).not.toBe('healthy');
  });

  it('an empty rack cannot detonate, a nearly empty one rarely does; Soviet 76 mm and HE-heavy loads are touchier', () => {
    const state = makeState();
    const { v } = addTank(state, 't34_76', { x: 100, y: 100 });
    const full = rackDetonationChance(state, v, VEHICLE_DEFS.t34_76);
    const pz = addTank(state, 'pz4gh', { x: 120, y: 100 });
    expect(full).toBeGreaterThan(rackDetonationChance(state, pz.v, VEHICLE_DEFS.pz4gh));
    v.mainAmmo = 5; v.rounds = undefined;
    expect(rackDetonationChance(state, v, VEHICLE_DEFS.t34_76)).toBeLessThan(full * 0.5);
    v.mainAmmo = 0; v.rounds = undefined;
    expect(rackDetonationChance(state, v, VEHICLE_DEFS.t34_76)).toBe(0);
    expect(detonateVehicle(state, new Rng(1), v, 'german')).toBe(false);

    const rng = new Rng(21);
    const loc: HitLocation = { zone: 'turretRear', face: 'rear' };
    let explosions = 0;
    for (let i = 0; i < 400; i++) {
      const s = makeState();
      const t = addTank(s, 't34_76', { x: 100, y: 100 });
      t.v.mainAmmo = 0;
      const r = resolveVehicleHit(s, rng, t.v, { weapon: WEAPONS.kwk42_75, round: 'ap', shooterPos: { x: 100, y: 200 }, shooterSide: 'german', distM: 200, location: loc });
      if (r.outcome === 'explosion' || t.v.turretBlown) explosions++;
      // even if it burns for the whole window: no ammunition explosion, at most the fuel tank
      if (t.v.state === 'burning') burn(s, rng, t.v, 100);
      expect(t.v.turretBlown).toBeFalsy();
      expect(s.events.some((e) => e.kind === 'vehicleExplosion' && (e.radiusM ?? 0) > FUEL_BLAST_RADIUS_M)).toBe(false);
    }
    expect(explosions).toBe(0);
  });
});

describe('cook-off of a burning vehicle', () => {
  it('pops first, then sometimes the full detonation, always inside the 10-90 s window and at the stated rate', () => {
    const N = 600;
    let detonated = 0, popped = 0;
    for (let seed = 1; seed <= N; seed++) {
      const state = makeState();
      const { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
      for (const c of state.soldiers.values()) c.vehicleId = null; // the crew got out
      v.state = 'burning';
      const rng = new Rng(seed);
      let at = -1, firstPop = -1;
      for (let t = 1; t <= 120 && v.state === 'burning'; t++) {
        state.time += 1; v.burnTimer += 1;
        stepCookOff(state, rng, v);
        if (firstPop < 0 && state.events.some((e) => e.kind === 'cookOffPop')) firstPop = t;
        if (at < 0 && v.cookOff?.ended === 'detonated') at = t;
      }
      if (firstPop >= 0) popped++;
      if (at >= 0) {
        detonated++;
        expect(at).toBeGreaterThanOrEqual(COOKOFF_FROM_S);
        expect(at).toBeLessThanOrEqual(COOKOFF_UNTIL_S);
        expect(v.turretBlown).toBe(true);
        expect(state.events.some((e) => e.kind === 'vehicleExplosion')).toBe(true);
      } else expect(v.cookOff?.ended).toBe('burntOut');
    }
    // stated rate: 1 - exp(-50 * COOKOFF_PEAK_PER_S * load) = about 11 % of burning Pz IVs with a
    // full load (load 0.81), with tolerance for 600 seeds
    expect(detonated / N).toBeGreaterThan(0.07);
    expect(detonated / N).toBeLessThan(0.16);
    expect(popped / N).toBeGreaterThan(0.9);
  });

  it('the fire lasts while the danger does (stepVehicles), and a pop can hurt only men within 5 m', () => {
    const state = makeState();
    const { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
    for (const c of state.soldiers.values()) c.vehicleId = null;
    v.state = 'burning';
    const watcher = ring(state, 'soviet', v.pos, 8, 1)[0];
    const rng = new Rng(7);
    let pops = 0;
    for (let i = 0; i < 60 / SIM_DT && !v.turretBlown; i++) {
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      pops += state.events.filter((e) => e.kind === 'cookOffPop').length;
      state.events.length = 0; state.explosions.length = 0;
    }
    if (!v.turretBlown) { expect(v.state).toBe('burning'); expect(watcher.health).toBe('healthy'); }
    expect(pops).toBeGreaterThan(0);
  });

  it('a burning halftrack gives at most a small fuel blast: no turret, no big radius, fewer of them', () => {
    const N = 300;
    let blasts = 0, hurtFar = 0;
    for (let seed = 1; seed <= N; seed++) {
      const state = makeState();
      const { v } = addTank(state, 'sdkfz251', { x: 100, y: 100 });
      for (const c of state.soldiers.values()) c.vehicleId = null;
      const far = ring(state, 'soviet', v.pos, 8, 4);
      v.state = 'burning';
      burn(state, new Rng(seed), v, 120);
      const ev = state.events.filter((e) => e.kind === 'vehicleExplosion');
      expect(ev.length).toBeLessThanOrEqual(1);
      if (ev.length) { blasts++; expect(ev[0].radiusM).toBe(FUEL_BLAST_RADIUS_M); expect(ev[0].turretLanding).toBeUndefined(); }
      expect(v.turretBlown).toBeFalsy();
      expect(state.events.some((e) => e.kind === 'cookOffPop')).toBe(false);
      hurtFar += far.filter((s) => s.health !== 'healthy').length;
    }
    expect(blasts / N).toBeGreaterThan(0.2);
    expect(blasts / N).toBeLessThan(0.4);
    expect(hurtFar).toBe(0); // 8 m away is outside the 5 m blast
  }, 60000);

  it('a heavy fragment coming down on a man injures him', () => {
    const state = makeState();
    const { v } = addTank(state, 'kv1', { x: 100, y: 100 });
    const rng = new Rng(11);
    detonateVehicle(state, rng, v, 'german');
    const part = (state.debris ?? []).find((d) => d.landAt != null)!;
    const [unlucky] = ring(state, 'german', part.pos, 0, 1);
    for (let i = 0; i < 3 / SIM_DT; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(unlucky.health).not.toBe('healthy');
    expect(part.landAt).toBeUndefined();
  });
});

describe('burning hulks as a danger source', () => {
  it('cover seeking never picks a spot within 15 m of a burning vehicle, and men standing there get clear', () => {
    const state = makeState();
    const { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
    for (const c of Array.from(state.soldiers.values())) state.soldiers.delete(c.id);
    // the best cover around is a crater right beside the hull
    state.map.tiles[100 * state.map.width + 102] = 'crater';
    const [s] = ring(state, 'soviet', { x: 103, y: 100 }, 0, 1);
    s.mind.threatDir = 0; s.mind.threatLevel = 0.8;
    s.activity = 'defending';
    expect(bestCoverNear(state, s, 6)!.tile).toEqual({ x: 102.5, y: 100.5 }); // not burning yet
    v.state = 'burning';
    const pick = bestCoverNear(state, s, 12);
    expect(pick).not.toBeNull();
    expect(dist(pick!.tile, v.pos) * TILE_M).toBeGreaterThan(FIRE_HAZARD_M);
    const rng = new Rng(2);
    for (let i = 0; i < 20 / SIM_DT; i++) {
      state.time += SIM_DT;
      stepCoverSeeking(state, rng, SIM_DT);
      stepMovement(state, rng, SIM_DT);
    }
    expect(dist(s.pos, v.pos) * TILE_M).toBeGreaterThan(FIRE_HAZARD_M);
  });

  it('a crew bailing out of a burning tank runs clear of it before going to ground', () => {
    let clear = 0, out = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const state = makeState();
      const { v, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 });
      const rng = new Rng(seed);
      v.mainAmmo = 0; // nothing to cook off: this is about where the men go
      const r = resolveVehicleHit(state, rng, v, { weapon: WEAPONS.kwk42_75, round: 'ap', shooterPos: { x: 100, y: 0 }, shooterSide: 'soviet', distM: 200, location: { zone: 'engineDeck', face: 'rear' } });
      if (r.outcome !== 'fire') continue;
      for (let i = 0; i < 25 / SIM_DT; i++) { state.time += SIM_DT; stepCoverSeeking(state, rng, SIM_DT); stepMovement(state, rng, SIM_DT); stepVehicles(state, rng, SIM_DT); }
      for (const c of crew) {
        if (down(c) || c.vehicleId != null) continue;
        out++;
        if (dist(c.pos, v.pos) * TILE_M > FIRE_HAZARD_M) clear++;
      }
    }
    expect(out).toBeGreaterThan(5);
    expect(clear / out).toBeGreaterThan(0.85);
  });
});

describe('the mix', () => {
  it('Monte Carlo: 15-25 % of destroyed gun tanks end catastrophically; abandoned or immobilised hulls never do', () => {
    const rng = new Rng(20260917);
    const tanks = Object.values(VEHICLE_DEFS).filter((d) => d.mainWeaponId && (d.kind === 'tank' || d.kind === 'spg'));
    const german = new Set(['pz3j', 'pz4f1', 'pz4gh', 'stug3g', 'panther', 'tiger', 'marder3']);
    const guns = { german: ['pak38', 'pak40', 'kwk39_50', 'kwk40_75', 'kwk42_75', 'kwk36_88'], soviet: ['m1937_45mm', 'zis3', 'f34_76', 'zis_s53_85', 'd25t_122', '45mm_20k'] };
    let destroyed = 0, immediate = 0, delayed = 0, fires = 0, notDestroyed = 0, abandoned = 0;
    for (let i = 0; i < 4000; i++) {
      const def = tanks[rng.int(0, tanks.length - 1)];
      const state = makeState(1944);
      const { v } = addTank(state, def.id, { x: 200, y: 200 }, 0, 50, german.has(def.id) ? 'german' : 'soviet');
      v.mainAmmo = Math.round(def.mainAmmo * rng.range(0.35, 1));
      const pool = (german.has(def.id) ? guns.soviet : guns.german).filter((id) => WEAPONS[id]);
      const weapon = WEAPONS[pool[rng.int(0, pool.length - 1)]];
      // mostly from the front quarter, sometimes flank or rear
      const bearing = (rng.chance(0.65) ? rng.range(-0.9, 0.9) : rng.range(-Math.PI, Math.PI));
      const distM = rng.range(80, Math.min(600, weapon.rangeM));
      const shooterPos = { x: v.pos.x + Math.sin(bearing) * distM * M, y: v.pos.y - Math.cos(bearing) * distM * M };
      for (let shot = 0; shot < 10 && (v.state === 'ok' || v.state === 'immobilized'); shot++) {
        resolveVehicleHit(state, rng, v, { weapon, round: 'ap', shooterPos, shooterSide: german.has(def.id) ? 'soviet' : 'german', distM });
      }
      if (v.state !== 'burning' && v.state !== 'knockedOut') {
        notDestroyed++;
        if (v.state === 'abandoned') abandoned++;
        expect(v.turretBlown).toBeFalsy(); // only abandoned / immobilised / unharmed: never explodes
        expect(state.events.some((e) => e.kind === 'vehicleExplosion')).toBe(false);
        continue;
      }
      destroyed++;
      if (state.events.some((e) => e.kind === 'vehicleExplosion')) { immediate++; continue; }
      if (v.state === 'burning') {
        fires++;
        burn(state, rng, v, 120);
        if (v.cookOff?.ended === 'detonated') delayed++;
      }
    }
    const share = (immediate + delayed) / destroyed;
    // eslint-disable-next-line no-console
    console.log(`[vehicleExplosion] destroyed gun tanks: ${destroyed} (not destroyed ${notDestroyed}, of them abandoned ${abandoned}); immediate ${(100 * immediate / destroyed).toFixed(1)} %, delayed ${(100 * delayed / destroyed).toFixed(1)} % (of ${fires} fires), catastrophic ${(100 * share).toFixed(1)} %`);
    expect(destroyed).toBeGreaterThan(800);
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.25);
    expect(immediate).toBeGreaterThan(0);
    expect(delayed).toBeGreaterThan(0);
  }, 60000);
});

describe('determinism', () => {
  it('the same seed gives the same explosion, man for man and fragment for fragment', () => {
    const run = (): string => {
      const state = makeState();
      const { v } = addTank(state, 't34_76', { x: 100, y: 100 });
      ring(state, 'german', v.pos, 6, 5); ring(state, 'soviet', v.pos, 12, 5, 0.3);
      const rng = new Rng(77);
      for (const c of state.soldiers.values()) if (c.vehicleId === v.id) c.vehicleId = null;
      v.state = 'burning';
      for (let i = 0; i < 100 / SIM_DT; i++) { state.time += SIM_DT; stepCoverSeeking(state, rng, SIM_DT); stepMovement(state, rng, SIM_DT); stepVehicles(state, rng, SIM_DT); state.events.length = 0; state.explosions.length = 0; }
      if (!v.turretBlown) detonateVehicle(state, rng, v, 'german');
      return JSON.stringify([Array.from(state.vehicles.values()), Array.from(state.soldiers.values()).map((s) => [s.id, s.health, s.pos, s.stunnedUntil]), state.debris, state.map.craterMarks, state.messages]);
    };
    expect(run()).toBe(run());
  });
});
