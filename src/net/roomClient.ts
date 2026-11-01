import { SIMULATION_BUILD } from '@/shared/version';
import type { Side } from '@/shared/types';
import type { Envelope, WireTransport } from './integrity';
import { RELAY_PROTOCOL, isRecord, isSide, type ClientFrame, type RoomSettings, type RoomView, type ServerFrame } from './relayProtocol';

export interface RoomCredential { url: string; code: string; token: string; side: Side }
export type RoomEvent = { kind: 'frame'; frame: ServerFrame } | { kind: 'disconnected'; reason: string };
const STORAGE_KEY = 'cc3.online.room';

/** Native WebSocket on browsers and Node 24; no ws package enters the game bundle. */
export class RoomClient implements WireTransport {
  room: RoomView | null = null;
  side: Side | null = null;
  generation = 0;
  credential: RoomCredential | null = null;
  private socket: WebSocket | null = null;
  private listeners = new Set<(event: RoomEvent) => void>();
  private receiver: ((env: unknown) => void) | null = null;
  private pending: Envelope[] = [];
  private intentional = false;
  constructor(readonly url: string, readonly build = SIMULATION_BUILD) {}
  static saved(): RoomCredential | null {
    try { const x = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); return isRecord(x) && typeof x.url === 'string' && typeof x.code === 'string' && typeof x.token === 'string' && isSide(x.side) ? x as unknown as RoomCredential : null; } catch { return null; }
  }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  onEvent(handler: (event: RoomEvent) => void): () => void { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  private emit(event: RoomEvent): void { for (const h of [...this.listeners]) h(event); }
  async connect(): Promise<void> {
    this.intentional = false;
    const previous = this.socket, ws = new WebSocket(this.url); this.socket = ws;
    previous?.close(1000, 'Reconnecting');
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.addEventListener('open', () => { opened = true; resolve(); });
      ws.addEventListener('error', () => { if (!opened) reject(new Error('Cannot reach the relay. Check the server address.')); });
      ws.addEventListener('close', e => {
        if (!opened) reject(new Error('Relay connection closed before joining.'));
        if (this.socket === ws && !this.intentional) this.emit({ kind: 'disconnected', reason: e.reason || 'Connection lost.' });
      });
      ws.addEventListener('message', e => {
        if (this.socket !== ws || typeof e.data !== 'string') return;
        let f: ServerFrame; try { f = JSON.parse(e.data); } catch { return; }
        if (!isRecord(f) || typeof f.op !== 'string') return;
        if (f.op === 'member') {
          this.side = f.side; this.room = f.room; this.generation = f.room.generation;
          this.credential = { url: this.url, code: f.room.code, side: f.side, token: f.token };
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.credential)); } catch { /* a live connection still works */ }
        } else if (f.op === 'room') { this.room = f.room; this.generation = f.room.generation; }
        else if (f.op === 'start' || f.op === 'history') { this.generation = f.generation; this.pending = []; this.receiver = null; }
        if (f.op === 'wire') {
          if (f.generation !== this.generation) return;
          if (this.receiver) this.receiver(f.envelope); else if (this.pending.length < 4096) this.pending.push(f.envelope);
        } else this.emit({ kind: 'frame', frame: f });
      });
    });
  }
  request(frame: ClientFrame): boolean {
    if (!this.connected) return false;
    this.socket!.send(JSON.stringify(frame)); return true;
  }
  create(side: Side, settings: RoomSettings): boolean { return this.request({ op: 'create', protocol: RELAY_PROTOCOL, build: this.build, side, settings }); }
  join(code: string): boolean { return this.request({ op: 'join', protocol: RELAY_PROTOCOL, build: this.build, code: code.trim().toUpperCase() }); }
  async reconnect(credential = this.credential): Promise<void> {
    if (!credential) throw new Error('No saved player token. Join or create a room.');
    this.credential = credential;
    await this.connect(); this.request({ op: 'rejoin', protocol: RELAY_PROTOCOL, build: this.build, code: credential.code, token: credential.token });
  }
  send(envelope: Envelope): void { this.request({ op: 'wire', generation: this.generation, envelope }); }
  onMessage(handler: (env: unknown) => void): void { this.receiver = handler; for (const env of this.pending.splice(0)) handler(env); }
  close(): void { this.intentional = true; this.socket?.close(1000, 'Left game'); this.receiver = null; this.pending = []; }
}
