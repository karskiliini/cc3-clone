// Loading and laying phases of tank / SPG main guns and AT guns (req_gun_timing, main part).
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { stepCombat } from '@/sim/combat';
import { stepVehicles } from '@/sim/vehicle';
import {
  BRACKET_LOST_M, bracketMul, designateS, fineLayBaseS, fineLayS, followUpLayS, laySkillMul, loadSkillMul, timeToFirstShotS,
  vehicleLoadS, weaponLoadS,
} from '@/sim/gunTiming';
import { crewEffects } from '@/sim/vehicleDamage';
import { loadTimeS, layTimeS } from '@/sim/crewWeapon';
import { makeState, addTank } from './vehicleDamageHelpers';

interface Scene { state: BattleState; v: Vehicle; crew: Soldier[]; e: { v: Vehicle; crew: Soldier[] } }

/** A tank at (100,300) facing north and a harmless enemy hull `distM` away at `bearingDeg`. */
function duel(defId: string, experience: number, distM: number, bearingDeg: number, enemyDef = 't34_76'): Scene {
  const state = makeState();
  const t = addTank(state, defId, { x: 100, y: 300 }, 0, experience);
  const b = (bearingDeg * Math.PI) / 180;
  const e = addTank(state, enemyDef, { x: 100 + (Math.sin(b) * distM) / 2, y: 300 - (Math.cos(b) * distM) / 2 }, 0, 50, t.v.side === 'german' ? 'soviet' : 'german');
  e.v.mainAmmo = 0; e.v.coaxAmmo = 0; // a target, not an opponent
  state.spottedVehicles[t.v.side].add(e.v.id);
  return { state, v: t.v, crew: t.crew, e };
}

interface RunOpts { move?: boolean; each?: (shot: boolean) => void; stopAfterShots?: number }
/** Steps the sim; returns the battle times of the main-gun shots of `sc.v`. The enemy hull is kept alive. */
function run(sc: Scene, rng: Rng, seconds: number, opts: RunOpts = {}): number[] {
  const { state, v, e } = sc;
  const weaponId = VEHICLE_DEFS[v.defId].mainWeaponId;
  const shots: number[] = [];
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    state.time += SIM_DT;
    if (opts.move !== false) stepVehicles(state, rng, SIM_DT);
    stepCombat(state, rng, SIM_DT);
    let shot = false;
    for (const ev of state.events) if (ev.kind === 'shot' && ev.weaponId === weaponId && ev.side === v.side) { shots.push(state.time); shot = true; }
    opts.each?.(shot);
    state.events.length = 0; state.tracers.length = 0; state.explosions.length = 0; state.flashes.length = 0;
    e.v.state = 'ok'; e.v.damage = undefined; e.v.bailBy = undefined; e.v.exiting = undefined;
    for (const c of e.crew) { c.health = 'healthy'; c.vehicleId = e.v.id; c.activity = 'idle'; c.mind.stress = 0; }
    if (opts.stopAfterShots && shots.length >= opts.stopAfterShots) break;
  }
  return shots;
}
const intervals = (t: number[]): number[] => t.slice(1).map((x, i) => x - t[i]);

