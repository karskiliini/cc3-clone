// ============================================================================
// losTool.ts — Alt+drag LOS line overlay for pending Fire orders: bright
// green where clear, dark green where obscured-but-mostly-clear, red where
// blocked, plus a range label at the cursor coloured by how good that range
// is for the selected team's weapons (green/yellow/red).
// ============================================================================
import type { BattleState, Camera, GameMap, Team, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { losTrace } from '@/sim/los';
import { WEAPONS } from '@/data/weapons';

const BRIGHT_GREEN = '#4ae04a';
const DARK_GREEN = '#2c7a2c';
const RED = '#d02020';
const YELLOW = '#e0c04a';

function drawLine(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
  ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
  ctx.stroke();
}

/** The selected team's best (longest) effective weapon range, in metres. */
function teamMaxRangeM(state: BattleState, team: Team): number {
  let best = 0;
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s) continue;
    const w = WEAPONS[s.weaponId];
    if (w) best = Math.max(best, w.rangeM);
  }
  if (team.vehicleId != null) best = Math.max(best, 600);
  return best || 300;
}

function rangeColor(distM: number, maxRangeM: number): string {
  const ratio = distM / maxRangeM;
  if (ratio <= 0.6) return BRIGHT_GREEN;
  if (ratio <= 1.0) return YELLOW;
  return RED;
}

/** Draws a LOS line from `from` to `to` (tile coords). When `team`/`state`
 * are given, the range label at the cursor is coloured by how good that
 * range is for the team's weapons; otherwise it falls back to clear/blocked. */
export function drawLOSLine(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  map: GameMap,
  from: Vec2,
  to: Vec2,
  context?: { state: BattleState; team: Team },
): void {
  const trace = losTrace(map, from, to);
  const fromPx = worldToScreen(cam, from);
  const toPx = worldToScreen(cam, to);
  const distM = dist(from, to) * TILE_M;

  if (trace.clear || !trace.blockedAt) {
    drawLine(ctx, fromPx, toPx, BRIGHT_GREEN);
  } else {
    const blockedFrac = dist(from, trace.blockedAt) / Math.max(0.001, dist(from, to));
    const blockedPx = worldToScreen(cam, trace.blockedAt);
    // Obscured (dark green) when the block point is near the far end of the
    // line (mostly clear ground with an edge obstruction); otherwise a hard
    // block (red) for most of the shot.
    const midColor = blockedFrac > 0.75 ? DARK_GREEN : BRIGHT_GREEN;
    drawLine(ctx, fromPx, blockedPx, midColor);
    drawLine(ctx, blockedPx, toPx, RED);
  }

  const distLabel = `${Math.round(distM)} m`;
  const color = context ? rangeColor(distM, teamMaxRangeM(context.state, context.team)) : (trace.clear ? BRIGHT_GREEN : RED);
  ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(distLabel, Math.round(toPx.x) + 6, Math.round(toPx.y) - 12);
}
