// ============================================================================
// lockstep.ts — deterministic lockstep between two peers (multiplayer plan §3, §7 M1), with desync
// recovery (backlog 047).
//
// Both peers run the whole sim and exchange only commands. Time is cut into turns of one sim tick
// (SIM_DT, shortened by the shared speed). A command the local player gives during turn T goes
// into the local bundle for turn T + D, which is sent at once; turn T runs only when both sides'
// bundles for T are in hand. D is the input delay (default 3 turns = 300 ms at 1x) scaled by the
// speed, so the delay budget stays the same in milliseconds at 2x and 4x. Every turn's bundle is
// sent, so an empty bundle is the heartbeat. A missing peer bundle stalls the session (measured in
// `stats`) until it arrives. Before a turn runs, its commands go to Battle.submit in canonical
// order (german bundle, then soviet, each in issue order), so both battles queue identical
// commands with identical sequence numbers; then Battle.advanceTick runs exactly one tick (or, in
// deploy and pause, only applies the commands — turns keep counting so a ready or resume can land).
//
// Every `hashInterval` turns, and when the battle ends, each peer sends hashState(battle) (and
// repeats its latest hash on every bundle, for lossy links). A mismatch never freezes the game for
// good — it starts a resync:
//   1. play stops on both peers (no command is lost: bundles stay queued);
//   2. the authority (the host, German by default) names the turn R play resumes at (its own
//      current turn) and sends its own bundles — its side's commands, turn by turn;
//   3. BOTH peers rebuild the battle from the config, turn by turn up to R, exactly as lockstep
//      ran it: our own commands from our own record of every bundle we sealed, the authority's
//      from its payload. A slice of turns runs per update() so the page stays responsive, then
//      the rebuilt battle is swapped in (`onBattleReplaced`). A state corrupted on either
//      machine, or an authority command one of them lost or got out of order, is gone;
//   4. each sends the hash of its rebuilt state; equal hashes resume play at R. Unequal hashes
//      (real nondeterminism) retry with a new epoch; after `maxResyncAttempts` failures in a row
//      the session reports `failed` — it never throws.
// Trust: nothing in a resync is taken on the peer's word except its own side's commands, which
// the battle only applies to that side's teams. R is bounded by what we sealed (the authority
// cannot have run a turn without our bundle for it); ticks follow from replaying the turns.
// Every resync leaves a DesyncReport in `reports`. The session is headless: no DOM, no timers —
// the owner calls update(nowMs) from its frame loop (or a test's virtual clock).
// ============================================================================
import { Battle } from '@/sim/battle';
import type { Command, CommandBody } from '@/sim/commands';
import { hashState } from '@/sim/stateHash';
import { SIM_DT, type BattleConfig, type Side } from '@/shared/types';
import type { NetMessage, Transport, TurnHash } from './transport';
import type { NetHealth } from './netHealth';

const SIDES: readonly Side[] = ['german', 'soviet'];
/** Turns after a resync before the authority honours another resync request from the peer (10 s
 * at 1x). A real mismatch is also seen by the authority's own hash check, which is not limited. */
const REQUEST_COOLDOWN_TURNS = 100;
/** How far past the resume turn a resync payload may pre-commit the authority's bundles. */
const MAX_PAYLOAD_LOOKAHEAD = 1000;

export interface LockstepOptions {
  battle: Battle;
  /** The side this peer commands; the transport's peer commands the other. */
  side: Side;
  transport: Transport;
  /** Input delay in turns at 1x; both peers must use the same value. */
  inputDelay?: number;
  /** Turns between state hash exchanges. */
  hashInterval?: number;
  /** An unanswered message is sent again after this long (ms), for transports that lose messages. */
  resendMs?: number;
  /** Whether this peer is the resync authority (default: the German side, i.e. the host). */
  authority?: boolean;
  /** Turns a resync rebuild runs per update() call (keeps a browser frame short). */
  rebuildTurnsPerUpdate?: number;
  /** Failed resyncs in a row before the session gives up (status 'failed'). */
  maxResyncAttempts?: number;
  /** Told when a resync swaps in a rebuilt battle (the UI must draw the new one). */
  onBattleReplaced?: (battle: Battle) => void;
  /** Where long waits, resyncs and a failed session are reported for the HUD's network symbol. */
  health?: NetHealth;
}

