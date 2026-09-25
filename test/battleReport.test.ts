import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import type { BattleConfig } from '@/shared/types';

const config: BattleConfig = {
  mapId: 'border_1941',
  playerSide: 'german',
  year: 1941,
  seed: 7,
  durationS: 120,
  difficulty: 'normal',
  forces: {
    german: ['ger_rifle_41', 'ger_pz4f1'],
    soviet: ['sov_rifle_41'],
  },
};

describe('battleReport (G1)', () => {
  it('exports every player-side team and soldier with uids when a roster payload is given', () => {
    const battle = new Battle(config);
    const teams = battle.selectableTeams('german');
    const infantry = teams[0];
    // stamp uids as the campaign would
    infantry.soldierIds.forEach((id, i) => {
      const s = battle.state.soldiers.get(id);
      if (s) s.uid = `t0/${i}`;
    });

    const rep = battle.battleReport();
    expect(rep.teams.length).toBe(2);
    const totalSoldiers = rep.teams.reduce((n, t) => n + t.soldiers.length, 0);
    expect(totalSoldiers).toBeGreaterThan(0);
    expect(rep.teams[0].soldiers[0].uid).toBe('t0/0');
  });

  it('falls back to battle-local uids when no roster payload exists', () => {
    const battle = new Battle(config);
    const rep = battle.battleReport();
    const first = rep.teams[0].soldiers[0];
    expect(first.uid).toMatch(/^b\d+$/);
  });

  it('reflects health changes: dead men export as dead', () => {
    const battle = new Battle(config);
    const teams = battle.selectableTeams('german');
    const victim = battle.state.soldiers.get(teams[0].soldierIds[0]);
    if (victim) victim.health = 'dead';
    const rep = battle.battleReport();
    expect(rep.teams[0].soldiers[0].health).toBe('dead');
  });

  it('sums per-soldier kills consistently with team kills after kills are awarded', () => {
    const battle = new Battle(config);
    const teams = battle.selectableTeams('german');
    const soldier = battle.state.soldiers.get(teams[0].soldierIds[0]);
    const team = battle.state.teams.get(teams[0].id);
    if (soldier) soldier.kills += 2;
    if (team) team.kills += 2;
    const rep = battle.battleReport();
    const sum = rep.teams[0].soldiers.reduce((n, s) => n + s.kills, 0);
    expect(sum).toBe(2);
    expect(rep.teams[0].kills).toBe(2);
  });
});
