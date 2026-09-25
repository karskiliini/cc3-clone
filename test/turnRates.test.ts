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
  while (t < 200 && Math.abs(wrapAngle(v.turretFacing - b)) > 1e-6) {
    state.time += SIM_DT;
    t += SIM_DT;
    stepVehicles(state, rng, SIM_DT);
  }
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
      if (def.kind === 'halftrack') { expect(def.turnRadiusM).toBeGreaterThanOrEqual(3.5); expect(def.turnRadiusM).toBeLessThanOrEqual(5.5); expect(def.hullTurnDegS).toBe(0); } else expect(def.hullTurnDegS, def.id).toBeGreaterThan(0);
    }
    const table: Record<string, [number, number]> = {
      pz3j: [8, 20], pz4f1: [14, 18], pz4gh: [14, 18], panther: [15, 16], tiger: [7, 12],
      t26: [10, 22], bt7: [10, 24], t70: [9, 25],
      t34_76: [25, 20], kv1: [10, 11], t34_85: [20, 18], is2: [13, 13],
      stug3g: [5, 20], marder3: [5, 22], su76: [5, 22], su85: [5, 18],
    };
    for (const [id, [turret, hull]] of Object.entries(table)) {
      expect(VEHICLE_DEFS[id].turretTraverseDegS, id).toBe(turret);
      expect(VEHICLE_DEFS[id].hullTurnDegS, id).toBe(hull);
    }
    expect([VEHICLE_DEFS.stug3g.gunArcDeg, VEHICLE_DEFS.marder3.gunArcDeg, VEHICLE_DEFS.su76.gunArcDeg, VEHICLE_DEFS.su85.gunArcDeg]).toEqual([12, 21, 16, 10]);
    // source scan: the old rule is gone (fs walk — works under bun AND vitest, unlike import.meta.glob)
    const fs: any = await import(/* @vite-ignore */ ('node:' + 'fs') as string);
    const path: any = await import(/* @vite-ignore */ ('node:' + 'path') as string);
    const root = new URL('../src/', import.meta.url).pathname;
    const sources: Record<string, string> = {};
    const walk = (dir: string, prefix = ''): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix + e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel + '/');
        else if (e.name.endsWith('.ts')) sources[rel] = fs.readFileSync(path.join(dir, e.name), 'utf8');
      }
    };
    walk(root);
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [f, text] of Object.entries(sources)) expect(/turnRateRad\s*\*\s*2/.test(text), f).toBe(false);
  });

  it('a VehicleDef literal without the figures falls back to its legacy hull rate in ONE helper', () => {
    const lit = { ...VEHICLE_DEFS.pz4gh, hullTurnDegS: undefined, turretTraverseDegS: undefined, turnRateRad: 0.5 };
    expect(hullTurnRad(lit)).toBe(0.5);
    expect(hullTurnRad(VEHICLE_DEFS.kv1)).toBeCloseTo(11 * DEG, 9);
  });
});
