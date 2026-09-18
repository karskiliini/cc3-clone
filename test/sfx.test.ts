import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { BattleEvent, Camera } from '@/shared/types';
import { Sfx } from '@/audio/sfx';

// ---------------------------------------------------------------------------
// Minimal fake Web Audio backend. jsdom/node has no AudioContext at all, so
// this stands in for the browser: every node is a chainable no-op, just
// enough surface for synth.ts's noiseBurst/tone/engine/ambient helpers to run
// without throwing. This lets the test drive the REAL Sfx class end to end
// (unlock -> handleEvents/updateVehicles/ambient -> real synth.ts calls)
// instead of re-implementing the event->sound mapping in a parallel pure
// function, so a future refactor that silences handleEvents actually trips
// this test.
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  linearRamps: { value: number; when: number }[] = [];
  setValueAtTime() { return this; }
  linearRampToValueAtTime(value: number, when: number) { this.linearRamps.push({ value, when }); return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
}

class FakeNode {
  connect() { return this; }
  disconnect() { return this; }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  start() {}
  stop() {}
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  starts: number[] = [];
  start(when: number) { this.starts.push(when); }
  stop() {}
}

class FakePanner extends FakeNode {
  pan = new FakeParam();
}

class FakeDelay extends FakeNode {
  delayTime = new FakeParam();
}

class FakeAudioContext {
  static latest: FakeAudioContext;
  constructor() { FakeAudioContext.latest = this; }
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeBufferSource[] = [];
  panners: FakePanner[] = [];
  createGain() { const gain = new FakeGain(); this.gains.push(gain); return gain; }
  createBiquadFilter() { return new FakeBiquad(); }
  createOscillator() { return new FakeOsc(); }
  createBufferSource() { const source = new FakeBufferSource(); this.sources.push(source); return source; }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createStereoPanner() { const panner = new FakePanner(); this.panners.push(panner); return panner; }
  createDelay() { return new FakeDelay(); }
  async resume() { this.state = 'running'; }
}

function makeCam(): Camera {
  return { x: 10, y: 10, zoom: 1 } as Camera;
}

function shot(x: number, weaponId: string): BattleEvent {
  return { kind: 'shot', pos: { x, y: 10 }, weaponId, side: 'german' };
}

