// Physical direct-fire paths, independent of whether the firer can see the aim point.
import type { BattleState, Tracer, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { clamp, dist } from '@/shared/math';
import type { Rng } from '@/shared/rng';
import type { LosHeights } from './los';
import { groundAtTile, inBounds } from './map';
import { GROWTH_HEIGHT_M, cutGrowthAt } from './growth';
import { damageVegetation } from './trees';

export interface RoundTrace {
  impact: Vec2;
  points: Vec2[];
  blocked: boolean;
  deflected: boolean;
}

/** Scatter around knowledge supplied by an order or belief, never around an unseen entity. */
export function estimateAim(state: BattleState, rng: Rng, from: Vec2, aim: Vec2): Vec2 {
  const radius = (2.5 + dist(from, aim) * TILE_M * 0.025) / TILE_M;
  const angle = rng.range(0, Math.PI * 2), r = radius * Math.sqrt(rng.next());
  return {
    x: clamp(aim.x + Math.cos(angle) * r, 0.01, state.map.width - 0.01),
    y: clamp(aim.y + Math.sin(angle) * r, 0.01, state.map.height - 0.01),
  };
}

/** Sample a straight round every half metre. Vegetation contacts can turn its remaining path;
 * that new path is traced again, including hard cover. Lobbed projectiles use their own model. */
export function traceRound(
  state: BattleState, rng: Rng, from: Vec2, to: Vec2, weapon: WeaponDef, heights: LosHeights = {},
): RoundTrace {
  const points = [{ ...from }];
  if (weapon.indirect || weapon.cls === 'mortar' || weapon.cls === 'grenade') {
    return { impact: { ...to }, points: [...points, { ...to }], blocked: false, deflected: false };
  }
  const map = state.map;
  let start = { ...from }, end = { ...to }, deflected = false, contacts = 0;
  let startZ = groundAtTile(map, Math.floor(from.x), Math.floor(from.y)) + (heights.eyeM ?? 1.7);
  let endZ = groundAtTile(map, Math.floor(to.x), Math.floor(to.y)) + (heights.targetM ?? 1.7);
  const visited = new Set<number>();
  const shell = weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket';
  const finish = (impact: Vec2, blocked: boolean): RoundTrace => {
    points.push({ ...impact });
    return { impact: { ...impact }, points, blocked, deflected };
  };
  const spark = (pos: Vec2, kind: BattleState['sparks'][number]['kind']) => {
    state.sparks.push({ pos: { ...pos }, kind, t: state.time });
  };
  // At most three changes of direction: bounded cost even in deep woodland.
  for (let leg = 0; leg < 4; leg++) {
    const length = dist(start, end), steps = Math.max(1, Math.ceil(length * 4));
    let turned = false;
    for (let step = 1; step <= steps; step++) {
      const f = step / steps;
      const p = { x: start.x + (end.x - start.x) * f, y: start.y + (end.y - start.y) * f };
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (!inBounds(map, x, y)) return finish({ x: clamp(p.x, 0, map.width - 0.001), y: clamp(p.y, 0, map.height - 0.001) }, true);
      const i = y * map.width + x, terrain = map.tiles[i];
      const z = startZ + (endZ - startZ) * f;
      const above = z - groundAtTile(map, x, y);
      if (above < -0.2) { spark(p, 'dust'); return finish(p, true); }
      const startTile = x === Math.floor(from.x) && y === Math.floor(from.y);
      const endTile = x === Math.floor(to.x) && y === Math.floor(to.y);
      const wall = terrain === 'buildingStone' || terrain === 'buildingWood' || terrain === 'stonewall';
      const window = map.windows[i] && (
        Math.max(Math.abs(x - Math.floor(from.x)), Math.abs(y - Math.floor(from.y))) <= 1
        || Math.max(Math.abs(x - Math.floor(to.x)), Math.abs(y - Math.floor(to.y))) <= 1);
      // The aim tile can contain the target at a wall/window, matching LOS endpoint semantics.
      if (wall && !startTile && !endTile && !window) {
        spark(p, terrain === 'buildingWood' ? 'wood' : 'stone'); return finish(p, true);
      }
      if (GROWTH_HEIGHT_M[terrain] && cutGrowthAt(map, p, above) && !visited.has(i)) spark(p, 'leaf');
      if (visited.has(i) || startTile) continue;
      visited.add(i);
      const woody = terrain === 'woods' || terrain === 'scatteredtrees' || (terrain === 'hedge' && above < 2);
      if (!woody) continue;
      // A shell clips the screen and bursts; small arms sometimes pass between branches.
      if (!shell && !rng.chance(terrain === 'woods' ? 0.65 : terrain === 'hedge' ? 0.55 : 0.35)) continue;
      damageVegetation(map, x, y, shell ? 50 : 1);
      spark(p, 'wood');
      contacts++;
      if ((shell && weapon.heRadiusM > 0) || contacts >= 3 || (!shell && rng.chance(0.18))) return finish(p, true);
      if (!rng.chance(shell ? 0.12 : 0.5)) continue;
      deflected = true;
      spark(p, 'ricochet');
      points.push({ ...p });
      const angle = Math.atan2(end.y - start.y, end.x - start.x) + (rng.chance(0.5) ? 1 : -1) * rng.range(0.08, 0.35);
      const remaining = length * (1 - f) * 0.75;
      start = p; startZ = z;
      end = { x: p.x + Math.cos(angle) * remaining, y: p.y + Math.sin(angle) * remaining };
      endZ = groundAtTile(map, Math.floor(end.x), Math.floor(end.y)) + (heights.targetM ?? 1.7);
      turned = true;
      break;
    }
    if (!turned) return finish(end, false);
  }
  return finish(start, true);
}

export function traceTracers(state: BattleState, shot: RoundTrace, kind: Tracer['kind'], hit = false): void {
  for (let i = 1; i < shot.points.length; i++) {
    state.tracers.push({ from: { ...shot.points[i - 1] }, to: { ...shot.points[i] }, t: 0,
      hit: hit && i === shot.points.length - 1, kind, deflected: i > 1 });
  }
}
