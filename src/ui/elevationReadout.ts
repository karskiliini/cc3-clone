import type { GameMap, Vec2 } from '@/shared/types';
import { featureHeightAt, getHeightField, groundAt, syncCraterMarks } from '@/sim/heightField';
import { growthHeightAt } from '@/sim/growth';

/** "12.4 m" for bare ground; with something standing on it or dug into it, the difference too:
 * "12.4 m +6.0" on a roof, "12.4 m -1.2" in a foxhole. Small differences are ground noise. */
export function elevationLabel(groundM: number, featureM: number): string {
  const g = `${groundM.toFixed(1)} m`;
  if (Math.abs(featureM) < 0.25) return g;
  return `${g} ${featureM > 0 ? '+' : '-'}${Math.abs(featureM).toFixed(1)}`;
}

/** Elevation text for the map point `w` (tile coords), or null off the map. Uses the same height
 * field as the depth map, so craters, foxholes, walls and damaged buildings count. Drawn by the
 * pointer readout (ui/hoverInfo.ts) under the name of what is there. */
export function elevationTextAt(map: GameMap, w: Vec2): string | null {
  if (w.x < 0 || w.y < 0 || w.x >= map.width || w.y >= map.height) return null;
  const field = getHeightField(map);
  syncCraterMarks(map, field);
  return elevationLabel(groundAt(field, w.x, w.y), featureHeightAt(field, w.x, w.y) + growthHeightAt(map, w.x, w.y));
}
