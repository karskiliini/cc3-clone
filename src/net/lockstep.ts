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
//   2. the authority (the host, German by default) sends its command log, its battle tick and
//      every sealed bundle from its current turn on;
//   3. BOTH peers rebuild the battle from the config and that log, fast-forwarding a slice of
//      ticks per update() so the page stays responsive, and swap the rebuilt battle in
//      (`onBattleReplaced`). A state corrupted on either machine, or a command one of them
//      lost or misordered, is gone: both now hold the authority's history;
//   4. each sends the hash of its rebuilt state; equal hashes resume play at the authority's turn.
//      Unequal hashes (real nondeterminism) retry with a new epoch; after `maxResyncAttempts`
//      failures in a row the session reports `failed` — it never throws.
// Every resync leaves a DesyncReport (turns, ticks, hashes, both command logs) in `reports` for
// offline reproduction with tools/replay.ts. The session is headless: no DOM, no timers — the
// owner calls update(nowMs) from its frame loop (or a test's virtual clock).
// ============================================================================
import { Battle } from '@/sim/battle';
import type { Command, CommandBody } from '@/sim/commands';
import { hashState } from '@/sim/stateHash';
import { SIM_DT, type BattleConfig, type Side } from '@/shared/types';
import type { NetMessage, Transport, TurnHash } from './transport';

const SIDES: readonly Side[] = ['german', 'soviet'];
/** Turns after a resync before the authority honours another resync request from the peer (10 s
 * at 1x). A real mismatch is also seen by the authority's own hash check, which is not limited. */
const REQUEST_COOLDOWN_TURNS = 100;

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
  /** Ticks a resync rebuild runs per update() call (keeps a browser frame short). */
  rebuildTicksPerUpdate?: number;
  /** Failed resyncs in a row before the session gives up (status 'failed'). */
  maxResyncAttempts?: number;
  /** Told when a resync swaps in a rebuilt battle (the UI must draw the new one). */
  onBattleReplaced?: (battle: Battle) => void;
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
  /** The authority's log the battle was rebuilt from (null until it arrives). */
  authorityLog: Command[] | null;
  /** Where play resumed (the authority's turn and tick), once recovered. */
  resumedAt: { turn: number; tick: number } | null;
  /** Rebuild attempts this mismatch took (1 = the first rebuild matched). */
  attempts: number;
  recovered: boolean;
  /** Why recovery stopped, when it did not recover (e.g. a payload that forged our commands). */
  reason?: string;
}

export interface LockstepStats {
  /** Time spent waiting for the peer's bundle (ms): the longest single stall and the sum. */
  maxStallMs: number;
  totalStallMs: number;
  stalls: number;
  bundlesResent: number;
  /** Resyncs completed, and ticks fast-forwarded by them in all. */
  resyncs: number;
  rebuiltTicks: number;
}

export type LockstepStatus = 'playing' | 'resyncing' | 'failed';

interface Rebuild {
  epoch: number;
  turn: number;
  tick: number;
  log: Command[];
  battle: Battle;
  done: boolean;
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
   * rewrites history, so entries from before it are dropped from the turn it resumed at. */
  readonly hashChain: [number, number][] = [];
  status: LockstepStatus = 'playing';
  /** Every mismatch so far, oldest first (recovered or not). */
  readonly reports: DesyncReport[] = [];
  readonly stats: LockstepStats = { maxStallMs: 0, totalStallMs: 0, stalls: 0, bundlesResent: 0, resyncs: 0, rebuiltTicks: 0 };
  /** Resync epoch: 0 until the first resync; hashes of an older epoch are ignored. */
  epoch = 0;

