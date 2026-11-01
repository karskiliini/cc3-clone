import { validCommand } from './commandValidation';
import { Battle } from '@/sim/battle';
import type { CommandBody } from '@/sim/commands';
import type { BattleConfig } from '@/shared/types';
import { hashState } from '@/sim/stateHash';
import { makeReplayLog } from '@/sim/replay';
import { IntegrityTransport } from './integrity';
import { LockstepSession, type DesyncReport } from './lockstep';
import { NetHealth } from './netHealth';
import { RoomClient, type RoomEvent } from './roomClient';
import type { ServerFrame, TurnHistory } from './relayProtocol';

export type OnlinePhase = 'waiting' | 'playing' | 'recovering' | 'failed' | 'closed' | 'local';
export interface OnlineCallbacks { onBattle?: (battle: Battle) => void; onLocal?: (battle: Battle) => void }
/** Headless lifecycle owner; the game frame calls update even while menus are open. */
export class OnlineMatch {
  session: LockstepSession | null = null;
  readonly health = new NetHealth();
  phase: OnlinePhase = 'waiting';
  message = 'Waiting for the other player.';
  private archive: DesyncReport[] = [];
  private fallbackBattle:Battle|null=null;
  private history:TurnHistory|null=null;
  private frozenGeneration:number|null=null;
  private pendingInput: CommandBody[] = [];
  private awaitingBarrier = false;
  private rebuiltSent = false;
  private unsubscribe: () => void;
  private lastProgress = -1;
  private now = 0;
  constructor(readonly client: RoomClient, private callbacks: OnlineCallbacks = {}, initial?: ServerFrame) {
    this.unsubscribe = client.onEvent(e => this.event(e));
    if (initial) this.frame(initial);
  }
  get reportCount():number{return this.archive.length+(this.session?.reports.length??0);}
  get battle(): Battle | null { return this.session?.battle ?? null; }
  get progress(): number | null { return this.session?.resyncProgress ?? (this.phase==='recovering' ? (this.awaitingBarrier?1:0) : null); }
  get canContinueLocally():boolean{return !!(this.awaitingBarrier&&this.session?.status!=='playing'?this.fallbackBattle:this.battle);}
  start(frame:Extract<ServerFrame,{op:'start'}>):void{this.frame(frame);}
  get blocked(): boolean { return this.phase !== 'playing' || this.session?.status !== 'playing'; }
  issue(body: CommandBody): boolean {
    if (this.blocked || !this.session) return false;
    if(!validCommand(body,this.session.battle.state.map.width,this.session.battle.state.map.height))return false;
    if (body.type === 'order' && this.battle?.state.phase === 'paused') return false;
    const p=this.battle?.state.multiplayerPolicy;
    if(p?.active&&body.type==='resume'&&p.pauseOwner!==this.client.side)return false;
    if(p?.active&&body.type==='pause'&&p.pausesUsed[this.client.side!]>=3)return false;
    this.session.issue(body); return true;
  }
  private event(e: RoomEvent): void {
    if (e.kind === 'disconnected') { this.phase = 'waiting'; this.message = e.reason; }
    else {try{this.frame(e.frame);}catch{this.phase='failed';this.message='Invalid recovery data. Download the report and rejoin.';}}
  }
  private construct(config: BattleConfig): LockstepSession {
    if (!this.client.side) throw new Error('Room has not assigned a side.');
    if (this.session) {this.fallbackBattle=this.battle;this.archive.push(...this.session.reports);}
    const cfg = structuredClone(config); cfg.playerSide = this.client.side;
    const transport = new IntegrityTransport(this.client, 4096, detail => this.health.note('corrupt', undefined, detail));
    const session = new LockstepSession({ battle: new Battle(cfg), side: this.client.side, transport, authority: this.client.room?.host === this.client.side,
      rebuildTurnsPerUpdate: 20, health: this.health, onBattleReplaced: b => this.callbacks.onBattle?.(b) });
    this.session = session; this.lastProgress = -1; return session;
  }
  private frame(f: ServerFrame): void {
    if (f.op === 'start') {
      const s = this.construct(f.config); this.phase = 'playing'; this.callbacks.onBattle?.(s.battle); return;
    }
    if (f.op === 'room') {
      const peer = this.client.side === 'german' ? 'soviet' : 'german';
      if (f.room.phase === 'closed') return;
      if (this.phase === 'playing' && !f.room.members[peer]?.connected) { this.phase = 'waiting'; this.message = 'Opponent disconnected. Rejoin is available for 15 minutes.'; }
      return;
    }
    if (f.op === 'freeze') {
      if (this.session&&this.frozenGeneration!==f.generation) this.pendingInput.push(...this.session.pendingInput);
      this.frozenGeneration=f.generation;
      this.phase = 'recovering'; this.message = 'Rejoining — agreeing a common turn…'; this.awaitingBarrier = false; this.rebuiltSent = false;
      const own=this.client.side?this.client.room?.members[this.client.side]:null;
      const point=this.session?.freezePoint()??{turn:own?.turn??0,sealedTo:own?.sealedTo??2};
      this.client.request({ op: 'frozen', generation: f.generation, ...point }); return;
    }
    if (f.op === 'history') {
      this.history=structuredClone(f.history);
      const s = this.construct(f.config); s.restoreHistory(f.history);
      for (const c of this.pendingInput.splice(0)) s.issue(c);
      this.lastProgress=-1; this.phase = 'recovering'; this.awaitingBarrier = true; this.rebuiltSent = false; this.message = 'Rejoining — rebuilding battle…'; return;
    }
    if (f.op === 'play') { this.phase = 'playing'; this.awaitingBarrier = false; this.rebuiltSent = false; this.message = ''; return; }
    if (f.op === 'closed') {
      this.phase = 'closed'; this.message = f.reason;
      if (f.forfeit && this.battle) { this.battle.submit(f.forfeit, { type: 'flee' }); this.battle.step(0); this.battle.advanceTick(); this.callbacks.onBattle?.(this.battle); }
      return;
    }
    if (f.op === 'error') { this.phase = 'failed'; this.message = f.message; }
  }
  update(nowMs: number): void {
    this.now = nowMs;
    const s = this.session;
    if (s && this.client.connected) {
      if (this.phase === 'playing') {
        s.update(nowMs);
        if (s.status === 'failed') { this.phase = 'failed'; this.message = s.desync?.reason ?? 'The battle could not resynchronise.'; }
        if (s.turn !== this.lastProgress) { this.lastProgress = s.turn; this.client.request({ op: 'progress', generation: this.client.generation, turn: s.turn }); }
      } else if (this.phase === 'recovering' && this.awaitingBarrier) {
        if (s.status === 'resyncing') s.update(nowMs);
        if(s.status==='failed'){this.phase='failed';this.message='Recovery could not rebuild the battle. Your previous battle is available for local continuation.';this.client.request({op:'rebuildFailed',generation:this.client.generation});}
        else if(s.status==='resyncing'&&s.rebuildTurn!==this.lastProgress){this.lastProgress=s.rebuildTurn;this.client.request({op:'rebuilding',generation:this.client.generation,turn:s.rebuildTurn});}
        if (s.status === 'playing' && !this.rebuiltSent) {
          this.rebuiltSent = true; this.message = 'Rebuilt — waiting for matching state…';
          this.client.request({ op: 'rebuilt', generation: this.client.generation, turn: s.turn, hash: hashState(s.battle) });
        }
      }
    }
    this.health.update(nowMs, this.phase === 'waiting' || !!s?.stalled, this.phase === 'recovering' || s?.status === 'resyncing', this.phase === 'failed', this.message);
  }
  async reconnect(): Promise<void> {
    this.phase = 'waiting'; this.message = 'Reconnecting…';
    try { await this.client.reconnect(); } catch (e) { this.phase = 'failed'; this.message = String(e); }
  }
  continueAgainstAI(): Battle | null {
    const b = this.awaitingBarrier&&this.session?.status!=='playing'?this.fallbackBattle:this.battle, side = this.client.side; if (!b || !side) return null;
    this.client.request({ op: 'leave', mode: 'ai' }); this.dispose();
    b.submit(side, { type: 'takeoverAI' }); b.step(0); b.advanceTick(); this.phase = 'local';
    this.callbacks.onLocal?.(b); return b;
  }
  forfeit(): void {
    const b = this.battle, side = this.client.side;
    this.client.request({ op: 'leave', mode: 'forfeit' }); this.dispose();
    if (b && side) { b.submit(side, { type: 'flee' }); b.step(0); b.advanceTick(); this.callbacks.onLocal?.(b); }
    this.phase = 'closed';
  }
  report(): unknown {
    return { room: this.client.room?.code, side: this.client.side, phase: this.phase, message: this.message,
      build:this.client.build,reports: [...this.archive, ...(this.session?.reports ?? [])], network: this.health.log, stats: this.session?.stats,
      history:this.history, replay: this.battle ? makeReplayLog(this.battle) : null, atMs: this.now };
  }
  leave(): void { this.client.request({ op: 'leave', mode: 'quit' }); this.dispose(); this.phase = 'closed'; }
  dispose(): void { this.unsubscribe(); this.client.close(); }
}
