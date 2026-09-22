// Historical turret traverse and hull turn rates (req_gun_timing, addendum).
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { wrapAngle } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { stepCombat } from '@/sim/combat';
import { stepVehicles, turnHull, hullTurnNow } from '@/sim/vehicle';
import { gunArcRad, hullTurnRad, onHandTraverse, turretTraverseRad, wantsHullTurn } from '@/sim/gunTiming';
import { ensureDamage } from '@/sim/vehicleDamage';
import { setTile } from '@/sim/map';
import { makeState, addTank } from './vehicleDamageHelpers';

const DEG = Math.PI / 180;

function fresh(defId: string, experience = 50): { state: BattleState; v: Vehicle; crew: Soldier[] } {
  const state = makeState();
  const t = addTank(state, defId, { x: 200, y: 200 }, 0, experience);
  return { state, v: t.v, crew: t.crew };
}

/** Seconds the turret needs to come round onto an ordered fire point `deg` off (stepVehicles only). */
function swingS(defId: string, deg: number, prepare?: (v: Vehicle) => void): number {
  const { state, v } = fresh(defId);
  prepare?.(v);
  const b = deg * DEG;
  v.targetPoint = { x: 200 + Math.sin(b) * 100, y: 200 - Math.cos(b) * 100 };
  const rng = new Rng(1);
  let t = 0;
  while (t < 200 && Math.abs(wrapAngle(v.turretFacing - b)) > 1e-6) { state.time += SIM_DT; t += SIM_DT; stepVehicles(state, rng, SIM_DT); }
  return t;
}

describe('data: every vehicle carries its OWN historical rates', () => {
  it('no shared default, no legacy field, no "hull rate x 2" turret rule anywhere', async () => {
    for (const def of Object.values(VEHICLE_DEFS)) {
      expect(def.turretTraverseDegS, def.id).toBeGreaterThan(0);
      expect(def.turretTraverseHandDegS, def.id).toBeGreaterThan(0);
      expect(def.hullTurnDegS, def.id).toBeDefined();
      expect(def.turnRateRad, def.id).toBeUndefined();
      if (!def.hasTurret && def.mainWeaponId) expect(def.gunArcDeg, def.id).toBeGreaterThan(0);
      if (def.kind === 'halftrack') { expect(def.turnRadiusM).toBe(5.5); expect(def.hullTurnDegS).toBe(0); } else expect(def.hullTurnDegS, def.id).toBeGreaterThan(0);
    }
    const table: Record<string, [number, number]> = {
      pz3j: [8, 20], pz4f1: [14, 18], pz4gh: [14, 18], panther: [15, 16], tiger: [7, 12], t26: [10, 22], bt7: [10, 24], t70: [9, 25],
      t34_76: [25, 20], kv1: [10, 11], t34_85: [20, 18], is2: [13, 13], stug3g: [5, 20], marder3: [5, 22], su76: [5, 22], su85: [5, 18],
    };
    for (const [id, [turret, hull]] of Object.entries(table)) {
      expect(VEHICLE_DEFS[id].turretTraverseDegS, id).toBe(turret);
      expect(VEHICLE_DEFS[id].hullTurnDegS, id).toBe(hull);
    }
    expect([VEHICLE_DEFS.stug3g.gunArcDeg, VEHICLE_DEFS.marder3.gunArcDeg, VEHICLE_DEFS.su76.gunArcDeg, VEHICLE_DEFS.su85.gunArcDeg]).toEqual([12, 21, 16, 10]);
    // source scan: the old rule is gone (fs walk — works under bun AND vitest, unlike import.meta.glob)
    const sources: Record<string, string> = {};
    // tsconfig has no node types (DOM project): read via Bun.Glob + Bun.file, cast through unknown
    const bun = (globalThis as unknown as {
      Bun: {
        Glob: new (p: string) => { scan(o: { cwd: string; dot: boolean }): AsyncIterable<string> };
        file: (p: string) => { text(): Promise<string> };
      };
    }).Bun;
    for await (const rel of new bun.Glob('**/*.ts').scan({ cwd: new URL('../src/', import.meta.url).pathname, dot: false })) {
      sources[rel] = await bun.file(new URL('../src/', import.meta.url).pathname + rel).text();
    }
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [f, text] of Object.entries(sources)) expect(/turnRateRad\s*\*\s*2/.test(text), f).toBe(false);
  });

  it('a VehicleDef literal without the figures falls back to its legacy hull rate in ONE helper', () => {
    const lit = { ...VEHICLE_DEFS.pz4gh, hullTurnDegS: undefined, turretTraverseDegS: undefined, turnRateRad: 0.5 };
    expect(hullTurnRad(lit)).toBe(0.5);
    expect(hullTurnRad(VEHICLE_DEFS.kv1)).toBeCloseTo(11 * DEG, 9);
  });
});

