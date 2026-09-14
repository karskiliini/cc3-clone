// ============================================================================
// orderMarkers.ts — order endpoints for the player's teams on the battle map.
//
// Every friendly team with an active Move / Move Fast / Sneak / Fire / Smoke
// order always shows its endpoint (order-colour dot at the final target, small
// dots at the waypoints still ahead); Defend / Ambush show their arc at the
// team. Lines (team -> waypoints -> endpoint) are drawn only for selected teams
// and for the team whose marker is hovered. Enemy orders are never shown.
// ============================================================================
import type { BattleState, Camera, Side, Team, Vec2 } from '@/shared/types';
import { ORDER_DOT_COLOR, TILE_PX } from '@/shared/types';
import { facingAngle } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { attackPhase, isOrderActive } from '@/sim/orders';

export interface OrderMarkerHit { teamId: number; kind: 'target' | 'waypoint'; index: number }

/** Screen-space pick radius (px). */
export const ORDER_MARKER_PICK_PX = 7;
const DOT_R = 2.5;
const WAYPOINT_R = 1.75;
const UNSELECTED_ALPHA = 0.7;

function isMoveType(t: string): boolean {
  return t === 'move' || t === 'moveFast' || t === 'sneak';
}

/** Teams whose order endpoints can be shown: the viewer's own, in action, with an active order. */
function hasEndpoint(state: BattleState, team: Team, playerSide: Side): boolean {
  if (team.side !== playerSide || team.outOfAction || !team.order) return false;
  const t = team.order.type;
  if (t !== 'fire' && t !== 'smoke' && !isMoveType(t)) return false;
  return isOrderActive(state, team);
}

/** Order dot colour: Move blue, Move Fast purple, Sneak yellow, Smoke gray, Fire red (attack unit)
 * or orange (area/suppression fire); Defend/Ambush use their arc colours. */
export function orderMarkerColor(team: Team): string {
  const order = team.order;
  if (!order) return ORDER_DOT_COLOR.move;
  if (order.type === 'fire' && order.targetTeamId == null) return '#e08a2c';
  return ORDER_DOT_COLOR[order.type];
}

/** Hit-test the viewer's own teams' order markers (final targets and waypoint dots) at a screen
 * point; the nearest within ORDER_MARKER_PICK_PX wins. Allocation-free. */
export function pickOrderMarker(state: BattleState, cam: Camera, mouse: Vec2, playerSide: Side): OrderMarkerHit | null {
  const px = TILE_PX * cam.zoom;
  const r2max = ORDER_MARKER_PICK_PX * ORDER_MARKER_PICK_PX;
  let bestD = Infinity;
  let bestTeam = -1;
  let bestKind: 'target' | 'waypoint' = 'target';
  let bestIndex = 0;
  for (const team of state.teams.values()) {
    if (!hasEndpoint(state, team, playerSide)) continue;
    const order = team.order!;
    let dx = (order.target.x - cam.x) * px - mouse.x;
    let dy = (order.target.y - cam.y) * px - mouse.y;
    let d2 = dx * dx + dy * dy;
    if (d2 <= r2max && d2 < bestD) { bestD = d2; bestTeam = team.id; bestKind = 'target'; bestIndex = 0; }
    const wps = isMoveType(order.type) ? order.waypoints : undefined;
    if (!wps) continue;
    for (let i = 0; i < wps.length; i++) {
      dx = (wps[i].x - cam.x) * px - mouse.x;
      dy = (wps[i].y - cam.y) * px - mouse.y;
      d2 = dx * dx + dy * dy;
      if (d2 <= r2max && d2 < bestD) { bestD = d2; bestTeam = team.id; bestKind = 'waypoint'; bestIndex = i; }
    }
  }
  return bestTeam < 0 ? null : { teamId: bestTeam, kind: bestKind, index: bestIndex };
}

/** The screen points of a team's order line, in draw order: team, remaining waypoints, target. */
export function orderLinePoints(team: Team): Vec2[] {
  const order = team.order;
  if (!order) return [];
  const pts: Vec2[] = [team.pos];
  if (isMoveType(order.type) && order.waypoints) for (const w of order.waypoints) pts.push(w);
  pts.push(order.target);
  return pts;
}

function drawDot(ctx: CanvasRenderingContext2D, p: Vec2, r: number, color: string, hollow: boolean, outline: boolean): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  if (hollow) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
  else { ctx.fillStyle = color; ctx.fill(); }
  if (outline) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawAttackRings(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, team: Team, color: string): void {
  const order = team.order!;
  const target = order.targetTeamId != null ? state.teams.get(order.targetTeamId) : undefined;
  if (!target) return;
  ctx.globalAlpha *= 0.8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (target.vehicleId != null) {
    const v = state.vehicles.get(target.vehicleId);
    if (v && state.spottedVehicles[team.side].has(v.id)) {
      const p = worldToScreen(cam, v.pos);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12 * cam.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }
  for (const id of target.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated' || !state.spotted[team.side].has(id)) continue;
    const p = worldToScreen(cam, s.pos);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 * cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Draw every friendly team's order endpoints; lines for selected teams and the hovered one. */
export function drawOrderMarkers(
  ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side,
  selectedTeamIds: readonly number[], hover: { teamId: number } | null,
): void {
  ctx.save();
  for (const team of state.teams.values()) {
    if (team.side !== playerSide || team.outOfAction || !team.order) continue;
    const order = team.order;
    const selected = selectedTeamIds.includes(team.id);
    const hovered = hover != null && hover.teamId === team.id;
    const color = orderMarkerColor(team);
    ctx.globalAlpha = selected || hovered ? 1 : UNSELECTED_ALPHA;

    if (order.type === 'defend' || order.type === 'ambush') {
      const from = worldToScreen(cam, team.pos);
      const rad = facingAngle(team.facing) - Math.PI / 2;
      const spread = Math.PI / 6; // 30deg either side = 60deg arc
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(from.x, from.y, (selected ? 20 : 16) * cam.zoom, rad - spread, rad + spread);
      ctx.stroke();
      continue;
    }
    if (!hasEndpoint(state, team, playerSide)) continue;

    const lost = order.type === 'fire' && order.targetTeamId != null && attackPhase(state, order) !== 'tracking';
    const showLine = selected || hovered;
    if (showLine) {
      ctx.save();
      if (lost) ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (lost) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const pts = orderLinePoints(team);
      for (let i = 0; i < pts.length; i++) {
        const p = worldToScreen(cam, pts[i]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    const scale = selected || hovered ? 1 : 0.8;
    if (isMoveType(order.type) && order.waypoints) {
      for (const w of order.waypoints) drawDot(ctx, worldToScreen(cam, w), WAYPOINT_R * scale * (hovered ? 1.3 : 1), color, false, false);
    }
    const end = worldToScreen(cam, order.target);
    if (lost) ctx.globalAlpha *= 0.55;
    drawDot(ctx, end, (lost ? 3 : DOT_R) * scale * (hovered ? 1.4 : 1), color, lost, hovered);
    if (order.type === 'fire' && order.targetTeamId != null && !lost && showLine) {
      ctx.save();
      drawAttackRings(ctx, cam, state, team, color);
      ctx.restore();
    }
  }
  ctx.restore();
}
