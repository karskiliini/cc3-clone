// ============================================================================
// src/audio/sfx.ts — Sfx: high-level sound-effect API built on synth.ts.
// Everything is synthesized; there are no audio files. Safe to call any
// method before unlock()/AudioContext exists — all become no-ops.
// ============================================================================

import type { BattleEvent, Camera } from '@/shared/types';
import { clamp } from '@/shared/math';
import {
  noiseBurst,
  tone,
  makeSlapEcho,
  startEngineVoice,
  startAmbientWind,
  type EngineVoice,
  type AmbientVoice,
} from './synth';

export type SfxKind =
  | 'rifle' | 'smg' | 'lmg' | 'hmg' | 'pistol'
  | 'mortarFire' | 'mortarHit' | 'tankGun' | 'atGun' | 'explosion' | 'grenade'
  | 'ricochet' | 'smokePop' | 'click' | 'message' | 'flagCapture' | 'scream';

/** Kinds that get priority when the polyphony cap is exceeded. */
const HIGH_PRIORITY: ReadonlySet<SfxKind> = new Set(['explosion', 'tankGun', 'atGun', 'mortarHit']);

const MAX_CONCURRENT_PER_WINDOW = 12;
const WINDOW_MS = 100;
const MAX_ENGINES = 6;
const MESSAGE_MIN_INTERVAL_S = 2;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterVolume = 0.7;

  private recentPlays: number[] = []; // performance.now() timestamps of one-shots in the current window

  private engines = new Map<number, EngineVoice>();
  private ambientVoice: AmbientVoice | null = null;
  private ambientOn = false;

  private lastMessageAt = -Infinity;

  /** Call on the first user gesture (click/keydown). Safe to call many times. */
  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        this.ctx = null;
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  private ready(): boolean {
    return this.ctx !== null && this.master !== null && this.ctx.state !== 'closed';
  }

  private admit(kind: SfxKind): boolean {
    const now = performance.now();
    this.recentPlays = this.recentPlays.filter((t) => now - t < WINDOW_MS);
    if (this.recentPlays.length < MAX_CONCURRENT_PER_WINDOW) {
      this.recentPlays.push(now);
      return true;
    }
    // Over cap: let high-priority sounds through anyway (drop others).
    if (HIGH_PRIORITY.has(kind)) {
      this.recentPlays.push(now);
      return true;
    }
    return false;
  }

  /** Play a one-shot sound. `gain` is relative to master (0..1-ish). */
  play(kind: SfxKind, gain = 1, pan?: number): void {
    if (!this.ready()) return;
    if (gain <= 0) return;
    if (!this.admit(kind)) return;

    const ctx = this.ctx!;
    const dest = this.master!;
    const when = ctx.currentTime;
    const g = clamp(gain, 0, 4);

    switch (kind) {
      case 'rifle': crack(ctx, dest, when, g, pan, 1); break;
      case 'smg': burstOfCracks(ctx, dest, when, g, pan, { count: 3 + Math.round(Math.random()), spacing: 0.07, bp: 1800 }); break;
      case 'lmg': burstOfCracks(ctx, dest, when, g, pan, { count: 5 + Math.floor(Math.random() * 3), spacing: 0.09, bp: 1300, thump: 90 }); break;
      case 'hmg': hmgBurst(ctx, dest, when, g, pan); break;
      case 'pistol': crack(ctx, dest, when, g, pan, 1.3); break;
      case 'mortarFire': mortarFire(ctx, dest, when, g, pan); break;
      case 'mortarHit': explosionSound(ctx, dest, when, g, pan, 0.8, false); break;
      case 'explosion': explosionSound(ctx, dest, when, g, pan, 1.1, true); break;
      case 'grenade': explosionSound(ctx, dest, when, g * 0.6, pan, 0.5, false); break;
      case 'tankGun': bigGun(ctx, dest, when, g, pan, 1.2); break;
      case 'atGun': bigGun(ctx, dest, when, g, pan, 0.7); break;
      case 'ricochet': ricochet(ctx, dest, when, g, pan); break;
      case 'smokePop': smokePop(ctx, dest, when, g, pan); break;
      case 'click': click(ctx, dest, when, g); break;
      case 'message': message(ctx, dest, when, g); break;
      case 'flagCapture': flagCapture(ctx, dest, when, g); break;
      case 'scream': scream(ctx, dest, when, g, pan); break;
    }
  }

  /** Per-vehicle looping engine sound. speedFactor 0..1, null stops/removes it. */
  engine(id: number, speedFactor: number | null): void {
    if (speedFactor === null) {
      const v = this.engines.get(id);
      if (v) {
        v.stop();
        this.engines.delete(id);
      }
      return;
    }
    if (!this.ready()) return;
    let v = this.engines.get(id);
    if (!v) {
      if (this.engines.size >= MAX_ENGINES) return; // cap concurrent engines
      v = startEngineVoice(this.ctx!, this.master!);
      this.engines.set(id, v);
    }
    v.setSpeed(speedFactor);
  }

  ambient(on: boolean): void {
    this.ambientOn = on;
    if (!on) {
      if (this.ambientVoice) {
        this.ambientVoice.stop();
        this.ambientVoice = null;
      }
      return;
    }
    if (!this.ready() || this.ambientVoice) return;
    this.ambientVoice = startAmbientWind(this.ctx!, this.master!);
  }

  /** Map battle events to sounds with distance attenuation from viewport centre. */
  handleEvents(events: BattleEvent[], cam: Camera): void {
    if (!this.ready() || events.length === 0) return;
    const centre = {
      x: cam.x + 40 / cam.zoom,
      y: cam.y + 24 / cam.zoom,
    };

    for (const ev of events) {
      switch (ev.kind) {
        case 'shot': {
          const kind = weaponSfxKind(ev.weaponId);
          this.emitAt(kind, ev.pos, centre);
          break;
        }
        case 'explosion': {
          this.emitAt('explosion', ev.pos, centre);
          break;
        }
        case 'hit': {
          this.emitAt('ricochet', ev.pos, centre);
          break;
        }
        case 'kill': {
          // Kept simple per spec: no automatic sound for kills.
          break;
        }
        case 'vlCaptured': {
          this.emitAt('flagCapture', ev.pos, centre, 0.5);
          break;
        }
        case 'vehicleKO': {
          this.emitAt('explosion', ev.pos, centre);
          break;
        }
        case 'message': {
          this.rateLimitedMessage();
          break;
        }
        case 'truce':
        case 'ended': {
          this.rateLimitedMessage();
          break;
        }
        case 'teamBroken':
          break;
      }
    }
  }

  private rateLimitedMessage(): void {
    const now = performance.now() / 1000;
    if (now - this.lastMessageAt < MESSAGE_MIN_INTERVAL_S) return;
    this.lastMessageAt = now;
    this.play('message', 0.5);
  }

  private emitAt(
    kind: SfxKind,
    pos: { x: number; y: number } | undefined,
    centre: { x: number; y: number },
    baseGain = 1,
  ): void {
    if (!pos) {
      this.play(kind, baseGain);
      return;
    }
    const dxTiles = pos.x - centre.x;
    const dyTiles = pos.y - centre.y;
    const distM = Math.hypot(dxTiles, dyTiles) * 2; // TILE_M = 2
    const atten = clamp(1 - distM / 400, 0.05, 1) ** 2;
    const pan = clamp(dxTiles / 40, -0.8, 0.8);
    this.play(kind, baseGain * atten, pan);
  }
}

