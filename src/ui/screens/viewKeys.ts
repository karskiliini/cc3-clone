// Pure keyboard helpers shared by the battle and deployment screens (node-testable).
import type { GameSettings, Order, OrderType, Vec2 } from '@/shared/types';

/** Tab toggles the depth map view. Returns true when the key was handled. */
export function handleDepthMapKey(keysPressed: ReadonlySet<string>, settings: GameSettings): boolean {
  if (!keysPressed.has('tab')) return false;
  settings.showDepthMap = !settings.showDepthMap;
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

/** Marker drag-n-drop (user request): releasing a dragged order marker re-issues the team's
 * order at the drop point, keeping the order type. Dragging the ENDPOINT preserves the
 * earlier Shift-click waypoints — the drag edits only the final leg. Dragging a WAYPOINT
 * dot rewrites that waypoint in place (same chain length). Returns the order to issue,
 * or null when the marker no longer matches the team's order (stale drag). */
export function reissueOrderOnMarkerDrag(
  current: Order | null,
  drag: { kind: 'target' | 'waypoint'; index: number; orderType: OrderType },
  dropPoint: Vec2,
): Order | null {
  if (!current || current.type !== drag.orderType) return null;
  if (drag.kind === 'waypoint') {
    if (current.type !== 'move' && current.type !== 'moveFast' && current.type !== 'sneak') return null;
    const wps = current.waypoints;
    if (!wps || drag.index >= wps.length) return null;
    return { ...current, waypoints: wps.map((w, i) => (i === drag.index ? dropPoint : w)) };
  }
  return { ...current, target: dropPoint };
}