describe('turret traverse', () => {
  it('Tiger I: at least 12 s for 90 deg; T-34/76: at most 4 s; Pz III J: about 11 s', () => {
    expect(swingS('tiger', 90)).toBeGreaterThanOrEqual(12);
    expect(swingS('tiger', 90)).toBeLessThan(14);
    expect(swingS('t34_76', 90)).toBeLessThanOrEqual(4);
    expect(swingS('t34_76', 90)).toBeGreaterThan(3);
    expect(swingS('pz3j', 90)).toBeGreaterThan(10.5);
    expect(swingS('pz3j', 90)).toBeLessThan(12);
  });

  it('crew quality: recruit x0.85, veteran x1.1', () => {
    const { v } = fresh('pz4gh');
    expect(turretTraverseRad(VEHICLE_DEFS.pz4gh, v, 25)).toBeCloseTo(14 * DEG * 0.85, 9);
    expect(turretTraverseRad(VEHICLE_DEFS.pz4gh, v, 50)).toBeCloseTo(14 * DEG, 9);
    expect(turretTraverseRad(VEHICLE_DEFS.pz4gh, v, 75)).toBeCloseTo(14 * DEG * 1.1, 9);
  });

  it('an engine-dead Panther traverses at the hand rate (3 deg/s)', () => {
    const powered = swingS('panther', 30);
    const dead = swingS('panther', 30, (v) => { ensureDamage(v).engine = 'destroyed'; });
    expect(powered).toBeLessThan(2.5);
    expect(dead).toBeGreaterThanOrEqual(30 / 3 - 0.11);
    expect(dead).toBeLessThan(30 / 3 + 0.5);
    const { v } = fresh('panther');
    expect(onHandTraverse(v)).toBe(false);
    ensureDamage(v).engine = 'destroyed';
    expect(onHandTraverse(v)).toBe(true);
    expect(turretTraverseRad(VEHICLE_DEFS.panther, v)).toBeCloseTo(3 * DEG, 9);
    // in the fight too: the gunner's lay (sim/combat.ts) cranks the turret round by hand
    const state = makeState();
    const t = addTank(state, 'panther', { x: 200, y: 200 }, 0, 50);
    ensureDamage(t.v).engine = 'destroyed';
    const e = addTank(state, 't34_76', { x: 300, y: 200 }, 0, 50);
    e.v.mainAmmo = 0; e.v.coaxAmmo = 0;
    state.spottedVehicles.german.add(e.v.id);
    const rng = new Rng(2);
    for (let i = 0; i < 100; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT); }
    expect(t.v.hullFacing).toBe(0); // no engine: the hull stays
    expect(wrapAngle(t.v.turretFacing)).toBeLessThanOrEqual(10 * 3 * DEG + 1e-9);
    expect(wrapAngle(t.v.turretFacing)).toBeGreaterThan(5 * 3 * DEG);
  });
});

