// ============================================================================
// battleInput.ts — map-view input shared by the deploy and battle screens:
// edge-scroll / arrow-key / drag panning, and forgiving screen-space picking
// of friendly teams. Nothing here owns simulation state.
// ============================================================================
import type { BattleState, Camera, InputState, Side, Team, Vec2 } from '@/shared/types';
import { VIEW_W, VIEW_H, TILE_M, TILE_PX } from '@/shared/types';
import { panCamera, clampCamera, worldToScreen } from '@/engine/camera';
import { VEHICLE_DEFS } from '@/data/units';

/** Edge-scroll (cursor near the viewport border) + arrow-key panning, clamped to the map. */
const EDGE_PX = 8;          // width of the edge-scroll hot zone
const EDGE_ACCEL_PX = 3;    // outermost band of the hot zone: faster scroll
const EDGE_SPEED = 700;     // px/s (base)
const EDGE_ACCEL_MULT = 1.6;
const EDGE_DWELL_S = 0.12;  // must dwell in the zone this long before it starts
const KEY_SPEED = 700;      // px/s, arrow keys — instant, no dwell

export interface EdgeScrollState {
  dwellLeft: number;
  dwellRight: number;
  dwellTop: number;
  dwellBottom: number;
}

export function makeEdgeScrollState(): EdgeScrollState {
  return { dwellLeft: 0, dwellRight: 0, dwellTop: 0, dwellBottom: 0 };
}

/** One edge's dwell-then-scroll speed (px/s), or 0 while not yet past the
 * dwell threshold / not active. Mutates `dwellRef` in place (no allocation). */
function edgeSpeed(active: boolean, distFromEdge: number, dt: number, dwellRef: EdgeScrollState, key: keyof EdgeScrollState): number {
  if (!active) {
    dwellRef[key] = 0;
    return 0;
  }
  dwellRef[key] += dt;
  if (dwellRef[key] < EDGE_DWELL_S) return 0;
  return distFromEdge <= EDGE_ACCEL_PX ? EDGE_SPEED * EDGE_ACCEL_MULT : EDGE_SPEED;
}

/**
 * Edge-scroll (mouse near the viewport edge, excluding the bottom panel) and
 * arrow-key scroll, combined into one smooth per-frame camera pan.
 * - Edge-scroll only engages when the pointer is inside the canvas, requires
 *   a short dwell before it starts (so passing the mouse over the edge on
 *   the way elsewhere doesn't yank the camera), and accelerates in the
 *   outermost few pixels of the hot zone.
 * - Arrow keys pan immediately, no dwell.
 * - Stops instantly when the pointer leaves the canvas/window or the window
 *   loses focus (via input.pointerInside, cleared by engine/input.ts).
 */
export function updateCameraEdgeScrollAndKeys(
  cam: Camera,
  input: InputState,
  dt: number,
  mapW: number,
  mapH: number,
  edgeState: EdgeScrollState,
): void {
  const inside = input.pointerInside && input.mouse.x >= 0 && input.mouse.x <= VIEW_W && input.mouse.y >= 0 && input.mouse.y <= VIEW_H;

  const leftActive = inside && input.mouse.x < EDGE_PX;
  const rightActive = inside && input.mouse.x > VIEW_W - EDGE_PX;
  const topActive = inside && input.mouse.y < EDGE_PX;
  const bottomActive = inside && input.mouse.y > VIEW_H - EDGE_PX;

  const leftSpd = edgeSpeed(leftActive, input.mouse.x, dt, edgeState, 'dwellLeft');
  const rightSpd = edgeSpeed(rightActive, VIEW_W - input.mouse.x, dt, edgeState, 'dwellRight');
  const topSpd = edgeSpeed(topActive, input.mouse.y, dt, edgeState, 'dwellTop');
  const bottomSpd = edgeSpeed(bottomActive, VIEW_H - input.mouse.y, dt, edgeState, 'dwellBottom');

  let dx = (rightSpd - leftSpd) * dt;
  let dy = (bottomSpd - topSpd) * dt;

  // WASD panning is suppressed while Ctrl/Cmd is held so Ctrl+A ("select
  // all") doesn't also nudge the camera.
  const wasdOk = !input.keysDown.has('control') && !input.keysDown.has('meta');
  let kx = 0;
  let ky = 0;
  if (input.keysDown.has('arrowleft') || (wasdOk && input.keysDown.has('a'))) kx -= 1;
  if (input.keysDown.has('arrowright') || (wasdOk && input.keysDown.has('d'))) kx += 1;
  if (input.keysDown.has('arrowup') || (wasdOk && input.keysDown.has('w'))) ky -= 1;
  if (input.keysDown.has('arrowdown') || (wasdOk && input.keysDown.has('s'))) ky += 1;
  dx += kx * KEY_SPEED * dt;
  dy += ky * KEY_SPEED * dt;

  if (dx !== 0 || dy !== 0) panCamera(cam, dx, dy);
  clampCamera(cam, mapW, mapH);
}

export interface DragPanState {
  active: boolean;
  lastX: number;
  lastY: number;
}

export function makeDragPanState(): DragPanState {
  return { active: false, lastX: 0, lastY: 0 };
}

/** Simple right-drag pan (no click/drag distinction) — used by screens without a command menu. */
export function updateRightDragPan(cam: Camera, input: InputState, s: DragPanState, mapW: number, mapH: number): void {
  updateDragPanIf(cam, input, s, mapW, mapH, input.buttons.right);
}

/** Middle-button drag, or Space+left-drag, pans the map — a modern-feeling
 * alternative to right-drag that doesn't tie up the right button. Returns
 * whether the pan gesture is currently active, so callers can suppress their
 * own left-click/drag-select handling while Space is held down. */
