import type { BattleState, BattleMessage, Side } from '@/shared/types';

/** Both sides' logs share one list; keep this many of the latest messages. */
const MESSAGE_CAP = 400;

/** Push a message to the battle log and a corresponding 'message' event for audio/UI. `side`
 * puts it in that side's log only (its own reports, worded from its point of view); without it
 * both sides read it. */
export function addMessage(state: BattleState, text: string, kind: BattleMessage['kind'] = 'info', side?: Side): void {
  state.messages.push(side ? { time: state.time, text, kind, side } : { time: state.time, text, kind });
  state.events.push(side ? { kind: 'message', text, side } : { kind: 'message', text });
  if (state.messages.length > MESSAGE_CAP) {
    state.messages.splice(0, state.messages.length - MESSAGE_CAP);
  }
}

/** Whether `viewer` reads message `m` (its own side's or a public one). */
export function messageVisibleTo(m: BattleMessage, viewer: Side): boolean {
  return m.side === undefined || m.side === viewer;
}

/** The messages `viewer` reads, oldest first. */
export function messagesFor(state: BattleState, viewer: Side): BattleMessage[] {
  return state.messages.filter((m) => messageVisibleTo(m, viewer));
}
