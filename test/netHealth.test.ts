import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { LockstepSession } from '@/net/lockstep';
import { IntegrityTransport, type WireTransport } from '@/net/integrity';
import { VirtualClock, memoryLink, type LinkOptions } from '@/net/memoryTransport';
import { NetHealth, INCIDENT_SHOW_MS, STALL_SHOW_MS } from '@/net/netHealth';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, Side } from '@/shared/types';

/** The red network symbol's source: what counts as trouble, and how long it shows. */

describe('NetHealth', () => {
  it('a short wait is not trouble; a long one shows while it lasts and briefly after', () => {
    const h = new NetHealth();
    h.update(0, true, false, false);
    h.update(STALL_SHOW_MS - 10, true, false, false);
    expect(h.troubled(STALL_SHOW_MS - 10)).toBe(false);
    h.update(STALL_SHOW_MS + 10, true, false, false);
    expect(h.troubled(STALL_SHOW_MS + 10)).toBe(true);
    expect(h.label()).toBe('Waiting for opponent');
    expect(h.counts.stall).toBe(1);
    h.update(2000, true, false, false); // still the same wait: one incident
    expect(h.counts.stall).toBe(1);
    h.update(2100, false, false, false);
    expect(h.troubled(2100 + INCIDENT_SHOW_MS - 1)).toBe(true);
    expect(h.troubled(2100 + INCIDENT_SHOW_MS + 1)).toBe(false);
  });

  it('a damaged packet lights it once; a resync and a failed session for as long as they last', () => {
    const h = new NetHealth();
    h.note('corrupt');
    h.update(1000, false, false, false);
    expect(h.troubled(1000)).toBe(true);
    expect(h.troubled(1000 + INCIDENT_SHOW_MS + 1)).toBe(false);
    h.update(5000, false, true, false);
    expect(h.troubled(60_000)).toBe(true);
    expect(h.label()).toBe('Resynchronising');
    h.update(6000, false, false, true);
    expect(h.troubled(1e9)).toBe(true);
    expect(h.label()).toBe('Connection lost');
    expect(h.counts).toEqual({ stall: 0, corrupt: 1, resync: 1, failed: 1 });
  });

  it('logs every incident with its time and details', () => {
    const h = new NetHealth();
    const printed: string[] = [];
    h.onLog = (e) => printed.push(e.kind);
    h.update(0, true, false, false);
    h.update(400, true, false, false);
    h.update(900, false, false, false);
    h.note('corrupt', undefined, 'message 17 arrived damaged; asked for it again');
    h.update(61_000, false, true, false);
    h.update(63_500, false, false, false);
    h.update(70_000, false, false, true, 'the rebuilt states kept disagreeing');
    expect(h.log.map((e) => e.kind)).toEqual(['stall', 'stallEnd', 'corrupt', 'resync', 'resyncEnd', 'failed']);
    expect(printed).toEqual(h.log.map((e) => e.kind));
    const text = h.logText().split('\n');
    expect(text[1]).toBe('00:00.9 stallEnd: the wait lasted 900 ms');
    expect(text[2]).toBe('01:01.0 corrupt: message 17 arrived damaged; asked for it again');
    expect(text[4]).toBe('01:03.5 resyncEnd: back in sync after 2500 ms');
    expect(text[5]).toBe('01:10.0 failed: the rebuilt states kept disagreeing');
  });
});

describe('the session and the checksum layer report to it', () => {
  function config(): BattleConfig {
    return {
      mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 1200,
      difficulty: 'normal', forces: DEFAULT_FORCES[1941], controllers: { german: 'human', soviet: 'human' },
    };
  }
  function play(link: Partial<LinkOptions>, turns: number) {
    const clock = new VirtualClock();
    const [ra, rb] = memoryLink(clock, { seed: 99, ...link });
    const health: Record<Side, NetHealth> = { german: new NetHealth(), soviet: new NetHealth() };
    const ta = new IntegrityTransport(ra as unknown as WireTransport, 4096, (d) => health.german.note('corrupt', undefined, d));
    const tb = new IntegrityTransport(rb as unknown as WireTransport, 4096, (d) => health.soviet.note('corrupt', undefined, d));
    const peers: Record<Side, LockstepSession> = {
      german: new LockstepSession({ battle: new Battle(config()), side: 'german', transport: ta, resendMs: 300, health: health.german }),
      soviet: new LockstepSession({ battle: new Battle(config()), side: 'soviet', transport: tb, resendMs: 300, health: health.soviet }),
    };
    peers.german.issue({ type: 'ready' });
    peers.soviet.issue({ type: 'ready' });
    for (let t = 0; t <= 10 * 60_000 && !(peers.german.turn >= turns && peers.soviet.turn >= turns); t += 10) {
      clock.advanceTo(t);
      for (const s of [peers.german, peers.soviet]) { s.update(t); s.battle.drainEvents(); }
    }
    return health;
  }

  it('a good link (20–60 ms) never lights the symbol', () => {
    const h = play({ minDelayMs: 20, maxDelayMs: 60, reorderChance: 0 }, 600);
    for (const x of [h.german, h.soviet]) expect(x.counts).toEqual({ stall: 0, corrupt: 0, resync: 0, failed: 0 });
  }, 120_000);

  it('a bad link (long delays, lost and damaged packets) lights it, and more often the worse it is', () => {
    const bad = play({ minDelayMs: 100, maxDelayMs: 700, dropChance: 0.03, corruptChance: 0.03 }, 600);
    const worse = play({ minDelayMs: 300, maxDelayMs: 1200, dropChance: 0.08, corruptChance: 0.08 }, 600);
    const total = (h: Record<Side, NetHealth>) => Object.values(h.german.counts).reduce((a, b) => a + b, 0);
    expect(bad.german.counts.stall).toBeGreaterThan(0);
    expect(bad.german.counts.corrupt + bad.soviet.counts.corrupt).toBeGreaterThan(0);
    expect(total(worse)).toBeGreaterThan(total(bad));
    // and every incident is in the log
    expect(bad.german.log.filter((e) => e.kind === 'corrupt').length).toBe(bad.german.counts.corrupt);
    expect(bad.german.log.some((e) => e.kind === 'stallEnd' && /the wait lasted \d+ ms/.test(e.detail))).toBe(true);
  }, 300_000);
});
