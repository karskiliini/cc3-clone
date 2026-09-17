// Spawned experience by side, year and kind of unit (data/experience.ts), and the words for it.
import { describe, it, expect } from 'vitest';
import type { TeamDef } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { TEAM_DEFS } from '@/data/units';
import { EXP_RECRUIT, EXP_REGULAR, EXP_VETERAN, EXP_HERO } from '@/sim/gunTiming';
import { VETERAN_EXP, RECRUIT_EXP } from '@/sim/vehicleCrew';
import { experienceBand, experienceLevel, rollExperience, teamQuality, typicalExperience, EXP_LEVEL_REGULAR, EXP_LEVEL_VETERAN, EXP_LEVEL_HERO } from '@/data/experience';
import { spawnTeam } from '@/sim/spawn';
import { makeState } from './vehicleDamageHelpers';

/** Every man of `defId` spawned in `year` over seeds 1..n. */
function sample(defId: string, year: number, n = 120): number[] {
  const out: number[] = [];
  for (let seed = 1; seed <= n; seed++) {
    const state = makeState(year);
    const team = spawnTeam(state, TEAM_DEFS[defId], TEAM_DEFS[defId].side, { x: 50.5, y: 50.5 }, new Rng(seed));
    for (const id of team.soldierIds) out.push(state.soldiers.get(id)!.experience);
  }
  return out;
}
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const share = (a: number[], pred: (e: number) => boolean): number => a.filter(pred).length / a.length;

describe('experience words', () => {
  it('Recruit / Regular / Veteran / Hero on the sim\'s behaviour thresholds', () => {
    expect(experienceLevel(0)).toBe('Recruit');
    expect(experienceLevel(39.9)).toBe('Recruit');
    expect(experienceLevel(40)).toBe('Regular');
    expect(experienceLevel(69.9)).toBe('Regular');
    expect(experienceLevel(70)).toBe('Veteran');
    expect(experienceLevel(85)).toBe('Veteran');
    expect(experienceLevel(85.1)).toBe('Hero');
    expect(experienceLevel(100)).toBe('Hero');
    expect(EXP_LEVEL_REGULAR).toBe(RECRUIT_EXP);
    expect(EXP_LEVEL_VETERAN).toBe(VETERAN_EXP);
    expect(EXP_LEVEL_HERO).toBe(85);
    // the gun-drill anchors (sim/gunTiming.ts) each carry their own word
    expect([EXP_RECRUIT, EXP_REGULAR, EXP_VETERAN, EXP_HERO].map(experienceLevel)).toEqual(['Recruit', 'Regular', 'Veteran', 'Hero']);
  });
});

