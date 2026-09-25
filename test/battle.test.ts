import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { SIM_DT } from '@/shared/types';
import type { BattleConfig } from '@/shared/types';

// Depends on '@/data/units' (TEAM_DEFS ids below) and '@/data/maps' (mapId below), owned by
// other agents. Ids verified against src/data/units.ts / src/data/maps once they existed.
const config: BattleConfig = {
  mapId: 'border_1941',
  playerSide: 'german',
  year: 1941,
  seed: 1,
  durationS: 120,
  difficulty: 'normal',
  forces: {
    german: ['ger_rifle_41', 'ger_pz4f1'],
    soviet: ['sov_rifle_41'],
  },
};

describe('Battle', () => {
  it('deploys forces, runs to completion, and obeys orders', () => {
    const battle = new Battle(config);
    expect(battle.state.phase).toBe('deploy');

    const germanTeams = battle.selectableTeams('german');
    expect(germanTeams.length).toBeGreaterThan(0);

    battle.start();
    expect(battle.state.phase).toBe('running');

    const moveTeam = germanTeams[0];
    const leader = battle.state.soldiers.get(moveTeam.leaderId)!;
    const startPos = { x: leader.pos.x, y: leader.pos.y };
    battle.issueOrder(moveTeam.id, {
      type: 'move',
      target: { x: startPos.x + 10, y: startPos.y },
      issuedAt: 0,
    });

    const defendTeam = germanTeams[germanTeams.length - 1];
    const defendFrom = { x: defendTeam.pos.x, y: defendTeam.pos.y };
    battle.issueOrder(defendTeam.id, {
      type: 'defend',
      target: { x: defendFrom.x, y: defendFrom.y + 5 },
      issuedAt: 0,
    });

    // Facing is set immediately by a defend order, before any simulation.
    expect(defendTeam.facing).toBe(4); // south, per FACING_DIR / facingTo semantics

    const steps = Math.round(120 / SIM_DT);
    expect(() => {
      for (let i = 0; i < steps; i++) battle.step(SIM_DT);
    }).not.toThrow();

    expect(battle.state.phase).toBe('ended');
    expect(battle.state.result).not.toBeNull();

    const leaderAfter = battle.state.soldiers.get(moveTeam.leaderId)!;
    if (leaderAfter.health !== 'dead' && leaderAfter.health !== 'incapacitated') {
      const moved = Math.hypot(leaderAfter.pos.x - startPos.x, leaderAfter.pos.y - startPos.y);
      expect(moved).toBeGreaterThan(0.1);
    }
  }, 30000);
});
