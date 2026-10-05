// ============================================================================
// memoryTransport.ts — two connected in-memory transports on a virtual clock, for testing
// lockstep without a network (multiplayer plan §7 M1). Every message gets a seeded random
// latency (20–300 ms by default), and a share of them is held back a little longer, so messages
// arrive with jitter and out of order exactly as the session must tolerate. Messages cross as
// JSON, so nothing the receiver gets aliases the sender's objects.
// ============================================================================
import { Rng } from '@/shared/rng';
import type { NetMessage, Transport } from './transport';

/** A deterministic clock: events fire in time order (ties in scheduling order) as it advances. */
export class VirtualClock {
  now = 0;
  private queue: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  schedule(delayMs: number, fn: () => void): void {
    this.queue.push({ at: this.now + Math.max(0, delayMs), seq: this.seq++, fn });
  }

  /** Runs every event due by `t` in order, then sets the clock to `t`. */
  advanceTo(t: number): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i], b = this.queue[best];
        if (e.at <= t && (best < 0 || e.at < b.at || (e.at === b.at && e.seq < b.seq))) best = i;
      }
      if (best < 0) break;
      const [e] = this.queue.splice(best, 1);
      this.now = e.at;
      e.fn();
    }
    this.now = Math.max(this.now, t);
  }

  pending(): number {
    return this.queue.length;
  }
}

export interface LinkOptions {
  seed: number;
  /** Per-message one-way latency, drawn uniformly (ms). */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Share of messages held back by up to `reorderMs` extra, overtaken by later ones. */
  reorderChance?: number;
  reorderMs?: number;
  /** Share of messages lost (the session's resends recover bundles). */
  dropChance?: number;
  /** Share of messages with one character of their JSON changed on the way (a damaged packet);
   * if that breaks the JSON, the receiver gets the raw string. */
  corruptChance?: number;
}

class MemoryEnd implements Transport {
  peer!: MemoryEnd;
  handler: ((msg: NetMessage) => void) | null = null;
  sent = 0;

  constructor(private clock: VirtualClock, private rng: Rng, private opts: Required<LinkOptions>) {}

  send(msg: NetMessage): void {
    this.sent++;
    const o = this.opts;
    if (o.dropChance > 0 && this.rng.chance(o.dropChance)) return;
    let delay = this.rng.range(o.minDelayMs, o.maxDelayMs);
    if (this.rng.chance(o.reorderChance)) delay += this.rng.range(0, o.reorderMs);
    let wire = JSON.stringify(msg);
    if (o.corruptChance > 0 && this.rng.chance(o.corruptChance)) {
      const i = this.rng.int(0, wire.length - 1);
      const c = wire.charCodeAt(i);
      wire = wire.slice(0, i) + String.fromCharCode(c === 0x31 ? 0x32 : 0x31) + wire.slice(i + 1);
    }
    const peer = this.peer;
    this.clock.schedule(delay, () => {
      let got: unknown;
      try { got = JSON.parse(wire); } catch { got = wire; }
      peer.handler?.(got as NetMessage);
    });
  }

  onMessage(handler: (msg: NetMessage) => void): void {
    this.handler = handler;
  }
}

/** Two transports wired to each other through `clock`; each direction has its own random stream. */
export function memoryLink(clock: VirtualClock, options: LinkOptions): [Transport, Transport] {
  const opts: Required<LinkOptions> = {
    minDelayMs: 20, maxDelayMs: 300, reorderChance: 0.15, reorderMs: 40, dropChance: 0, corruptChance: 0, ...options,
  };
  const a = new MemoryEnd(clock, new Rng(opts.seed), opts);
  const b = new MemoryEnd(clock, new Rng(opts.seed ^ 0x9e3779b9), opts);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
