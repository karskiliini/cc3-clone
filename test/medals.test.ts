import { describe, it, expect } from 'vitest';
import { MEDAL_DEFS, earnedMedals, medalById } from '../src/data/medals';
import { addTeam, applyReport, newCampaign, resetUidCounter } from '../src/campaign/roster';
import { RANKS } from '../src/data/names';
import { TEAM_DEFS } from '../src/data/units';
import type { SoldierOutcome, TeamOutcome } from '../src/shared/types';

function outcome(kills: number, health: 'ok' | 'dead' | 'wounded' = 'ok'): SoldierOutcome {
  return { uid: '', name: 'x', rank: 'Schtz', weaponId: 'kar98k', health, kills, experience: 50, isLeader: false };
}

function reportFor(defId: string, outs: SoldierOutcome[]): { result: 'totalVictory'; fledSide: null; teams: TeamOutcome[] } {
  return {
    result: 'totalVictory',
    fledSide: null,
    teams: [{ defId, kills: outs.reduce((s, o) => s + o.kills, 0), soldiers: outs }],
  };
}

describe('medal data (G2)', () => {
  it('ladders ascend by kill threshold and ids resolve', () => {
    for (const side of ['german', 'soviet'] as const) {
      const defs = MEDAL_DEFS[side];
      expect(defs.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < defs.length; i++) expect(defs[i].kills).toBeGreaterThan(defs[i - 1].kills);
      for (const m of defs) expect(medalById(m.id)?.name).toBe(m.name);
    }
  });

  it('earnedMedals grants the next rung only once', () => {
    expect(earnedMedals('german', 0, [])).toEqual([]);
    expect(earnedMedals('german', 2, [])).toEqual(['ironCross2']);
    expect(earnedMedals('german', 2, ['ironCross2'])).toEqual([]);
    expect(earnedMedals('german', 16, [])).toEqual(['ironCross2', 'ironCross1', 'germanCross', 'knightsCross']);
  });
});

describe('applyReport awards (G2)', () => {
  it('awards medals on cumulative kills and records lastAwards', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_rifle_41'];
    addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c, reportFor('ger_rifle_41', [outcome(2), ...def.soldiers.slice(1).map(() => outcome(0))]));
    const man = c.soldiers[c.teams[0].soldierUids[0]];
    expect(man.medals).toEqual(['ironCross2']);
    expect(c.lastAwards.length).toBe(1);
    expect(c.lastAwards[0].medalIds).toEqual(['ironCross2']);
    expect(c.lastAwards[0].promotedTo).toBeUndefined();
    // second battle: reaches IC1 with cumulative kills
    applyReport(c, reportFor('ger_rifle_41', [outcome(3), ...def.soldiers.slice(1).map(() => outcome(0))]));
    expect(c.soldiers[c.teams[0].soldierUids[0]].medals).toEqual(['ironCross2', 'ironCross1']);
  });

  it('promotes NCOs after a 3-kill battle and never into the officer slot', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_rifle_41'];
    addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    const team = c.teams[0];
    const ranksBefore = team.soldierUids.map((uid) => c.soldiers[uid].rank);
    applyReport(c, reportFor('ger_rifle_41', def.soldiers.map(() => outcome(3))));
    team.soldierUids.forEach((uid, i) => {
      const idx = RANKS.german.indexOf(ranksBefore[i]);
      if (idx > 1) expect(c.soldiers[uid].rank).toBe(RANKS.german[idx - 1]);
      else expect(c.soldiers[uid].rank).toBe(ranksBefore[i]);
    });
    // officers (index <= 1) never promoted
    const ltMen = team.soldierUids.filter((uid) => RANKS.german.indexOf(ranksBefore[team.soldierUids.indexOf(uid)]) <= 1);
    for (const uid of ltMen) expect(c.soldiers[uid].rank).toBe(ranksBefore[team.soldierUids.indexOf(uid)]);
  });

  it('dead men still earn medals for prior kills, but are never promoted', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_rifle_41'];
    addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c, reportFor('ger_rifle_41', [outcome(5, 'dead'), ...def.soldiers.slice(1).map(() => outcome(0))]));
    const dead = c.soldiers[c.teams[0].soldierUids[0]];
    expect(dead.health).toBe('kia');
    expect(dead.medals).toEqual(['ironCross2', 'ironCross1']);
    expect(c.lastAwards[0].promotedTo).toBeUndefined();
  });
});
