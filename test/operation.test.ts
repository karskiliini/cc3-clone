import { afterEach, describe, expect, it } from 'vitest';
import { advanceOperation } from '@/ui/screens/operation';
import { OPERATION } from '@/data/operation';
import { Battle } from '@/sim/battle';
import { game } from '@/game';
import type { BattleConfig, OperationState } from '@/shared/types';

// Depends on '@/data/units' (TEAM_DEFS ids below), owned by other agents — ids verified against
// test/battle.test.ts, which already exercises them.
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

describe('advanceOperation', () => {
  afterEach(() => {
    game.operation = null;
    game.battle = null;
  });

  it('rebuilds the force pool from the just-fought battle: destroyed teams drop out, survivors keep their experience', () => {
    const battle = new Battle(config);
    const germanTeams = battle.selectableTeams('german');
    expect(germanTeams.length).toBe(2);
    const [destroyedTeam, survivingTeam] = germanTeams;

    // Kill every soldier in one german team; leave the other's crew alive.
    for (const id of destroyedTeam.soldierIds) {
      const s = battle.state.soldiers.get(id);
      if (s) s.health = 'dead';
    }
    survivingTeam.experience = 77;

    const op: OperationState = {
      index: 0,
      playerSide: 'german',
      results: [],
      forcePool: [
        { defId: destroyedTeam.defId, experience: 30, alive: destroyedTeam.soldierIds.length },
        { defId: survivingTeam.defId, experience: 30, alive: survivingTeam.soldierIds.length },
      ],
      requisition: OPERATION[0].requisition.german,
    };
    game.operation = op;
    game.battle = battle;

    advanceOperation('minorVictory');

    expect(op.results).toEqual(['minorVictory']);
    expect(op.index).toBe(1);
    expect(op.requisition).toBe(OPERATION[1].requisition.german);

    // The destroyed team is gone; the surviving team is kept with its post-battle experience.
    expect(op.forcePool.some((f) => f.defId === destroyedTeam.defId)).toBe(false);
    const survivorEntry = op.forcePool.find((f) => f.defId === survivingTeam.defId);
    expect(survivorEntry).toBeDefined();
    expect(survivorEntry?.experience).toBe(77);
    expect(survivorEntry?.alive).toBe(survivingTeam.soldierIds.length);
  });

  it('leaves the force pool untouched when there is no in-progress battle to rebuild it from', () => {
    const op: OperationState = {
      index: 0,
      playerSide: 'german',
      results: [],
      forcePool: [{ defId: 'ger_rifle_41', experience: 45, alive: 4 }],
      requisition: OPERATION[0].requisition.german,
    };
    game.operation = op;
    game.battle = null;

    advanceOperation('minorDefeat');

    expect(op.results).toEqual(['minorDefeat']);
    expect(op.forcePool).toEqual([{ defId: 'ger_rifle_41', experience: 45, alive: 4 }]);
  });
});