describe('Sfx.handleEvents — battle events actually request sounds', () => {
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    (globalThis as any).window = { AudioContext: FakeAudioContext };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  function makeUnlockedSfx(): Sfx {
    const sfx = new Sfx();
    sfx.unlock();
    return sfx;
  }

  it('unlock() creates a running AudioContext', () => {
    const sfx = makeUnlockedSfx();
    expect(sfx.debugState().ctxState).toBe('running');
  });

  it('maps shot/explosion/hit/vlCaptured/vehicleKO events to sounds', () => {
    const sfx = makeUnlockedSfx();
    const cam = makeCam();
    const events: BattleEvent[] = [
      shot(10, 'kar98k'),
      shot(10, 'mp40'),
      shot(10, 'mg34'),
      { kind: 'explosion', pos: { x: 10, y: 10 }, side: 'german' },
      { kind: 'hit', pos: { x: 10, y: 10 }, side: 'german' },
      { kind: 'vlCaptured', pos: { x: 10, y: 10 }, side: 'german' },
      { kind: 'vehicleKO', pos: { x: 10, y: 10 }, side: 'german' },
    ];
    sfx.handleEvents(events, cam);
    const { counts } = sfx.debugState();
    expect(counts.rifle ?? 0).toBeGreaterThan(0);
    expect(counts.smg ?? 0).toBeGreaterThan(0);
    expect(counts.lmg ?? 0).toBeGreaterThan(0);
    // one explosion + one vehicleKO -> both map to 'explosion'
    expect(counts.explosion ?? 0).toBe(2);
    expect(counts.ricochet ?? 0).toBe(1);
    expect(counts.flagCapture ?? 0).toBe(1);
  });

  it('synthesizes one crack per timed SMG round with its distance gain and stereo position', () => {
    const sfx = makeUnlockedSfx();
    const audio = FakeAudioContext.latest;
    audio.currentTime = 7;
    const cam = { x: 0, y: 0, zoom: 1 } as Camera; // viewport centre = (40,24)
    sfx.handleEvents([
      { kind: 'shot', weaponId: 'mp40', singleRound: true, pos: { x: 40, y: 24 } },
      { kind: 'shot', weaponId: 'ppsh41', singleRound: true, pos: { x: 60, y: 24 } },
      { kind: 'shot', weaponId: 'mp40', singleRound: true },
    ], cam);
    expect(audio.sources).toHaveLength(3);
    expect(audio.sources.map((source) => source.starts)).toEqual([[7], [7], [7]]);
    // Master gain is the first node; each crack adds exactly one envelope.
    expect(audio.gains.slice(1).map((gain) => gain.gain.linearRamps[0].value)).toEqual([0.85, 0.85 * 0.81, 0.85]);
    expect(audio.panners.map((panner) => panner.pan.value)).toEqual([0, 0.5]);
    expect(sfx.debugState().counts.smg).toBe(3);
  });

  it('keeps the legacy SMG preview as a short burst', () => {
    const sfx = makeUnlockedSfx();
    const audio = FakeAudioContext.latest;
    sfx.play('smg');
    expect(audio.sources.length).toBeGreaterThanOrEqual(3);
    expect(audio.sources.length).toBeLessThanOrEqual(4);
    expect(audio.sources[0].starts).toEqual([audio.currentTime]);
    expect(audio.sources[1].starts[0]).toBeGreaterThan(audio.currentTime);
  });

  it('un-silences kill (scream) and teamBroken — round-5 fix #3', () => {
    const sfx = makeUnlockedSfx();
    const cam = makeCam();
    sfx.handleEvents(
      [
        { kind: 'kill', pos: { x: 10, y: 10 }, side: 'german' },
        { kind: 'teamBroken', teamId: 1, side: 'soviet' },
      ],
      cam,
    );
    const { counts } = sfx.debugState();
    expect(counts.scream ?? 0).toBe(1);
    expect(counts.teamBroken ?? 0).toBe(1);
  });

  it('rate-limits screams so a mass-casualty frame is not a scream chorus', () => {
    const sfx = makeUnlockedSfx();
    const cam = makeCam();
    const kills: BattleEvent[] = Array.from({ length: 10 }, () => ({
      kind: 'kill',
      pos: { x: 10, y: 10 },
      side: 'german',
    }));
    sfx.handleEvents(kills, cam);
    expect(sfx.debugState().counts.scream ?? 0).toBe(1);
  });

  it('drops all sound when volume is 0 (options volume must be truly silent)', () => {
    const sfx = makeUnlockedSfx();
    sfx.setVolume(0);
    sfx.handleEvents([shot(10, 'kar98k')], makeCam());
    // handleEvents still "requests" the sound (counts increment — it reached
    // synthesis) but the master bus gain is 0, so nothing is audible; assert
    // the volume plumbing itself rather than trying to measure silence.
    expect(sfx.debugState().masterVolume).toBe(0);
  });

  it('plays nothing while paused, and resumes after unpause', () => {
    const sfx = makeUnlockedSfx();
    sfx.setPaused(true);
    sfx.handleEvents([shot(10, 'kar98k'), { kind: 'kill', pos: { x: 10, y: 10 } }], makeCam());
    expect(sfx.debugState().counts.rifle ?? 0).toBe(0);
    expect(sfx.debugState().counts.scream ?? 0).toBe(0);

    sfx.setPaused(false);
    sfx.handleEvents([shot(10, 'kar98k')], makeCam());
    expect(sfx.debugState().counts.rifle ?? 0).toBe(1);
  });

  it('updateVehicles starts/stops engine voices for moving vehicles, capped at 6', () => {
    const sfx = makeUnlockedSfx();
    const cam = makeCam();
    const moving = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      pos: { x: 10 + i, y: 10 },
      speedFactor: 0.5,
      active: true,
    }));
    sfx.updateVehicles(moving, cam);
    expect(sfx.debugState().engineCount).toBe(6);

    // Stopping (speedFactor 0) or knocking out a vehicle removes its voice.
    const stopped = moving.map((v, i) => ({ ...v, speedFactor: i === 0 ? 0 : v.speedFactor }));
    sfx.updateVehicles(stopped, cam);
    expect(sfx.debugState().engineCount).toBe(5);
  });

  it('ambient() only starts once battle audio is unlocked and ready', () => {
    const sfx = new Sfx(); // never unlocked
    sfx.ambient(true);
    expect(sfx.debugState().ambientOn).toBe(true);
    // no ctx -> no voice actually created, but no throw either
    const sfx2 = makeUnlockedSfx();
    sfx2.ambient(true);
    expect(sfx2.debugState().ambientOn).toBe(true);
  });

  it('stopAll() tears down ambient and every engine voice', () => {
    const sfx = makeUnlockedSfx();
    const cam = makeCam();
    sfx.ambient(true);
    sfx.updateVehicles([{ id: 1, pos: { x: 10, y: 10 }, speedFactor: 0.5, active: true }], cam);
    expect(sfx.debugState().engineCount).toBe(1);
    sfx.stopAll();
    expect(sfx.debugState().engineCount).toBe(0);
    expect(sfx.debugState().ambientOn).toBe(false);
  });
});