describe('casemates', () => {
  function stug(offDeg: number): { hullAtShot: number; shotAt: number; hullTurned: boolean } {
    const state = makeState();
    const t = addTank(state, 'stug3g', { x: 200, y: 300 }, 0, 50);
    const b = offDeg * DEG;
    const e = addTank(state, 't34_76', { x: 200 + Math.sin(b) * 150, y: 300 - Math.cos(b) * 150 }, 0, 50);
    e.v.mainAmmo = 0; e.v.coaxAmmo = 0;
    state.spottedVehicles.german.add(e.v.id);
    const rng = new Rng(3);
    let shotAt = -1, hullTurned = false;
    for (let i = 0; i < 400 && shotAt < 0; i++) {
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      stepCombat(state, rng, SIM_DT);
      if (Math.abs(t.v.hullFacing) > 1e-9) hullTurned = true;
      if (state.events.some((ev) => ev.kind === 'shot' && ev.weaponId === 'stuk40')) shotAt = state.time;
      state.events.length = 0;
    }
    return { hullAtShot: t.v.hullFacing, shotAt, hullTurned };
  }

  it('a StuG engages a target 8 deg off without turning the hull; for one 40 deg off the hull turns first', () => {
    expect(gunArcRad(VEHICLE_DEFS.stug3g)).toBeCloseTo(12 * DEG, 9);
    const near = stug(8);
    expect(near.shotAt).toBeGreaterThan(0);
    expect(near.hullTurned).toBe(false);
    const far = stug(40);
    expect(far.shotAt).toBeGreaterThan(near.shotAt);
    expect(far.hullTurned).toBe(true);
    expect(far.hullAtShot).toBeGreaterThanOrEqual((40 - 12) * DEG - 1e-6); // far enough round for the gun arc
  });
});

