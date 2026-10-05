import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Battle } from '@/sim/battle';
import { hashHex, hashState } from '@/sim/stateHash';
import { makeReplayLog, runReplay, runTicks, type ReplayLog } from '@/sim/replay';
import { leaveCrater } from '@/sim/combat';
import { getHeightField } from '@/sim/heightField';
import { elevationTextAt } from '@/ui/elevationReadout';
import { DepthOverlay } from '@/render/depthOverlay';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, Camera, Order, Vec2 } from '@/shared/types';
import { SIM_DT } from '@/shared/types';

/** Item 043: determinism fixes, state hash and replays (multiplayer plan §7 P3-P4). */

const ROOT = resolve(__dirname, '..');

function config(extra: Partial<BattleConfig> = {}): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 11, durationS: 1200,
    difficulty: 'normal', forces: DEFAULT_FORCES[1941], ...extra,
  };
}

const TICKS = 600; // one sim-minute

/**
 * A single-player battle driven like the UI drives it: deploy moves, Begin, then orders, a pause
 * with an order given while paused, a speed change and a fire order, all at scattered ticks and
 * stepped with uneven frame times (never more than one tick per frame, so every tick is hashed).
 */
function playScripted(): { battle: Battle; chain: number[] } {
  const b = new Battle(config());
  const own = b.selectableTeams('german');
  const zone = b.state.map.def.deployZones.german;
  // a deploy move: the first team to the far corner of the zone
  const spot = { x: zone.x + zone.w - 3.5, y: zone.y + zone.h - 3.5 };
  if (b.canDeployTeam(own[0].id, spot)) b.submit('german', { type: 'deployTeam', teamId: own[0].id, pos: spot });
  b.step(0);
  b.submit('german', { type: 'ready' });
  b.step(0);
  expect(b.state.phase).toBe('running');

  const enemyVL = b.state.map.victoryLocations[0];
  const order = (type: Order['type'], target: Vec2): Order => ({ type, target, issuedAt: b.state.time });
  const script: Record<number, () => void> = {
    20: () => b.submit('german', { type: 'order', teamId: own[1].id, order: order('move', { x: enemyVL.x, y: enemyVL.y }) }),
    21: () => b.submit('german', { type: 'order', teamId: own[2].id, order: order('moveFast', { x: own[2].pos.x + 8, y: own[2].pos.y - 6 }) }),
    95: () => b.submit('german', { type: 'order', teamId: own[3].id, order: order('sneak', { x: own[3].pos.x - 5, y: own[3].pos.y + 4 }) }),
    150: () => b.submit('german', { type: 'pause' }),
    260: () => b.submit('german', { type: 'setSpeed', speed: 2 }),
    310: () => b.submit('german', { type: 'order', teamId: own[0].id, order: order('fire', { x: enemyVL.x, y: enemyVL.y }) }),
    420: () => b.submit('german', { type: 'order', teamId: own[1].id, order: order('defend', { x: enemyVL.x, y: enemyVL.y + 3 }) }),
  };
  const chain: number[] = [];
  const frames = [0.07, 0.03, 0.1, 0.05, 0.09, 0.016];
  let f = 0, pausedFrames = 0;
  while ((b.state.tick ?? 0) < TICKS && b.state.phase !== 'ended') {
    const tick = b.state.tick ?? 0;
    if (b.state.phase === 'paused') {
      // the player looks around, gives an order while paused, then resumes
      pausedFrames++;
      if (pausedFrames === 5) b.submit('german', { type: 'order', teamId: own[4].id, order: order('ambush', { x: own[4].pos.x, y: own[4].pos.y - 10 }) });
      if (pausedFrames === 9) b.submit('german', { type: 'resume' });
    } else {
      script[tick]?.();
      delete script[tick];
    }
    b.step(frames[f++ % frames.length]);
    b.drainEvents();
    if ((b.state.tick ?? 0) > tick) chain.push(hashState(b));
  }
  return { battle: b, chain };
}

describe('Rng state (D7)', () => {
  it('state() / setState() resume the stream exactly', () => {
    const a = new Rng(42);
    for (let i = 0; i < 1000; i++) a.next();
    const s = a.state();
    const want = [a.next(), a.next(), a.gauss()];
    const b = new Rng(1);
    b.setState(s);
    expect([b.next(), b.next(), b.gauss()]).toEqual(want);
  });
});

describe('hashState', () => {
  it('is read-only and follows the RNG position and the state', () => {
    const b = new Battle(config({ aiBothSides: true }));
    b.submit('german', { type: 'ready' });
    b.step(SIM_DT);
    const h = hashState(b);
    expect(hashState(b)).toBe(h);
    b.rng.next();
    expect(hashState(b)).not.toBe(h);
    const s = b.state.soldiers.values().next().value!;
    const before = hashState(b);
    s.pos = { x: s.pos.x + 1e-12, y: s.pos.y }; // a last-bit difference shows at once
    expect(hashState(b)).not.toBe(before);
  });
});

