import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Battle } from '@/sim/battle';
import { hashHex, hashState } from '@/sim/stateHash';
import { LockstepSession } from '@/net/lockstep';
import { VirtualClock, memoryLink, type LinkOptions } from '@/net/memoryTransport';
import type { NetMessage, Transport } from '@/net/transport';
import { Rng } from '@/shared/rng';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, Order, Side } from '@/shared/types';

/** Multiplayer M1 (plan §7): two lockstep sessions over an in-memory transport. */

function config(): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 1200,
    difficulty: 'normal', forces: DEFAULT_FORCES[1941], controllers: { german: 'human', soviet: 'human' },
  };
}

interface Pair { clock: VirtualClock; peers: Record<Side, LockstepSession> }

/** Rewrites (or drops, by returning null) what a transport sends: a bug or a hostile wire. */
function tamper(t: Transport, fn: (msg: NetMessage) => NetMessage | null): Transport {
  return { send: (msg) => { const m = fn(msg); if (m) t.send(m); }, onMessage: (h) => t.onMessage(h) };
}

function pair(link: Partial<LinkOptions> = {}, resendMs?: number, wrap?: Partial<Record<Side, (t: Transport) => Transport>>): Pair {
  const clock = new VirtualClock();
  const [ra, rb] = memoryLink(clock, { seed: 1234, ...link });
  const ta = wrap?.german ? wrap.german(ra) : ra;
  const tb = wrap?.soviet ? wrap.soviet(rb) : rb;
  // each peer builds its own battle from the same config, as two browsers would
  return {
    clock,
    peers: {
      german: new LockstepSession({ battle: new Battle(config()), side: 'german', transport: ta, resendMs }),
      soviet: new LockstepSession({ battle: new Battle(config()), side: 'soviet', transport: tb, resendMs }),
    },
  };
}

/**
 * What each player does, by the turn their session is on: auto-deploy, ready, then an order to
 * one of their teams every few seconds (seeded per side), a German pause and resume and a Soviet
 * speed change. Each side's script reads only its own battle, like a player's UI.
 */
function scriptFor(side: Side): (s: LockstepSession) => void {
  const rng = new Rng(side === 'german' ? 101 : 202);
  let next = 0;
  const events: [number, (s: LockstepSession) => void][] = [
    [1, (s) => s.issue({ type: 'autoDeploy' })],
    [4, (s) => s.issue({ type: 'ready' })],
  ];
  if (side === 'german') events.push([1800, (s) => s.issue({ type: 'pause' })], [1840, (s) => s.issue({ type: 'resume' })]);
  else events.push([2600, (s) => s.issue({ type: 'setSpeed', speed: 2 })], [3400, (s) => s.issue({ type: 'setSpeed', speed: 1 })]);
  let orderAt = 30 + rng.int(0, 60);
  const types: Order['type'][] = ['move', 'moveFast', 'sneak', 'defend', 'fire'];
  return (s) => {
    while (next < events.length && s.turn >= events[next][0]) events[next++][1](s);
    if (s.turn < orderAt || s.battle.state.phase !== 'running') return;
    orderAt = s.turn + 40 + rng.int(0, 120);
    const teams = s.battle.selectableTeams(side);
    if (teams.length === 0) return;
    const team = rng.pick(teams);
    const map = s.battle.state.map;
    const vl = rng.pick(map.victoryLocations);
    const target = rng.chance(0.5)
      ? { x: vl.x + rng.range(-6, 6), y: vl.y + rng.range(-6, 6) }
      : { x: Math.min(map.width - 2, Math.max(2, team.pos.x + rng.range(-25, 25))), y: Math.min(map.height - 2, Math.max(2, team.pos.y + rng.range(-25, 25))) };
    const order: Order = { type: rng.pick(types), target, issuedAt: s.battle.state.time };
    s.issue({ type: 'order', teamId: team.id, order });
  };
}

