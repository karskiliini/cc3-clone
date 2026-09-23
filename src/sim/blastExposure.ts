import type { BattleState, Soldier, Terrain, Vec2 } from '@/shared/types';
import { inBounds, tileAt } from './map';
import { clamp } from '@/shared/math';

// Blast protection is physical shelter, not visibility: grass and smoke cannot stop it.
const SHELTER: Partial<Record<Terrain, number>> = {
  trench: 0.85, crater: 0.65, rubble: 0.55, stonewall: 0.75,
  buildingStone: 0.8, buildingWood: 0.55, floor: 0.35, woods: 0.2, scatteredtrees: 0.1,
};
const BARRIER: Partial<Record<Terrain, number>> = {
  stonewall: 0.9, buildingStone: 0.92, buildingWood: 0.65, rubble: 0.35,
};

export interface BlastExposure {
  cover: number;
  injury: number;
  force: number;
  shock: number;
}

/** Sample before injury changes posture, knockback moves the man or the blast destroys cover.
 * A wall only protects when it lies BETWEEN the man and this burst. A burst in his own tile or
 * room bypasses that position's shelter; crouching/prone posture still reduces exposure. */
export function blastExposure(state: BattleState, s: Soldier, burst: Vec2): BlastExposure {
  const map = state.map, tx = Math.floor(s.pos.x), ty = Math.floor(s.pos.y);
  const bx = Math.floor(burst.x), by = Math.floor(burst.y);
  const ti = ty * map.width + tx, bi = by * map.width + bx;
  const inside = inBounds(map, tx, ty), burstInside = inBounds(map, bx, by);
  const sameBuilding = inside && burstInside && map.buildingId[ti] >= 0 && map.buildingId[ti] === map.buildingId[bi];
  const burstTerrain = burstInside ? tileAt(map, bx, by) : 'open';
  const insideBurst = sameBuilding && burstTerrain === 'floor';
  const samePosition = (tx === bx && ty === by) || insideBurst;
  const low = s.stance === 'prone', standing = s.stance === 'standing';
  let cover = inside && !samePosition ? (SHELTER[tileAt(map, tx, ty)] ?? 0) * (standing ? 0.6 : low ? 1 : 0.9) : 0;
  // A shell bursting on the exterior wall is still outside the room. Do not mistake the wall's
  // building id for an interior detonation just because its occupants share that id.
  if (sameBuilding && !samePosition) cover = Math.max(cover, BARRIER[burstTerrain] ?? 0);
  const dx = s.pos.x - burst.x, dy = s.pos.y - burst.y, length2 = dx * dx + dy * dy;
  const steps = Math.ceil(Math.sqrt(length2) / 0.2);
  let last = -1;
  for (let k = 1; k < steps; k++) {
    const f = k / steps, x = Math.floor(burst.x + dx * f), y = Math.floor(burst.y + dy * f);
    const i = y * map.width + x;
    if (!inBounds(map, x, y) || i === last || i === ti || i === bi) continue;
    last = i;
    // A partition can shield another room even when both rooms share the building id.
    cover = Math.max(cover, BARRIER[tileAt(map, x, y)] ?? 0);
  }
  const transmission = 1 - clamp(cover, 0, 0.95);
  return {
    cover,
    injury: (standing ? 1.25 : low ? 0.3 : 0.7) * transmission,
    force: (standing ? 1.2 : low ? 0.3 : 0.6) * transmission ** 1.5,
    // Shelter reduces the physical shock, but a nearby explosion remains audible and frightening.
    shock: (standing ? 1 : low ? 0.65 : 0.8) * (0.2 + 0.8 * transmission),
  };
}