describe('tables', () => {
  it('loading time by calibre, skill multipliers', () => {
    expect(weaponLoadS(WEAPONS.kwk39_50)).toBe(5);
    expect(weaponLoadS(WEAPONS.kwk40_75)).toBe(6.5);
    expect(weaponLoadS(WEAPONS.f34_76)).toBe(6.5);
    expect(weaponLoadS(WEAPONS.kwk36_88)).toBe(8.5);
    expect(weaponLoadS(WEAPONS.zis_s53_85)).toBe(8.5);
    expect(weaponLoadS(WEAPONS.d25t_122)).toBe(24);
    expect(loadSkillMul(25)).toBeCloseTo(1.35, 5);
    expect(loadSkillMul(50)).toBeCloseTo(1, 5);
    expect(loadSkillMul(75)).toBeCloseTo(0.85, 5);
    expect(loadSkillMul(95)).toBeCloseTo(0.75, 5);
    expect(laySkillMul(25)).toBeCloseTo(1.5, 5);
    expect(laySkillMul(95)).toBeCloseTo(0.75, 5);
    // every gun carries its own loading time
    for (const w of Object.values(WEAPONS)) if (w.cls === 'tankgun' || w.cls === 'atgun') expect(w.loadS, w.id).toBeGreaterThan(0);
  });

  it('fine lay: 4 s to 200 m, +1 s per further 200 m, moving x1.5, aim point, shaken, damaged sight', () => {
    expect(fineLayBaseS(100)).toBe(4);
    expect(fineLayBaseS(400)).toBe(5);
    expect(fineLayBaseS(800)).toBe(7);
    const base = { distM: 400, experience: 50, targetMoving: false, aimMul: 1, shaken: false, sightDamaged: false };
    expect(fineLayS(base)).toBeCloseTo(5, 5);
    expect(fineLayS({ ...base, targetMoving: true })).toBeCloseTo(7.5, 5);
    expect(fineLayS({ ...base, aimMul: 1.4 })).toBeCloseTo(7, 5);
    expect(fineLayS({ ...base, shaken: true })).toBeCloseTo(7, 5);
    expect(fineLayS({ ...base, sightDamaged: true })).toBeCloseTo(7.5, 5);
    expect(followUpLayS(95)).toBeCloseTo(1.5, 5);
    expect(followUpLayS(50)).toBeCloseTo(2, 5);
    expect(followUpLayS(25)).toBeCloseTo(2.5, 5);
    expect(designateS(75, false)).toBeCloseTo(1, 5);
    expect(designateS(25, false)).toBeCloseTo(3, 5);
    expect(designateS(50, true)).toBeCloseTo(4, 5);
  });

  it('vehicle loading: cramped two-man turret x1.25, dead loader x1.8, hull racks x1.25 after the ready rack', () => {
    const a = duel('pz4gh', 50, 400, 0);
    const load = (sc: Scene): number => vehicleLoadS(sc.state, sc.v, VEHICLE_DEFS[sc.v.defId], WEAPONS[VEHICLE_DEFS[sc.v.defId].mainWeaponId!], crewEffects(sc.state, sc.v).reloadMul, null);
    expect(load(a)).toBeCloseTo(6.5, 5);
    a.v.readyRackUsed = VEHICLE_DEFS.pz4gh.readyRack;
    expect(load(a)).toBeCloseTo(6.5 * 1.25, 5);
    const t34 = duel('t34_76', 50, 400, 0, 'pz4gh');
    expect(load(t34)).toBeCloseTo(6.5 * 1.25, 5);
    const is2 = duel('is2', 50, 400, 0, 'pz4gh');
    expect(load(is2)).toBeCloseTo(24, 5);
  });

  it('AT guns use the same table x0.9 and the same fine lay', () => {
    expect(loadTimeS('pak40', 50)).toBeCloseTo(6.5 * 0.9, 5);
    expect(loadTimeS('pak38', 50)).toBeCloseTo(5 * 0.9, 5);
    expect(layTimeS('pak40', 50, 400, 0)).toBeCloseTo(5, 5);
    expect(layTimeS('pak40', 50, 400, 0, true)).toBeCloseTo(7.5, 5);
  });
});

