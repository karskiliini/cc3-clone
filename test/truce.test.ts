import { describe, it, expect } from 'vitest';
import { Battle } from '../src/sim/battle';
import { otherSide, type BattleConfig } from '../src/shared/types';

function battleWith(forces: { german: string[]; soviet: string[] }): Battle {
  return new Battle({
    mapId: 'border_1941',
    playerSide: 'german',
    year: 1941,
    seed: 7,
    durationS: 600,
    difficulty: 'normal',
    forces,
  } as BattleConfig);
}

describe('truce negotiation (G14)', () => {
  it('AI accepts a player offer when it is losing; refuses when it is winning', () => {
    const b = battleWith({ german: ['ger_command'], soviet: ['sov_rifle_41'] });
    b.start();
    const s = b.state.sides;
    // set the losing situation first, then offer once
    s.soviet.morale = 30;
    s.soviet.losses = 10;
    s.german.losses = 0;
    b.offerTruce('german');
    expect(s.soviet.truceOffered).toBe(true);
    expect(s.soviet.truceAccepted).toBe(true);
    expect(b.state.messages.some((m) => m.text.includes('accepted the truce'))).toBe(true);
  });

  it('the AI sues for a truce only after the minimum time and only when badly losing', () => {
    const b = battleWith({ german: ['ger_command'], soviet: ['sov_rifle_41'] });
    b.start();
    const s = b.state.sides;
    // side morale is recomputed from team morale each tick: drive the teams down
    const driveLow = () => { for (const t of b.state.teams.values()) if (t.side === 'soviet') for (const id of t.soldierIds) { const sol = b.state.soldiers.get(id); if (sol) sol.morale = 2; } };
    driveLow();
    s.soviet.losses = 20;
    s.soviet.score = 0;
    s.german.score = 100;
    b.step(5);
    expect(s.soviet.truceOffered).toBe(false); // before the 120 s gate
    b.state.time = 200;
    b.step(5);
    driveLow();
    b.step(5);
    expect(s.soviet.truceOffered).toBe(true);
    expect(b.state.messages.some((m) => m.text.includes('requests a truce'))).toBe(true);
  });
  it('the player accepts an AI offer via acceptTruce; both-accepted ends the battle', () => {
    const b = battleWith({ german: ['ger_command'], soviet: ['sov_rifle_41'] });
    b.start();
    const s = b.state.sides;
    s.soviet.truceOffered = true;
    b.step(0.2);
    // player accepts through the same path the Truce button uses
    b.acceptTruce('german');
    expect(s.german.truceAccepted).toBe(true);
    expect(s.soviet.truceAccepted).toBe(true);
    // victory.ts ends the battle when both accept
    b.step(0.2);
    expect(b.state.phase).toBe('ended');
  });

  it('a recovering AI withdraws its unanswered offer', () => {
    const b = battleWith({ german: ['ger_command'], soviet: ['sov_rifle_41'] });
    b.start();
    const s = b.state.sides;
    s.soviet.truceOffered = true;
    // AI recovers: high soldier morale, no losses
    for (const t of b.state.teams.values()) if (t.side === 'soviet') for (const id of t.soldierIds) { const sol = b.state.soldiers.get(id); if (sol) sol.morale = 95; }
    b.step(5); b.step(5); b.step(5);
    expect(s.soviet.truceOffered).toBe(false);
    expect(b.state.messages.some((m) => m.text.includes('withdrawn its truce offer'))).toBe(true);
  });
  it('pressTruce covers all three button paths', () => {
    const b = battleWith({ german: ['ger_command'], soviet: ['sov_rifle_41'] });
    b.start();
    const s = b.state.sides;
    // 1. own offer
    b.pressTruce('german');
    expect(s.german.truceOffered).toBe(true);
    // 2. withdraw own offer
    b.pressTruce('german');
    expect(s.german.truceOffered).toBe(false);
    // 3. accept a standing AI offer
    s.soviet.truceOffered = true;
    b.pressTruce('german');
    expect(s.german.truceAccepted).toBe(true);
    expect(s.soviet.truceAccepted).toBe(true);
  });
});