describe('hull', () => {
  it('a KV-1 needs at least 16 s to turn its hull through 180 deg', () => {
    const { state, v } = fresh('kv1');
    v.path = [{ x: 200, y: 330 }]; // dead astern
    const rng = new Rng(4);
    let t = 0;
    const start = { ...v.pos };
    while (t < 60 && Math.abs(wrapAngle(v.hullFacing - Math.PI)) > 0.01) { state.time += SIM_DT; t += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(t).toBeGreaterThanOrEqual(16);
    expect(t).toBeLessThan(18);
    expect(v.pos.y).toBeGreaterThanOrEqual(start.y); // it pivoted first, it did not drive off sideways
  });

  it('soft ground x0.7; one damaged track: only toward that side, at half rate; destroyed: none', () => {
    const { state, v } = fresh('pz4gh');
    expect(hullTurnNow(state, v, VEHICLE_DEFS.pz4gh).rate).toBeCloseTo(18 * DEG, 9);
    setTile(state.map, 200, 200, 'mud');
    expect(hullTurnNow(state, v, VEHICLE_DEFS.pz4gh).rate).toBeCloseTo(18 * DEG * 0.7, 9);
    setTile(state.map, 200, 200, 'open');
    ensureDamage(v).trackL = 'damaged';
    expect(hullTurnNow(state, v, VEHICLE_DEFS.pz4gh)).toEqual({ rate: 9 * DEG, onlyDir: -1 });
    turnHull(state, v, VEHICLE_DEFS.pz4gh, 30 * DEG, 1); // wanted: right; it can only come round to the left
    expect(wrapAngle(v.hullFacing)).toBeCloseTo(-9 * DEG, 9);
    ensureDamage(v).trackL = 'destroyed';
    expect(hullTurnNow(state, v, VEHICLE_DEFS.pz4gh).rate).toBe(0);
  });

  it('a tracked vehicle turning sharply under way slows to 40% of its speed', () => {
    const { state, v } = fresh('t34_76');
    v.path = [{ x: 200 + 60, y: 200 - 80 }]; // ~37 deg off the bow
    const rng = new Rng(5);
    state.time += SIM_DT; stepVehicles(state, rng, SIM_DT);
    expect(v.speed).toBeCloseTo(VEHICLE_DEFS.t34_76.speedOffroadMs * 0.4, 5);
    for (let i = 0; i < 30; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(v.speed).toBeCloseTo(VEHICLE_DEFS.t34_76.speedOffroadMs, 5);
  });
});

describe('halftrack (wheel steering)', () => {
  it('cannot change heading while stationary; under way it turns at speed / 5.5 m', () => {
    const { state, v } = fresh('sdkfz251');
    const rng = new Rng(6);
    expect(hullTurnNow(state, v, VEHICLE_DEFS.sdkfz251).rate).toBe(0);
    turnHull(state, v, VEHICLE_DEFS.sdkfz251, Math.PI / 2, 5);
    expect(v.hullFacing).toBe(0);
    v.targetPoint = { x: 300, y: 200 };
    for (let i = 0; i < 100; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); }
    expect(v.hullFacing).toBe(0);
    // a route off to the right rear: every change of heading happens while it is rolling
    v.path = [{ x: 240, y: 260 }];
    let prevFacing = v.hullFacing, maxRate = 0, reversed = false, turnedAtRest = false;
    for (let i = 0; i < 600 && v.path.length > 0; i++) {
      state.time += SIM_DT; stepVehicles(state, rng, SIM_DT);
      const d = Math.abs(wrapAngle(v.hullFacing - prevFacing));
      if (d > 1e-9 && Math.abs(v.speed) < 1e-6) turnedAtRest = true;
      if (Math.abs(v.speed) > 1e-6) maxRate = Math.max(maxRate, d / SIM_DT / (Math.abs(v.speed) / 5.5));
      if (v.speed < 0) reversed = true;
      prevFacing = v.hullFacing;
    }
    expect(turnedAtRest).toBe(false);
    expect(maxRate).toBeLessThanOrEqual(1 + 1e-6);
    expect(reversed).toBe(true); // facing the wrong way: a K-turn
    expect(v.path.length).toBe(0); // and it gets there
  });
});

describe('hull or turret? (mind spec §10)', () => {
  it('a Tiger facing a flank threat starts its hull turning at once; a T-34 swings the turret', () => {
    const tiger = fresh('tiger'), t34 = fresh('t34_76');
    expect(wantsHullTurn(VEHICLE_DEFS.tiger, tiger.v, 90 * DEG)).toBe(true);
    expect(wantsHullTurn(VEHICLE_DEFS.t34_76, t34.v, 90 * DEG)).toBe(false);
    for (const sc of [tiger, t34]) {
      const side = sc.v.side === 'german' ? 'soviet' : 'german';
      const e = addTank(sc.state, side === 'soviet' ? 't34_76' : 'pz4gh', { x: 350, y: 200 }, 0, 50, side);
      e.v.mainAmmo = 0; e.v.coaxAmmo = 0;
      sc.state.spottedVehicles[sc.v.side].add(e.v.id);
      const rng = new Rng(7);
      for (let i = 0; i < 60; i++) { sc.state.time += SIM_DT; stepVehicles(sc.state, rng, SIM_DT); stepCombat(sc.state, rng, SIM_DT); }
    }
    expect(tiger.v.hullFacing).toBeGreaterThan(20 * DEG);
    expect(t34.v.hullFacing).toBe(0);
    expect(wrapAngle(t34.v.turretFacing)).toBeGreaterThan(40 * DEG);
  });
});

describe('determinism', () => {
  it('the same seed gives the same drive', () => {
    const once = (): string => {
      const state = makeState();
      const a = addTank(state, 'sdkfz251', { x: 200, y: 200 }, 0, 50);
      const b = addTank(state, 'kv1', { x: 220, y: 220 }, 1, 50);
      a.v.path = [{ x: 180, y: 260 }, { x: 120, y: 260 }];
      b.v.path = [{ x: 260, y: 300 }];
      const rng = new Rng(9);
      for (let i = 0; i < 400; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT); }
      return JSON.stringify([a.v, b.v]);
    };
    expect(once()).toBe(once());
  });
});