export interface DesyncReport {
  /** The resync epoch this mismatch started. */
  epoch: number;
  /** The turn (and this peer's battle tick) after which the hashes first differed. */
  turn: number;
  tick: number;
  localHash: number;
  remoteHash: number;
  /** This peer's command log when the mismatch was found. */
  localLog: Command[];
  /** The turn the authority resumed play at (null until its resync payload arrives). */
  resumeTurn: number | null;
  /** Where play resumed (turn and tick), once recovered. */
  resumedAt: { turn: number; tick: number } | null;
  /** Rebuild attempts this mismatch took (1 = the first rebuild matched). */
  attempts: number;
  recovered: boolean;
  /** Why recovery stopped, when it did not recover (e.g. an impossible resync payload). */
  reason?: string;
}

export interface LockstepStats {
  /** Time spent waiting for the peer's bundle (ms): the longest single stall and the sum. */
  maxStallMs: number;
  totalStallMs: number;
  stalls: number;
  bundlesResent: number;
  /** Resyncs completed, and turns replayed by them in all. */
  resyncs: number;
  rebuiltTurns: number;
}

export type LockstepStatus = 'playing' | 'resyncing' | 'failed';

type ResyncPayload = Extract<NetMessage, { kind: 'resync' }>;

interface Rebuild {
  epoch: number;
  /** Turns to replay (play resumes at this turn). */
  turn: number;
  /** The authority's commands by turn, for the turns being replayed. */
  authorityTurns: Map<number, CommandBody[]>;
  battle: Battle;
  /** The next turn to replay. */
  next: number;
}

export class LockstepSession {
  battle: Battle;
  readonly side: Side;
  readonly authority: boolean;
  readonly inputDelay: number;
  readonly hashInterval: number;
  /** Turns run so far (turn N is the next to run). */
  turn = 0;
  /** [turn, hash] after every hash exchange: the chain both peers must agree on. A resync
   * rewrites history, so entries from the turn it resumed at on are replaced. */
  readonly hashChain: [number, number][] = [];
  status: LockstepStatus = 'playing';
  /** Every mismatch so far, oldest first (recovered or not). */
  readonly reports: DesyncReport[] = [];
  readonly stats: LockstepStats = { maxStallMs: 0, totalStallMs: 0, stalls: 0, bundlesResent: 0, resyncs: 0, rebuiltTurns: 0 };
  /** Resync epoch: 0 until the first resync; hashes of an older epoch are ignored. */
  epoch = 0;

