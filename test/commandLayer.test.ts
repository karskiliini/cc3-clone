import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Battle } from '@/sim/battle';
import { compareCommands, resolveControllers, type Command } from '@/sim/commands';
import { messagesFor } from '@/sim/messages';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, BattleResult, Order } from '@/shared/types';
import { SIM_DT } from '@/shared/types';

/** Item 042: the command layer and per-side perspective (multiplayer plan §7 P1-P2). */

function config(extra: Partial<BattleConfig> = {}): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 1200,
    difficulty: 'normal', forces: DEFAULT_FORCES[1941], ...extra,
  };
}

const MIRROR: Record<BattleResult, BattleResult> = {
  totalVictory: 'totalDefeat', decisiveVictory: 'decisiveDefeat', majorVictory: 'majorDefeat',
  minorVictory: 'minorDefeat', draw: 'draw', minorDefeat: 'minorVictory', majorDefeat: 'majorVictory',
  decisiveDefeat: 'decisiveVictory', totalDefeat: 'totalVictory',
};

describe('controllers', () => {
  it('default from the viewer side, the harness flag, or an explicit map', () => {
    expect(resolveControllers(config())).toEqual({ german: 'human', soviet: 'ai' });
    expect(resolveControllers(config({ playerSide: 'soviet' }))).toEqual({ german: 'ai', soviet: 'human' });
    expect(resolveControllers(config({ aiBothSides: true }))).toEqual({ german: 'ai', soviet: 'ai' });
    const both = { german: 'human', soviet: 'human' } as const;
    expect(resolveControllers(config({ controllers: both }))).toEqual(both);
  });
});

describe('command queue', () => {
  it('applies commands at the next tick boundary in canonical order and keeps the log', () => {
    const b = new Battle(config());
    b.start();
    const g = b.selectableTeams('german')[0];
    const order: Order = { type: 'move', target: { x: g.pos.x + 5, y: g.pos.y }, issuedAt: 0 };
    b.submit('soviet', { type: 'setSpeed', speed: 2 });
    b.submit('german', { type: 'order', teamId: g.id, order });
    expect(g.order?.type).not.toBe('move'); // queued, not applied
    b.step(SIM_DT / 2);
    expect(g.order?.type).not.toBe('move'); // no tick yet
    b.step(SIM_DT / 2);
    expect(g.order?.type).toBe('move');
    expect(b.state.speed).toBe(2);
    const log = b.commandLog();
    expect(log.map((c) => c.type)).toEqual(['order', 'setSpeed']); // german before soviet in a tick
    expect(log.every((c) => c.tick === 0)).toBe(true);
  });

  it('holds a command stamped for a later tick until that tick', () => {
    const b = new Battle(config());
    b.start();
    b.submit('german', { type: 'setSpeed', speed: 4 }, 3);
    b.step(SIM_DT * 3);
    expect(b.state.speed).toBe(1);
    b.step(SIM_DT);
    expect(b.state.speed).toBe(4);
  });

  it('sorts by tick, then side, then submission order', () => {
    const c = (tick: number, side: 'german' | 'soviet', seq: number) => ({ type: 'pause', tick, side, seq }) as Command;
    const list = [c(2, 'german', 0), c(1, 'soviet', 1), c(1, 'german', 3), c(1, 'german', 2)];
    expect(list.sort(compareCommands).map((x) => x.seq)).toEqual([2, 3, 1, 0]);
  });

  it('rejects orders and deploy moves for the other side\'s teams', () => {
    const b = new Battle(config({ controllers: { german: 'human', soviet: 'human' } }));
    const s = b.selectableTeams('soviet')[0];
    const before = { ...s.pos };
    const standing = s.order;
    b.submit('german', { type: 'deployTeam', teamId: s.id, pos: { x: before.x + 1, y: before.y } });
    b.submit('german', { type: 'order', teamId: s.id, order: { type: 'move', target: { x: 1, y: 1 }, issuedAt: 0 } });
    b.step(0);
    expect(s.pos).toEqual(before);
    expect(s.order).toBe(standing);
  });

  it('pauses, resumes and flees through commands', () => {
    const b = new Battle(config());
    b.start();
    b.submit('german', { type: 'pause' });
    b.step(SIM_DT);
    expect(b.state.phase).toBe('paused');
    const t = b.state.time;
    b.step(1);
    expect(b.state.time).toBe(t);
    b.submit('german', { type: 'resume' });
    b.step(0); // applied while paused, without a tick
    expect(b.state.phase).toBe('running');
    b.submit('soviet', { type: 'flee' });
    b.step(SIM_DT);
    expect(b.state.phase).toBe('ended');
    expect(b.state.results).toEqual({ german: 'totalVictory', soviet: 'totalDefeat' });
    expect(b.state.result).toBe('totalVictory'); // the viewer's (german) perspective
  });
});

