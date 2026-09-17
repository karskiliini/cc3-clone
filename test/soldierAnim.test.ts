// Pure animation selection (spec 2026-09-17 §1-§4): posture, action, mood, frames, cadence,
// 16-way facing, and the ragdoll flight maths.
import { describe, it, expect } from 'vitest';
import type { Activity, MentalState, Soldier } from '@/shared/types';
import { createMind } from '@/sim/mind';
import {
  FIRE_KICK_S, STRIDE_M, actionFor, entryKeyChain, frameFor, gaitCadence, headingFor, isFlinching, moodFor, phaseOffset,
  pickAnimation, postureFor, quantiseDir, ragdollDuration, ragdollHeading, ragdollSample, ragdollVariants, transitionPosture,
  trembleOffset, weaponSuffix, RAGDOLL_FLIGHT_VARIANTS, RAGDOLL_LANDED_VARIANTS,
} from '@/render/soldierAnim';

function sol(o: Partial<Soldier> = {}, state: MentalState = 'calm'): Soldier {
  const mind = createMind(50); mind.state = state;
  return {
    id: 7, teamId: 1, side: 'german', name: 'T', rank: 'Gefr', weaponId: 'kar98k', ammo: 5, ammoReserve: 20, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle' as Activity,
    pos: { x: 10, y: 10 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0,
    fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0,
    kills: 0, mind, ...o,
  };
}
const LOOP4 = { frames: 4, fps: 4, loop: true }, RUN6 = { frames: 6, fps: 9, loop: true }, FIRE3 = { frames: 3, fps: 12, loop: false };

describe('posture', () => {
  it('kneeling is derived: crouching + stationary + firing/aiming/reloading/defending; crouching + moving or idle = crouched', () => {
    expect(postureFor(sol({ stance: 'crouching', activity: 'firing' }))).toBe('kneeling');
    expect(postureFor(sol({ stance: 'crouching', activity: 'reloading' }))).toBe('kneeling');
    expect(postureFor(sol({ stance: 'crouching', activity: 'defending' }))).toBe('kneeling');
    expect(postureFor(sol({ stance: 'crouching', targetSoldierId: 3 }))).toBe('kneeling');
    expect(postureFor(sol({ stance: 'crouching', activity: 'moving', path: [{ x: 12, y: 10 }] }))).toBe('crouched');
    expect(postureFor(sol({ stance: 'crouching', activity: 'firing', path: [{ x: 12, y: 10 }] }))).toBe('crouched');
    expect(postureFor(sol({ stance: 'crouching' }))).toBe('crouched');
    expect(postureFor(sol({ stance: 'standing' }))).toBe('standing');
    expect(postureFor(sol({ stance: 'prone' }))).toBe('prone');
  });
  it('pinned kneelers flatten; incapacitated and stunned men lie down', () => {
    expect(postureFor(sol({ stance: 'crouching', activity: 'pinned' }))).toBe('prone');
    expect(postureFor(sol({ health: 'incapacitated' }))).toBe('prone');
    expect(postureFor(sol({ stunnedUntil: 12 }), 11)).toBe('prone');
    expect(postureFor(sol({ stunnedUntil: 12 }), 13)).toBe('standing');
  });
  it('standing <-> prone passes through kneeling briefly', () => {
    expect(transitionPosture('standing', 'prone', 0.05)).toBe('kneeling');
    expect(transitionPosture('prone', 'standing', 0.1)).toBe('kneeling');
    expect(transitionPosture('standing', 'prone', 0.5)).toBe('prone');
    expect(transitionPosture('kneeling', 'prone', 0.05)).toBe('prone');
  });
});

describe('action and mood', () => {
  it('selects the action from activity, stance, path and timestamps', () => {
    expect(actionFor(sol(), 100)).toBe('idle');
    expect(actionFor(sol({ activity: 'moving', path: [{ x: 1, y: 1 }] }), 100)).toBe('walk');
    expect(actionFor(sol({ activity: 'movingFast', path: [{ x: 1, y: 1 }] }), 100)).toBe('run');
    expect(actionFor(sol({ stance: 'crouching', activity: 'sneaking', path: [{ x: 1, y: 1 }] }), 100)).toBe('sneak');
    expect(actionFor(sol({ stance: 'prone', activity: 'moving', path: [{ x: 1, y: 1 }] }), 100)).toBe('crawl');
    expect(actionFor(sol({ activity: 'firing', lastFiredAt: 99.9 }), 100)).toBe('fire');
    expect(actionFor(sol({ activity: 'firing', lastFiredAt: 99 }), 100)).toBe('aim');
    expect(actionFor(sol({ activity: 'reloading', reloadTimer: 1.5 }), 100)).toBe('reload');
    expect(actionFor(sol({ activity: 'hiding' }), 100)).toBe('hide');
    expect(actionFor(sol({ activity: 'ambushing' }), 100)).toBe('hide');
    expect(actionFor(sol({ activity: 'cowering', path: [{ x: 1, y: 1 }] }), 100)).toBe('hide');
    expect(actionFor(sol({ activity: 'panicked', path: [{ x: 1, y: 1 }] }), 100)).toBe('run');
    expect(actionFor(sol({ health: 'incapacitated' }), 100)).toBe('woundedCrawl');
    expect(actionFor(sol({ health: 'dead' }), 100)).toBe('hit');
    expect(actionFor(sol({ stunnedUntil: 101, activity: 'firing', lastFiredAt: 99.95 }), 100)).toBe('hide');
  });
  it('mood comes from activity first, then mind.state', () => {
    expect(moodFor(sol())).toBe('calm');
    expect(moodFor(sol({}, 'alert'))).toBe('alert');
    expect(moodFor(sol({}, 'wary'))).toBe('alert');
    expect(moodFor(sol({}, 'shaken'))).toBe('shaken');
    expect(moodFor(sol({}, 'broken'))).toBe('panicked');
    expect(moodFor(sol({ activity: 'routed' }))).toBe('panicked');
    expect(moodFor(sol({ activity: 'pinned' }, 'shaken'))).toBe('pinned');
    expect(moodFor(sol({ activity: 'cowering' }))).toBe('cowering');
    expect(moodFor(sol({ activity: 'berserk' }))).toBe('berserk');
    expect(moodFor(sol({ activity: 'surrendered' }, 'panicked'))).toBe('surrendered');
  });
  it('builds `<posture>.<action>[.<mood>][@weapon]` keys, most specific first', () => {
    expect(entryKeyChain('kneeling', 'fire', 'shaken', 'smg')).toEqual([
      'kneeling.fire.shaken@smg', 'kneeling.fire.shaken', 'kneeling.fire@smg', 'kneeling.fire',
      'kneeling.idle.shaken@smg', 'kneeling.idle.shaken', 'kneeling.idle@smg', 'kneeling.idle', 'standing.idle@smg', 'standing.idle',
    ]);
    expect(entryKeyChain('standing', 'idle', 'calm', null)).toEqual(['standing.idle']);
    expect(weaponSuffix('mp40')).toBe('smg');
    expect(weaponSuffix('mg34')).toBe('lmg');
    expect(weaponSuffix('kar98k')).toBe('rifle');
    const p = pickAnimation(sol({ activity: 'panicked', path: [{ x: 12, y: 10 }] }), 50);
    expect(p.keys[0]).toBe('standing.run.panicked@rifle');
  });
});

describe('frames', () => {
  it('is a pure, stable function of the clock, with a per-soldier phase offset', () => {
    const a = sol({ id: 3 }), b = sol({ id: 4 });
    expect(frameFor(a, 12.34, 'idle', LOOP4)).toBe(frameFor(a, 12.34, 'idle', LOOP4));
    expect(phaseOffset(3)).not.toBe(phaseOffset(4));
    const seqA = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => frameFor(a, i * 0.25, 'idle', LOOP4));
    const seqB = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => frameFor(b, i * 0.25, 'idle', LOOP4));
    expect(new Set(seqA).size).toBe(4);
    void seqB;
    const distinct = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [0, 1, 2, 3].map((i) => frameFor(sol({ id }), i * 0.25, 'idle', LOOP4)).join('')));
    expect(distinct.size).toBeGreaterThan(1); // a squad does not breathe in unison
    for (const f of seqA) { expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(4); }
  });
  it('gait cadence is proportional to ground speed (feet do not slide) and slower when shaken', () => {
    expect(gaitCadence('run', 4.8)).toBeCloseTo(4.8 / STRIDE_M.run, 9);
    expect(gaitCadence('run', 4.8)).toBeCloseTo(2 * gaitCadence('run', 2.4), 9);
    expect(gaitCadence('walk', 1.5, 'shaken')).toBeCloseTo(0.8 * gaitCadence('walk', 1.5), 9);
    expect(gaitCadence('idle', 3)).toBe(0);
    // frames advanced over one second = cadence * frames
    const s = sol({ id: 1, activity: 'movingFast', path: [{ x: 1, y: 1 }] });
    const count = (speed: number) => { let changes = 0, prev = -1; for (let i = 0; i <= 1000; i++) { const f = frameFor(s, i / 1000, 'run', RUN6, speed); if (f !== prev && prev >= 0) changes++; prev = f; } return changes; };
    expect(count(4.8)).toBe(Math.round(gaitCadence('run', 4.8) * 6));
    expect(count(2.4)).toBe(Math.round(gaitCadence('run', 2.4) * 6));
  });
  it('fire kick runs once from lastFiredAt; reload follows the reload timer', () => {
    const s = sol({ lastFiredAt: 10 });
    expect(frameFor(s, 10.0, 'fire', FIRE3)).toBe(0);
    expect(frameFor(s, 10 + FIRE_KICK_S * 0.5, 'fire', FIRE3)).toBe(1);
    expect(frameFor(s, 10 + FIRE_KICK_S * 0.9, 'fire', FIRE3)).toBe(2);
    expect(frameFor(s, 11, 'fire', FIRE3)).toBe(2);
    const r = (timer: number) => frameFor(sol({ activity: 'reloading', reloadTimer: timer }), 5, 'reload', { frames: 4, fps: 2, loop: false });
    expect(r(3)).toBe(0); expect(r(1.4)).toBe(2); expect(r(0.01)).toBe(3);
  });
  it('flinches for a moment after incoming fire; shaken / cowering men tremble by at most 1 px', () => {
    const s = sol(); s.mind.lastIncomingAt = 20;
    expect(isFlinching(s, 20.1)).toBe(true);
    expect(isFlinching(s, 21)).toBe(false);
    expect(pickAnimation(s, 20.1).action).toBe('hide');
    const calm = sol(), cow = sol({ activity: 'cowering' });
    let moved = 0;
    for (let i = 0; i < 100; i++) {
      expect(trembleOffset(calm, i * 0.1)).toEqual({ x: 0, y: 0 });
      const j = trembleOffset(cow, i * 0.1);
      expect(Math.abs(j.x)).toBeLessThanOrEqual(1); expect(Math.abs(j.y)).toBeLessThanOrEqual(1);
      if (j.x !== 0 || j.y !== 0) moved++;
    }
    expect(moved).toBeGreaterThan(10);
  });
});