  private transport: Transport;
  private resendMs: number;
  private rebuildTurnsPerUpdate: number;
  private maxResyncAttempts: number;
  private onBattleReplaced?: (battle: Battle) => void;
  private health?: NetHealth;
  private peer: Side;
  /** The config both battles were built from, for rebuilding. */
  private config: BattleConfig;
  /** Commands given since the last bundle was sealed. */
  private outgoing: CommandBody[] = [];
  /** Live bundles per side by turn: sealed and not yet run (ours also until the peer acks them). */
  private bundles: Record<Side, Map<number, CommandBody[]>> = { german: new Map(), soviet: new Map() };
  /** History for rebuilds (non-empty bundles only): every bundle we sealed, and every peer
   * bundle of a turn we ran. Ours is the only source of our side's commands in a rebuild. */
  private ownHistory = new Map<number, CommandBody[]>();
  private peerHistory = new Map<number, CommandBody[]>();
  /** The highest turn our bundles were sealed for. */
  private sealedTo: number;
  /** Our sealed bundles not yet acked: turn -> last send time. */
  private unacked = new Map<number, number>();
  /** Every peer bundle up to this turn has arrived. */
  private receivedTo: number;
  private remoteHashes = new Map<number, number>();
  /** Our hashes awaiting the peer's, with the battle tick they were taken at. */
  private localHashes = new Map<number, { hash: number; tick: number }>();
  /** Our latest hash, repeated on every bundle. */
  private latestHash: TurnHash | null = null;
  /** When the next turn is due (ms), and when the current stall began (null: not stalled). */
  private nextTurnAt: number | null = null;
  private stallSince: number | null = null;
  // ---- resync
  private rebuild: Rebuild | null = null;
  /** The authority's payload for the current epoch (kept to answer a peer that missed it). */
  private payload: ResyncPayload | null = null;
  private rebuiltHash: number | null = null;
  private peerRebuiltHash: number | null = null;
  private lastResyncSend = -Infinity;
  private failedAttempts = 0;
  /** The turn play last resumed at after a resync (a peer's request is not honoured again
   * within REQUEST_COOLDOWN_TURNS of it, so it cannot keep the host rebuilding). */
  private resumedTurn = -Infinity;

  constructor(opts: LockstepOptions) {
    this.battle = opts.battle;
    this.side = opts.side;
    this.peer = opts.side === 'german' ? 'soviet' : 'german';
    this.authority = opts.authority ?? opts.side === 'german';
    this.transport = opts.transport;
    this.inputDelay = Math.max(1, opts.inputDelay ?? 3);
    this.hashInterval = Math.max(1, opts.hashInterval ?? 10);
    this.resendMs = opts.resendMs ?? 1000;
    this.rebuildTurnsPerUpdate = Math.max(1, opts.rebuildTurnsPerUpdate ?? 600);
    this.maxResyncAttempts = Math.max(1, opts.maxResyncAttempts ?? 3);
    this.onBattleReplaced = opts.onBattleReplaced;
    this.health = opts.health;
    this.config = structuredClone(opts.battle.state.config);
    // the first D turns have no bundles on the wire: both peers know they are empty
    for (let t = 0; t < this.inputDelay; t++) for (const s of SIDES) this.bundles[s].set(t, []);
    this.sealedTo = this.inputDelay - 1;
    this.receivedTo = this.inputDelay - 1;
    this.transport.onMessage((msg) => {
      // a malformed or unexpected message must never take the game down
      try { this.receive(msg); } catch { /* ignored: resends and the hash check cover it */ }
    });
  }

  /** Queues a local command: it applies on both peers at the start of turn `turn + delay`
   * (or the next unsealed turn). Normalised through JSON, exactly as the peer receives it. */
  issue(body: CommandBody): void {
    this.outgoing.push(JSON.parse(JSON.stringify(body)) as CommandBody);
  }

  /** Whether the session stopped: the battle ended (and is in sync), or recovery gave up. */
  get done(): boolean {
    return this.status === 'failed' || (this.status === 'playing' && this.battle.state.phase === 'ended');
  }

  /** The latest unrecovered mismatch, or null while in sync. */
  get desync(): DesyncReport | null {
    const last = this.reports[this.reports.length - 1];
    return last && !last.recovered ? last : null;
  }

  /** Whether the next turn is due but waits for the peer's bundle. */
  get stalled(): boolean {
    return this.stallSince !== null;
  }

  /** How far a resync rebuild has got (0..1), or null when none is running. */
  get resyncProgress(): number | null {
    if (this.status !== 'resyncing') return null;
    const r = this.rebuild;
    if (!r) return 0;
    return r.turn > 0 ? Math.min(1, r.next / r.turn) : 1;
  }

  /** Milliseconds one turn takes at the shared speed. */
  turnMs(): number {
    return (SIM_DT * 1000) / this.speed();
  }

  /** The input delay in turns at the current speed (the same number of milliseconds at any speed).
   * Both peers apply speed changes on the same turn, so they agree on it. */
  delayTurns(): number {
    return Math.ceil(this.inputDelay * this.speed());
  }