describe('two human sides', () => {
  it('deploy until both are ready, and no AI order is ever issued', () => {
    const b = new Battle(config({ controllers: { german: 'human', soviet: 'human' } }));
    // every team keeps the standing order it spawned with: no aiDeploy, no stepAI orders
    const spawned = new Map([...b.state.teams.values()].map((t) => [t.id, t.order]));
    b.submit('german', { type: 'ready' });
    b.step(SIM_DT);
    expect(b.state.phase).toBe('deploy');
    b.submit('soviet', { type: 'ready' });
    b.step(SIM_DT);
    expect(b.state.phase).toBe('running');
    for (let i = 0; i < 1200; i++) b.step(SIM_DT); // two minutes
    for (const t of b.state.teams.values()) expect(t.order).toBe(spawned.get(t.id));
  });

  it('a truce needs both sides to press TRUCE', () => {
    const b = new Battle(config({ controllers: { german: 'human', soviet: 'human' } }));
    b.submit('german', { type: 'ready' });
    b.submit('soviet', { type: 'ready' });
    b.step(SIM_DT);
    b.submit('german', { type: 'truce' });
    for (let i = 0; i < 100; i++) b.step(SIM_DT);
    expect(b.state.phase).toBe('running');
    expect(messagesFor(b.state, 'soviet').some((m) => /requests a truce/.test(m.text))).toBe(true);
    b.submit('soviet', { type: 'truce' });
    b.step(SIM_DT);
    b.step(SIM_DT);
    expect(b.state.phase).toBe('ended');
  });
});

describe('per-side perspective', () => {
  it('each side\'s log holds only its own reports, and the results mirror each other', () => {
    const b = new Battle(config({ aiBothSides: true, seed: 3 }));
    b.start();
    for (let i = 0; i < 6000 && b.state.phase === 'running'; i++) b.step(SIM_DT);
    const nameSides = new Map<string, Set<string>>();
    for (const t of b.state.teams.values()) {
      if (!nameSides.has(t.name)) nameSides.set(t.name, new Set());
      nameSides.get(t.name)!.add(t.side);
    }
    let ownReports = 0;
    for (const side of ['german', 'soviet'] as const) {
      const log = messagesFor(b.state, side);
      expect(log.length).toBeGreaterThan(0);
      for (const m of log) {
        expect(m.side === undefined || m.side === side).toBe(true);
        const sides = nameSides.get(m.text.split(/\n|:/)[0]);
        // a report headed by a team name that only one side has belongs to that side's log
        // (enemy teams are reported as "Enemy", never by name)
        if (m.side && sides && sides.size === 1) {
          expect([...sides][0]).toBe(side);
          ownReports++;
        }
      }
    }
    expect(ownReports).toBeGreaterThan(0);
    if (b.state.phase !== 'ended') { b.submit('german', { type: 'flee' }); b.step(SIM_DT); }
    const r = b.state.results!;
    expect(r.soviet).toBe(MIRROR[r.german]);
  });
});

describe('UI and render never mutate the sim directly', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  it('no issueOrder, deployTeam, flee, truce, aiDeploy or addMessage calls under src/ui or src/render', () => {
    const banned = /\.issueOrder\(|\.deployTeam\(|[^\w.]flee\(|\.pressTruce\(|\.offerTruce\(|\.acceptTruce\(|aiDeploy\(|addMessage\(/;
    const offenders = [...files('src/ui'), ...files('src/render')]
      .filter((f) => readFileSync(f, 'utf8').split('\n').some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && banned.test(line)));
    expect(offenders).toEqual([]);
  });
});
