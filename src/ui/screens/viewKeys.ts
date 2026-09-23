// Pure keyboard helpers shared by the battle and deployment screens (node-testable).
import type { GameSettings, Vec2 } from '@/shared/types';

/** '§' (the key left of 1; '½' with Shift) toggles the depth map view. Returns true when handled. */
export function handleDepthMapKey(keysPressed: ReadonlySet<string>, settings: GameSettings): boolean {
  if (!keysPressed.has('§') && !keysPressed.has('½')) return false;
  settings.showDepthMap = !settings.showDepthMap;
  return true;
}

/** Game speeds, slowest first. */
export const GAME_SPEEDS: readonly GameSettings['speed'][] = [1, 2, 4];

/** Tab steps the game speed up (1x, 2x, 4x, back to 1x). Returns true when the key was handled. */
export function handleSpeedKey(keysPressed: ReadonlySet<string>, settings: GameSettings): boolean {
  if (!keysPressed.has('tab')) return false;
  const i = GAME_SPEEDS.indexOf(settings.speed);
  settings.speed = GAME_SPEEDS[(i + 1) % GAME_SPEEDS.length];
  return true;
}

/** '.' selects the next team, ',' the previous one (wrapping). Returns the new team id, or null
 * when neither key was pressed or there are no teams. */
export function cycleTeamKey(keysPressed: ReadonlySet<string>, teamIds: readonly number[], currentId: number | null): number | null {
  const dir = keysPressed.has('.') ? 1 : keysPressed.has(',') ? -1 : 0;
  if (dir === 0 || teamIds.length === 0) return null;
  const idx = currentId == null ? -1 : teamIds.indexOf(currentId);
  if (idx < 0) return dir > 0 ? teamIds[0] : teamIds[teamIds.length - 1];
  return teamIds[(idx + dir + teamIds.length) % teamIds.length];
}

/** Move-type group order geometry: every point of the chain (Shift-click waypoints in click order,
 * then the final click) shifted by the team's offset from the primary team. */
export function offsetOrderPoints(target: Vec2, waypoints: readonly Vec2[], offset: Vec2): { target: Vec2; waypoints: Vec2[] } {
  return {
    target: { x: target.x + offset.x, y: target.y + offset.y },
    waypoints: waypoints.map((w) => ({ x: w.x + offset.x, y: w.y + offset.y })),
  };
}
