// ============================================================================
// teamGrid.ts — the 5x3 grid of friendly-team boxes at the left of the bottom
// strip (x 0..333, y 672..736; the original's 67x20 slots). Each occupied box:
// a team-type icon, a coloured name bar, and the status word below it in
// white. Click selects + centres camera.
// ============================================================================
import type { Rect, InputState, Team, BattleState, Soldier } from '@/shared/types';
import { HUD } from '@/render/palette';
import { getTeamIcon } from '@/render/sprites';
import { drawHudBevel, hitRect, setHudFont, clipTextToWidth, fitHudText, teamBarColor, teamDisplayName, teamStatusLabel, teamStatusTextColor, tintedTeamIcon } from './hudChrome';

const COLS = 5;
const ROWS = 3;
const GRID_X = 0;
const GRID_Y = 672;
const BOX_W = 65;
const BOX_H = 20;
const GAP = 2;

export const TEAM_GRID_RECT: Rect = { x: GRID_X, y: GRID_Y, w: COLS * (BOX_W + GAP), h: ROWS * (BOX_H + GAP) };

function boxRect(index: number): Rect {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: GRID_X + col * (BOX_W + GAP),
    y: GRID_Y + row * (BOX_H + GAP),
    w: BOX_W,
    h: BOX_H,
  };
}

export interface TeamGridClick {
  id: number;
  /** Shift was held: caller should toggle this id into the selection rather
   * than replacing it. */
  shift: boolean;
  /** Second click on the same box within the double-click window: caller
   * should centre the camera on this team. */
  doubleClick: boolean;
}

const DOUBLE_CLICK_MS = 350;

export class TeamGrid {
  private hoverIndex = -1;
  private lastClickIndex = -1;
  private lastClickTime = 0;

  update(input: InputState, teams: Team[]): TeamGridClick | null {
    this.hoverIndex = -1;
    let clicked: TeamGridClick | null = null;
    const now = performance.now();
    for (let i = 0; i < COLS * ROWS; i++) {
      const r = boxRect(i);
      if (hitRect(input.mouse, r) && !(i < teams.length && teams[i].outOfAction)) this.hoverIndex = i;
      if (i >= teams.length || teams[i].outOfAction) continue;
      for (const c of input.clicks) {
        if (c.button === 0 && hitRect({ x: c.x, y: c.y }, r)) {
          const doubleClick = this.lastClickIndex === i && now - this.lastClickTime < DOUBLE_CLICK_MS;
          clicked = { id: teams[i].id, shift: input.keysDown.has('shift'), doubleClick };
          this.lastClickIndex = i;
          this.lastClickTime = now;
        }
      }
    }
    return clicked;
  }

  draw(ctx: CanvasRenderingContext2D, teams: Team[], state: BattleState, selectedTeamIds: number[] | number | null): void {
    const selected = Array.isArray(selectedTeamIds)
      ? new Set(selectedTeamIds)
      : new Set(selectedTeamIds != null ? [selectedTeamIds] : []);
    for (let i = 0; i < COLS * ROWS; i++) {
      const r = boxRect(i);
      const team = i < teams.length ? teams[i] : null;
      this.drawBox(ctx, r, team, state, team != null && selected.has(team.id), this.hoverIndex === i);
    }
  }
  private drawBox(
    ctx: CanvasRenderingContext2D,
    r: Rect,
    team: Team | null,
    state: BattleState,
    selected: boolean,
    hot: boolean,
  ): void {
    // Raised 1px bevel per cell (light top/left, dark bottom/right) for the
    // console's slight 3D panel feel, rather than a flat rectangle.
    drawHudBevel(ctx, r, false, HUD.base);
    if (!team) return;

    // The original's slot: a small icon left, a green name bar over the rest,
    // and the status word in white centred below the bar.
    const iconAreaW = 20;
    const iconRect: Rect = { x: r.x + 1, y: r.y + 1, w: iconAreaW - 2, h: r.h - 2 };
    ctx.fillStyle = '#241009';
    ctx.fillRect(Math.round(iconRect.x), Math.round(iconRect.y), Math.round(iconRect.w), Math.round(iconRect.h));
    const icon = tintedTeamIcon(getTeamIcon(team.type), team.type);
    ctx.imageSmoothingEnabled = false;
    // Square 18x18 icon art centred in the 18x18 cell (refs11/12: the icon is
    // small and square-ish, tighter than the 40x26 source art). Clip so wide
    // art never bleeds into the bar.
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.round(iconRect.x), Math.round(iconRect.y), Math.round(iconRect.w), Math.round(iconRect.h));
    ctx.clip();
    ctx.drawImage(icon, Math.round(iconRect.x + (iconRect.w - 18) / 2), Math.round(iconRect.y + (iconRect.h - 18) / 2), 18, 18);
    ctx.restore();

    const barX = r.x + iconAreaW + 1;
    const barW = r.w - iconAreaW - 3;
    const barColor = teamBarColor(team);
    const barRect: Rect = { x: barX, y: r.y + 1, w: barW, h: 8 };
    ctx.fillStyle = barColor;
    ctx.fillRect(Math.round(barRect.x), Math.round(barRect.y), Math.round(barRect.w), Math.round(barRect.h));

    const nameOnDark = barColor === HUD.darkRed || barColor === HUD.red;
    const nameFit = fitHudText(ctx, [teamDisplayName(team.name)], barW - 3);
    ctx.font = nameFit.font;
    ctx.fillStyle = nameOnDark ? HUD.text : HUD.black;
    ctx.fillText(nameFit.text, Math.round(barX + 2), Math.round(barRect.y + 1));
    ctx.font = 'bold 6px Arial, Helvetica, sans-serif';

    // Out-of-action boxes stay in the roster (greyed) so the player sees why a team is gone.
    const statusFit = fitHudText(ctx, [teamStatusLabel(team.status)], barW - 2, 2);
    ctx.font = statusFit.font;
    ctx.fillStyle = team.outOfAction ? HUD.red : teamStatusTextColor(team.status);
    ctx.fillText(statusFit.text, Math.round(barX + barW / 2), Math.round(r.y + 11));
    ctx.textAlign = 'left';

    if (team.outOfAction) {
      // Grey the icon + name bar of a knocked-out/destroyed team; the red status word stays readable.
      ctx.fillStyle = 'rgba(40,36,34,0.6)';
      ctx.fillRect(Math.round(r.x) + 1, Math.round(r.y) + 1, Math.round(r.w) - 2, 8);
      ctx.fillRect(Math.round(r.x) + 1, Math.round(r.y) + 9, iconAreaW - 1, Math.round(r.h) - 10);
      return;
    }

    if (selected) {
      ctx.strokeStyle = HUD.gold;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    } else if (hot) {
      ctx.strokeStyle = HUD.bevelLight;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    }
  }
}
