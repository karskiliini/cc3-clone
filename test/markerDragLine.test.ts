import { describe, expect, it } from 'vitest';
import type { Team } from '@/shared/types';
import { drawOrderDragLine } from '@/render/orderMarkers';

function recordingContext() {
  const moves: number[][] = [], lines: number[][] = [];
  let strokes = 0;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => k === 'moveTo' ? (x: number, y: number) => moves.push([x, y])
      : k === 'lineTo' ? (x: number, y: number) => lines.push([x, y])
      : k === 'stroke' ? () => { strokes++; }
      : k === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : k in t ? t[k] : () => {},
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, moves, lines, strokes: () => strokes };
}

describe('marker drag line stays attached to the unit and the live pointer', () => {
  it('draws from the unit in camera coordinates to the pointer, including a settled Move order', () => {
    const r = recordingContext();
    const team = { pos: { x: 15, y: 20 }, order: { type: 'move' } } as Team;
    drawOrderDragLine(r.ctx, { x: 10, y: 10, zoom: 2 }, team, { x: 600, y: 450 });
    expect(r.moves).toEqual([[200, 400]]); expect(r.lines).toEqual([[600, 450]]); expect(r.strokes()).toBeGreaterThanOrEqual(2);
  });
  it('anchors a crew weapon to the deployed gun rather than the crew centroid', () => {
    const r = recordingContext();
    const team = { pos: { x: 15, y: 20 }, crewWeapon: { pos: { x: 12, y: 13 }, abandoned: false }, order: { type: 'fire' } } as Team;
    drawOrderDragLine(r.ctx, { x: 10, y: 10, zoom: 1 }, team, { x: 400, y: 250 });
    expect(r.moves).toEqual([[40, 60]]); expect(r.lines).toEqual([[400, 250]]);
  });
});