describe('first shot and follow-up shots', () => {
  it('a regular Pz IV crew, target at 400 m 90 deg off the turret: first shot >= traverse + lay, never under 6 s', () => {
    // turret alone (no hull help): 90 deg at 14 deg/s = 6.4 s, then a 5 s fine lay, after the commander's call
    const alone = duel('pz4gh', 50, 400, 90);
    const tAlone = run(alone, new Rng(1), 40, { move: false, stopAfterShots: 1 })[0];
    expect(tAlone).toBeGreaterThanOrEqual(90 / 14 + 5);
    // standing free, the hull helps the turret round (18 + 14 deg/s): still traverse + lay
    const helped = duel('pz4gh', 50, 400, 90);
    const est = timeToFirstShotS(helped.state, helped.v, helped.e.v.pos);
    const tHelped = run(helped, new Rng(1), 40, { stopAfterShots: 1 })[0];
    expect(tHelped).toBeGreaterThanOrEqual(90 / (14 + 18) + 5);
    expect(tHelped).toBeGreaterThanOrEqual(6);
    expect(tHelped).toBeLessThan(tAlone);
    // the crews' own estimate (threat ranking, cover decisions) is about right
    expect(Math.abs(est - tHelped)).toBeLessThan(2.5);
  });

  it('follow-up shots on the same target are limited by the loading time: 7.5 cm, regular crew, about 6.5 s', () => {
    const sc = duel('pz4gh', 50, 400, 0);
    const gaps = intervals(run(sc, new Rng(2), 40));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(6.5 - 1e-6); expect(g).toBeLessThan(6.5 + 0.35); }
  });

  it('the D-25T of the IS-2 needs at least 20 s per round', () => {
    const sc = duel('is2', 50, 400, 0, 'pz4gh');
    const gaps = intervals(run(sc, new Rng(3), 80));
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(20);
  });

  it('a recruit crew is slower than a veteran crew in both phases', () => {
    const rec = run(duel('pz4gh', 25, 400, 0), new Rng(4), 40);
    const vet = run(duel('pz4gh', 75, 400, 0), new Rng(4), 40);
    expect(rec[0]).toBeGreaterThan(vet[0] + 2);                         // laying (turret already on)
    expect(intervals(rec)[0]).toBeGreaterThan(intervals(vet)[0] + 2);   // loading
    expect(intervals(vet)[0]).toBeCloseTo(6.5 * 0.85, 0);
    expect(intervals(rec)[0]).toBeCloseTo(6.5 * 1.35, 0);
  });

  it('a change of round type costs the unload and a whole new load', () => {
    const sc = duel('pz4gh', 50, 400, 0);
    const first = run(sc, new Rng(5), 20, { stopAfterShots: 1 });
    expect(first).toHaveLength(1);
    run(sc, new Rng(5), 7); // AP back in the breech (second shot may fall)
    sc.v.loadedRound = 'he'; sc.v.mainFireTimer = 0; sc.v.rounds!.he--; sc.v.rounds!.ap++; // as if HE had been loaded for infantry
    const t0 = sc.state.time;
    const next = run(sc, new Rng(5), 20, { stopAfterShots: 1 })[0];
    expect(next - t0).toBeGreaterThanOrEqual(6.5 + 2 - 1e-6);
  });
});

describe('snap shot', () => {
  it('a veteran about to be fired at shoots before his fine lay is complete; a regular crew finishes the lay', () => {
    const first = (experience: number): number => {
      const sc = duel('pz4gh', experience, 400, 0);
      // the enemy gun is loaded and all but laid on us
      sc.e.v.loadedRound = 'ap';
      sc.e.v.gunLay = { key: `v${sc.v.id}`, aim: { ...sc.v.pos }, designateLeftS: 0, fineLeftS: 0.5, totalS: 5 };
      return run(sc, new Rng(12), 20, { stopAfterShots: 1 })[0];
    };
    const vet = first(80), reg = first(50);
    expect(reg).toBeGreaterThanOrEqual(5);     // call + 5 s fine lay
    expect(vet).toBeLessThan(2.5);             // fires on the commander's call, lay barely begun
  });
});

describe('short halt', () => {
  it('a moving vehicle halts before an aimed shot, fires standing, and drives on', () => {
    const sc = duel('pz4gh', 50, 400, 20);
    sc.v.path = [{ x: 100, y: 20 }];
    let moved = false, shotsStanding = 0, shotsMoving = 0, drivenAfter = false;
    let yAtShot = NaN;
    run(sc, new Rng(6), 60, {
      each: (shot) => {
        if (Math.abs(sc.v.speed) > 0.1) { moved = true; if (!Number.isNaN(yAtShot) && sc.v.pos.y < yAtShot - 1) drivenAfter = true; }
        if (shot) { if (Math.abs(sc.v.speed) > 0.1) shotsMoving++; else shotsStanding++; yAtShot = sc.v.pos.y; }
      },
    });
    expect(moved).toBe(true);
    expect(shotsStanding).toBeGreaterThan(0);
    expect(shotsMoving).toBe(0);
    expect(drivenAfter).toBe(true);
    expect(sc.v.path.length).toBeGreaterThan(0); // the route was kept through the halts
  });
});