describe('experience by side, year and unit', () => {
  it('1941: Soviet line troops are mostly recruits, German veterans are common', () => {
    const sov = sample('sov_rifle_41', 1941), ger = sample('ger_rifle_41', 1941);
    expect(share(sov, (e) => e < EXP_LEVEL_REGULAR)).toBeGreaterThan(0.65);
    expect(share(ger, (e) => e >= EXP_LEVEL_VETERAN)).toBeGreaterThan(0.15);
    expect(share(ger, (e) => e < EXP_LEVEL_REGULAR)).toBeLessThan(0.05);
    expect(mean(ger) - mean(sov)).toBeGreaterThan(20);
  });

  it('the armies trade places by 1944-45; Panzerfaust teams are the rawest Germans', () => {
    expect(mean(sample('sov_rifle_43', 1945))).toBeGreaterThan(mean(sample('ger_rifle_43', 1945)) + 10);
    expect(mean(sample('ger_rifle_43', 1943))).toBeGreaterThan(mean(sample('ger_rifle_43', 1945)) + 10);
    const faust = sample('ger_pzfaust_44', 1945);
    expect(mean(faust)).toBeLessThan(mean(sample('ger_rifle_43', 1945)) - 8);
    expect(share(faust, (e) => e < EXP_LEVEL_REGULAR)).toBeGreaterThan(0.8);
  });

  it('elite units stand above the line: snipers, command, assault squads, Tiger and Guards-era crews', () => {
    const line43 = mean(sample('ger_rifle_43', 1943));
    for (const id of ['ger_sniper', 'ger_command', 'ger_tiger']) expect(mean(sample(id, 1943, 200))).toBeGreaterThan(line43 + 12);
    for (const id of ['ger_assault_42', 'ger_engineers', 'ger_panther']) expect(mean(sample(id, 1943))).toBeGreaterThan(line43 + 4);
    expect(share(sample('ger_tiger', 1943), (e) => e >= EXP_LEVEL_VETERAN)).toBeGreaterThan(0.45);
    // Guards: the same SMG squad is better in 1944 than the year's change alone explains
    expect(teamQuality(TEAM_DEFS.sov_smg_42, 1942)).toBe('seasoned');
    expect(teamQuality(TEAM_DEFS.sov_smg_42, 1944)).toBe('elite');
    expect(mean(sample('sov_smg_42', 1944))).toBeGreaterThan(mean(sample('sov_rifle_43', 1944)) + 12);
    expect(mean(sample('sov_is2', 1944))).toBeGreaterThan(mean(sample('sov_su76', 1944)) + 12);
    expect(mean(sample('sov_t34_85', 1944))).toBeGreaterThan(mean(sample('sov_t34_76', 1941)) + 20);
  });

  it('a few aces turn up, the range is far wider than the old 20-60, and leaders are the better men', () => {
    const all = [...sample('ger_rifle_41', 1941, 300), ...sample('sov_rifle_43', 1944, 300)];
    const aces = share(all, (e) => e > EXP_LEVEL_HERO);
    expect(aces).toBeGreaterThan(0.005);
    expect(aces).toBeLessThan(0.06);
    const everyone = [...sample('sov_rifle_41', 1941), ...sample('ger_tiger', 1943), ...sample('ger_pzfaust_44', 1945)];
    expect(Math.min(...everyone)).toBeLessThan(15);
    expect(Math.max(...everyone)).toBeGreaterThan(90);
    for (const e of everyone) { expect(e).toBeGreaterThanOrEqual(0); expect(e).toBeLessThanOrEqual(100); }
    let leaders = 0, others = 0, nl = 0, no = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const state = makeState(1943);
      const team = spawnTeam(state, TEAM_DEFS.ger_rifle_43, 'german', { x: 50.5, y: 50.5 }, new Rng(seed));
      for (const id of team.soldierIds) { const s = state.soldiers.get(id)!; if (s.isLeader) { leaders += s.experience; nl++; } else { others += s.experience; no++; } }
    }
    expect(leaders / nl).toBeGreaterThan(others / no + 4);
  });

  it('an explicit [min, max] on the def overrides the table; the purchase-screen word is the middle of the band', () => {
    const def: TeamDef = { ...TEAM_DEFS.sov_rifle_41, experience: [80, 90] };
    expect(experienceBand(def, 1941)).toEqual([80, 90]);
    for (let i = 0; i < 20; i++) { const e = rollExperience(def, 1941, false, i / 25); expect(e).toBeGreaterThanOrEqual(80); expect(e).toBeLessThanOrEqual(90); }
    expect(experienceLevel(typicalExperience(TEAM_DEFS.sov_rifle_41, 1941))).toBe('Recruit');
    expect(experienceLevel(typicalExperience(TEAM_DEFS.ger_rifle_41, 1941))).toBe('Regular');
    expect(experienceLevel(typicalExperience(TEAM_DEFS.ger_tiger, 1943))).toBe('Veteran');
    // every def has a sane band in each of its years
    for (const d of Object.values(TEAM_DEFS)) for (const y of d.years) { const [lo, hi] = experienceBand(d, y); expect(lo).toBeGreaterThanOrEqual(5); expect(hi).toBeLessThanOrEqual(98); expect(hi - lo).toBeGreaterThan(15); }
  });

  it('is deterministic: the same seed gives the same men, and one draw per man as before', () => {
    const run = (seed: number): string => {
      const state = makeState(1942);
      const rng = new Rng(seed);
      const team = spawnTeam(state, TEAM_DEFS.ger_rifle_41, 'german', { x: 50.5, y: 50.5 }, rng);
      return JSON.stringify([team.experience, team.soldierIds.map((id) => state.soldiers.get(id)!.experience), rng.next()]);
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });
});