  private speed(): number {
    return Math.max(1e-3, this.battle.state.speed ?? 1);
  }

  /** Runs every turn due by `nowMs` whose bundles are in hand, or a slice of a resync rebuild;
   * returns the number of turns run. After a stall or a resync the schedule restarts from the
   * moment play resumes (no catch-up burst). Never throws. */
  update(nowMs: number): number {
    let ran = 0;
    try {
      ran = this.updateUnsafe(nowMs);
    } catch {
      // a bug in the sim or the session: give up cleanly rather than crash the page
      if (this.status !== 'failed') this.fail('internal error');
    }
    this.health?.update(nowMs, this.stallSince !== null, this.status === 'resyncing', this.status === 'failed', this.reports[this.reports.length - 1]?.reason);
    return ran;
  }

  private updateUnsafe(nowMs: number): number {
    this.resend(nowMs);
    if (this.status === 'failed') {
      // keep telling the peer, so it stops waiting for a resync that will not come
      if (nowMs - this.lastResyncSend >= this.resendMs) {
        this.lastResyncSend = nowMs;
        this.transport.send({ kind: 'resyncFailed', side: this.side, epoch: this.epoch });
      }
      return 0;
    }
    if (this.status === 'resyncing') {
      this.stepResync(nowMs);
      return 0;
    }
    if (this.nextTurnAt === null) this.nextTurnAt = nowMs;
    let ran = 0;
    while (this.status === 'playing' && this.battle.state.phase !== 'ended' && nowMs >= this.nextTurnAt) {
      this.seal(this.turn + this.delayTurns(), nowMs);
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
      if (this.outgoing.length > 0) this.ownHistory.set(t, structuredClone(this.outgoing));
      this.outgoing = [];
      this.unacked.set(t, nowMs);
      this.sendBundle(t);
    }
  }

  private sendBundle(turn: number): void {
    const commands = this.bundles[this.side].get(turn) ?? this.ownHistory.get(turn) ?? [];
    this.transport.send({ kind: 'bundle', side: this.side, turn, commands, ack: this.receivedTo, hash: this.latestHash });
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
    const peerCmds = this.bundles[this.peer].get(turn) ?? [];
    if (peerCmds.length > 0) this.peerHistory.set(turn, peerCmds);
    for (const side of SIDES) {
      const tick = battle.state.tick ?? 0;
      for (const body of this.bundles[side].get(turn) ?? []) battle.submit(side, body, tick);
      // the peer's bundle is done with; ours stays until acked (a resend may still need it)
      if (side === this.peer) this.bundles[side].delete(turn);
      else if (!this.unacked.has(turn)) this.bundles[side].delete(turn);
    }
    battle.advanceTick();
    this.turn = turn + 1;
    // hash every interval, and once more when the battle ends so the final state is compared too
    if (this.turn % this.hashInterval === 0 || battle.state.phase === 'ended') this.shareHash();
  }

  private shareHash(): void {
    const hash = hashState(this.battle);
    this.hashChain.push([this.turn, hash]);
    this.localHashes.set(this.turn, { hash, tick: this.battle.state.tick ?? 0 });
    this.latestHash = { turn: this.turn, hash, epoch: this.epoch };
    this.transport.send({ kind: 'hash', side: this.side, ...this.latestHash });
    this.compare(this.turn);
  }

