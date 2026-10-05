import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as dm from '@/shared/dmath';
import { Battle } from '@/sim/battle';
import { hashState } from '@/sim/stateHash';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig, Side } from '@/shared/types';
import { SIM_DT } from '@/shared/types';

/** Item 045: deterministic math, and 046: the sim never orders sides by the viewer. */

const buf = new Float64Array(2);
const bits = new BigInt64Array(buf.buffer);
function ulps(a: number, b: number): number {
  buf[0] = a; buf[1] = b;
  const d = bits[0] - bits[1];
  return Number(d < 0n ? -d : d);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
}

describe('dmath', () => {
  const r = lcg(42);
  const cases: [string, (x: number, y: number) => number, (x: number, y: number) => number, () => [number, number]][] = [
    ['sin', (x) => dm.sin(x), (x) => Math.sin(x), () => [(r() - 0.5) * 200, 0]],
    ['cos', (x) => dm.cos(x), (x) => Math.cos(x), () => [(r() - 0.5) * 200, 0]],
    ['atan2', (y, x) => dm.atan2(y, x), (y, x) => Math.atan2(y, x), () => [(r() - 0.5) * 400, (r() - 0.5) * 400]],
    ['exp', (x) => dm.exp(x), (x) => Math.exp(x), () => [(r() - 0.5) * 60, 0]],
    ['log', (x) => dm.log(x), (x) => Math.log(x), () => [r() * 1000, 0]],
    ['pow (integer exponent)', (x, y) => dm.pow(x, y), (x, y) => Math.pow(x, y), () => [r() * 3, Math.floor(r() * 6)]],
    ['hypot', (x, y) => dm.hypot(x, y), (x, y) => Math.hypot(x, y), () => [(r() - 0.5) * 400, (r() - 0.5) * 400]],
  ];
  it.each(cases)('%s stays within a few ulp of Math over 20 000 inputs', (name, f, g, gen) => {
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const [x, y] = gen();
      worst = Math.max(worst, ulps(f(x, y), g(x, y)));
    }
    // repeated squaring rounds once per multiply
    expect(worst).toBeLessThanOrEqual(name.startsWith('pow') ? 4 : 2);
  });

  it('pow with a fractional exponent (exp·log) stays within 1e-13 relative', () => {
    for (let i = 0; i < 20000; i++) {
      const x = r() * 3, y = r() * 4;
      expect(Math.abs(dm.pow(x, y) - Math.pow(x, y))).toBeLessThanOrEqual(1e-13 * Math.pow(x, y) + 1e-300);
    }
  });

  it('gets the special values right', () => {
    expect(dm.sin(0)).toBe(0);
    expect(Object.is(dm.sin(-0), -0)).toBe(true);
    expect(dm.cos(0)).toBe(1);
    expect(dm.atan2(0, -1)).toBe(Math.PI);
    expect(dm.atan2(-0, -1)).toBe(-Math.PI);
    expect(dm.atan2(1, 0)).toBe(Math.PI / 2);
    expect(dm.atan2(0, 0)).toBe(0);
    expect(dm.exp(0)).toBe(1);
    expect(dm.exp(-800)).toBe(0);
    expect(dm.exp(800)).toBe(Infinity);
    expect(dm.log(1)).toBe(0);
    expect(dm.log(0)).toBe(-Infinity);
    expect(dm.log(-1)).toBeNaN();
    expect(dm.sin(Infinity)).toBeNaN();
    expect(dm.pow(2, 10)).toBe(1024);
    expect(dm.pow(3, -2)).toBe(1 / 9);
  });

  it('reproduces fixed reference bits (the same on every engine)', () => {
    // values pinned from this implementation; an engine-dependent Math call would change them
    const probe = [dm.sin(1), dm.cos(2), dm.atan2(3, -4), dm.exp(0.7), dm.log(10), dm.sin(123.456), dm.pow(2.5, 1.5)];
    expect(probe.map((v) => v.toString())).toMatchSnapshot();
  });
});

describe('the sim uses no engine-dependent math', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  it('bans Math transcendentals and ** under src/sim and the shared sim helpers', () => {
    const banned = /\bMath\.(sin|cos|tan|atan2|atan|asin|acos|exp|log|log2|log10|pow|hypot|cbrt|expm1|log1p|sinh|cosh|tanh)\(|[\w)\]]\s*\*\*\s*[\w(]/;
    const offenders: string[] = [];
    for (const f of [...files('src/sim'), ...files('src/shared'), ...files('src/net')]) {
      if (f.endsWith('dmath.ts')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(code)) return;
        if (banned.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the sim does not depend on who is watching', () => {
  function chain(viewer: Side, controllers: BattleConfig['controllers']): number[] {
    const b = new Battle({
      mapId: 'village_1942', playerSide: viewer, year: 1942, seed: 5, durationS: 1200,
      difficulty: 'normal', forces: DEFAULT_FORCES[1942], controllers,
    });
    const g = b.selectableTeams('german')[0];
    const s = b.selectableTeams('soviet')[0];
    b.submit('german', { type: 'ready' });
    b.submit('soviet', { type: 'ready' });
    const out: number[] = [];
    for (let i = 0; i < 900 && b.state.phase !== 'ended'; i++) {
      if (i === 50) b.submit('german', { type: 'order', teamId: g.id, order: { type: 'moveFast', target: { x: g.pos.x, y: g.pos.y - 20 }, issuedAt: 0 } });
      if (i === 80) b.submit('soviet', { type: 'order', teamId: s.id, order: { type: 'move', target: { x: s.pos.x + 10, y: s.pos.y }, issuedAt: 0 } });
      if (i === 300) b.submit('german', { type: 'truce' });
      b.step(SIM_DT);
      out.push(hashState(b));
    }
    return out;
  }
  it.each([
    ['two humans', { german: 'human', soviet: 'human' }],
    ['human vs AI', { german: 'human', soviet: 'ai' }],
    ['AI vs AI', { german: 'ai', soviet: 'ai' }],
  ] as const)('%s: a German and a Soviet viewer compute the same hash chain', (_n, controllers) => {
    expect(chain('soviet', { ...controllers })).toEqual(chain('german', { ...controllers }));
  });
});