  private transport: Transport;
  private resendMs: number;
  private rebuildTicksPerUpdate: number;
  private maxResyncAttempts: number;
  private onBattleReplaced?: (battle: Battle) => void;
  private peer: Side;
  /** The config both battles were built from, for rebuilding. */
  private config: BattleConfig;
  /** Commands given since the last bundle was sealed. */
  private outgoing: CommandBody[] = [];
  /** Every command we ever sealed, by turn and in issue order: our own record of our side's
   * history, which a resync payload from the authority must not contradict (trust boundary). */
  private sent: { turn: number; key: string; body: CommandBody }[] = [];
  /** Sealed bundles per side by turn (ours are kept until the peer acks them and they have run). */
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
  /** Our latest hash, repeated on every bundle. */
  private latestHash: TurnHash | null = null;
  /** When the next turn is due (ms), and when the current stall began (null: not stalled). */
  private nextTurnAt: number | null = null;
  private stallSince: number | null = null;
  // ---- resync
  private rebuild: Rebuild | null = null;
  /** The authority's payload for the current epoch (kept to answer a peer that missed it). */
  private payload: Extract<NetMessage, { kind: 'resync' }> | null = null;
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
    this.rebuildTicksPerUpdate = Math.max(1, opts.rebuildTicksPerUpdate ?? 600);
    this.maxResyncAttempts = Math.max(1, opts.maxResyncAttempts ?? 3);
    this.onBattleReplaced = opts.onBattleReplaced;
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
    return r.tick > 0 ? Math.min(1, (r.battle.state.tick ?? 0) / r.tick) : 1;
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
    try {
      return this.updateUnsafe(nowMs);
    } catch (e) {
      // a bug in the sim or the session: give up cleanly rather than crash the page
      this.status = 'failed';
      this.reports.push(this.report(this.turn, this.battle.state.tick ?? 0, NaN, NaN));
      void e;
      return 0;
    }
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
      for (const body of this.outgoing) this.sent.push({ turn: t, key: canonical(body), body: structuredClone(body) });
      this.outgoing = [];
      this.unacked.set(t, nowMs);
      this.sendBundle(t);
    }
  }

  private sendBundle(turn: number): void {
    const commands = this.bundles[this.side].get(turn) ?? [];
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
        // a duplicate or a bundle for a turn already run is ignored; the ack still counts.
        // While resyncing, keep everything: the turn play resumes at is not known yet.
        const floor = this.status === 'resyncing' ? 0 : this.turn;
        if (msg.turn >= floor && !this.bundles[this.peer].has(msg.turn)) {
          this.bundles[this.peer].set(msg.turn, msg.commands);
        }
        while (this.bundles[this.peer].has(this.receivedTo + 1)) this.receivedTo++;
        for (const t of [...this.unacked.keys()]) {
          if (t > msg.ack) continue;
          this.unacked.delete(t);
          if (t < this.turn) this.bundles[this.side].delete(t);
        }
        if (msg.hash) this.takeRemoteHash(msg.hash);
        return;
      }
      case 'hash':
        this.takeRemoteHash(msg);
        return;
      case 'resyncRequest':
        // the peer saw a mismatch first: the authority starts the resync it asks for
        if (!this.authority) return;
        // honoured only while playing, and not again right after a resync; during a resync the
        // peer gets the current payload again instead of restarting the rebuild
        if (this.status === 'playing' && msg.epoch > this.epoch) {
          if (this.turn - this.resumedTurn < REQUEST_COOLDOWN_TURNS) return;
          this.startResync(msg.epoch, msg.turn, NaN, NaN);
        } else if (this.status === 'resyncing' && this.payload) this.transport.send(this.payload);
        return;
      case 'resync':
        if (this.authority) return;
        if (msg.epoch > this.epoch || (msg.epoch === this.epoch && this.status === 'resyncing' && !this.rebuild)) this.adoptPayload(msg);
        // a repeat of a resync we already finished: the authority missed our answer
        else if (msg.epoch === this.epoch && this.rebuiltHash !== null) {
          this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
        }
        return;
      case 'resyncFailed':
        // the peer stopped: no more bundles will come, whatever state we are in
        if (this.status !== 'failed') {
          this.status = 'failed';
          this.lastResyncSend = -Infinity;
        }
        return;
      case 'resynced':
        if (msg.epoch !== this.epoch) return;
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
    if (this.remoteHashes.has(h.turn)) return;
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
      authorityLog: null, resumedAt: null, attempts: 0, recovered: false,
    };
  }

  /** Stops play for resync `epoch`. The authority freezes its history and sends it; a follower
   * asks for it (and keeps asking until it arrives). */
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
    const bundles: Record<Side, [number, CommandBody[]][]> = { german: [], soviet: [] };
    for (const s of SIDES) {
      for (const [t, cmds] of this.bundles[s]) if (t >= this.turn) bundles[s].push([t, cmds]);
    }
    this.payload = {
      kind: 'resync', side: this.side, epoch, turn: this.turn, tick: this.battle.state.tick ?? 0,
      log: structuredClone([...this.battle.commandLog()]), bundles,
    };
    this.adoptPayload(this.payload);
  }

  /** Begins rebuilding the battle from the authority's history for its epoch. */
  private adoptPayload(p: Extract<NetMessage, { kind: 'resync' }>): void {
    if (this.status !== 'resyncing') {
      // the authority saw the mismatch first
      this.status = 'resyncing';
      this.stallSince = null;
      this.reports.push(this.report(this.turn, this.battle.state.tick ?? 0, NaN, NaN));
    }
    // Trust boundary: the authority may decide the order of history and drop a command it never
    // got, but it may not speak for us. Our side's commands in its log must be ones we sent, in
    // the order we sent them; anything else (a forged order for our teams, a flee or truce in our
    // name) ends the session instead of being replayed.
    if (!this.authority) {
      const why = this.payloadProblem(p);
      if (why) {
        const report = this.reports[this.reports.length - 1];
        report.authorityLog = Array.isArray(p.log) ? p.log : null;
        report.reason = why;
        this.status = 'failed';
        this.rebuild = null;
        this.lastResyncSend = -Infinity;
        return;
      }
    }
    this.epoch = p.epoch;
    this.rebuiltHash = null;
    this.peerRebuiltHash = null;
    const report = this.reports[this.reports.length - 1];
    report.authorityLog = p.log;
    report.attempts++;
    const battle = new Battle(structuredClone(this.config));
    battle.loadCommands(p.log);
    this.rebuild = { epoch: p.epoch, turn: p.turn, tick: p.tick, log: p.log, battle, done: false };
    // the authority's bundles from the resume turn on; our own come from our record, never from it
    for (const [t, cmds] of p.bundles[this.peer]) if (!this.bundles[this.peer].has(t)) this.bundles[this.peer].set(t, cmds);
    if (!this.authority) {
      for (let t = p.turn; t <= this.sealedTo; t++) {
        if (!this.bundles[this.side].has(t)) this.bundles[this.side].set(t, this.sent.filter((e) => e.turn === t).map((e) => structuredClone(e.body)));
      }
    }
  }

  /** Why a resync payload cannot be trusted, or null. */
  private payloadProblem(p: Extract<NetMessage, { kind: 'resync' }>): string | null {
    if (!Array.isArray(p.log) || !p.bundles || !Array.isArray(p.bundles[this.peer])) return 'malformed resync payload';
    if (!Number.isInteger(p.turn) || !Number.isInteger(p.tick) || p.turn < 0 || p.tick < 0) return 'malformed resync payload';
    let i = 0;
    for (const c of p.log) {
      if (!c || (c.side !== 'german' && c.side !== 'soviet') || !Number.isInteger(c.tick)) return 'malformed command in the authority log';
      if (c.side !== this.side) continue;
      // our command: it must come next in what we sent (skipping any the authority never got)
      const { side: _s, tick: _t, seq: _q, ...body } = c;
      const key = canonical(body);
      while (i < this.sent.length && this.sent[i].key !== key) i++;
      if (i === this.sent.length) return `the authority log holds a ${c.type} command in our name that we never sent`;
      i++;
    }
    return null;
  }

  /** One update's worth of resync work: (re)send what the peer may be missing, rebuild a slice. */
  private stepResync(nowMs: number): void {
    const r = this.rebuild;
    if (nowMs - this.lastResyncSend >= this.resendMs) {
      this.lastResyncSend = nowMs;
      if (!this.authority && !r) this.transport.send({ kind: 'resyncRequest', side: this.side, epoch: this.epoch, turn: this.turn });
      if (this.authority && this.payload && this.peerRebuiltHash === null) this.transport.send(this.payload);
      if (this.rebuiltHash !== null) this.transport.send({ kind: 'resynced', side: this.side, epoch: this.epoch, hash: this.rebuiltHash });
    }
    if (!r || r.done) return;
    const battle = r.battle;
    const state = battle.state;
    let stuck = false;
    for (let n = 0; n < this.rebuildTicksPerUpdate; n++) {
      if ((state.tick ?? 0) >= r.tick || state.phase === 'ended') break;
      const before = state.tick ?? 0, waiting = battle.pendingCount();
      battle.step(SIM_DT);
      battle.drainEvents();
      this.stats.rebuiltTicks += (state.tick ?? 0) - before;
      // deploy or paused with nothing applied: no command left that could move it on
      if ((state.tick ?? 0) === before && state.phase !== 'running' && battle.pendingCount() === waiting) { stuck = true; break; }
    }
    if ((state.tick ?? 0) < r.tick && state.phase !== 'ended' && !stuck) return;
    // the commands the authority applied after its last tick (a pause, a flee) land now
    battle.flushDue();
    battle.drainEvents();
    r.done = true;
    this.adoptRebuilt(r, nowMs);
  }

  /** Swaps the rebuilt battle in at the authority's turn and reports its hash. */
  private adoptRebuilt(r: Rebuild, nowMs: number): void {
    this.battle = r.battle;
    this.turn = r.turn;
    // history before the resume turn is the authority's now
    for (let i = this.hashChain.length - 1; i >= 0 && this.hashChain[i][0] >= r.turn; i--) this.hashChain.pop();
    for (const s of SIDES) for (const t of [...this.bundles[s].keys()]) if (t < r.turn && !(s === this.side && this.unacked.has(t))) this.bundles[s].delete(t);
    this.receivedTo = r.turn - 1;
    while (this.bundles[this.peer].has(this.receivedTo + 1)) this.receivedTo++;
    this.sealedTo = Math.max(this.sealedTo, r.turn - 1);
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
      this.status = 'failed';
      this.lastResyncSend = -Infinity;
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

/** JSON with object keys sorted, so equal commands compare equal however they were built. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