// ---------------------------------------------------------------------------
// Weapon-id heuristics (WEAPONS lives in the parallel data module; we don't
// import it — infer sound class from the id string per the audio spec).
// ---------------------------------------------------------------------------
export function weaponSfxKind(weaponId: string | undefined): SfxKind {
  const id = (weaponId ?? '').toLowerCase();
  if (id.includes('hmg') || id.includes('maxim')) return 'hmg';
  if (id.includes('mg')) return 'lmg';
  if (id.includes('mp40') || id.includes('ppsh') || id.includes('smg')) return 'smg';
  if (id.includes('pistol')) return 'pistol';
  if (id.includes('mortar')) return 'mortarFire';
  if (
    id.includes('kwk') || id.includes('stuk') || id.includes('f34') ||
    id.includes('zis') || id.includes('d25') || id.includes('kv_') || id.includes('45mm')
  ) {
    return id.includes('pak') ? 'atGun' : 'tankGun';
  }
  if (id.includes('pak')) return 'atGun';
  if (id.includes('panzerfaust') || id.includes('panzerschreck') || id.includes('ptrd')) return 'atGun';
  if (id.includes('grenade') || id.includes('satchel')) return 'grenade';
  return 'rifle';
}

// ---------------------------------------------------------------------------
// Sound recipes
// ---------------------------------------------------------------------------

function crack(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined, pitchMul: number): void {
  const detune = 1 + (Math.random() * 2 - 1) * 0.08; // ±8%
  noiseBurst(ctx, dest, when, {
    duration: 0.04,
    gain: gain * 0.9,
    bandpassHz: 1200 * pitchMul * detune,
    bandpassQ: 1.5,
    lowpassFromHz: 4000,
    lowpassToHz: 600,
    attack: 0.001,
    decay: 0.25,
    pan,
  });
  tone(ctx, dest, when, { freq: 120 * pitchMul, duration: 0.02, gain: gain * 0.6, type: 'sine', pan });
}

function burstOfCracks(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  gain: number,
  pan: number | undefined,
  opts: { count: number; spacing: number; bp: number; thump?: number },
): void {
  for (let i = 0; i < opts.count; i++) {
    const t = when + i * opts.spacing * (0.85 + Math.random() * 0.3);
    const detune = 1 + (Math.random() * 2 - 1) * 0.08;
    noiseBurst(ctx, dest, t, {
      duration: 0.035,
      gain: gain * 0.85,
      bandpassHz: opts.bp * detune,
      bandpassQ: 1.6,
      lowpassFromHz: 4500,
      lowpassToHz: 700,
      decay: 0.2,
      pan,
    });
    if (opts.thump) {
      tone(ctx, dest, t, { freq: opts.thump, duration: 0.02, gain: gain * 0.5, pan });
    }
  }
}

