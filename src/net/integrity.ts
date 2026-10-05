// ============================================================================
// integrity.ts — a checksum layer under the lockstep session. Every message travels in an
// envelope with a sequence number and the CRC-32 of its JSON; a receiver that finds the checksum
// wrong (or the envelope unreadable) drops it and answers with a NACK naming the sequence number,
// and the sender sends that message again at once instead of waiting for the session's resend
// timer. A corrupted packet therefore never reaches the sim and costs one round trip, not a desync.
//
// CRC-32 detects every error burst up to 32 bits and practically every other accidental change;
// it is not a defence against a hostile peer, who can recompute it (the session's trust rules
// cover that). Over TLS/DTLS transports corruption should not happen at all; this catches relay
// and serialisation bugs. Browsers cannot send raw UDP, so the NACK goes over the same channel.
// ============================================================================
import type { NetMessage, Transport } from './transport';

/** What actually crosses the wire under an IntegrityTransport. */
export type Envelope =
  | { k: 'm'; seq: number; crc: number; body: string }
  | { k: 'nack'; seq: number; crc: number };

/** A transport that carries envelopes (any JSON-safe value). */
export interface WireTransport {
  send(env: Envelope): void;
  onMessage(handler: (env: unknown) => void): void;
}

export interface IntegrityStats {
  sent: number;
  /** Messages that arrived corrupted (checksum wrong or unreadable). */
  corrupted: number;
  /** NACKs we sent, and messages we sent again because the peer NACKed them. */
  nacksSent: number;
  resentOnNack: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const UTF8 = new TextEncoder();

/** CRC-32 (IEEE 802.3, as zip and PNG use) of a string's UTF-8 bytes. */
export function crc32(s: string): number {
  const bytes = UTF8.encode(s);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function nackCrc(seq: number): number {
  return crc32(`nack:${seq}`);
}

/** Wraps a wire in checksummed envelopes; the session talks to the returned Transport. */
export class IntegrityTransport implements Transport {
  readonly stats: IntegrityStats = { sent: 0, corrupted: 0, nacksSent: 0, resentOnNack: 0 };
  private seq = 0;
  /** Recent sent envelopes by sequence number, for answering a NACK. */
  private recent = new Map<number, Envelope>();
  private handler: ((msg: NetMessage) => void) | null = null;

  /** @param keep how many recent messages are kept for NACKs
   * @param onCorrupt told of every damaged message (the HUD's network symbol) */
  constructor(private wire: WireTransport, private keep = 4096, private onCorrupt?: (detail: string) => void) {
    wire.onMessage((env) => this.receive(env));
  }

  send(msg: NetMessage): void {
    const body = JSON.stringify(msg);
    const env: Envelope = { k: 'm', seq: this.seq++, crc: crc32(body), body };
    this.recent.set(env.seq, env);
    if (this.recent.size > this.keep) this.recent.delete(this.recent.keys().next().value!);
    this.stats.sent++;
    this.wire.send(env);
  }

  onMessage(handler: (msg: NetMessage) => void): void {
    this.handler = handler;
  }

  private receive(raw: unknown): void {
    const env = raw as Partial<Envelope> | null;
    if (!env || typeof env !== 'object') return;
    if (env.k === 'nack') {
      // the peer got one of ours damaged: send it again now (a damaged NACK itself is ignored)
      if (typeof env.seq !== 'number' || env.crc !== nackCrc(env.seq)) return;
      const again = this.recent.get(env.seq);
      if (again) {
        this.stats.resentOnNack++;
        this.wire.send(again);
      }
      return;
    }
    const ok = env.k === 'm' && typeof env.body === 'string' && typeof env.seq === 'number' && env.crc === crc32(env.body);
    let msg: NetMessage | null = null;
    if (ok) {
      try { msg = JSON.parse(env.body!) as NetMessage; } catch { msg = null; }
    }
    if (!msg) {
      this.stats.corrupted++;
      const seq = typeof env.seq === 'number' && Number.isSafeInteger(env.seq) ? env.seq : null;
      this.onCorrupt?.(seq !== null ? `message ${seq} arrived damaged; asked for it again` : 'an unreadable message arrived');
      // ask again when we can still read which message it was; otherwise the session's own
      // resend timer recovers it
      if (typeof env.seq === 'number' && Number.isSafeInteger(env.seq)) {
        this.stats.nacksSent++;
        this.wire.send({ k: 'nack', seq: env.seq, crc: nackCrc(env.seq) });
      }
      return;
    }
    this.handler?.(msg);
  }
}
