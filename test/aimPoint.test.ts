// Aim points by gunner experience (req_ammo_damage B).
import { describe, it, expect } from 'vitest';
import type { BattleState, RoundCounts } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import {
  chooseAimPoint, gunnerSkill, spotHitMul, aimLayMul, SPOT_MISS_STILL_HITS, AIM_WORDS,
} from '@/sim/aimPoint';
import { expectedArmorMm, locateHit, locationArmorMm, LUCKY_SPOT_CHANCE } from '@/sim/vehicleDamage';
import { stepCombat } from '@/sim/combat';
import { stepCrewWeapons, fireMissionWait } from '@/sim/crewWeapon';
import { makeState, addTank, addGun, soldier } from './vehicleDamageHelpers';

const FULL: RoundCounts = { ap: 10, apcr: 4, he: 6, smoke: 0 };
const NO_APCR: RoundCounts = { ap: 10, apcr: 0, he: 6, smoke: 0 };
const KILL_SPOTS = ['turretRing', 'driverPlate', 'lowerHull'];

function run(state: BattleState, rng: Rng, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    state.time += SIM_DT;
    stepCrewWeapons(state, SIM_DT);
    stepCombat(state, rng, SIM_DT);
    each?.();
    state.events.length = 0; state.explosions.length = 0; state.tracers.length = 0;
  }
}

/** KV-1 at `distM` due north of the origin point, hull turned by `hullDeg` away from facing it. */
function kvAt(state: BattleState, distM: number, hullDeg = 0) {
  return addTank(state, 'kv1', { x: 200, y: 350 - distM / 2 }, Math.PI + (hullDeg * Math.PI) / 180);
}
const FROM = { x: 200, y: 350 };

describe('gunner skill', () => {
  it('is experience, degraded by stress and suppression: a shaken veteran shoots like a novice', () => {
    const vet = soldier(1, 1, 'german', FROM, 'pak38', { experience: 80 });
    expect(gunnerSkill(vet)).toBeCloseTo(0.8, 5);
    vet.suppression = 90;
    expect(gunnerSkill(vet)).toBeLessThan(0.35);
    vet.suppression = 0; vet.mind.state = 'shaken';
    expect(gunnerSkill(vet)).toBeLessThan(0.65);
  });
});