describe('bracketing', () => {
  it('+15% per observed miss up to +30%', () => {
    expect(bracketMul(0)).toBe(1);
    expect(bracketMul(1)).toBeCloseTo(1.15, 5);
    expect(bracketMul(2)).toBeCloseTo(1.3, 5);
    expect(bracketMul(5)).toBeCloseTo(1.3, 5);
  });

  it('a miss raises the hit chance of the next round; lost when the target moves more than ~10 m', () => {
    // the same seeds twice: once as it is, once with the observed miss forgotten before the second
    // round. Same dice, so every round that hits without the bracket also hits with it, and some more.
    const second = (seed: number, forget: boolean): { firstHit: boolean; secondHit: boolean; sc: Scene; rng: Rng } | null => {
      const sc = duel('pz4gh', 50, 600, 0);
      const rng = new Rng(seed);
      const results: boolean[] = [];
      run(sc, rng, 30, {
        stopAfterShots: 2,
        each: (shot) => {
          if (shot) results.push(sc.state.tracers.some((t) => t.kind === 'shell' && t.hit));
          if (forget && sc.v.gunLay) sc.v.gunLay.misses = 0;
        },
      });
      return results.length < 2 ? null : { firstHit: results[0], secondHit: results[1], sc, rng };
    };
    let withBracket = 0, without = 0, n = 0, lostChecked = false;
    for (let seed = 1; seed <= 60; seed++) {
      const a = second(seed, false), b = second(seed, true);
      if (!a || !b || a.firstHit) continue;
      n++;
      if (a.secondHit) withBracket++;
      if (b.secondHit) { without++; expect(a.secondHit).toBe(true); }
      if (!a.secondHit && !lostChecked) {
        expect(a.sc.v.gunLay!.misses).toBe(2);
        a.sc.e.v.pos = { x: a.sc.e.v.pos.x + (BRACKET_LOST_M + 2) / 2, y: a.sc.e.v.pos.y };
        run(a.sc, a.rng, SIM_DT);
        expect(a.sc.v.gunLay!.misses ?? 0).toBe(0);
        lostChecked = true;
      }
    }
    expect(n).toBeGreaterThan(12);
    expect(lostChecked).toBe(true);
    expect(withBracket).toBeGreaterThan(without);
  });
});

describe('gun state', () => {
  it('exposes loading / laying / ready; both progress values only ever rise within a phase', () => {
    const sc = duel('pz4gh', 50, 400, 60);
    const seen = new Set<string>();
    let lastLoad = 0, lastLay = 0, sawPartialLoad = false, sawPartialLay = false;
    const shots = run(sc, new Rng(7), 40, {
      each: (shot) => {
        const v = sc.v;
        if (v.gunState) seen.add(v.gunState);
        const load = v.loadProgress ?? 1, lay = v.layProgress ?? 0;
        if (shot) { lastLoad = 0; lastLay = 0; expect(load).toBe(0); expect(lay).toBe(0); expect(v.gunState).toBe('loading'); return; }
        expect(load).toBeGreaterThanOrEqual(lastLoad - 1e-9);
        expect(lay).toBeGreaterThanOrEqual(lastLay - 1e-9);
        expect(load).toBeLessThanOrEqual(1); expect(lay).toBeLessThanOrEqual(1);
        if (load > 0.2 && load < 0.8) sawPartialLoad = true;
        if (lay > 0.2 && lay < 0.8) sawPartialLay = true;
        if (v.gunState === 'ready') { expect(load).toBe(1); expect(lay).toBe(1); }
        lastLoad = load; lastLay = lay;
      },
    });
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(seen.has('loading')).toBe(true);
    expect(seen.has('laying')).toBe(true);
    expect(sawPartialLoad).toBe(true);
    expect(sawPartialLay).toBe(true);
  });

  it('the gun does not fire until the turret is within the lay tolerance (no snapping)', () => {
    const sc = duel('tiger', 50, 400, 120);
    let prev = sc.v.turretFacing, maxStep = 0;
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
    run(sc, new Rng(8), 60, {
      stopAfterShots: 1,
      each: (shot) => {
        maxStep = Math.max(maxStep, Math.abs(wrap(sc.v.turretFacing - prev)));
        prev = sc.v.turretFacing;
        if (shot) expect(Math.abs(wrap(sc.v.turretFacing - (120 * Math.PI) / 180))).toBeLessThan(0.04);
      },
    });
    // per step: at most hull (12 deg/s) + turret (7 deg/s) together
    expect(maxStep).toBeLessThanOrEqual(((12 + 7) * Math.PI / 180) * SIM_DT + 1e-9);
  });
});

describe('determinism', () => {
  it('the same seed gives the same duel', () => {
    const once = (): string => {
      const sc = duel('pz4gh', 60, 500, 70);
      sc.v.path = [{ x: 140, y: 250 }];
      const shots = run(sc, new Rng(11), 45);
      return JSON.stringify([shots, sc.v, sc.e.v.hits]);
    };
    expect(once()).toBe(once());
  });
});
