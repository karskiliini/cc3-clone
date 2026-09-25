import { describe, expect, it } from 'vitest';
import {
  addTeam, applyReport, availableSoldiers, fillReplacements, newCampaign, resetUidCounter,
} from '@/campaign/roster';
import type { BattleReport } from '@/shared/types';
import { TEAM_DEFS } from '@/data/units';

const SEED = 4242;

function campaign() {
  resetUidCounter();
  return newCampaign(SEED, 'german', 200);
}

function report(teamIdx: number, soldiers: BattleReport['teams'][number]['soldiers']): BattleReport {
  return { result: 'minorVictory', fledSide: null, teams: [{ defId: 'ger_rifle_41', kills: 2, soldiers }] };
}

const def = TEAM_DEFS['ger_rifle_41'];

describe('campaign roster (G1)', () => {
  it('credits kills to the right soldier and counts battles for survivors', () => {
    const c = campaign();
    const team = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c, report(0, [
      { uid: team.soldierUids[0], name: 'A', rank: 'Gefr', weaponId: 'k98', health: 'ok', kills: 3, experience: 60, isLeader: true },
      { uid: team.soldierUids[1], name: 'B', rank: 'Gefr', weaponId: 'k98', health: 'ok', kills: 1, experience: 40, isLeader: false },
    ]));
    expect(c.soldiers[team.soldierUids[0]].kills).toBe(3);
    expect(c.soldiers[team.soldierUids[1]].kills).toBe(1);
    expect(c.soldiers[team.soldierUids[0]].battles).toBe(1);
    expect(c.soldiers[team.soldierUids[0]].health).toBe('healthy');
  });

  it('marks KIA soldiers and they never become available again', () => {
    const c = campaign();
    const team = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c, report(0, [
      { uid: team.soldierUids[0], name: 'A', rank: 'Gefr', weaponId: 'k98', health: 'dead', kills: 0, experience: 40, isLeader: true },
    ]));
    expect(c.soldiers[team.soldierUids[0]].health).toBe('kia');
    for (let i = 0; i < 10; i++) applyReport(c, report(0, []));
    expect(availableSoldiers(c).some((s) => s.uid === team.soldierUids[0])).toBe(false);
  });

  it('wounded soldiers miss battles and return when their time is up (seed reproducible)', () => {
    const c = campaign();
    const team = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c, report(0, [
      { uid: team.soldierUids[0], name: 'A', rank: 'Gefr', weaponId: 'k98', health: 'wounded', kills: 0, experience: 40, isLeader: true },
    ]));
    const rec = c.soldiers[team.soldierUids[0]];
    expect(rec.health === 'woundedLight' || rec.health === 'woundedSerious').toBe(true);
    const from = rec.availableFrom ?? 0;
    expect(from).toBeGreaterThan(1);

    // replay the same fold with the same seed: identical availability date
    const c2 = campaign();
    const team2 = addTeam(c2, 'ger_rifle_41', def.name, def.soldiers);
    applyReport(c2, report(0, [
      { uid: team2.soldierUids[0], name: 'A', rank: 'Gefr', weaponId: 'k98', health: 'wounded', kills: 0, experience: 40, isLeader: true },
    ]));
    expect(c2.soldiers[team2.soldierUids[0]].availableFrom).toBe(from);

    // before his return date he is out; at it he is back
    c.battleIndex = from - 1;
    expect(availableSoldiers(c).some((s) => s.uid === rec.uid)).toBe(false);
    c.battleIndex = from;
    expect(availableSoldiers(c).some((s) => s.uid === rec.uid)).toBe(true);
  });

  it('clamps experience into the valid band and grows it only for survivors', () => {
    const c = campaign();
    const team = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    const exp0 = c.soldiers[team.soldierUids[0]].experience;
    applyReport(c, report(0, [
      { uid: team.soldierUids[0], name: 'A', rank: 'Gefr', weaponId: 'k98', health: 'ok', kills: 1, experience: 90, isLeader: true },
    ]));
    const exp1 = c.soldiers[team.soldierUids[0]].experience;
    expect(exp1).toBeGreaterThanOrEqual(exp0);
    expect(exp1).toBeLessThanOrEqual(98);
  });

  it('fillReplacements tops a short team up with named soldiers at reduced experience', () => {
    const c = campaign();
    const team = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    // two men gone
    c.soldiers[team.soldierUids[0]].health = 'kia';
    c.soldiers[team.soldierUids[1]].health = 'kia';
    const added = fillReplacements(c, team.uid, def.soldiers.length);
    expect(team.soldierUids.length).toBe(12);
    const newcomers = team.soldierUids.slice(-2);
    for (const uid of newcomers) {
      const s = c.soldiers[uid];
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.experience).toBeLessThan(30);
    }
  });

  it('a second addTeam gets a distinct team uid and soldier uids', () => {
    const c = campaign();
    const a = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    const b = addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    expect(a.uid).not.toBe(b.uid);
    for (const uid of a.soldierUids) expect(uid in c.soldiers).toBe(true);
    for (const uid of b.soldierUids) expect(uid in c.soldiers).toBe(true);
  });
});