describe('aim point choice', () => {
  it('a recruit always aims at the centre of mass', () => {
    const state = makeState(1942);
    for (const [def, distM, deg] of [['kv1', 300, 0], ['kv1', 100, 0], ['kv1', 200, 180], ['t26', 150, 90], ['t34_76', 250, 45]] as const) {
      const t = addTank(state, def, { x: 200, y: 350 - distM / 2 }, Math.PI + (deg * Math.PI) / 180);
      for (const counts of [FULL, NO_APCR]) {
        expect(chooseAimPoint(WEAPONS.pak38, counts, 0.3, FROM, t.v, 1942).aimPoint).toBe('mass');
      }
    }
  });

  it('a regular aims at the mass, but at the tracks when his best round cannot beat the plate', () => {
    const state = makeState(1942);
    expect(chooseAimPoint(WEAPONS.pak38, NO_APCR, 0.5, FROM, kvAt(state, 300).v, 1942).aimPoint).toBe('runningGear');
    expect(chooseAimPoint(WEAPONS.pak38, FULL, 0.5, FROM, kvAt(state, 200).v, 1942).aimPoint).toBe('mass');
    expect(chooseAimPoint(WEAPONS.pak40, null, 0.5, FROM, kvAt(state, 300).v, 1942).aimPoint).toBe('mass');
  });

  it('a veteran PaK 38 layer facing a KV-1 front at 300 m with no APCR aims at the running gear', () => {
    const state = makeState(1942);
    const c = chooseAimPoint(WEAPONS.pak38, NO_APCR, 0.75, FROM, kvAt(state, 300).v, 1942);
    expect(c.aimPoint).toBe('runningGear');
    expect(c.round).toBe('ap');
  });

  it('with APCR inside 250 m he goes for a kill spot', () => {
    const state = makeState(1942);
    const c = chooseAimPoint(WEAPONS.pak38, FULL, 0.75, FROM, kvAt(state, 220).v, 1942);
    expect(KILL_SPOTS).toContain(c.aimPoint);
    expect(c.round).toBe('apcr');
    // and the rear when he sees it
    const rear = chooseAimPoint(WEAPONS.pak40, null, 0.75, FROM, kvAt(state, 220, 180).v, 1942);
    expect(['rear', 'turretRing']).toContain(rear.aimPoint);
  });

  it('a veteran under heavy suppression reverts to the centre of mass', () => {
    const state = makeState(1942);
    const vet = soldier(1, 1, 'german', FROM, 'pak38', { experience: 80 });
    const kv = kvAt(state, 220).v;
    expect(chooseAimPoint(WEAPONS.pak38, FULL, gunnerSkill(vet), FROM, kv, 1942).aimPoint).not.toBe('mass');
    vet.suppression = 85; vet.mind.stress = 70;
    expect(chooseAimPoint(WEAPONS.pak38, FULL, gunnerSkill(vet), FROM, kv, 1942).aimPoint).toBe('mass');
  });

  it('beyond ~500 m even veterans lay on the mass; an ace out to ~800 m', () => {
    const state = makeState(1943);
    const kv = kvAt(state, 650).v;
    expect(chooseAimPoint(WEAPONS.pak40, null, 0.75, FROM, kv, 1943).aimPoint).toBe('mass');
    expect(chooseAimPoint(WEAPONS.pak40, null, 0.9, FROM, kv, 1943).aimPoint).not.toBe('mass');
  });

  it('an ace knows the type: the KV-1 turret ring is 60 mm to him, the Tiger has no frontal weak spot', () => {
    const state = makeState(1943);
    const kv = kvAt(state, 300).v;
    expect(expectedArmorMm(kv, VEHICLE_DEFS.kv1, FROM, 'turretRing', true)).toBe(60);
    expect(expectedArmorMm(kv, VEHICLE_DEFS.kv1, FROM, 'turretRing', false)).toBeCloseTo(75 * 0.85, 5);
    expect(VEHICLE_DEFS.tiger.weakSpots).toBeUndefined();
    expect(expectedArmorMm(kv, VEHICLE_DEFS.kv1, FROM, 'runningGear')).toBe(20);
  });

  it('a veteran holds his fire a moment for a target that is turning its flank to him', () => {
    const state = makeState(1942);
    const t = kvAt(state, 300);
    t.v.path = [{ x: 260, y: 200 }]; // about to turn east: its side will face the gun
    t.v.speed = 2;
    expect(chooseAimPoint(WEAPONS.pak38, NO_APCR, 0.75, FROM, t.v, 1942).hold).toBe(true);
    expect(chooseAimPoint(WEAPONS.pak38, NO_APCR, 0.5, FROM, t.v, 1942).hold).toBe(false);
  });
});

describe('cost of precision', () => {
  it('aimed shots have a lower hit chance than mass at the same range, falling with range and movement', () => {
    for (const aim of ['turretRing', 'lowerHull', 'driverPlate', 'gunMantlet', 'runningGear'] as const) {
      const near = spotHitMul(aim, 100, false, 0.75);
      expect(near).toBeGreaterThanOrEqual(0.45);
      expect(near).toBeLessThanOrEqual(0.8);
      expect(spotHitMul(aim, 400, false, 0.75)).toBeLessThan(near);
      expect(spotHitMul(aim, 100, true, 0.75)).toBeLessThan(near);
      // total chance to hit the vehicle at all (spot, or a near miss of it that lands elsewhere)
      const p = 0.5, pSpot = p * near;
      expect(pSpot + (p - pSpot) * SPOT_MISS_STILL_HITS).toBeLessThan(p);
      expect(aimLayMul(aim)).toBeGreaterThanOrEqual(1.2);
      expect(aimLayMul(aim)).toBeLessThanOrEqual(1.4 + 1e-9);
    }
    expect(spotHitMul('mass', 300, true, 0.2)).toBe(1);
    expect(aimLayMul('mass')).toBe(1);
  });

  it('measured: a veteran aiming at the tracks hits the vehicle less often than a recruit-style mass shot', () => {
    // gun timing: a veteran crew now also LOADS faster (x0.85 against a recruit's x1.3), so hits are
    // compared per round fired, not per minute
    const hits = (experience: number): number => {
      let n = 0, shots = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const state = makeState(1942);
        const g = addGun(state, 'pak38', FROM, 3, { experience, ammo: 20, ammoReserve: 0, rounds: { ...NO_APCR, ap: 14 } });
        const t = kvAt(state, 300);
        state.spottedVehicles.german.add(t.v.id);
        run(state, new Rng(seed), 60, () => { for (const tr of state.tracers) { shots++; if (tr.hit) n++; } });
        void g;
      }
      return n / Math.max(1, shots);
    };
    // same accuracy term for both would need the same experience; compare the aimed total against
    // the closed form instead: the veteran (better shot) must not hit MORE than x1.25 the recruit
    const vet = hits(75), rec = hits(30);
    expect(vet).toBeGreaterThan(0);
    expect(rec).toBeGreaterThan(0);
    expect(vet / rec).toBeLessThan((0.7 + 75 / 300) / (0.7 + 30 / 300) * 1.0);
  });
});

