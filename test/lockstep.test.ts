import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Battle } from '@/sim/battle';
import { hashHex, hashState } from '@/sim/stateHash';
import { LockstepSession } from '@/net/lockstep';
import { VirtualClock, memoryLink, type LinkOptions } from '@/net/memoryTransport';
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

function pair(link: Partial<LinkOptions> = {}, resendMs?: number): Pair {
  const clock = new VirtualClock();
  const [ta, tb] = memoryLink(clock, { seed: 1234, ...link });
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

  it('a corrupted state is caught as a desync with both hashes and both command logs', () => {
    const p = pair({ seed: 77 });
    const { german, soviet } = p.peers;
    let corruptedAt = -1;
    drive(p, () => german.desync?.remoteLog != null && soviet.desync?.remoteLog != null, 5 * 60_000, () => {
      // one soldier on the Soviet machine moves by a hair once the battle is running
      if (corruptedAt < 0 && soviet.battle.state.phase === 'running' && tick(soviet) >= 150) {
        const man = soviet.battle.state.soldiers.values().next().value!;
        man.pos = { x: man.pos.x + 1e-9, y: man.pos.y };
        corruptedAt = soviet.turn;
      }
    });
    expect(corruptedAt).toBeGreaterThan(0);
    for (const s of [german, soviet]) {
      const d = s.desync!;
      expect(d).not.toBeNull();
      // caught at the first hash exchange after the corruption
      expect(d.turn).toBeGreaterThan(corruptedAt);
      expect(d.turn).toBeLessThanOrEqual(corruptedAt + s.hashInterval);
      expect(d.localHash).not.toBe(d.remoteHash);
      expect(d.localLog.length).toBeGreaterThan(0);
      expect(d.remoteLog!.length).toBeGreaterThan(0);
    }
    expect(german.desync!.turn).toBe(soviet.desync!.turn);
    expect(german.desync!.localHash).toBe(soviet.desync!.remoteHash);
    // the session froze: no turn runs after the desync
    const frozen = german.turn;
    german.update(p.clock.now + 5000);
    expect(german.turn).toBe(frozen);
  }, 120_000);

  it('src/net stays headless (no DOM)', () => {
    const dir = resolve(__dirname, '../src/net');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\b(document|window|HTMLElement|requestAnimationFrame|@\/(ui|render))\b/);
    }
  });
});
