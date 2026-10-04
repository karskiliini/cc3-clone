import type { BattleConfig, Controller, Order, Side, Vec2 } from '@/shared/types';

/**
 * Everything a player can do to a battle, as plain serializable data (multiplayer plan §7 P1).
 * The UI never mutates the sim directly: it submits commands, and `Battle` applies them at the
 * start of a sim tick in canonical order (tick, side, sequence), so the RNG stream does not
 * depend on the frame a click landed in and a command log can replay a battle exactly.
 */
export type CommandBody =
  | { type: 'order'; teamId: number; order: Order }
  | { type: 'deployTeam'; teamId: number; pos: Vec2 }
  /** The deploy screen's Auto button: the AI deploys the side's teams. */
  | { type: 'autoDeploy' }
  /** The Truce button: accepts a standing enemy offer, otherwise offers or withdraws our own. */
  | { type: 'truce' }
  | { type: 'flee' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setSpeed'; speed: number }
  /** The side is ready to begin (deploy -> running once every human side is ready). */
  | { type: 'ready' };

export type Command = CommandBody & {
  side: Side;
  /** Tick the command applies at (stamped by submit: the next tick unless given a later one). */
  tick: number;
  /** Per-battle submission sequence: the last tie-break, after tick and side. */
  seq: number;
};

/** Canonical application order: tick, then side (german before soviet), then submission. */
export function compareCommands(a: Command, b: Command): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.side !== b.side) return a.side === 'german' ? -1 : 1;
  return a.seq - b.seq;
}

/** Who controls each side: the explicit map, else AI vs AI for the harness, else the viewer's
 * side is human and the other AI (single player). */
export function resolveControllers(config: BattleConfig): Record<Side, Controller> {
  if (config.controllers) return { ...config.controllers };
  if (config.aiBothSides) return { german: 'ai', soviet: 'ai' };
  return config.playerSide === 'german'
    ? { german: 'human', soviet: 'ai' }
    : { german: 'ai', soviet: 'human' };
}
