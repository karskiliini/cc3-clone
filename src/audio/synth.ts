// ============================================================================
// Low-level Web Audio synthesis helpers. No audio files — everything here is
// generated at runtime. All functions take an explicit AudioContext and a
// destination AudioNode to connect into (usually the master gain from sfx.ts)
// and schedule themselves starting at `when` (AudioContext time, seconds).
// ============================================================================

export type Ctx = AudioContext;

/** Cache of pre-rendered noise buffers, keyed by (ctx, seconds) so we don't
 * regenerate the same buffer on every shot. */
const noiseBufferCache = new WeakMap<Ctx, Map<number, AudioBuffer>>();

export function noiseBuffer(ctx: Ctx, seconds: number): AudioBuffer {
  const key = Math.round(seconds * 1000);
  let byCtx = noiseBufferCache.get(ctx);
  if (!byCtx) { byCtx = new Map(); noiseBufferCache.set(ctx, byCtx); }
  const cached = byCtx.get(key);
  if (cached) return cached;
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  byCtx.set(key, buf);
  return buf;
}

/** White-noise burst through optional bandpass + lowpass, with an envelope. */
export function noiseBurst(
  ctx: Ctx,
  dest: AudioNode,
  when: number,
  opts: {
    duration: number;
    gain: number;
    bandpassHz?: number;
    bandpassQ?: number;
    lowpassFromHz?: number;
    lowpassToHz?: number;
    attack?: number;
    decay?: number;
    pan?: number;
  },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.duration + 0.05);

  let node: AudioNode = src;

  if (opts.bandpassHz !== undefined) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = opts.bandpassHz;
    bp.Q.value = opts.bandpassQ ?? 1;
    node.connect(bp);
    node = bp;
  }

  if (opts.lowpassFromHz !== undefined) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(opts.lowpassFromHz, when);
    lp.frequency.exponentialRampToValueAtTime(
      Math.max(20, opts.lowpassToHz ?? opts.lowpassFromHz),
      when + opts.duration,
    );
    node.connect(lp);
    node = lp;
  }

  const env = ctx.createGain();
  const attack = opts.attack ?? 0.002;
  const decay = opts.decay ?? opts.duration;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(opts.gain, when + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  node.connect(env);

  let out: AudioNode = env;
  if (opts.pan !== undefined && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = opts.pan;
    out.connect(panner);
    out = panner;
  }
  out.connect(dest);

  src.start(when);
  src.stop(when + opts.duration + 0.05);
}

/** A simple decaying sine "thump"/tone burst. */
export function tone(
  ctx: Ctx,
  dest: AudioNode,
  when: number,
  opts: {
    freq: number;
    freqTo?: number;
    duration: number;
    gain: number;
    type?: OscillatorType;
    attack?: number;
    pan?: number;
  },
): void {
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, when);
  if (opts.freqTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), when + opts.duration);
  }

  const env = ctx.createGain();
  const attack = opts.attack ?? 0.002;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(opts.gain, when + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, when + opts.duration);
  osc.connect(env);

  let out: AudioNode = env;
  if (opts.pan !== undefined && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = opts.pan;
    out.connect(panner);
    out = panner;
  }
  out.connect(dest);

  osc.start(when);
  osc.stop(when + opts.duration + 0.05);
}

/** Short feedback delay used as a cheap "reverb" tail for big guns. */
export function makeSlapEcho(ctx: Ctx, dest: AudioNode, delaySec = 0.09, feedback = 0.25): AudioNode {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = delaySec;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const wet = ctx.createGain();
  wet.gain.value = 0.4;

  input.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(dest);
  input.connect(dest); // dry path

  return input;
}

/** Continuously-running oscillator+filter "engine" voice; caller controls
 * frequency/gain live and calls stop() to tear it down. */
export interface EngineVoice {
  setSpeed(speedFactor: number): void;
  stop(when?: number): void;
}

export function startEngineVoice(ctx: Ctx, dest: AudioNode, baseHz = 45, maxHz = 70): EngineVoice {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = baseHz;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;

  const gain = ctx.createGain();
  gain.gain.value = 0.0001;

  osc.connect(lp);
  lp.connect(gain);
  gain.connect(dest);
  osc.start();

  let stopped = false;
  return {
    setSpeed(speedFactor: number) {
      if (stopped) return;
      const now = ctx.currentTime;
      const sf = Math.max(0, Math.min(1, speedFactor));
      const freq = baseHz + (maxHz - baseHz) * sf;
      osc.frequency.setTargetAtTime(freq, now, 0.08);
      gain.gain.setTargetAtTime(0.0001 + sf * 0.12, now, 0.15);
    },
    stop(when?: number) {
      if (stopped) return;
      stopped = true;
      const t = when ?? ctx.currentTime;
      gain.gain.setTargetAtTime(0.0001, t, 0.1);
      osc.stop(t + 0.4);
    },
  };
}

/** Soft looping ambient wind: filtered noise with a slow LFO on cutoff. */
export interface AmbientVoice {
  stop(): void;
}

export function startAmbientWind(ctx: Ctx, dest: AudioNode): AmbientVoice {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 4);
  src.loop = true;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  lp.Q.value = 0.5;

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);
  lfo.start();

  const gain = ctx.createGain();
  gain.gain.value = 0.05;

  src.connect(lp);
  lp.connect(gain);
  gain.connect(dest);
  src.start();

  return {
    stop() {
      try { src.stop(); } catch { /* already stopped */ }
      try { lfo.stop(); } catch { /* already stopped */ }
    },
  };
}