/** Drives both peers on the virtual clock in 10 ms frames until `until(pair)` or `maxMs`. */
function drive(p: Pair, until: (p: Pair) => boolean, maxMs: number, perFrame?: (p: Pair) => void): void {
  const scripts = { german: scriptFor('german'), soviet: scriptFor('soviet') };
  for (let t = p.clock.now; t <= maxMs && !until(p); t += 10) {
    p.clock.advanceTo(t);
    for (const side of ['german', 'soviet'] as Side[]) {
      const s = p.peers[side];
      scripts[side](s);
      s.update(t);
      s.battle.drainEvents();
    }
    perFrame?.(p);
  }
}

const tick = (s: LockstepSession) => s.battle.state.tick ?? 0;

describe('lockstep session (M1)', () => {
  it('two peers play 10 sim-minutes over a laggy, reordering link with identical hash chains', () => {
    const p = pair();
    const { german, soviet } = p.peers;
    const TICKS = 6000;
    drive(p, () => (tick(german) >= TICKS || german.done) && (tick(soviet) >= TICKS || soviet.done), 30 * 60_000);

    expect(german.desync).toBeNull();
    expect(soviet.desync).toBeNull();
    expect(tick(german)).toBeGreaterThanOrEqual(TICKS);
    // the battle was really played: both sides deployed, orders flew, pause and speed went through
    const types = german.battle.commandLog().map((c) => `${c.side}:${c.type}`);
    for (const t of ['german:ready', 'soviet:ready', 'german:order', 'soviet:order', 'german:pause', 'german:resume', 'soviet:setSpeed']) {
      expect(types).toContain(t);
    }
    // identical hash chains over every turn both reached
    const n = Math.min(german.hashChain.length, soviet.hashChain.length);
    expect(n).toBeGreaterThanOrEqual(TICKS / 10);
    expect(german.hashChain.slice(0, n).map(([t, h]) => `${t} ${hashHex(h)}`))
      .toEqual(soviet.hashChain.slice(0, n).map(([t, h]) => `${t} ${hashHex(h)}`));
    // stalls stay inside the delay budget: the link's worst one-way latency
    for (const s of [german, soviet]) expect(s.stats.maxStallMs).toBeLessThanOrEqual(300);
    if (process.env.LOCKSTEP_STATS) console.log(JSON.stringify({ turns: [german.turn, soviet.turn], ticks: [tick(german), tick(soviet)], hashes: n, stats: [german.stats, soviet.stats] }));
  }, 600_000);

  it('the same commands land on the same ticks on both peers', () => {
    const p = pair({ seed: 99 });
    const { german, soviet } = p.peers;
    drive(p, () => german.turn >= 900 && soviet.turn >= 900, 10 * 60_000);
    // every command applied by the tick both peers reached is identical, tick and sequence included
    const strip = (s: LockstepSession) => s.battle.commandLog().filter((c) => c.tick < Math.min(tick(german), tick(soviet)));
    expect(JSON.stringify(strip(german))).toBe(JSON.stringify(strip(soviet)));
    expect(german.battle.commandLog().length).toBeGreaterThan(5);
  }, 120_000);

  it('a lossy link recovers through acks and resends', () => {
    const p = pair({ seed: 5, dropChance: 0.05 }, 250);
    const { german, soviet } = p.peers;
    drive(p, () => german.turn >= 600 && soviet.turn >= 600, 10 * 60_000);
    expect(german.turn).toBeGreaterThanOrEqual(600);
    expect(german.desync).toBeNull();
    expect(german.stats.bundlesResent + soviet.stats.bundlesResent).toBeGreaterThan(0);
    const n = Math.min(german.hashChain.length, soviet.hashChain.length);
    expect(german.hashChain.slice(0, n)).toEqual(soviet.hashChain.slice(0, n));
  }, 120_000);

  it('src/net stays headless (no DOM)', () => {
    const dir = resolve(__dirname, '../src/net');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\b(document|window|HTMLElement|requestAnimationFrame|@\/(ui|render))\b/);
    }
  });
});

/** Chains agree on every turn both peers reached since `fromTurn`. */
function chainsAgreeFrom(p: Pair, fromTurn: number): number {
  const a = p.peers.german.hashChain.filter(([t]) => t >= fromTurn);
  const b = p.peers.soviet.hashChain.filter(([t]) => t >= fromTurn);
  const n = Math.min(a.length, b.length);
  expect(a.slice(0, n)).toEqual(b.slice(0, n));
  return n;
}

