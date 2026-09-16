import { describe, it, expect } from 'vitest';
import type { Team } from '@/shared/types';
import { finalStateLabel, RESULT_WORDS } from '@/ui/screens/debrief';

function team(status: Team['status']): Team {
  return { status } as unknown as Team;
}

describe('finalStateLabel (round5 critique #10)', () => {
  it('shows the terminal states as-is, not the in-battle activity word', () => {
    expect(finalStateLabel(team('Destroyed'), false)).toBe('Destroyed');
    expect(finalStateLabel(team('Knocked Out'), false)).toBe('Knocked Out');
    expect(finalStateLabel(team('Routed'), false)).toBe('Routed');
    expect(finalStateLabel(team('Surrendered'), false)).toBe('Surrendered');
  });

  it('never shows a live in-battle activity word ("Loading", "Firing", "Moving Fast") as an end state', () => {
    for (const activity of ['Loading', 'Firing', 'Aiming', 'Setting up', 'Moving Fast', 'Waiting', 'Defending'] as const) {
      const label = finalStateLabel(team(activity), false);
      expect(label).not.toBe(activity);
      expect(['Intact', 'Withdrawn']).toContain(label);
    }
  });

  it('a surviving team reads "Intact" normally and "Withdrawn" when its own side fled the field', () => {
    expect(finalStateLabel(team('Waiting'), false)).toBe('Intact');
    expect(finalStateLabel(team('Waiting'), true)).toBe('Withdrawn');
  });
});

describe('RESULT_WORDS (round5 critique #10)', () => {
  it('covers all nine graded levels with the manual\'s Total/Decisive/Major/Minor vocabulary', () => {
    expect(RESULT_WORDS.totalVictory).toBe('Total Victory');
    expect(RESULT_WORDS.decisiveVictory).toBe('Decisive Victory');
    expect(RESULT_WORDS.majorVictory).toBe('Major Victory');
    expect(RESULT_WORDS.minorVictory).toBe('Minor Victory');
    expect(RESULT_WORDS.draw).toBe('Draw');
    expect(RESULT_WORDS.minorDefeat).toBe('Minor Defeat');
    expect(RESULT_WORDS.majorDefeat).toBe('Major Defeat');
    expect(RESULT_WORDS.decisiveDefeat).toBe('Decisive Defeat');
    expect(RESULT_WORDS.totalDefeat).toBe('Total Defeat');
  });
});
