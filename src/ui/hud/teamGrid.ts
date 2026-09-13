// ============================================================================
// teamGrid.ts — the 5x3 grid of friendly-team boxes at the left of the bottom
// panel (x 0..~620, y 632..725). Each occupied box: a team-type icon, a
// coloured name bar, and the status word. Click selects + centres camera.
// ============================================================================
import type { Rect, InputState, Team, BattleState, Soldier } from '@/shared/types';
import { HUD } from '@/render/palette';
import { getTeamIcon } from '@/render/sprites';
import { drawHudBevel, hitRect, setHudFont, clipTextToWidth, teamBarColor, teamStatusLabel, teamStatusTextColor, tintedTeamIcon } from './hudChrome';

const COLS = 5;
const ROWS = 3;
const GRID_X = 0;
const GRID_Y = 632;
const BOX_W = 123;
const BOX_H = 31;
const GAP = 1;

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

export class TeamGrid {
  private hoverIndex = -1;

  update(input: InputState, teams: Team[]): number | null {
    this.hoverIndex = -1;
    let clicked: number | null = null;
    for (let i = 0; i < COLS * ROWS; i++) {
      const r = boxRect(i);
      if (hitRect(input.mouse, r)) this.hoverIndex = i;
      if (i >= teams.length) continue;
      for (const c of input.clicks) {
        if (c.button === 0 && hitRect({ x: c.x, y: c.y }, r)) clicked = teams[i].id;
      }
    }
    return clicked;
  }

  draw(ctx: CanvasRenderingContext2D, teams: Team[], state: BattleState, selectedTeamId: number | null): void {
    for (let i = 0; i < COLS * ROWS; i++) {
      const r = boxRect(i);
      const team = i < teams.length ? teams[i] : null;
      this.drawBox(ctx, r, team, state, team != null && team.id === selectedTeamId, this.hoverIndex === i);
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

    const iconAreaW = 30;
    const iconRect: Rect = { x: r.x + 1, y: r.y + 1, w: iconAreaW - 2, h: r.h - 2 };
    ctx.fillStyle = '#241009';
    ctx.fillRect(Math.round(iconRect.x), Math.round(iconRect.y), Math.round(iconRect.w), Math.round(iconRect.h));
    const icon = tintedTeamIcon(getTeamIcon(team.type), team.type);
    const iconScale = 2;
    const iw = icon.width * iconScale, ih = icon.height * iconScale;
    ctx.imageSmoothingEnabled = false;
    // Clip the (often wider-than-the-slot) icon art to its icon cell so it
    // never bleeds into the status-word column to its right.
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.round(iconRect.x), Math.round(iconRect.y), Math.round(iconRect.w), Math.round(iconRect.h));
    ctx.clip();
    ctx.drawImage(icon, Math.round(iconRect.x + (iconRect.w - iw) / 2), Math.round(iconRect.y + (iconRect.h - ih) / 2), iw, ih);
    ctx.restore();

    const barX = r.x + iconAreaW + 2;
    const barW = r.w - iconAreaW - 4;
    const barColor = teamBarColor(team);
    const barRect: Rect = { x: barX, y: r.y + 2, w: barW, h: 12 };
    ctx.fillStyle = barColor;
    ctx.fillRect(Math.round(barRect.x), Math.round(barRect.y), Math.round(barRect.w), Math.round(barRect.h));

    const nameOnDark = barColor === HUD.darkRed || barColor === HUD.red;
    setHudFont(ctx, 'tiny');
    ctx.fillStyle = nameOnDark ? HUD.text : HUD.black;
    ctx.fillText(clipTextToWidth(ctx, team.name, barW - 4), Math.round(barX + 2), Math.round(barRect.y + 1));

    setHudFont(ctx, 'small');
    ctx.fillStyle = teamStatusTextColor(team.status);
    const label = teamStatusLabel(team.status);
    ctx.fillText(clipTextToWidth(ctx, label, barW - 2), Math.round(barX + 1), Math.round(r.y + 16));

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
