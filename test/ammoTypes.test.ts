// Ammunition types (req_ammo_damage A): AP / APCR / HE / smoke per gun, chosen at LOAD.
import { describe, it, expect } from 'vitest';
import type { BattleState } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { penetrates, expectedPenetrationChance, bestRoundAgainst, apcrIssued } from '@/sim/ballistics';
import { chooseRound, splitRounds, soldierRounds, vehicleRounds } from '@/sim/aimPoint';
import { resolveVehicleHit } from '@/sim/vehicleDamage';
import { stepCombat } from '@/sim/combat';
import { stepCrewWeapons } from '@/sim/crewWeapon';
import { makeState, addTank, addGun, soldier, mkTeam } from './vehicleDamageHelpers';

const KV = VEHICLE_DEFS.kv1.armor;

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

describe('penetration by round type', () => {
  it('PaK 38 plain AP cannot penetrate a KV-1 frontally at 300 m; APCR can inside ~250 m and cannot at 600 m', () => {
    const pak = WEAPONS.pak38;
    const rng = new Rng(3);
    let ap = 0, apcrNear = 0, apcrFar = 0;
    for (let i = 0; i < 5000; i++) {
      if (penetrates(pak, 300, KV.front, rng, 'ap')) ap++;
      if (penetrates(pak, 250, KV.front, rng, 'apcr')) apcrNear++;
      if (penetrates(pak, 600, KV.front, rng, 'apcr')) apcrFar++;
    }
    expect(ap).toBe(0);
    expect(apcrNear / 5000).toBeGreaterThan(0.6);
    expect(apcrFar).toBe(0);
    expect(expectedPenetrationChance(pak, 100, KV.front, 'ap')).toBeLessThan(0.05); // never, at any range
    expect(expectedPenetrationChance(pak, 200, KV.front, 'apcr')).toBeGreaterThan(0.85);
  });

  it('PaK 40 AP penetrates the KV-1', () => {
    expect(expectedPenetrationChance(WEAPONS.pak40, 300, KV.front, 'ap')).toBeGreaterThan(0.75);
    expect(expectedPenetrationChance(WEAPONS.pak40, 300, KV.rear, 'ap')).toBeGreaterThan(0.9);
  });

  it('the short 7.5 cm gets a HEAT round from 1942 that does not lose penetration with range', () => {
    const k = WEAPONS.kwk37_75;
    expect(expectedPenetrationChance(k, 100, 60, 'apcr')).toBeCloseTo(expectedPenetrationChance(k, 600, 60, 'apcr'), 6);
    expect(apcrIssued(k, 1941)).toBe(false);
    expect(apcrIssued(k, 1942)).toBe(true);
  });

  it('APCR is issued by battle year', () => {
    const g = WEAPONS.m1937_45mm;
    expect(splitRounds(g, 260, 1941).apcr).toBe(0);
    expect(splitRounds(g, 260, 1942).apcr).toBe(3);
    const c = splitRounds(g, 260, 1942);
    expect(c.ap + c.apcr + c.he + c.smoke).toBe(260);
    expect(splitRounds(WEAPONS.zis3, 100, 1942).apcr).toBe(0);
    expect(splitRounds(WEAPONS.zis3, 100, 1943).apcr).toBe(3);
    // the enemy's reckoning of the gun follows the year too
    expect(bestRoundAgainst(g, 100, 60, 1941).round).toBe('ap');
    expect(bestRoundAgainst(g, 100, 60, 1942).round).toBe('apcr');
    // a gunner's count is split lazily and keeps ammo + reserve as its total
    const s = soldier(1, 1, 'soviet', { x: 1, y: 1 }, 'm1937_45mm', { ammo: 20, ammoReserve: 40 });
    const r = soldierRounds(makeState(1941), s);
    expect(r.apcr).toBe(0);
    expect(r.ap + r.he).toBe(60);
  });

  it('every gun has a load of AP and HE that adds up to its ammo', () => {
    for (const w of Object.values(WEAPONS)) {
      if (w.cls !== 'atgun' && w.cls !== 'tankgun') continue;
      expect(w.rounds, w.id).toBeDefined();
      const r = w.rounds!;
      expect(r.ap + (r.apcr ?? 0) + r.he + (r.smoke ?? 0), w.id).toBe(w.ammo);
      if (r.apcr) expect(w.apcr, w.id).toBeDefined();
    }
  });
});

