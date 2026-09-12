// ============================================================================
// teamList.ts — bottom-left panel (0,480,200,120): friendly team roster.
// ============================================================================
import type { Rect, InputState, Team, BattleState, TeamStatusWord, Soldier } from '@/shared/types';
import { pointInRect, clamp } from '@/shared/math';
import { PALETTE, HEALTH_COLOR, STATUS_COLOR } from '@/render/palette';
import { drawText, textWidth, FONT_SMALL_H } from '@/render/pixelfont';
import { getTeamIcon } from '@/render/sprites';
import { drawPanel, drawListRow, drawScrollArrows, hitRect } from '@/ui/chrome';

const TITLE_H = 12;
const ROW_H = 14;
const VISIBLE_ROWS = 7;
const ARROWS_H = 10;

const STATUS_ABBREV: Partial<Record<TeamStatusWord, string>> = {
  'Moving Fast': 'Mv Fast',
  Defending: 'Defend',
  Ambushing: 'Ambush',
  Surrendered: 'Surr.',
  'Knocked Out': 'KO',
  Destroyed: 'Dead',
};

function abbreviateStatus(word: TeamStatusWord): string {
  return STATUS_ABBREV[word] ?? word;
}

function truncateToWidth(text: string, maxW: number): string {
  if (textWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 0 && textWidth(s) > maxW) s = s.slice(0, -1);
  return s;
}

export class TeamListPanel {
  rect: Rect = { x: 0, y: 480, w: 200, h: 120 };
  scroll = 0;
  private hoverRow = -1;
  private hoverUp = false;
  private hoverDown = false;

  private listRect(): Rect {
    return { x: this.rect.x, y: this.rect.y + TITLE_H, w: this.rect.w, h: ROW_H * VISIBLE_ROWS };
  }

  private arrowsRect(): Rect {
    return { x: this.rect.x, y: this.rect.y + TITLE_H + ROW_H * VISIBLE_ROWS, w: this.rect.w, h: ARROWS_H };
  }

  private maxScroll(teams: Team[]): number {
    return Math.max(0, teams.length - VISIBLE_ROWS);
  }

  /** Updates hover/scroll state; returns the clicked team's id, or null. */
  update(input: InputState, teams: Team[], _state: BattleState): number | null {
    this.hoverRow = -1;
    this.hoverUp = false;
    this.hoverDown = false;
    const maxScroll = this.maxScroll(teams);

    if (pointInRect(input.mouse, this.rect) && input.wheel !== 0) {
      this.scroll = clamp(this.scroll + Math.sign(input.wheel), 0, maxScroll);
    }

    const arrows = this.arrowsRect();
    const halfW = Math.floor(arrows.w / 2);
    const upRect: Rect = { x: arrows.x, y: arrows.y, w: halfW, h: arrows.h };
    const downRect: Rect = { x: arrows.x + halfW, y: arrows.y, w: arrows.w - halfW, h: arrows.h };
    this.hoverUp = pointInRect(input.mouse, upRect);
    this.hoverDown = pointInRect(input.mouse, downRect);

    let clickedTeamId: number | null = null;
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (hitRect(p, upRect)) { this.scroll = clamp(this.scroll - 1, 0, maxScroll); continue; }
      if (hitRect(p, downRect)) { this.scroll = clamp(this.scroll + 1, 0, maxScroll); continue; }
      const list = this.listRect();
      if (hitRect(p, list)) {
        const rowIdx = Math.floor((p.y - list.y) / ROW_H);
        const teamIdx = this.scroll + rowIdx;
        if (rowIdx >= 0 && rowIdx < VISIBLE_ROWS && teamIdx < teams.length) {
          clickedTeamId = teams[teamIdx].id;
        }
      }
    }

    // clamp scroll if the roster shrank
    this.scroll = clamp(this.scroll, 0, maxScroll);

    if (pointInRect(input.mouse, this.listRect())) {
      const list = this.listRect();
      const rowIdx = Math.floor((input.mouse.y - list.y) / ROW_H);
      if (rowIdx >= 0 && rowIdx < VISIBLE_ROWS && this.scroll + rowIdx < teams.length) this.hoverRow = rowIdx;
    }

    return clickedTeamId;
  }

  draw(ctx: CanvasRenderingContext2D, teams: Team[], state: BattleState, selectedTeamId: number | null): void {
    drawPanel(ctx, this.rect, { title: 'TEAMS' });
    const list = this.listRect();

    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const teamIdx = this.scroll + i;
      const rowRect: Rect = { x: list.x, y: list.y + i * ROW_H, w: list.w, h: ROW_H };
      if (teamIdx >= teams.length) continue;
      const team = teams[teamIdx];
      drawListRow(ctx, rowRect, { hot: this.hoverRow === i, selected: team.id === selectedTeamId });
      this.drawRow(ctx, rowRect, team, state);
    }

    drawScrollArrows(ctx, this.arrowsRect(), this.hoverUp, this.hoverDown);
  }

  private drawRow(ctx: CanvasRenderingContext2D, r: Rect, team: Team, state: BattleState): void {
    const dim = team.outOfAction;
    const prevAlpha = ctx.globalAlpha;
    if (dim) ctx.globalAlpha = 0.55;

    // icon (icon id == TeamType string, matches getTeamIcon's key set)
    const icon = getTeamIcon(team.type);
    ctx.drawImage(icon, Math.round(r.x + 2), Math.round(r.y + (r.h - 12) / 2));

    // name, truncated to ~90px
    const nameColor = dim ? PALETTE.dim : PALETTE.text;
    const name = truncateToWidth(team.name, 90);
    drawText(ctx, name, Math.round(r.x + 16), Math.round(r.y + (r.h - FONT_SMALL_H) / 2), nameColor, 'small');

    // up to 10 tiny 3x5 soldier figures colored by health
    const figX0 = r.x + 110;
    const figY = Math.round(r.y + (r.h - 5) / 2);
    const soldiers: Soldier[] = team.soldierIds
      .map((id) => state.soldiers.get(id))
      .filter((s): s is Soldier => !!s)
      .slice(0, 10);
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      const fx = Math.round(figX0 + i * 4);
      ctx.fillStyle = HEALTH_COLOR[s.health];
      ctx.fillRect(fx, figY, 3, 5);
    }

    if (dim) ctx.globalAlpha = prevAlpha;

    // status word, right-aligned at x=198 (relative to rect x=0; offset by rect.x)
    const statusText = abbreviateStatus(team.status);
    const color = dim ? PALETTE.dim : STATUS_COLOR(team.status);
    const rightX = this.rect.x + 198;
    const w = textWidth(statusText);
    drawText(ctx, statusText, Math.round(rightX - w), Math.round(r.y + (r.h - FONT_SMALL_H) / 2), color, 'small');
  }
}