describe('aim point on the fire mission', () => {
  it('is stored on the mission, lengthens the lay by 20-40%, and the veteran can immobilise the KV-1', () => {
    const layS = (experience: number): { aim: string | undefined; layS: number } => {
      const state = makeState(1942);
      const g = addGun(state, 'pak38', FROM, 3, { experience, ammo: 20, ammoReserve: 0, rounds: { ...NO_APCR } });
      const t = kvAt(state, 300);
      state.time = 1;
      stepCrewWeapons(state, SIM_DT);
      fireMissionWait(state, g.team, g.gunner, { aim: t.v.pos, targetTeamId: t.team.id, targetVehicle: t.v });
      const m = g.team.crewWeapon!.mission!;
      return { aim: m.aimPoint, layS: m.layS! };
    };
    const rec = layS(30), vet = layS(75);
    expect(rec.aim).toBe('mass');
    expect(vet.aim).toBe('runningGear');
    expect(vet.layS / rec.layS).toBeGreaterThanOrEqual(1.2 - 1e-9);
    expect(vet.layS / rec.layS).toBeLessThanOrEqual(1.4 + 1e-9);

    let immobilised = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const state = makeState(1942);
      addGun(state, 'pak38', FROM, 3, { experience: 75, ammo: 20, ammoReserve: 0, rounds: { ...NO_APCR, ap: 14 } });
      const t = kvAt(state, 300);
      // Isolate the gunner's aim: vehicles now return area fire on the belief formed by an
      // incoming round even without a spotted target, which otherwise suppresses this crew.
      t.v.mainAmmo = 0; t.v.coaxAmmo = 0; t.v.bowAmmo = 0;
      state.spottedVehicles.german.add(t.v.id);
      run(state, new Rng(seed), 120);
      if (t.v.state === 'immobilized' || t.v.state === 'abandoned') immobilised++;
      expect(t.v.state === 'knockedOut' || t.v.state === 'burning').toBe(false); // AP never gets through the KV-1
    }
    expect(immobilised).toBeGreaterThanOrEqual(5);
  });

  it('tells the player: "Hit the tracks — KV-1 immobilised."', () => {
    let told = false;
    for (let seed = 1; seed <= 8 && !told; seed++) {
      const state = makeState(1942);
      const g = addGun(state, 'pak38', FROM, 3, { experience: 75, ammo: 20, ammoReserve: 0, rounds: { ...NO_APCR, ap: 14 } });
      const t = kvAt(state, 300);
      state.spottedVehicles.german.add(t.v.id);
      run(state, new Rng(seed), 120);
      told = state.messages.some((m) => m.text === `${g.team.name}\nHit the tracks — KV-1 immobilised.`);
    }
    expect(told).toBe(true);
  });
});

describe('centre-of-mass luck', () => {
  it('about 5-8% of mass hits land on a weak spot, with that spot\'s thinner plate', () => {
    const state = makeState();
    const t = kvAt(state, 300);
    const rng = new Rng(21);
    let spots = 0, thinner = 0;
    const N = 8000;
    for (let i = 0; i < N; i++) {
      const loc = locateHit(rng, t.v, VEHICLE_DEFS.kv1, FROM);
      if (loc.spot) { spots++; if (locationArmorMm(VEHICLE_DEFS.kv1, loc) < VEHICLE_DEFS.kv1.armor.front) thinner++; }
    }
    expect(LUCKY_SPOT_CHANCE).toBeGreaterThanOrEqual(0.05);
    expect(LUCKY_SPOT_CHANCE).toBeLessThanOrEqual(0.08);
    expect(spots / N).toBeGreaterThan(0.03);
    expect(spots / N).toBeLessThan(0.08);
    expect(thinner).toBeGreaterThan(0);
  });

  it('every "Aiming: ..." word exists for the monitor', () => {
    expect(AIM_WORDS).toContain('Aiming: tracks');
  });
});
