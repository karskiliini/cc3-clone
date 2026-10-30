import type { GameMap, HullGroundProbe } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { clamp } from '@/shared/math';
import { getHeightField, heightAt, HF_STEP_M, syncCraterMarks } from './heightField';

function currentField(map: GameMap) {
  const field = getHeightField(map);
  syncCraterMarks(map, field);
  return field;
}

/** Composite terrain/features in metres; tree canopy is not a hull support. */
export function groundProbe(map: GameMap, scope: 'live' | 'tick' = 'live'): HullGroundProbe {
  // One synchronous body completion cannot mutate terrain until accepted effects
  // run afterwards. Keep live semantics for reusable external probes.
  let field = scope === 'tick' ? currentField(map) : getHeightField(map);
  const h = (xM: number, yM: number): number => heightAt(
    field, clamp(xM, 0, map.width * TILE_M) / TILE_M,
    clamp(yM, 0, map.height * TILE_M) / TILE_M,
  );
  return (xM, yM) => {
    // Retain only the field reference; authored marks and rebuilt fields stay visible.
    if (scope === 'live') field = currentField(map);
    const x = clamp(xM, 0, map.width * TILE_M), y = clamp(yM, 0, map.height * TILE_M);
    const dx = h(x + HF_STEP_M, y) - h(x - HF_STEP_M, y);
    const dy = h(x, y + HF_STEP_M) - h(x, y - HF_STEP_M);
    const n = Math.sqrt(dx * dx + dy * dy + 1);
    return { heightM: h(x, y), normal: { x: -dx / n, y: -dy / n, z: 1 / n } };
  };
}

/** Sync pending marks before the caller compares the global revision at its sleep gate. */
export function groundVersion(map: GameMap): number {
  return currentField(map).version;
}
