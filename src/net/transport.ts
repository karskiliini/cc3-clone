// ============================================================================
// transport.ts — the wire a lockstep session talks over (multiplayer plan §3, §7 M1). The session
// never knows whether messages travel through memory (tests), a WebSocket relay (M2) or a WebRTC
// channel: it only sends plain JSON-safe messages and receives the peer's. A transport may delay,
// reorder and lose messages; the session copes (bundles carry their turn, acks drive resends,
// bundles repeat the latest hash, and resync messages are repeated until answered).
// ============================================================================
import type { Command, CommandBody } from '@/sim/commands';
import type { Side } from '@/shared/types';

/** A state hash taken after `turn` turns, in resync epoch `epoch`. */
export interface TurnHash { turn: number; hash: number; epoch: number }

export type NetMessage =
  /** One side's commands for one lockstep turn; an empty list is the heartbeat. `ack` = the
   * highest turn up to which the sender holds every bundle of the receiver. `hash` repeats the
   * sender's latest state hash, so a lost hash message is made good by a later bundle. */
  | { kind: 'bundle'; side: Side; turn: number; commands: CommandBody[]; ack: number; hash?: TurnHash | null }
  /** The sender's state hash after `turn` turns. */
  | { kind: 'hash'; side: Side } & TurnHash
  /** The sender found a hash mismatch and asks the authority to resynchronise. */
  | { kind: 'resyncRequest'; side: Side; epoch: number; turn: number }
  /** The authority's ground truth for resync `epoch`: both peers rebuild the battle from `log` up
   * to `tick` and continue at `turn`, with every sealed bundle for turns >= `turn`. */
  | {
    kind: 'resync'; side: Side; epoch: number; turn: number; tick: number; log: Command[];
    bundles: Record<Side, [number, CommandBody[]][]>;
  }
  /** The sender finished rebuilding for `epoch`; `hash` is its state hash after the rebuild. */
  | { kind: 'resynced'; side: Side; epoch: number; hash: number }
  /** The sender gave up resynchronising (rebuilds kept disagreeing); the receiver stops too. */
  | { kind: 'resyncFailed'; side: Side; epoch: number };

export interface Transport {
  send(msg: NetMessage): void;
  /** Sets the receiver of every message from the peer (one handler; a later call replaces it). */
  onMessage(handler: (msg: NetMessage) => void): void;
}