/** Plays until both peers have recovered from `resyncs` resyncs and then run `more` turns. */
function recoverAndPlay(p: Pair, resyncs: number, more: number, perFrame?: (p: Pair) => void): void {
  const { german, soviet } = p.peers;
  let resumedTurn = Infinity;
  drive(p, () => {
    if (german.stats.resyncs >= resyncs && soviet.stats.resyncs >= resyncs && resumedTurn === Infinity) {
      resumedTurn = Math.max(german.turn, soviet.turn);
    }
    return german.turn >= resumedTurn + more && soviet.turn >= resumedTurn + more;
  }, 20 * 60_000, perFrame);
}

describe('desync recovery (047)', () => {
  function expectRecovered(p: Pair, resyncs = 1): void {
    for (const s of [p.peers.german, p.peers.soviet]) {
      expect(s.status).toBe('playing');
      expect(s.desync).toBeNull();
      expect(s.stats.resyncs).toBe(resyncs);
      const r = s.reports[resyncs - 1];
      expect(r.recovered).toBe(true);
      expect(r.authorityLog?.length).toBeGreaterThan(0);
      expect(r.localLog.length).toBeGreaterThan(0);
    }
    // both resumed at the authority's turn and tick, and agree on everything since
    expect(p.peers.german.reports[resyncs - 1].resumedAt).toEqual(p.peers.soviet.reports[resyncs - 1].resumedAt);
    const from = p.peers.german.reports[resyncs - 1].resumedAt!.turn;
    expect(chainsAgreeFrom(p, from)).toBeGreaterThan(10);
    // (the peers may stand a few turns apart right now, so compare live states only at equal turns)
    if (p.peers.german.turn === p.peers.soviet.turn) expect(hashState(p.peers.german.battle)).toBe(hashState(p.peers.soviet.battle));
  }

  it.each(['soviet', 'german'] as Side[])('a soldier nudged on the %s machine: both rebuild from the host\'s log and play on in sync', (victim) => {
    const p = pair({ seed: 77 });
    let corrupted = false;
    recoverAndPlay(p, 1, 300, () => {
      const s = p.peers[victim];
      if (!corrupted && s.battle.state.phase === 'running' && tick(s) >= 150) {
        const man = s.battle.state.soldiers.values().next().value!;
        man.pos = { x: man.pos.x + 1e-3, y: man.pos.y }; // a millimetre
        corrupted = true;
      }
    });
    expect(corrupted).toBe(true);
    expectRecovered(p);
    // detected at the first hash exchange after the corruption
    const r = p.peers.german.reports[0];
    expect(r.localHash).not.toBe(r.remoteHash);
  }, 300_000);

  it('a skipped RNG draw on one machine is repaired', () => {
    const p = pair({ seed: 31 });
    let done = false;
    recoverAndPlay(p, 1, 300, () => {
      const s = p.peers.soviet;
      if (!done && s.battle.state.phase === 'running' && tick(s) >= 200) { s.battle.rng.next(); done = true; }
    });
    expectRecovered(p);
  }, 300_000);

  it('a command lost on the way (a bug, not a lossy link) is repaired from the host\'s log', () => {
    let dropped = 0;
    const p = pair({ seed: 12 }, undefined, {
      // the German orders never reach the Soviet machine intact: the first one is stripped
      german: (t) => tamper(t, (m) => {
        if (m.kind === 'bundle' && dropped === 0 && m.commands.some((c) => c.type === 'order')) {
          dropped++;
          return { ...m, commands: m.commands.filter((c) => c.type !== 'order') };
        }
        return m;
      }),
    });
    recoverAndPlay(p, 1, 300);
    expect(dropped).toBe(1);
    expectRecovered(p);
    // the host's history wins: the order the Soviet machine never saw is in both logs now
    expect(p.peers.soviet.battle.commandLog().filter((c) => c.side === 'german' && c.type === 'order').length)
      .toBe(p.peers.german.battle.commandLog().filter((c) => c.side === 'german' && c.type === 'order').length);
  }, 300_000);

  it('two commands delivered in the wrong order are repaired', () => {
    let swapped = 0;
    const p = pair({ seed: 13 }, undefined, {
      german: (t) => tamper(t, (m) => {
        if (m.kind === 'bundle' && swapped === 0 && m.commands.length >= 2) {
          swapped++;
          return { ...m, commands: [...m.commands].reverse() };
        }
        return m;
      }),
    });
    // the German player gives two orders in the same turn, once the battle runs
    let given = false;
    recoverAndPlay(p, 1, 300, () => {
      const g = p.peers.german;
      if (!given && g.battle.state.phase === 'running' && g.turn >= 120) {
        const [a, b] = g.battle.selectableTeams('german');
        g.issue({ type: 'order', teamId: a.id, order: { type: 'moveFast', target: { x: a.pos.x + 8, y: a.pos.y - 8 }, issuedAt: 0 } });
        g.issue({ type: 'order', teamId: b.id, order: { type: 'sneak', target: { x: b.pos.x - 8, y: b.pos.y - 8 }, issuedAt: 0 } });
        given = true;
      }
    });
    expect(swapped).toBe(1);
    expectRecovered(p);
  }, 300_000);

  it('recovers over a lossy, reordering link (the resync messages are repeated until answered)', () => {
    const p = pair({ seed: 44, dropChance: 0.08 }, 200);
    let corrupted = false;
    recoverAndPlay(p, 1, 300, () => {
      const s = p.peers.soviet;
      if (!corrupted && s.battle.state.phase === 'running' && tick(s) >= 150) {
        s.battle.state.soldiers.values().next().value!.ammo += 1;
        corrupted = true;
      }
    });
    expectRecovered(p);
  }, 300_000);

  it('recovers again after a second, later desync', () => {
    const p = pair({ seed: 78 });
    let hits = 0;
    recoverAndPlay(p, 2, 200, () => {
      const s = p.peers.soviet;
      if (s.battle.state.phase !== 'running') return;
      if ((hits === 0 && tick(s) >= 150) || (hits === 1 && p.peers.german.stats.resyncs === 1 && tick(s) >= 600)) {
        s.battle.state.soldiers.values().next().value!.morale -= 1;
        hits++;
      }
    });
    expect(hits).toBe(2);
    expectRecovered(p, 2);
  }, 300_000);

  it('gives up cleanly (status failed, no exception) when rebuilds keep disagreeing', () => {
    // the Soviet machine's rebuilt hash is always reported wrong: real nondeterminism, as seen from the host
    const p = pair({ seed: 9 }, 200, {
      soviet: (t) => tamper(t, (m) => (m.kind === 'resynced' ? { ...m, hash: (m.hash + 1) >>> 0 } : m)),
    });
    let corrupted = false;
    drive(p, () => p.peers.german.status === 'failed' && p.peers.soviet.status === 'failed', 10 * 60_000, () => {
      const s = p.peers.soviet;
      if (!corrupted && s.battle.state.phase === 'running' && tick(s) >= 150) {
        s.battle.state.soldiers.values().next().value!.ammo += 1;
        corrupted = true;
      }
    });
    for (const s of [p.peers.german, p.peers.soviet]) {
      expect(s.status).toBe('failed');
      expect(s.done).toBe(true);
    }
    // the host tried three rebuilds before giving up (the Soviet side saw its own as matching)
    expect(p.peers.german.desync!.attempts).toBe(3);
    expect(() => p.peers.german.update(p.clock.now + 1000)).not.toThrow();
  }, 300_000);

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('stress seed %i: lossy link, a random corruption on a random side, always back in sync', (seed) => {
    const rng = new Rng(seed * 7919);
    const p = pair({ seed: 500 + seed, dropChance: 0.05, reorderChance: 0.3 }, 200);
    const victim: Side = rng.chance(0.5) ? 'german' : 'soviet';
    const atTick = 60 + rng.int(0, 400);
    const kind = rng.int(0, 3);
    let corrupted = false;
    recoverAndPlay(p, 1, 200, () => {
      const s = p.peers[victim];
      if (corrupted || s.battle.state.phase !== 'running' || tick(s) < atTick) return;
      const men = [...s.battle.state.soldiers.values()];
      const man = men[rng.int(0, men.length - 1)];
      if (kind === 0) man.pos = { x: man.pos.x + 1e-6, y: man.pos.y };
      else if (kind === 1) s.battle.rng.next();
      else if (kind === 2) man.ammo += 1;
      else man.morale -= 0.5;
      corrupted = true;
    });
    expect(corrupted).toBe(true);
    expectRecovered(p);
  }, 300_000);

  it('garbage on the wire never throws', () => {
    const p = pair({ seed: 3 });
    const g = p.peers.german;
    const handler = (g as unknown as { transport: { handler: (m: unknown) => void } }).transport;
    void handler;
    const raw: ((m: unknown) => void)[] = [];
    const fake: Transport = { send: () => {}, onMessage: (h) => raw.push(h as (m: unknown) => void) };
    const s = new LockstepSession({ battle: new Battle(config()), side: 'german', transport: fake });
    for (const m of [null, undefined, 42, {}, { side: 'soviet' }, { kind: 'bundle', side: 'soviet' }, { kind: 'resync', side: 'soviet', epoch: 1 }, { kind: 'resynced', side: 'soviet', epoch: 0, hash: 1 }]) {
      expect(() => raw[0](m)).not.toThrow();
    }
    expect(() => s.update(0)).not.toThrow();
    expect(() => s.update(1000)).not.toThrow();
  });
});

