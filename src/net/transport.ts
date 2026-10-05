// ============================================================================
// transport.ts — the wire a lockstep session talks over (multiplayer plan §3, §7 M1). The session
// never knows whether messages travel through memory (tests), a WebSocket relay (M2) or a WebRTC
// channel: it only sends plain JSON-safe messages and receives the peer's. A transport may delay
// and reorder messages; the session copes with both (bundles carry their turn, acks drive resends).
// ============================================================================
import type { Command, CommandBody } from '@/sim/commands';
import type { Side } from '@/shared/types';

export type NetMessage =
  /** One side's commands for one lockstep turn; an empty list is the heartbeat. `ack` = the
   * highest turn up to which the sender holds every bundle of the receiver. */
  | { kind: 'bundle'; side: Side; turn: number; commands: CommandBody[]; ack: number }
  /** The sender's state hash after `turn` turns. */
  | { kind: 'hash'; side: Side; turn: number; hash: number }
  /** The sender found a hash mismatch at `turn` (or answers one): its full command log. */
  | { kind: 'desync'; side: Side; turn: number; hash: number | null; log: Command[] };

export interface Transport {
  send(msg: NetMessage): void;
  /** Sets the receiver of every message from the peer (one handler; a later call replaces it). */
  onMessage(handler: (msg: NetMessage) => void): void;
}
