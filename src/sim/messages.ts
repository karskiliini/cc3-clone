import type { BattleState, BattleMessage } from '@/shared/types';

/** Push a message to the battle log and a corresponding 'message' event for audio/UI. */
export function addMessage(state: BattleState, text: string, kind: BattleMessage['kind'] = 'info'): void {
  state.messages.push({ time: state.time, text, kind });
  state.events.push({ kind: 'message', text });
  if (state.messages.length > 200) {
    state.messages.splice(0, state.messages.length - 200);
  }
}