function hmgBurst(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined): void {
  const count = 8;
  for (let i = 0; i < count; i++) {
    const t = when + i * 0.1 * (0.9 + Math.random() * 0.2);
    noiseBurst(ctx, dest, t, {
      duration: 0.04,
      gain: gain * 0.95,
      bandpassHz: 1000 * (1 + (Math.random() * 2 - 1) * 0.08),
      bandpassQ: 1.7,
      lowpassFromHz: 5000,
      lowpassToHz: 600,
      decay: 0.22,
      pan,
    });
    tone(ctx, dest, t, { freq: 100, duration: 0.02, gain: gain * 0.55, pan });
    // mechanical click layer
    noiseBurst(ctx, dest, t + 0.005, { duration: 0.01, gain: gain * 0.25, bandpassHz: 3000, bandpassQ: 3, decay: 0.03, pan });
  }
}

function mortarFire(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined): void {
  tone(ctx, dest, when, { freq: 180, freqTo: 90, duration: 0.12, gain: gain * 0.9, type: 'sine', pan });
  noiseBurst(ctx, dest, when, { duration: 0.08, gain: gain * 0.4, lowpassFromHz: 1200, lowpassToHz: 300, decay: 0.1, pan });
}

function explosionSound(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  gain: number,
  pan: number | undefined,
  scale: number,
  loud: boolean,
): void {
  const decay = 0.8 * scale;
  noiseBurst(ctx, dest, when, {
    duration: decay,
    gain: gain * (loud ? 1 : 0.85),
    lowpassFromHz: 1200,
    lowpassToHz: 300,
    attack: 0.002,
    decay,
    pan,
  });
  tone(ctx, dest, when, { freq: 50, duration: decay * 1.1, gain: gain * (loud ? 0.9 : 0.7), type: 'sine', pan });
  noiseBurst(ctx, dest, when + 0.005, {
    duration: 0.15,
    gain: gain * 0.6,
    bandpassHz: 900,
    bandpassQ: 1.2,
    decay: 0.15,
    pan,
  });
}

function bigGun(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined, boomScale: number): void {
  const echo = makeSlapEcho(ctx, dest, 0.08, 0.22);
  noiseBurst(ctx, echo, when, {
    duration: 0.05,
    gain: gain * 1.1,
    bandpassHz: 900,
    bandpassQ: 1.3,
    lowpassFromHz: 5000,
    lowpassToHz: 500,
    decay: 0.2,
    pan,
  });
  const boomDur = 1.2 * boomScale;
  tone(ctx, echo, when + 0.01, { freq: 65, freqTo: 35, duration: boomDur, gain: gain * 0.95, type: 'sine', pan });
  noiseBurst(ctx, echo, when + 0.01, {
    duration: boomDur,
    gain: gain * 0.5,
    lowpassFromHz: 500,
    lowpassToHz: 100,
    decay: boomDur,
    pan,
  });
}

function ricochet(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined): void {
  tone(ctx, dest, when, { freq: 2500, freqTo: 700, duration: 0.3, gain: gain * 0.35, type: 'sine', pan });
  noiseBurst(ctx, dest, when, { duration: 0.15, gain: gain * 0.2, bandpassHz: 2000, bandpassQ: 2, decay: 0.15, pan });
}

function smokePop(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined): void {
  noiseBurst(ctx, dest, when, { duration: 0.05, gain: gain * 0.5, bandpassHz: 500, bandpassQ: 1, decay: 0.05, pan });
  noiseBurst(ctx, dest, when + 0.02, { duration: 0.6, gain: gain * 0.15, lowpassFromHz: 2000, lowpassToHz: 800, decay: 0.6, pan });
}

function click(ctx: AudioContext, dest: AudioNode, when: number, gain: number): void {
  tone(ctx, dest, when, { freq: 1000, duration: 0.015, gain: gain * 0.4, type: 'square' });
}

function message(ctx: AudioContext, dest: AudioNode, when: number, gain: number): void {
  tone(ctx, dest, when, { freq: 600, duration: 0.06, gain: gain * 0.3, type: 'sine' });
  tone(ctx, dest, when + 0.07, { freq: 900, duration: 0.06, gain: gain * 0.3, type: 'sine' });
}

function flagCapture(ctx: AudioContext, dest: AudioNode, when: number, gain: number): void {
  const notes = [261.63, 329.63, 392.0]; // C4 E4 G4
  notes.forEach((f, i) => {
    tone(ctx, dest, when + i * 0.09, { freq: f, duration: 0.12, gain: gain * 0.25, type: 'square' });
  });
}

function scream(ctx: AudioContext, dest: AudioNode, when: number, gain: number, pan: number | undefined): void {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(400, when);
  osc.frequency.exponentialRampToValueAtTime(250, when + 0.3);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 18;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 30;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(gain * 0.18, when + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);

  osc.connect(env);
  let out: AudioNode = env;
  if (pan !== undefined && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner);
    out = panner;
  }
  out.connect(dest);

  osc.start(when);
  lfo.start(when);
  osc.stop(when + 0.35);
  lfo.stop(when + 0.35);
}
