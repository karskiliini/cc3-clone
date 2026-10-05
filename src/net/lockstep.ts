// ============================================================================
// lockstep.ts — deterministic lockstep between two peers (multiplayer plan §3, §7 M1).
//
// Both peers run the whole sim and exchange only commands. Time is cut into turns of one sim tick
// (SIM_DT, shortened by the shared speed). A command the local player gives during turn T goes
// into the local bundle for turn T + D (input delay, default 3 turns = 300 ms at 1x), which is sent
// at once; turn T runs only when both sides' bundles for T are in hand. Every turn's bundle is sent,
// so an empty bundle is the heartbeat. A missing peer bundle stalls the session (measured in
// `stats`) until it arrives. Before a turn runs, its commands go to Battle.submit in canonical
// order (german bundle, then soviet, each in issue order), so both battles queue identical
// commands with identical sequence numbers; then Battle.advanceTick runs exactly one tick (or, in
// deploy and pause, only applies the commands — turns keep counting so a ready or resume can land).
//
// Every `hashInterval` turns each peer sends hashState(battle). A mismatch freezes the session and
// captures a DesyncReport (turn, tick, both hashes, both command logs) for offline reproduction
// with the P4 replay runner. The session is headless: no DOM, no timers — the owner calls
// update(nowMs) from its frame loop (or a test's virtual clock).
// ============================================================================
import type { Battle } from '@/sim/battle';
import type { Command, CommandBody } from '@/sim/commands';
import { hashState } from '@/sim/stateHash';
import { SIM_DT, type Side } from '@/shared/types';
import type { NetMessage, Transport } from './transport';

const SIDES: readonly Side[] = ['german', 'soviet'];

export interface LockstepOptions {
  battle: Battle;
  /** The side this peer commands; the transport's peer commands the other. */
  side: Side;
  transport: Transport;
  /** Input delay in turns; both peers must use the same value. */
  inputDelay?: number;
  /** Turns between state hash exchanges. */
  hashInterval?: number;
  /** An unacknowledged bundle is sent again after this long (ms), for transports that lose messages. */
  resendMs?: number;
}

export interface DesyncReport {
  /** The turn (and the battle's tick) after which the hashes first differed. */
  turn: number;
  tick: number;
  localHash: number;
  remoteHash: number;
  localLog: Command[];
  /** The peer's command log, once its answer arrives. */
  remoteLog: Command[] | null;
}

export interface LockstepStats {
  /** Time spent waiting for the peer's bundle (ms): the longest single stall and the sum. */
  maxStallMs: number;
  totalStallMs: number;
  stalls: number;
  bundlesResent: number;
}

export class LockstepSession {
  readonly battle: Battle;
  readonly side: Side;
  readonly inputDelay: number;
  readonly hashInterval: number;
  /** Turns run so far (turn N is the next to run). */
  turn = 0;
  /** [turn, hash] after every hashInterval-th turn: the chain both peers must agree on. */
  readonly hashChain: [number, number][] = [];
  desync: DesyncReport | null = null;
  readonly stats: LockstepStats = { maxStallMs: 0, totalStallMs: 0, stalls: 0, bundlesResent: 0 };

  private transport: Transport;
  private resendMs: number;
  private peer: Side;
  /** Commands given since the last bundle was sealed. */
  private outgoing: CommandBody[] = [];
  /** Sealed bundles per side by turn (ours are kept until the peer acks them). */
  private bundles: Record<Side, Map<number, CommandBody[]>> = { german: new Map(), soviet: new Map() };
  /** The highest turn our bundles were sealed for. */
  private sealedTo: number;
  /** Our sealed bundles not yet acked: turn -> last send time. */
  private unacked = new Map<number, number>();
  /** Every peer bundle up to this turn has arrived. */
  private receivedTo: number;
  private remoteHashes = new Map<number, number>();
  /** Our hashes awaiting the peer's, with the battle tick they were taken at. */
  private localHashes = new Map<number, { hash: number; tick: number }>();
  private remoteDesync: { turn: number; hash: number | null; log: Command[] } | null = null;
  private sentDesync = false;
  /** When the next turn is due (ms), and when the current stall began (null: not stalled). */
  private nextTurnAt: number | null = null;
  private stallSince: number | null = null;

  constructor(opts: LockstepOptions) {
    this.battle = opts.battle;
    this.side = opts.side;
    this.peer = opts.side === 'german' ? 'soviet' : 'german';
    this.transport = opts.transport;
    this.inputDelay = Math.max(1, opts.inputDelay ?? 3);
    this.hashInterval = Math.max(1, opts.hashInterval ?? 10);
    this.resendMs = opts.resendMs ?? 1000;
    // the first D turns have no bundles on the wire: both peers know they are empty
    for (let t = 0; t < this.inputDelay; t++) for (const s of SIDES) this.bundles[s].set(t, []);
    this.sealedTo = this.inputDelay - 1;
    this.receivedTo = this.inputDelay - 1;
    this.transport.onMessage((msg) => this.receive(msg));
  }

  /** Queues a local command: it applies on both peers at the start of turn `turn + inputDelay`
   * (or the next unsealed turn). */
  issue(body: CommandBody): void {
    this.outgoing.push(structuredClone(body));
  }