describe('facing', () => {
  it('quantises to 16 (or any number of) directions, 0 = north, clockwise', () => {
    expect(quantiseDir(0)).toBe(0);
    expect(quantiseDir(Math.PI / 2)).toBe(4);
    expect(quantiseDir(Math.PI / 8)).toBe(1);
    expect(quantiseDir(-Math.PI / 2)).toBe(12);
    expect(quantiseDir(Math.PI * 2 - 0.01)).toBe(0);
    expect(quantiseDir(Math.PI, 64)).toBe(32);
  });
  it('moving men face along their path, aiming men at the target, others keep the 8-way facing', () => {
    expect(headingFor(sol({ path: [{ x: 12, y: 9 }] }))).toBeCloseTo(Math.atan2(2, 1), 9);
    expect(quantiseDir(headingFor(sol({ path: [{ x: 12, y: 9 }] })))).toBe(3); // ENE-ish: not an 8-way direction
    expect(headingFor(sol({ facing: 2 }), { x: 10, y: 20 })).toBeCloseTo(Math.PI, 9);
    expect(headingFor(sol({ facing: 6 }))).toBeCloseTo((6 * Math.PI) / 4, 9);
  });
});

describe('ragdoll flight (pure half)', () => {
  const blast = { from: { x: 10, y: 10 }, time: 100, force: 1, origin: { x: 10.5, y: 10 } };
  const pos = { x: 11.5, y: 10 };
  it('flies from the pre-blast position and lands exactly on the sim position within 0.5-1.9 s', () => {
    expect(ragdollDuration(0.1)).toBeCloseTo(0.5062, 3);
    expect(ragdollDuration(0)).toBe(0.5);
    expect(ragdollDuration(5)).toBe(1.9);
    const start = ragdollSample(blast, pos, 100);
    expect(start.x).toBeCloseTo(10.5, 9);
    expect(start.heightM).toBeCloseTo(0, 9);
    const mid = ragdollSample(blast, pos, 100 + ragdollDuration(1) * 0.4);
    expect(mid.heightM).toBeGreaterThan(1);
    expect(mid.x).toBeGreaterThan(10.5); expect(mid.x).toBeLessThan(11.5);
    expect(mid.shadow).toBeLessThan(0.6);                 // the shadow shrinks while he is airborne
    const end = ragdollSample(blast, pos, 100 + ragdollDuration(1) + 0.001);
    expect(end.landed).toBe(true);
    expect(end.x).toBe(11.5); expect(end.y).toBe(10); expect(end.heightM).toBe(0); expect(end.shadow).toBe(1);
  });
  it('rises, falls, bounces once low, and moves monotonically toward the landing point', () => {
    const dur = ragdollDuration(1);
    let prevX = -Infinity, peak = 0, bouncePeak = 0;
    for (let i = 0; i <= 100; i++) {
      const s = ragdollSample(blast, pos, 100 + ((dur * i) / 100) * 0.999999);
      expect(s.x).toBeGreaterThanOrEqual(prevX - 1e-9); prevX = s.x;
      expect(s.heightM).toBeGreaterThanOrEqual(0);
      if (s.t < 0.78) peak = Math.max(peak, s.heightM); else bouncePeak = Math.max(bouncePeak, s.heightM);
    }
    expect(bouncePeak).toBeGreaterThan(0);
    expect(bouncePeak).toBeLessThan(peak * 0.3);
  });
  it('picks variants by hash and heads away from the burst', () => {
    const v = ragdollVariants(12, 100), w = ragdollVariants(12, 100);
    expect(v).toEqual(w);
    expect(v.flight).toBeGreaterThanOrEqual(0); expect(v.flight).toBeLessThan(RAGDOLL_FLIGHT_VARIANTS);
    expect(v.landed).toBeGreaterThanOrEqual(0); expect(v.landed).toBeLessThan(RAGDOLL_LANDED_VARIANTS);
    const seen = new Set<number>(); for (let id = 0; id < 60; id++) seen.add(ragdollVariants(id, 100).flight);
    expect(seen.size).toBe(RAGDOLL_FLIGHT_VARIANTS);
    expect(ragdollHeading(blast, pos)).toBeCloseTo(Math.PI / 2, 9); // thrown east
  });

  describe('men who are not going anywhere stay still', () => {
    it('a hiding or ambushing man with a leftover path does not crawl on the spot', () => {
      for (const activity of ['hiding', 'ambushing'] as const) {
        const s = { ...sol(), stance: 'prone', activity, path: [{ x: 9, y: 9 }] } as Soldier;
        expect(actionFor(s, 10, 'prone', 0)).toBe('hide');
        expect(pickAnimation(s, 10, null, 'prone', 0.01).action).toBe('hide');
        // really crawling, or speed not yet measured: the gait plays
        expect(actionFor(s, 10, 'prone', 0.5)).toBe('crawl');
        expect(actionFor(s, 10, 'prone')).toBe('crawl');
      }
    });
    it('a held crouching man kneels instead of showing the moving crouch', () => {
      const s = { ...sol(), stance: 'crouching', activity: 'defending', path: [{ x: 9, y: 9 }] } as Soldier;
      expect(postureFor(s, 0, 0)).toBe('kneeling');
      expect(postureFor(s, 0, 1)).toBe('crouched');
    });
  });
});

