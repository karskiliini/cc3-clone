// ============================================================================
// losTool.ts — the aiming line for pending Fire/Smoke orders, coloured along its
// length: bright green where clear, dark green where obscured, red where
// blocked, plus a range label at the cursor coloured by how good that range
// is for the selected team's weapons (green/yellow/red).
// ============================================================================
import type { BattleState, Camera, GameMap, Team, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import type { LosHeights } from '@/sim/los';
import { aimLineProfile, aimPointClass, type AimClass } from '@/sim/losProfile';
import { WEAPONS } from '@/data/weapons';

const BRIGHT_GREEN = '#4ae04a';
const DARK_GREEN = '#2c7a2c';
const RED = '#d02020';
const YELLOW = '#e0c04a';
const CLASS_COLOR: Record<AimClass, string> = { clear: BRIGHT_GREEN, obscured: DARK_GREEN, blocked: RED };

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

/** Draws the aiming line from `from` to `to` (tile coords), coloured along its length by what
 * can actually be seen from `from`: bright green where the view is clear, dark green where it is
 * obscured (tall grass, hedges, smoke, wood edges), red where it is blocked (walls, buildings,
 * dense woods, ground rising in between). The line can turn green again beyond an obstacle when
 * the ground there is visible. When `team`/`state` are given, the range label at the cursor is
 * coloured by how good that range is for the team's weapons. */
export function drawLOSLine(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  map: GameMap,
  from: Vec2,
  to: Vec2,
  context?: { state: BattleState; team: Team },
  heights?: LosHeights,
  opts?: { label?: boolean; alpha?: number },
): void {
  const segs = aimLineProfile(map, from, to, heights);
  const fromPx = worldToScreen(cam, from);
  const toPx = worldToScreen(cam, to);
  const distM = dist(from, to) * TILE_M;
  const at = (t: number): Vec2 => ({ x: fromPx.x + (toPx.x - fromPx.x) * t, y: fromPx.y + (toPx.y - fromPx.y) * t });

  ctx.save();
  ctx.globalAlpha = opts?.alpha ?? 1;
  ctx.lineCap = 'butt';
  // dark under-stroke so the colours hold on bright grass and on snow
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(fromPx.x, fromPx.y);
  ctx.lineTo(toPx.x, toPx.y);
  ctx.stroke();
  ctx.lineWidth = 2;
  for (const seg of segs) {
    const a = at(seg.t0), b = at(seg.t1);
    ctx.strokeStyle = CLASS_COLOR[seg.cls];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // tick where the view is first blocked, so the obstacle is easy to find
  const firstBlocked = segs.find((g) => g.cls === 'blocked');
  if (firstBlocked && firstBlocked.t0 > 0.001) {
    const m = at(firstBlocked.t0);
    const dx = toPx.x - fromPx.x, dy = toPx.y - fromPx.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.x - nx * 5, m.y - ny * 5);
    ctx.lineTo(m.x + nx * 5, m.y + ny * 5);
    ctx.stroke();
  }
  // end dot in the class of the aim point itself
  const endCls = aimPointClass(segs);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath(); ctx.arc(toPx.x, toPx.y, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = CLASS_COLOR[endCls];
  ctx.beginPath(); ctx.arc(toPx.x, toPx.y, 3, 0, Math.PI * 2); ctx.fill();

  if (opts?.label ?? true) {
    const word = endCls === 'clear' ? '' : endCls === 'obscured' ? ' obscured' : ' blocked';
    const distLabel = `${Math.round(distM)} m${word}`;
    const color = context ? rangeColor(distM, teamMaxRangeM(context.state, context.team)) : CLASS_COLOR[endCls];
    ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'top';
    const tx = Math.round(toPx.x) + 8, ty = Math.round(toPx.y) - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(distLabel, tx + 1, ty + 1);
    ctx.fillStyle = endCls === 'blocked' ? RED : color;
    ctx.fillText(distLabel, tx, ty);
  }
  ctx.restore();
}
