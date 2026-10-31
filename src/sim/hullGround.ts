import type { GameMap, HullGroundProbe } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { clamp } from '@/shared/math';
import { getHeightField, heightAt, HF_RES, HF_STEP_M, syncCraterMarks } from './heightField';

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
  // A tick probe lives only until this hull's accepted effects run. A uniform
  // tile plus its derivative/interpolation halo proves every five-point sample
  // is constant; mixed tiles retain the original arithmetic below.
  const flatTiles = scope === 'tick' && field.res === HF_RES ? new Map<number, number | null>() : null;
  const h = (xM: number, yM: number): number => heightAt(
    field, clamp(xM, 0, map.width * TILE_M) / TILE_M,
    clamp(yM, 0, map.height * TILE_M) / TILE_M,
  );
  return (xM, yM) => {
    // Retain only the field reference; authored marks and rebuilt fields stay visible.
    if (scope === 'live') field = currentField(map);
    const x = clamp(xM, 0, map.width * TILE_M), y = clamp(yM, 0, map.height * TILE_M);
    if (flatTiles && Number.isFinite(x) && Number.isFinite(y)) {
      const tx = Math.min(map.width - 1, Math.floor(x / TILE_M));
      const ty = Math.min(map.height - 1, Math.floor(y / TILE_M));
      const key = ty * map.width + tx;
      let flat = flatTiles.get(key);
      if (flat === undefined) {
        const r = field.res, a = field.height;
        // +/- HF_STEP_M and the bilinear half-sample offset need two samples
        // before this tile and one beyond its following edge (eight at res=4).
        const x0 = Math.max(0, tx * r - 2), x1 = Math.min(field.w - 1, (tx + 1) * r + 1);
        const y0 = Math.max(0, ty * r - 2), y1 = Math.min(field.h - 1, (ty + 1) * r + 1);
        const value = a[y0 * field.w + x0];
        flat = Number.isFinite(value) ? value + 0 : null;
        if (flat !== null) outer: for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) if (a[yy * field.w + xx] !== value) {
            flat = null; break outer;
          }
        }
        flatTiles.set(key, flat);
      }
      if (flat !== null) return { heightM: flat, normal: { x: -0, y: -0, z: 1 } };
    }
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