describe('the round is chosen at load', () => {
  it('chooseRound: APCR for the KV-1 up close, AP for a T-26, HE for infantry, smoke if carried else HE', () => {
    const pak = WEAPONS.pak38;
    const counts = { ap: 10, apcr: 4, he: 6, smoke: 0 };
    expect(chooseRound(pak, counts, { kind: 'vehicle', armorMm: KV.front, distM: 200 })).toBe('apcr');
    expect(chooseRound(pak, counts, { kind: 'vehicle', armorMm: VEHICLE_DEFS.t26.armor.front, distM: 200 })).toBe('ap');
    expect(chooseRound(pak, counts, { kind: 'soft' })).toBe('he');
    expect(chooseRound(pak, counts, { kind: 'smoke' })).toBe('he');
    expect(chooseRound(WEAPONS.kwk37_75, { ap: 5, apcr: 0, he: 5, smoke: 2 }, { kind: 'smoke' })).toBe('smoke');
    // APCR gone, or too far for it: plain AP (at the running gear, see aimPoint)
    expect(chooseRound(pak, { ...counts, apcr: 0 }, { kind: 'vehicle', armorMm: KV.front, distM: 200 })).toBe('ap');
    expect(chooseRound(pak, counts, { kind: 'vehicle', armorMm: KV.front, distM: 600 })).toBe('ap');
  });

  function gunVs(targetDef: string | null, distTiles = 100): ReturnType<typeof addGun> & { state: BattleState; fired: string[] } {
    const state = makeState(1942);
    const g = addGun(state, 'pak38', { x: 200, y: 300 }, 3, { ammo: 20, ammoReserve: 0 });
    if (targetDef) {
      const t = addTank(state, targetDef, { x: 200, y: 300 - distTiles }, Math.PI); // hull towards the gun
      state.spottedVehicles.german.add(t.v.id);
    } else {
      const e = soldier(900, 900, 'soviet', { x: 200, y: 300 - distTiles }, 'mosin');
      state.soldiers.set(900, e);
      state.teams.set(900, mkTeam(900, 'rifle', [900], 'soviet', e.pos));
      state.spotted.german.add(900);
    }
    return { ...g, state, fired: [] };
  }

  it('the loader picks APCR for the KV-1, AP for a T-26 and HE for infantry; ammo decrements per type', () => {
    for (const [target, want] of [['kv1', 'apcr'], ['t26', 'ap'], [null, 'he']] as const) {
      const g = gunVs(target);
      const before = { ...soldierRounds(g.state, g.gunner) };
      const rng = new Rng(9);
      let seen: string | undefined;
      run(g.state, rng, 12, () => { if (g.team.crewWeapon!.chambered && !seen) seen = g.team.crewWeapon!.chamberedType; });
      expect(seen, String(target)).toBe(want);
      const after = soldierRounds(g.state, g.gunner);
      expect(after[want], String(target)).toBeLessThan(before[want]);
      for (const k of ['ap', 'apcr', 'he'] as const) if (k !== want) expect(after[k], `${target} ${k}`).toBe(before[k]);
      // totals stay in step with what the HUD and the reload code read
      expect(after.ap + after.apcr + after.he + after.smoke).toBe(g.gunner.ammo + g.gunner.ammoReserve);
    }
  });

  it('a wrong round for a new kind of target is unloaded (2 s) and goes back on the stack', () => {
    const g = gunVs(null);
    const rng = new Rng(4);
    for (let i = 0; i < 100 && !g.team.crewWeapon!.chambered; i++) run(g.state, rng, 0.1);
    expect(g.team.crewWeapon!.chamberedType).toBe('he');
    // the infantry goes to ground out of sight, a KV-1 rolls up
    g.state.spotted.german.clear();
    const heBefore = soldierRounds(g.state, g.gunner).he;
    const t = addTank(g.state, 'kv1', { x: 200, y: 200 }, Math.PI);
    g.state.spottedVehicles.german.add(t.v.id);
    let unloading = false;
    run(g.state, rng, 8, () => { if (g.men.some((m) => m.crewTask?.id === 'unload')) unloading = true; });
    expect(unloading).toBe(true);
    expect(soldierRounds(g.state, g.gunner).he).toBe(heBefore + 1);
    expect(['apcr', undefined]).toContain(g.team.crewWeapon!.chamberedType); // APCR loaded (or already fired)
  });

  it('says "Out of APCR." once when the last one is loaded', () => {
    const g = gunVs('kv1');
    g.gunner.rounds = { ap: 8, apcr: 1, he: 11, smoke: 0 };
    run(g.state, new Rng(2), 30);
    expect(g.state.messages.filter((m) => m.text === `${g.team.name}\nOut of APCR.`)).toHaveLength(1);
    expect(soldierRounds(g.state, g.gunner).apcr).toBe(0);
  });

  it('a tank loads by type too: HE for infantry, and its counts add up to mainAmmo', () => {
    const state = makeState(1943);
    const t = addTank(state, 'pz4gh', { x: 200, y: 300 }, 0);
    const e = soldier(900, 900, 'soviet', { x: 200, y: 250 }, 'mosin');
    state.soldiers.set(900, e);
    state.teams.set(900, mkTeam(900, 'rifle', [900], 'soviet', e.pos));
    state.spotted.german.add(900);
    const r0 = { ...vehicleRounds(state, t.v) };
    expect(r0.ap + r0.apcr + r0.he + r0.smoke).toBe(t.v.mainAmmo);
    run(state, new Rng(1), 6);
    const r = vehicleRounds(state, t.v);
    expect(r.he).toBeLessThan(r0.he);
    expect(r.ap).toBe(r0.ap);
    expect(r.ap + r.apcr + r.he + r.smoke).toBe(t.v.mainAmmo);
  });
});