describe('crater height-field sync (D1)', () => {
  it('a vehicle explosion crater is in the height field at once', () => {
    const b = new Battle(config());
    const map = b.state.map;
    const field = getHeightField(map);
    const v = [...b.state.vehicles.values()][0] ?? { pos: { x: map.width / 2, y: map.height / 2 } };
    leaveCrater(b.state, v.pos, WEAPONS[Object.keys(WEAPONS)[0]], 3.5);
    expect(map.craterMarks!.length).toBeGreaterThan(0);
    expect(field.marksApplied).toBe(map.craterMarks!.length);
  });

  describe('viewer-side readers leave the hash chain unchanged', () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, ImageData: g.ImageData };
    beforeAll(() => {
      // the depth overlay paints into a canvas: a stand-in is enough, the test is about the sim
      g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
      g.ImageData = class { constructor(public data: unknown, public width: number, public height: number) {} };
    });
    afterAll(() => { g.document = saved.document; g.ImageData = saved.ImageData; });

    function run(readers: boolean): number[] {
      const b = new Battle(config({ aiBothSides: true, seed: 5 }));
      b.submit('german', { type: 'autoDeploy' });
      b.submit('german', { type: 'ready' });
      const overlay = new DepthOverlay();
      const cam: Camera = { x: 0, y: 0, zoom: 1 } as Camera;
      const chain: number[] = [];
      const map = b.state.map;
      for (let t = 0; t < 300; t++) {
        // the same scripted blast in both runs: a hull-size bowl with no blast pass after it,
        // exactly what a vehicle explosion leaves (the case the renderer used to stamp early)
        if (t === 40) leaveCrater(b.state, { x: map.width / 2 + 0.3, y: map.height / 2 + 0.6 }, WEAPONS[Object.keys(WEAPONS)[0]], 4);
        b.step(SIM_DT);
        b.drainEvents();
        if (readers) {
          overlay.update(map, cam);
          elevationTextAt(map, { x: map.width / 2, y: map.height / 2 });
        }
        chain.push(hashState(b));
      }
      return chain;
    }

    it('running the depth overlay and the elevation readout every frame changes nothing', () => {
      const plain = run(false);
      const viewed = run(true);
      expect(viewed.length).toBe(plain.length);
      expect(viewed.map(hashHex)).toEqual(plain.map(hashHex));
    });
  });
});

describe('replay (P4)', () => {
  let played: { battle: Battle; chain: number[] };
  let log: ReplayLog;
  beforeAll(() => {
    played = playScripted();
    log = makeReplayLog(played.battle);
  });

  it('the scripted battle ran the minute and logged its commands', () => {
    expect(played.chain.length).toBe(TICKS);
    const types = log.commands.map((c) => c.type);
    for (const t of ['deployTeam', 'ready', 'order', 'pause', 'resume', 'setSpeed']) expect(types).toContain(t);
    expect(log.final).toEqual({ tick: TICKS, hash: played.chain[TICKS - 1] });
    // the log survives JSON (what Save replay writes)
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });

  it('replaying the log in this process gives the identical per-tick hash chain', () => {
    const { chain } = runReplay(JSON.parse(JSON.stringify(log)));
    expect(chain.map(hashHex)).toEqual(played.chain.map(hashHex));
  });

  it('replaying the log in a separate Node process gives the identical per-tick hash chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc3-replay-'));
    try {
      const logFile = join(dir, 'replay.json'), chainFile = join(dir, 'chain.txt');
      writeFileSync(logFile, JSON.stringify(log));
      const r = spawnSync('npx', ['vite-node', 'tools/replay.ts', logFile, '--out', chainFile, '--quiet'], {
        cwd: ROOT, encoding: 'utf8', timeout: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('matches the recorded final hash');
      const lines = readFileSync(chainFile, 'utf8').trim().split('\n');
      expect(lines).toEqual(played.chain.map((h, i) => `${i + 1} ${hashHex(h)}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it('a replay stops where the log does and can run on past it', () => {
    const { battle, chain } = runReplay(log, 100);
    expect(chain.length).toBe(100);
    expect(chain[99]).toBe(played.chain[99]);
    runTicks(battle, 110, chain);
    expect(chain.length).toBe(110);
  });
});

describe('replay of a battle ended by a command (043 review)', () => {
  function fled(): Battle {
    const b = new Battle(config({ seed: 3 }));
    b.submit('german', { type: 'ready' });
    b.step(0);
    for (let i = 0; i < 100; i++) b.step(SIM_DT);
    b.submit('german', { type: 'flee' });
    b.step(SIM_DT);
    expect(b.state.phase).toBe('ended');
    return b;
  }

  it('a battle that ended by a flee replays to the recorded final hash', () => {
    const log = makeReplayLog(fled());
    const run = runReplay(log);
    expect(run.battle.state.tick).toBe(log.final!.tick);
    expect(run.battle.pendingCount()).toBe(0);
    expect(hashState(run.battle)).toBe(log.final!.hash);
  });

  it('orders after the end are neither applied nor logged; setSpeed still is', () => {
    const b = fled();
    const n = b.commandLog().length, h = hashState(b);
    const team = b.selectableTeams('german')[0];
    b.submit('german', { type: 'order', teamId: team.id, order: { type: 'moveFast', target: { x: team.pos.x + 5, y: team.pos.y }, issuedAt: b.state.time } });
    b.submit('german', { type: 'flee' });
    b.step(SIM_DT);
    expect(b.commandLog().length).toBe(n);
    expect(hashState(b)).toBe(h);
    b.submit('german', { type: 'setSpeed', speed: 2 });
    b.step(SIM_DT);
    expect(b.commandLog().length).toBe(n + 1);
    const log = makeReplayLog(b);
    expect(hashState(runReplay(log).battle)).toBe(log.final!.hash);
  });

  it('tools/replay.ts accepts the fled battle (exit 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc3-flee-'));
    try {
      const file = join(dir, 'fled.json');
      writeFileSync(file, JSON.stringify(makeReplayLog(fled())));
      const r = spawnSync('npx', ['vite-node', 'tools/replay.ts', file, '--quiet'], { cwd: ROOT, encoding: 'utf8' });
      expect(r.stderr).toContain('matches the recorded final hash');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
