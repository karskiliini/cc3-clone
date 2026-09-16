import { describe, it, expect } from 'vitest';
import type { BattleMessage, Team } from '@/shared/types';
import { splitMessage, collapseMessages } from '@/ui/hud/combatMessages';
import { clipTextToWidth } from '@/ui/hud/hudChrome';

// Helvetica/Arial advance widths (1/1000 em) — enough to approximate canvas measureText in node
// (same table used by test/soldierMonitor.test.ts).
const REG: Record<string, number> = {
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  ' ': 278,
};
const CAPS: Record<string, number> = {
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
};
function fakeCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '11px Arial', textBaseline: 'top',
    measureText(t: string) {
      const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)![1]);
      let w = 0;
      for (const ch of t) w += REG[ch] ?? CAPS[ch] ?? 500;
      return { width: (w / 1000) * px };
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function msg(text: string, kind: BattleMessage['kind'] = 'info', time = 0): BattleMessage {
  return { text, kind, time };
}

const noTeams: Team[] = [];

describe('splitMessage', () => {
  it('splits the team-name header line from the body', () => {
    expect(splitMessage('PzKw IV F1\nKnocked out.', noTeams)).toEqual({ who: 'PzKw IV F1', body: 'Knocked out.' });
  });

  it('strips a duplicated team name from the start of the body (round5 critique #6)', () => {
    // The exact defect reported: "PzKw IV F1 / PzKw IV F1 has been knocked out."
    expect(splitMessage('PzKw IV F1\nPzKw IV F1 has been knocked out.', noTeams))
      .toEqual({ who: 'PzKw IV F1', body: 'has been knocked out.' });
  });

  it('leaves a body that merely starts with a similar-but-different word alone', () => {
    expect(splitMessage('Rifle Squad\nRifle Squadron reports in.', noTeams))
      .toEqual({ who: 'Rifle Squad', body: 'Rifle Squadron reports in.' });
  });
});

describe('collapseMessages', () => {
  it('leaves distinct messages uncollapsed with count 1', () => {
    const out = collapseMessages([msg('A\nfoo'), msg('A\nbar')], noTeams);
    expect(out).toEqual([{ who: 'A', body: 'foo', kind: 'info', count: 1 }, { who: 'A', body: 'bar', kind: 'info', count: 1 }]);
  });

  it('merges consecutive identical messages into one row with a repeat count (round5 critique #6)', () => {
    const out = collapseMessages([
      msg('PzKw IV F1\nKnocked out.', 'bad'),
      msg('PzKw IV F1\nKnocked out.', 'bad'),
      msg('PzKw IV F1\nKnocked out.', 'bad'),
    ], noTeams);
    expect(out).toEqual([{ who: 'PzKw IV F1', body: 'Knocked out.', kind: 'bad', count: 3 }]);
  });

  it('does not merge identical text across a different kind, and resumes counting after an interruption', () => {
    const out = collapseMessages([
      msg('A\nfoo', 'bad'),
      msg('A\nfoo', 'good'),
      msg('B\nbar', 'info'),
      msg('A\nfoo', 'bad'),
    ], noTeams);
    expect(out.map((m) => m.count)).toEqual([1, 1, 1, 1]);
  });
});

describe('clipTextToWidth', () => {
  it('returns text unchanged when it already fits', () => {
    const ctx = fakeCtx();
    expect(clipTextToWidth(ctx, 'short', 200)).toBe('short');
  });

  it('never cuts a word in half — it breaks on a word boundary and marks the cut with an ellipsis', () => {
    // Round5 critique #6: the old trim produced "has been wounde", "has been destroye",
    // "has been knocked o" — a dangling word fragment with no indication of truncation.
    const ctx = fakeCtx();
    const text = 'Schtz. Kaiser has been wounded in the shoulder';
    for (let w = 20; w <= 140; w += 4) {
      const out = clipTextToWidth(ctx, text, w);
      if (out === text) continue;
      expect(out.endsWith('…')).toBe(true);
      const withoutEllipsis = out.slice(0, -1);
      // every word in the clipped output (besides a possible fully-char-trimmed final word) must
      // be a whole word from the source text
      if (withoutEllipsis.length > 0) {
        const words = withoutEllipsis.split(' ');
        const sourceWords = text.split(' ');
        for (let i = 0; i < words.length - 1; i++) expect(sourceWords).toContain(words[i]);
      }
    }
  });

  it('falls back to a char-trim + ellipsis only when a single word cannot fit at all', () => {
    const ctx = fakeCtx();
    const out = clipTextToWidth(ctx, 'Superduperlongsingleword', 30);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan('Superduperlongsingleword'.length);
  });
});
