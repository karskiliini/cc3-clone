import type { GameMap, Vec2 } from '@/shared/types';
import { idx, inBounds } from './map';

export function addSmoke(map: GameMap, center: Vec2, radiusTiles: number, density: number): void {
  const cx = Math.floor(center.x), cy = Math.floor(center.y);
  const r = Math.ceil(radiusTiles);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(map, x, y)) continue;
      const d = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
      if (d > radiusTiles) continue;
      const falloff = Math.max(0, 1 - d / radiusTiles);
      const i = idx(map, x, y);
      map.smoke[i] = Math.max(map.smoke[i], density * falloff);
    }
  }
}

export function stepSmoke(map: GameMap, dt: number): void {
  const w = map.width, h = map.height;
  const decay = dt / 60;
  // drift: copy 5% of each tile's density to its +x neighbour per second
  const driftFrac = 0.05 * dt;
  const next = new Float32Array(map.smoke.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(map, x, y);
      const d = map.smoke[i];
      if (d <= 0) continue;
      const moved = d * driftFrac;
      const remain = d - moved;
      next[i] += remain;
      if (inBounds(map, x + 1, y)) {
        next[idx(map, x + 1, y)] += moved;
      } else {
        next[i] += moved; // no neighbour to drift into, keep it
      }
    }
  }
  for (let i = 0; i < next.length; i++) {
    map.smoke[i] = Math.max(0, next[i] - decay);
  }
}