describe('threat ranking uses the best round (mind spec §10.1)', () => {
  it('a KV-1 crew respects a PaK 38 at 200 m (APCR) and shrugs at it at 600 m', () => {
    const pak = WEAPONS.pak38;
    expect(bestRoundAgainst(pak, 200, KV.front, 1942).chance).toBeGreaterThan(0.15);
    expect(bestRoundAgainst(pak, 200, KV.front, 1942).round).toBe('apcr');
    expect(bestRoundAgainst(pak, 600, KV.front, 1942).chance).toBeLessThan(0.15);
  });
});

describe('running gear', () => {
  it('hits on the running gear immobilise, whatever the armour', () => {
    let immobilised = 0;
    const rng = new Rng(6);
    for (let i = 0; i < 200; i++) {
      const state = makeState();
      const { v } = addTank(state, 'kv1', { x: 100, y: 100 }, 0);
      const res = resolveVehicleHit(state, rng, v, { weapon: WEAPONS.pak38, round: 'ap', shooterPos: { x: 100, y: 0 }, shooterSide: 'german', distM: 200, aimPoint: 'runningGear' });
      expect(res.location.zone === 'runningGearL' || res.location.zone === 'runningGearR').toBe(true);
      expect(v.state === 'knockedOut' || v.state === 'burning').toBe(false);
      if (v.state === 'immobilized') immobilised++;
    }
    expect(immobilised).toBeGreaterThan(100);
  });
});
