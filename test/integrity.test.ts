import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { LockstepSession } from '@/net/lockstep';
import { IntegrityTransport, crc32, type Envelope, type WireTransport } from '@/net/integrity';
import { VirtualClock, memoryLink } from '@/net/memoryTransport';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, Side } from '@/shared/types';

/** The checksum layer under the lockstep session: damaged packets are NACKed and sent again. */

function config(): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 1200,
    difficulty: 'normal', forces: DEFAULT_FORCES[1941], controllers: { german: 'human', soviet: 'human' },
  };
}

describe('crc32', () => {
  it('matches the standard check value and sees a one-character change', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
    expect(crc32('{"turn":10}')).not.toBe(crc32('{"turn":11}'));
    expect(crc32('ä')).not.toBe(crc32('a'));
  });
});

describe('IntegrityTransport', () => {
  it('drops a damaged message, NACKs it, and the sender sends it again', () => {
    const toB: Envelope[] = [];
    const toA: Envelope[] = [];
    let aIn: (e: unknown) => void = () => {};
    let bIn: (e: unknown) => void = () => {};
    const wa: WireTransport = { send: (e) => toB.push(e), onMessage: (h) => { aIn = h; } };
    const wb: WireTransport = { send: (e) => toA.push(e), onMessage: (h) => { bIn = h; } };
    const a = new IntegrityTransport(wa);
    const b = new IntegrityTransport(wb);
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    a.onMessage(() => {});

    a.send({ kind: 'hash', side: 'german', turn: 10, hash: 123, epoch: 0 });
    const env = toB.shift()! as Extract<Envelope, { k: 'm' }>;
    bIn({ ...env, body: env.body.replace('123', '124') }); // one digit changed on the way
    expect(got).toEqual([]);
    expect(b.stats.corrupted).toBe(1);
    const nack = toA.shift()!;
    expect(nack).toMatchObject({ k: 'nack', seq: env.seq });
    aIn(nack);
    expect(a.stats.resentOnNack).toBe(1);
    bIn(toB.shift());
    expect(got).toEqual([{ kind: 'hash', side: 'german', turn: 10, hash: 123, epoch: 0 }]);
    // unreadable junk and a forged NACK are ignored without throwing
    expect(() => bIn('{"k":"m","seq":1')).not.toThrow();
    expect(() => aIn({ k: 'nack', seq: 0, crc: 1 })).not.toThrow();
    expect(a.stats.resentOnNack).toBe(1);
  });
});

describe('lockstep over a corrupting link', () => {
  function run(withIntegrity: boolean) {
    const clock = new VirtualClock();
    const [ra, rb] = memoryLink(clock, { seed: 4242, corruptChance: 0.05 });
    const wrap = (t: typeof ra) => (withIntegrity ? new IntegrityTransport(t as unknown as WireTransport) : t);
    const ta = wrap(ra), tb = wrap(rb);
    const peers: Record<Side, LockstepSession> = {
      german: new LockstepSession({ battle: new Battle(config()), side: 'german', transport: ta, resendMs: 300 }),
      soviet: new LockstepSession({ battle: new Battle(config()), side: 'soviet', transport: tb, resendMs: 300 }),
    };
    peers.german.issue({ type: 'autoDeploy' });
    peers.soviet.issue({ type: 'autoDeploy' });
    let readied = false;
    for (let t = 0; t <= 6 * 60_000 && !(peers.german.turn >= 1500 && peers.soviet.turn >= 1500); t += 10) {
      clock.advanceTo(t);
      if (!readied && peers.german.turn >= 5) {
        peers.german.issue({ type: 'ready' });
        peers.soviet.issue({ type: 'ready' });
        readied = true;
      }
      for (const s of [peers.german, peers.soviet]) { s.update(t); s.battle.drainEvents(); }
      if (peers.german.done || peers.soviet.done) break;
    }
    return { peers, ta, tb };
  }

  it('5 % of packets damaged: every one is caught and sent again, and the game never desyncs', () => {
    const { peers, ta, tb } = run(true);
    const ia = ta as IntegrityTransport, ib = tb as IntegrityTransport;
    expect(peers.german.turn).toBeGreaterThanOrEqual(1500);
    expect(ia.stats.corrupted + ib.stats.corrupted).toBeGreaterThan(20);
    expect(ia.stats.resentOnNack + ib.stats.resentOnNack).toBeGreaterThan(0);
    expect(peers.german.reports).toEqual([]);
    expect(peers.soviet.reports).toEqual([]);
    const n = Math.min(peers.german.hashChain.length, peers.soviet.hashChain.length);
    expect(n).toBeGreaterThan(100);
    expect(peers.german.hashChain.slice(0, n)).toEqual(peers.soviet.hashChain.slice(0, n));
  }, 300_000);

  it('without the layer, the same damage reaches the session (resyncs or a failed game)', () => {
    const { peers } = run(false);
    const trouble = peers.german.reports.length + peers.soviet.reports.length;
    expect(trouble).toBeGreaterThan(0);
  }, 300_000);
});