export function updateModernDragPan(cam: Camera, input: InputState, s: DragPanState, mapW: number, mapH: number): boolean {
  const active = input.buttons.middle || ((input.keysDown.has(' ') || input.keysDown.has('spacebar')) && input.buttons.left);
  updateDragPanIf(cam, input, s, mapW, mapH, active);
  return active;
}

/** Shared drag-pan mechanics: while `active`, panning follows pointer motion
 * 1:1 (grab-and-drag); otherwise the gesture resets. */
function updateDragPanIf(cam: Camera, input: InputState, s: DragPanState, mapW: number, mapH: number, active: boolean): void {
  if (active) {
    if (!s.active) {
      s.active = true;
      s.lastX = input.mouse.x;
      s.lastY = input.mouse.y;
    } else {
      const dx = input.mouse.x - s.lastX;
      const dy = input.mouse.y - s.lastY;
      if (dx !== 0 || dy !== 0) {
        panCamera(cam, -dx, -dy);
        s.lastX = input.mouse.x;
        s.lastY = input.mouse.y;
      }
    }
  } else {
    s.active = false;
  }
  clampCamera(cam, mapW, mapH);
}

// ============================================================================
// SCREEN-SPACE HIT-TESTING — selecting a team should feel forgiving and
// zoom-independent, like the original: pick the nearest friendly soldier
// within a fixed screen-pixel radius, else fall back to a team's bounding
// circle, else a vehicle's rotated hull rectangle (+ a few px of slop).
// ============================================================================
const SOLDIER_PICK_PX = 14;
const TEAM_CIRCLE_SLOP_PX = 12;
const VEHICLE_HULL_SLOP_PX = 6;

/** Nearest living friendly soldier whose on-screen position is within
 * `SOLDIER_PICK_PX` screen pixels of `screenPt`, regardless of zoom. */
function pickFriendlySoldierScreen(state: BattleState, cam: Camera, screenPt: Vec2, side: Side): Team | null {
  let bestTeam: Team | null = null;
  let bestD = SOLDIER_PICK_PX;
  for (const s of state.soldiers.values()) {
    if (s.side !== side || s.health === 'dead') continue;
    const p = worldToScreen(cam, s.pos);
    const d = Math.hypot(p.x - screenPt.x, p.y - screenPt.y);
    if (d <= bestD) {
      const team = state.teams.get(s.teamId);
      if (team) { bestD = d; bestTeam = team; }
    }
  }
  return bestTeam;
}

/** Screen-space team bounding circle: centre = centroid of the team's alive
 * soldiers (or vehicle position), radius = the furthest member from that
 * centre plus a fixed px margin, so a click anywhere near a spread-out
 * team's footprint still hits it. */
function teamBoundingCircleScreen(state: BattleState, cam: Camera, team: Team): { c: Vec2; r: number } | null {
  const pts: Vec2[] = [];
  for (const sid of team.soldierIds) {
    const s = state.soldiers.get(sid);
    if (s && s.health !== 'dead') pts.push(worldToScreen(cam, s.pos));
  }
  if (pts.length === 0) {
    if (team.vehicleId == null) return null;
    const v = state.vehicles.get(team.vehicleId);
    if (!v) return null;
    pts.push(worldToScreen(cam, v.pos));
  }
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
  return { c: { x: cx, y: cy }, r: r + TEAM_CIRCLE_SLOP_PX };
}

/** Point-in-rotated-rectangle test, in screen space, expanded by `slopPx` on
 * every side — used for a vehicle's hull (heading: 0 = north, clockwise). */
function pointInRotatedRectScreen(p: Vec2, centre: Vec2, halfLenPx: number, halfWidPx: number, headingRad: number, slopPx: number): boolean {
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  const cos = Math.cos(-headingRad);
  const sin = Math.sin(-headingRad);
  const lx = dx * sin - dy * cos; // along the hull's length axis
  const ly = dx * cos + dy * sin; // across the hull's width axis
  return Math.abs(lx) <= halfLenPx + slopPx && Math.abs(ly) <= halfWidPx + slopPx;
}

/**
 * Selecting a team the way the original felt: forgiving, not pixel-precise.
 * Tries, in order: the nearest friendly soldier within a fixed screen-px
 * radius (independent of zoom), then any friendly team's screen-space
 * bounding circle, then any friendly vehicle's rotated hull rectangle
 * (+ slop). Returns the hit team, or null.
 */
export function pickFriendlyTeamScreen(state: BattleState, cam: Camera, screenPt: Vec2, side: Side): Team | null {
  const soldierHit = pickFriendlySoldierScreen(state, cam, screenPt, side);
  if (soldierHit) return soldierHit;

  for (const team of state.teams.values()) {
    if (team.side !== side || team.outOfAction) continue;
    const circle = teamBoundingCircleScreen(state, cam, team);
    if (circle && Math.hypot(screenPt.x - circle.c.x, screenPt.y - circle.c.y) <= circle.r) return team;
  }

  const pxPerTile = TILE_PX * cam.zoom;
  for (const v of state.vehicles.values()) {
    if (v.side !== side) continue;
    const def = VEHICLE_DEFS[v.defId];
    if (!def) continue;
    const centre = worldToScreen(cam, v.pos);
    const halfLenPx = (def.lengthM / TILE_M / 2) * pxPerTile;
    const halfWidPx = (def.widthM / TILE_M / 2) * pxPerTile;
    if (pointInRotatedRectScreen(screenPt, centre, halfLenPx, halfWidPx, v.hullFacing, VEHICLE_HULL_SLOP_PX)) {
      return state.teams.get(v.teamId) ?? null;
    }
  }
  return null;
}
