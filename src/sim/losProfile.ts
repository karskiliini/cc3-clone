// ============================================================================
// losProfile.ts — visibility profile along an aiming line, for the Fire/Smoke
// aiming line in the HUD. Pure: uses the same losTrace the sim uses for spotting
// and fire, so the line never disagrees with what the soldiers can actually see.
// ============================================================================
import type { GameMap, Vec2 } from '@/shared/types';
import { losTrace, losDistanceFactor, type LosHeights } from './los';
import { TILE_M } from '@/shared/types';

export type AimClass = 'clear' | 'obscured' | 'blocked';

/** One run of the aiming line with a single visibility class; t in 0..1 along from→to. */
export interface AimSegment { t0: number; t1: number; cls: AimClass }

/** Below this share of un-concealed visibility a stretch counts as obscured (dark green). */
export const OBSCURED_BELOW = 0.72;
const STEP_TILES = 0.5;
const MAX_SAMPLES = 160;

/** Classifies how well `from` can see the single point `p` (distance falloff excluded, so a
 * long clear shot over open ground stays bright green like in the original). */
export function classifyPoint(map: GameMap, from: Vec2, p: Vec2, heights?: LosHeights): AimClass {
  const r = losTrace(map, from, p, heights);
  if (!r.clear) return 'blocked';
  const distM = Math.hypot(p.x - from.x, p.y - from.y) * TILE_M;
  const df = losDistanceFactor(distM);
  const concealShare = df > 0 ? r.visibility / df : 0;
  return concealShare < OBSCURED_BELOW ? 'obscured' : 'clear';
}

/** Walks the line from `from` to `to` and returns merged runs of clear / obscured / blocked.
 * Ground beyond an obstacle is blocked, but the line can turn visible again further on (for
 * example rising ground beyond a dip), exactly as the sight line behaves in the sim. */
export function aimLineProfile(map: GameMap, from: Vec2, to: Vec2, heights?: LosHeights): AimSegment[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 1e-6) return [{ t0: 0, t1: 1, cls: 'clear' }];
  const n = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(len / STEP_TILES)));
  const segs: AimSegment[] = [];
  let curCls: AimClass | null = null;
  let curStart = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    const cls = classifyPoint(map, from, p, heights);
    if (cls !== curCls) {
      if (curCls !== null) segs.push({ t0: curStart, t1: (i - 1) / n, cls: curCls });
      curCls = cls;
      curStart = (i - 1) / n;
    }
  }
  if (curCls !== null) segs.push({ t0: curStart, t1: 1, cls: curCls });
  return segs;
}

/** Class of the aim point itself (the far end of the line). */
export function aimPointClass(segs: AimSegment[]): AimClass {
  return segs.length ? segs[segs.length - 1].cls : 'clear';
}