  private receive(msg: NetMessage): void {
    if (!msg || msg.side !== this.peer) return;
    switch (msg.kind) {
      case 'bundle': {
        if (!Number.isSafeInteger(msg.turn) || msg.turn < 0 || !Array.isArray(msg.commands)) return;
        // a duplicate or a bundle for a turn already run is ignored; the ack still counts.
        // While resyncing, keep everything: the turn play resumes at is not known yet.
        const floor = this.status === 'resyncing' ? 0 : this.turn;
        if (msg.turn >= floor && !this.bundles[this.peer].has(msg.turn)) {
          this.bundles[this.peer].set(msg.turn, msg.commands);
        }
        while (this.bundles[this.peer].has(this.receivedTo + 1)) this.receivedTo++;
        if (Number.isSafeInteger(msg.ack)) {
          for (const t of [...this.unacked.keys()]) {
            if (t > msg.ack) continue;
            this.unacked.delete(t);
            if (t < this.turn) this.bundles[this.side].delete(t);
          }
        }
        if (msg.hash) this.takeRemoteHash(msg.hash);
        return;
      }
      case 'hash':
        this.takeRemoteHash(msg);
        return;
      case 'resyncRequest':
        // the peer saw a mismatch first: the authority starts the resync it asks for — only while
        // playing, and not again right after one; during a resync the peer gets the current
        // payload again instead of restarting the rebuild
        if (!this.authority) return;
        if (this.status === 'playing' && Number.isSafeInteger(msg.epoch) && msg.epoch > this.epoch) {
          if (this.turn - this.resumedTurn < REQUEST_COOLDOWN_TURNS) return;
          this.startResync(this.epoch + 1, this.turn, NaN, NaN);
        } else if (this.status === 'resyncing' && this.payload) this.transport.send(this.payload);
        return;
      case 'resync':
        if (this.authority || !Number.isSafeInteger(msg.epoch)) return;
        if (msg.epoch > this.epoch || (msg.epoch === this.epoch && this.status === 'resyncing' && !this.rebuild)) this.adoptPayload(msg);
        // a repeat of a resync we already finished: the authority missed our answer
        else if (msg.epoch === this.epoch && this.rebuiltHash !== null) {
          this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
        }
        return;
      case 'resyncFailed':
        // the peer stopped: no more bundles will come, whatever state we are in
        if (this.status !== 'failed') this.fail('the other player gave up resynchronising');
        return;
      case 'resynced':
        if (msg.epoch !== this.epoch || !Number.isSafeInteger(msg.hash)) return;
        this.peerRebuiltHash = msg.hash;
        if (this.status === 'playing' && this.rebuiltHash !== null) {
          // we resumed already; the peer is still waiting, so it missed our answer
          this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
        } else {
          this.finishResync();
        }
        return;
    }
  }

  private takeRemoteHash(h: TurnHash): void {
    if (h.epoch !== this.epoch || this.status !== 'playing') return;
    if (!Number.isSafeInteger(h.turn) || this.remoteHashes.has(h.turn)) return;
    this.remoteHashes.set(h.turn, h.hash);
    this.compare(h.turn);
  }

  /** Compares both hashes of `turn` once both are known; a mismatch starts a resync. */
  private compare(turn: number): void {
    const local = this.localHashes.get(turn), remote = this.remoteHashes.get(turn);
    if (local === undefined || remote === undefined) return;
    // older turns can no longer be compared once a newer one is
    for (const t of [...this.localHashes.keys()]) if (t <= turn) this.localHashes.delete(t);
    for (const t of [...this.remoteHashes.keys()]) if (t <= turn) this.remoteHashes.delete(t);
    if (local.hash === remote || this.status !== 'playing') return;
    this.startResync(this.epoch + 1, turn, local.hash, remote, local.tick);
  }

  private report(turn: number, tick: number, localHash: number, remoteHash: number): DesyncReport {
    return {
      epoch: this.epoch, turn, tick, localHash, remoteHash,
      localLog: structuredClone([...this.battle.commandLog()]),
      resumeTurn: null, resumedAt: null, attempts: 0, recovered: false,
    };
  }

  /** Ends the session cleanly, telling the peer. */
  private fail(why: string): void {
    const report = this.reports[this.reports.length - 1];
    if (report && !report.recovered) report.reason ??= why;
    else this.reports.push({ ...this.report(this.turn, this.battle.state.tick ?? 0, NaN, NaN), reason: why });
    this.status = 'failed';
    this.rebuild = null;
    this.lastResyncSend = -Infinity;
  }