  /** Whether the session stopped: the battle ended or a desync froze it. */
  get done(): boolean {
    return this.desync !== null || this.battle.state.phase === 'ended';
  }

  /** Whether the next turn is due but waits for the peer's bundle. */
  get stalled(): boolean {
    return this.stallSince !== null;
  }

  /** Milliseconds one turn takes at the shared speed. */
  turnMs(): number {
    return (SIM_DT * 1000) / Math.max(1e-3, this.battle.state.speed ?? 1);
  }

  /** Runs every turn due by `nowMs` whose bundles are in hand; returns the number of turns run.
   * After a stall the schedule restarts from the moment play resumes (no catch-up burst). */
  update(nowMs: number): number {
    this.resend(nowMs);
    if (this.nextTurnAt === null) this.nextTurnAt = nowMs;
    let ran = 0;
    while (!this.done && nowMs >= this.nextTurnAt) {
      this.seal(this.turn + this.inputDelay, nowMs);
      if (!this.bundles[this.peer].has(this.turn)) {
        if (this.stallSince === null) {
          this.stallSince = this.nextTurnAt;
          this.stats.stalls++;
        }
        break;
      }
      if (this.stallSince !== null) {
        const stall = nowMs - this.stallSince;
        this.stats.maxStallMs = Math.max(this.stats.maxStallMs, stall);
        this.stats.totalStallMs += stall;
        this.stallSince = null;
        this.nextTurnAt = nowMs;
      }
      this.runTurn();
      ran++;
      this.nextTurnAt += this.turnMs();
    }
    return ran;
  }

  /** Seals (and sends) our bundles up to `turn`; commands given so far ride the first one. */
  private seal(turn: number, nowMs: number): void {
    while (this.sealedTo < turn) {
      const t = ++this.sealedTo;
      this.bundles[this.side].set(t, this.outgoing);
      this.outgoing = [];
      this.unacked.set(t, nowMs);
      this.sendBundle(t);
    }
  }

  private sendBundle(turn: number): void {
    const commands = this.bundles[this.side].get(turn) ?? [];
    this.transport.send({ kind: 'bundle', side: this.side, turn, commands, ack: this.receivedTo });
  }

  private resend(nowMs: number): void {
    for (const [turn, at] of this.unacked) {
      if (nowMs - at < this.resendMs) continue;
      this.unacked.set(turn, nowMs);
      this.stats.bundlesResent++;
      this.sendBundle(turn);
    }
  }

  private runTurn(): void {
    const battle = this.battle;
    const turn = this.turn;
    for (const side of SIDES) {
      const tick = battle.state.tick ?? 0;
      for (const body of this.bundles[side].get(turn) ?? []) battle.submit(side, body, tick);
      // the peer's bundle is done with; ours stays until acked (a resend may still need it)
      if (side === this.peer) this.bundles[side].delete(turn);
      else if (!this.unacked.has(turn)) this.bundles[side].delete(turn);
    }
    battle.advanceTick();
    this.turn = turn + 1;
    if (this.turn % this.hashInterval === 0) {
      const hash = hashState(battle);
      this.hashChain.push([this.turn, hash]);
      this.localHashes.set(this.turn, { hash, tick: battle.state.tick ?? 0 });
      this.transport.send({ kind: 'hash', side: this.side, turn: this.turn, hash });
      this.compare(this.turn);
    }
  }

  private receive(msg: NetMessage): void {
    if (msg.side !== this.peer) return;
    switch (msg.kind) {
      case 'bundle': {
        // a duplicate or a bundle for a turn already run is ignored; the ack still counts
        if (msg.turn >= this.turn && !this.bundles[this.peer].has(msg.turn)) {
          this.bundles[this.peer].set(msg.turn, msg.commands);
        }
        while (this.bundles[this.peer].has(this.receivedTo + 1)) this.receivedTo++;
        for (const t of [...this.unacked.keys()]) {
          if (t > msg.ack) continue;
          this.unacked.delete(t);
          if (t < this.turn) this.bundles[this.side].delete(t);
        }
        return;
      }
      case 'hash':
        this.remoteHashes.set(msg.turn, msg.hash);
        this.compare(msg.turn);
        return;
      case 'desync':
        this.remoteDesync = { turn: msg.turn, hash: msg.hash, log: msg.log };
        if (this.desync) this.desync.remoteLog = msg.log;
        else if (msg.hash !== null) this.remoteHashes.set(msg.turn, msg.hash);
        return;
    }
  }

  /** Compares both hashes of `turn` once both are known; a mismatch freezes the session. */
  private compare(turn: number): void {
    const local = this.localHashes.get(turn), remote = this.remoteHashes.get(turn);
    if (local === undefined || remote === undefined) return;
    this.localHashes.delete(turn);
    this.remoteHashes.delete(turn);
    if (local.hash === remote || this.desync) return;
    this.desync = {
      turn, tick: local.tick, localHash: local.hash, remoteHash: remote,
      localLog: [...this.battle.commandLog()].map((c) => structuredClone(c)),
      remoteLog: this.remoteDesync?.log ?? null,
    };
    if (!this.sentDesync) {
      this.sentDesync = true;
      this.transport.send({ kind: 'desync', side: this.side, turn, hash: local.hash, log: this.desync.localLog });
    }
  }
}
