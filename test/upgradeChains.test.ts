import { describe, it, expect } from 'vitest';
import { TEAM_DEFS } from '../src/data/units';
import { addTeam, newCampaign, resetUidCounter, upgradeTeam } from '../src/campaign/roster';

describe('upgrade chains data (G3b)', () => {
  it('every upgradesTo target exists, is same side, and becomes available strictly later', () => {
    for (const def of Object.values(TEAM_DEFS)) {
      if (!def.upgradesTo) continue;
      const next = TEAM_DEFS[def.upgradesTo];
      expect(next, `${def.id} -> ${def.upgradesTo} exists`).toBeDefined();
      expect(next.side).toBe(def.side);
      expect(Math.max(...next.years)).toBeGreaterThan(Math.max(...def.years));
    }
  });

  it('no cycles in the upgrade graph', () => {
    for (const def of Object.values(TEAM_DEFS)) {
      const seen = new Set<string>([def.id]);
      let cur = def.upgradesTo;
      while (cur) {
        expect(seen.has(cur), `no cycle from ${def.id}`).toBe(false);
        seen.add(cur);
        cur = TEAM_DEFS[cur]?.upgradesTo;
      }
    }
  });
});

describe('upgradeTeam (G3b)', () => {
  it('carries veterans forward: uid/name/kills/experience survive, rank/weaponId refresh', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_rifle_41'];
    addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    const team = c.teams[0];
    const vet = c.soldiers[team.soldierUids[0]];
    vet.kills = 7;
    vet.experience = 85;
    vet.name = 'Werner';
    const uid = vet.uid;

    expect(upgradeTeam(c, team.uid, 1943)).toBe(true);
    expect(team.defId).toBe('ger_rifle_43');
    expect(team.soldierUids[0]).toBe(uid);
    const carried = c.soldiers[uid];
    expect(carried.kills).toBe(7);
    expect(carried.experience).toBe(85);
    expect(carried.name).toBe('Werner');
    // weapon refreshed from the 1943 def
    expect(carried.weaponId).toBe(TEAM_DEFS['ger_rifle_43'].soldiers[0].weaponId);
    expect(carried.rank).toBe(TEAM_DEFS['ger_rifle_43'].soldiers[0].rank);
  });

  it('charges the cost difference and rejects when requisition is insufficient', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 5);
    const def = TEAM_DEFS['ger_pak38'];
    addTeam(c, 'ger_pak38', def.name, def.soldiers);
    // pak38 30 -> pak40 40: diff 10 > 5
    expect(upgradeTeam(c, c.teams[0].uid, 1943)).toBe(false);
    expect(c.teams[0].defId).toBe('ger_pak38');
    c.requisition = 10;
    expect(upgradeTeam(c, c.teams[0].uid, 1943)).toBe(true);
    expect(c.requisition).toBe(0);
    expect(c.teams[0].defId).toBe('ger_pak40');
  });

  it('rejects when the successor is not yet available in the year', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_pz3j'];
    addTeam(c, 'ger_pz3j', def.name, def.soldiers, 'pz3j');
    // pz3j -> pz4gh (Y42_45); upgrading in 1941 is impossible
    expect(upgradeTeam(c, c.teams[0].uid, 1941)).toBe(false);
    expect(c.teams[0].defId).toBe('ger_pz3j');
    expect(upgradeTeam(c, c.teams[0].uid, 1942)).toBe(true);
    expect(c.teams[0].defId).toBe('ger_pz4gh');
  });

  it('swaps the vehicle hull and clears carry-over damage', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_pz4f1'];
    addTeam(c, 'ger_pz4f1', def.name, def.soldiers, 'pz4f1');
    c.teams[0].vehicleDamage = 'immobilised';
    expect(upgradeTeam(c, c.teams[0].uid, 1942)).toBe(true);
    expect(c.teams[0].defId).toBe('ger_pz4gh');
    expect(c.teams[0].vehicleDefId).toBe('pz4gh');
    expect(c.teams[0].vehicleDamage).toBeUndefined();
  });

  it('truncates to the successor squad size, dropping KIA tail first', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_rifle_41'];
    addTeam(c, 'ger_rifle_41', def.name, def.soldiers);
    const team = c.teams[0];
    // KIA the last two men: rifle_41 has 10, rifle_43 has 9 -> survivors 8, no truncation loss
    const lastTwo = team.soldierUids.slice(-2);
    for (const uid of lastTwo) c.soldiers[uid].health = 'kia';
    const survivorUids = team.soldierUids.filter((uid) => !lastTwo.includes(uid));
    expect(upgradeTeam(c, team.uid, 1943)).toBe(true);
    expect(team.soldierUids).toEqual(survivorUids);
    expect(team.soldierUids.length).toBe(TEAM_DEFS['ger_rifle_43'].soldiers.length - 1);
  });

  it('returns false for teams without an upgrade path', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS['ger_sniper'];
    addTeam(c, 'ger_sniper', def.name, def.soldiers);
    expect(upgradeTeam(c, c.teams[0].uid, 1944)).toBe(false);
    expect(c.teams[0].defId).toBe('ger_sniper');
  });
});