  /** Stops play for resync `epoch`. The authority names its current turn as the resume turn and
   * sends its own bundles; a follower asks for that (and keeps asking until it arrives). */
  private startResync(epoch: number, turn: number, localHash: number, remoteHash: number, tick = this.battle.state.tick ?? 0): void {
    const continuing = this.status === 'resyncing';
    this.status = 'resyncing';
    this.epoch = epoch;
    this.stallSince = null;
    this.rebuiltHash = null;
    this.peerRebuiltHash = null;
    this.rebuild = null;
    this.payload = null;
    this.lastResyncSend = -Infinity;
    if (!continuing || !this.desync) this.reports.push(this.report(turn, tick, localHash, remoteHash));
    if (!this.authority) return; // stepResync sends the request
    const bundles: [number, CommandBody[]][] = [];
    for (const [t, cmds] of this.ownHistory) bundles.push([t, cmds]);
    this.payload = { kind: 'resync', side: this.side, epoch, turn: this.turn, sealedTo: this.sealedTo, bundles };
    this.beginRebuild(this.turn, this.peerHistory);
  }

  /** A follower checks the authority's payload and starts its own rebuild from it. */
  private adoptPayload(p: ResyncPayload): void {
    if (this.status !== 'resyncing') {
      // the authority saw the mismatch first
      this.status = 'resyncing';
      this.stallSince = null;
      this.reports.push(this.report(this.turn, this.battle.state.tick ?? 0, NaN, NaN));
    }
    this.epoch = p.epoch;
    this.rebuiltHash = null;
    this.peerRebuiltHash = null;
    // The resume turn is the one thing the authority decides. It cannot have run a turn without
    // our bundle for it, so it cannot be past what we sealed; anything else is refused.
    const ok = Number.isSafeInteger(p.turn) && p.turn >= 0 && p.turn <= this.sealedTo + 1
      && Number.isSafeInteger(p.sealedTo) && p.sealedTo >= p.turn - 1 && p.sealedTo <= p.turn + MAX_PAYLOAD_LOOKAHEAD
      && Array.isArray(p.bundles)
      && p.bundles.every((b) => Array.isArray(b) && Number.isSafeInteger(b[0]) && b[0] >= 0 && b[0] <= p.sealedTo && Array.isArray(b[1]));
    if (!ok) {
      this.fail('the authority sent an impossible resync');
      return;
    }
    // its own commands, by turn; a turn it does not list is an empty bundle
    const authorityTurns = new Map<number, CommandBody[]>();
    for (const [t, cmds] of p.bundles) authorityTurns.set(t, cmds);
    // its live bundles from the resume turn on are what it says they are (they are its commands)
    for (let t = p.turn; t <= p.sealedTo; t++) this.bundles[this.peer].set(t, authorityTurns.get(t) ?? []);
    this.beginRebuild(p.turn, authorityTurns);
  }

  private beginRebuild(turn: number, peerTurns: Map<number, CommandBody[]>): void {
    const report = this.reports[this.reports.length - 1];
    report.resumeTurn = turn;
    report.attempts++;
    this.rebuild = { epoch: this.epoch, turn, authorityTurns: peerTurns, battle: new Battle(structuredClone(this.config)), next: 0 };
  }