// ------------------------------------------------------------------ hatch climbs ---
// @ts-expect-error -- node builtins carry no type declarations in this project (no @types/node)
import * as nodeFs from 'node:fs';
const { readFileSync, readdirSync } = nodeFs as { readFileSync(p: string, enc: string): string; readdirSync(p: string): string[] };
import { hatchClimbAnim, hatchClimbFrame, resolveEntryKey } from '@/render/soldierAnim';

describe('hatch climb sprites', () => {
  const dir = 'public/sprites';
  const atlases = readdirSync(dir).filter((f) => /^soldiers_.*\.json$/.test(f));
  it('every soldier atlas carries crew.bailout / crew.mount and the climb chain resolves to them first', () => {
    expect(atlases.length).toBeGreaterThan(0);
    for (const f of atlases) {
      const entries = (JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { entries: Record<string, { frames: number; hullHeightM?: number }> }).entries;
      for (const kind of ['bailout', 'mount'] as const) {
        const s = sol({ hatch: { vehicleId: 1, hatch: 0, kind, from: { x: 10, y: 10 }, to: { x: 12, y: 10 }, start: 0, until: 4, panicked: false } });
        const a = hatchClimbAnim(s, 2)!;
        expect(a.keys[0]).toBe(`crew.${kind}`);
        const key = resolveEntryKey(entries, a.keys)!;
        expect(key).toBe(`crew.${kind}`);
        expect(entries[key].frames).toBe(6);
        expect(entries[key].hullHeightM).toBe(1.5);
        expect(hatchClimbFrame(key, 6, 0, 0)).toBe(0);
        expect(hatchClimbFrame(key, 6, a.progress, 2)).toBeGreaterThan(0);
        expect(hatchClimbFrame(key, 6, 1, 4)).toBe(5);
      }
    }
  });
});