describe('M1 review fixes (046)', () => {
  it('the input delay holds its milliseconds at 4x: stalls stay inside the link latency', () => {
    const p = pair({ seed: 21 });
    const { german, soviet } = p.peers;
    let fast = false;
    drive(p, () => german.turn >= 2400 && soviet.turn >= 2400, 20 * 60_000, () => {
      if (!fast && german.battle.state.phase === 'running') { german.issue({ type: 'setSpeed', speed: 4 }); fast = true; }
    });
    expect(german.battle.state.speed).toBe(4);
    expect(german.delayTurns()).toBe(12);
    for (const s of [german, soviet]) expect(s.stats.maxStallMs).toBeLessThanOrEqual(300);
    expect(german.desync).toBeNull();
  }, 300_000);

  it('the final state is compared when the battle ends between hash turns', () => {
    const p = pair({ seed: 8 }, undefined, undefined);
    const { german, soviet } = p.peers;
    let fled = false;
    drive(p, () => german.done && soviet.done, 10 * 60_000, () => {
      if (!fled && german.battle.state.phase === 'running' && german.turn >= 333) { german.issue({ type: 'flee' }); fled = true; }
    });
    for (const s of [german, soviet]) {
      expect(s.battle.state.phase).toBe('ended');
      const [lastTurn] = s.hashChain[s.hashChain.length - 1];
      expect(lastTurn % s.hashInterval).not.toBe(0);
      expect(lastTurn).toBe(s.turn);
    }
    expect(german.hashChain[german.hashChain.length - 1]).toEqual(soviet.hashChain[soviet.hashChain.length - 1]);
  }, 300_000);

  it('a lost hash message is made good by the hash repeated on the bundles', () => {
    let lost = 0;
    const p = pair({ seed: 17 }, undefined, {
      soviet: (t) => tamper(t, (m) => (m.kind === 'hash' && lost++ < 5 ? null : m)),
    });
    let corrupted = false;
    recoverAndPlay(p, 1, 200, () => {
      const s = p.peers.soviet;
      if (!corrupted && s.battle.state.phase === 'running' && tick(s) >= 30) {
        s.battle.state.soldiers.values().next().value!.ammo += 1;
        corrupted = true;
      }
    });
    expect(lost).toBeGreaterThanOrEqual(5);
    // the German side still saw the mismatch through the bundles and the game recovered
    expect(p.peers.german.reports.length).toBe(1);
    expect(p.peers.german.status).toBe('playing');
  }, 300_000);
});