  /** One update's worth of resync work: (re)send what the peer may be missing, replay a slice. */
  private stepResync(nowMs: number): void {
    const r = this.rebuild;
    if (nowMs - this.lastResyncSend >= this.resendMs) {
      this.lastResyncSend = nowMs;
      if (!this.authority && !r) this.transport.send({ kind: 'resyncRequest', side: this.side, epoch: this.epoch, turn: this.turn });
      if (this.authority && this.payload && this.peerRebuiltHash === null) this.transport.send(this.payload);
      if (this.rebuiltHash !== null) this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
    }
    if (!r || r.next > r.turn) return;
    // the turns exactly as lockstep ran them: both bundles submitted at the tick, then one tick
    const battle = r.battle;
    for (let n = 0; n < this.rebuildTurnsPerUpdate && r.next < r.turn && battle.state.phase !== 'ended'; n++, r.next++) {
      const t = r.next;
      for (const side of SIDES) {
        const cmds = side === this.side ? this.ownHistory.get(t) : r.authorityTurns.get(t);
        const tick = battle.state.tick ?? 0;
        for (const body of cmds ?? []) battle.submit(side, structuredClone(body), tick);
      }
      battle.advanceTick();
      battle.drainEvents();
      this.stats.rebuiltTurns++;
    }
    if (r.next < r.turn && battle.state.phase !== 'ended') return;
    r.next = r.turn + 1;
    this.adoptRebuilt(r, nowMs);
  }

  /** Swaps the rebuilt battle in at the resume turn and reports its hash. */
  private adoptRebuilt(r: Rebuild, nowMs: number): void {
    this.battle = r.battle;
    this.turn = r.turn;
    // the replayed peer history is now the one both machines share
    if (!this.authority) {
      for (const t of [...this.peerHistory.keys()]) if (t < r.turn) this.peerHistory.delete(t);
      for (const [t, cmds] of r.authorityTurns) if (t < r.turn && cmds.length > 0) this.peerHistory.set(t, cmds);
    }
    for (let i = this.hashChain.length - 1; i >= 0 && this.hashChain[i][0] >= r.turn; i--) this.hashChain.pop();
    for (const s of SIDES) for (const t of [...this.bundles[s].keys()]) if (t < r.turn && !(s === this.side && this.unacked.has(t))) this.bundles[s].delete(t);
    // our own live bundles from the resume turn on come from our record
    for (let t = r.turn; t <= this.sealedTo; t++) if (!this.bundles[this.side].has(t)) this.bundles[this.side].set(t, this.ownHistory.get(t) ?? []);
    this.sealedTo = Math.max(this.sealedTo, r.turn - 1);
    this.receivedTo = r.turn - 1;
    while (this.bundles[this.peer].has(this.receivedTo + 1)) this.receivedTo++;
    this.localHashes.clear();
    this.remoteHashes.clear();
    this.rebuiltHash = hashState(r.battle);
    this.latestHash = null;
    this.onBattleReplaced?.(r.battle);
    this.lastResyncSend = nowMs;
    this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
    this.finishResync();
  }

  /** Both rebuilt hashes known: resume when they agree, otherwise try again (or give up). */
  private finishResync(): void {
    if (this.status !== 'resyncing' || this.rebuiltHash === null || this.peerRebuiltHash === null) return;
    const report = this.reports[this.reports.length - 1];
    if (this.rebuiltHash === this.peerRebuiltHash) {
      this.status = 'playing';
      this.failedAttempts = 0;
      this.nextTurnAt = null;
      this.stallSince = null;
      this.rebuild = null;
      this.stats.resyncs++;
      report.recovered = true;
      report.resumedAt = { turn: this.turn, tick: this.battle.state.tick ?? 0 };
      this.resumedTurn = this.turn;
      this.hashChain.push([this.turn, this.rebuiltHash]);
      this.latestHash = { turn: this.turn, hash: this.rebuiltHash, epoch: this.epoch };
      return;
    }
    // the same history gave different states: rebuild again under a new epoch, or give up
    this.failedAttempts++;
    if (this.failedAttempts >= this.maxResyncAttempts) {
      this.fail('the rebuilt states kept disagreeing');
      return;
    }
    if (this.authority) this.startResync(this.epoch + 1, this.turn, this.rebuiltHash, this.peerRebuiltHash);
    else {
      this.epoch++;
      this.rebuild = null;
      this.rebuiltHash = null;
      this.peerRebuiltHash = null;
      this.lastResyncSend = -Infinity;
    }
  }
}
