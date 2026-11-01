import type { BattleState, Side } from '@/shared/types';
import type { CommandBody } from './commands';

/** Rules are applied by the deterministic command queue, including rejected requests. */
export function applyMultiplayerPolicy(state: BattleState, side: Side, body: CommandBody): boolean {
  const p = state.multiplayerPolicy;
  if (!p?.active) return false;
  switch (body.type) {
    case 'setSpeed':
      if ([1, 2, 4].includes(body.speed)) {
        p.speedVotes[side] = body.speed;
        state.speed = Math.min(p.speedVotes.german, p.speedVotes.soviet);
      }
      return true;
    case 'pause':
      if (state.phase === 'running' && p.pausesUsed[side] < 3) {
        p.pausesUsed[side]++; p.pauseOwner = side; state.phase = 'paused';
      }
      return true;
    case 'resume':
      if (state.phase === 'paused' && p.pauseOwner === side) {
        state.phase = 'running'; p.pauseOwner = null;
      }
      return true;
    case 'order': return state.phase === 'paused';
    default: return false;
  }
}
