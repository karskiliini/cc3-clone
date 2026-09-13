// ============================================================================
// combatMessages.ts — the "Combat Messages" column (x 620..800, y 632..768):
// last 4 messages, each in its own sunken box (team name + coloured body line)
// with a running number, up/down arrow buttons, and the red title under it.
// ============================================================================
import type { Rect, InputState, BattleState, BattleMessage, Team } from '@/shared/types';
import { HUD } from '@/render/palette';
import { clamp } from '@/shared/math';
import { drawHudBevel, hitRect, setHudFont, clipTextToWidth } from './hudChrome';

/** Wheel-scroll area: the message column plus its arrow buttons (panel + strip rows). */
export const COMBAT_MESSAGES_RECT: Rect = { x: 620, y: 632, w: 182, h: 122 };
const BOX_X = 622;
const BOX_W = 160;
const BOX_H = 24;
/** Top of each visible message box: three in the panel (2px gaps as in ref_cc3_1482, spread to
 * fill y 632..728) and a 4th in the bottom strip, above the title. */
const ROW_YS = [634, 665, 696, 729];
const VISIBLE_ROWS = ROW_YS.length;
const ARROW_W = 12;
const ARROW_H = 14;
const UP_RECT: Rect = { x: 786, y: ROW_YS[0] + (BOX_H - ARROW_H) / 2, w: ARROW_W, h: ARROW_H };
const DOWN_RECT: Rect = { x: 786, y: ROW_YS[VISIBLE_ROWS - 1] + (BOX_H - ARROW_H) / 2, w: ARROW_W, h: ARROW_H };
/** Red title centred under the column (original: x 640..760, bottom of the strip). */
const TITLE_CX = 702;
const TITLE_Y = 754;

function msgColor(kind: BattleMessage['kind']): string {
  switch (kind) {
    case 'warn':
      return HUD.yellow;
    case 'bad':
      return HUD.red;
    case 'good':
      return HUD.green;
    default:
      return HUD.green;
  }
}

/** Messages are stored as `${teamName}\n${body}` at the source (sim/victory,
 * sim/morale, sim/combat); split on that newline. Older/unstructured
 * messages fall back to matching a known team's name as a prefix, or
 * "Report" when no team is identifiable. */
function splitMessage(text: string, teams: Team[]): { who: string; body: string } {
  const nl = text.indexOf('\n');
  if (nl >= 0) return { who: text.slice(0, nl), body: text.slice(nl + 1) };
  let best: Team | null = null;
  for (const t of teams) {
    if (!t.name) continue;
    if (text === t.name || text.startsWith(t.name + ':') || text.startsWith(t.name + ' ')) {
      if (!best || t.name.length > best.name.length) best = t;
    }
  }
  if (!best) return { who: 'Report', body: text };
  let body = text.slice(best.name.length);
  if (body.startsWith(':')) body = body.slice(1);
  return { who: best.name, body: body.trim() || text };
}

function drawArrowButton(ctx: CanvasRenderingContext2D, r: Rect, dir: 'up' | 'down', hot: boolean, enabled: boolean): void {
  drawHudBevel(ctx, r, hot, HUD.face);
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2);
  ctx.fillStyle = enabled ? HUD.text : HUD.dim;
  ctx.beginPath();
  if (dir === 'up') { ctx.moveTo(cx - 4, cy + 2); ctx.lineTo(cx + 4, cy + 2); ctx.lineTo(cx, cy - 3); }
  else { ctx.moveTo(cx - 4, cy - 2); ctx.lineTo(cx + 4, cy - 2); ctx.lineTo(cx, cy + 3); }
  ctx.closePath();
  ctx.fill();
}

export class CombatMessages {
  /** Rows scrolled back from the newest message (0 = pinned to newest). */
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;

  private maxScroll(total: number): number {
    return Math.max(0, total - VISIBLE_ROWS);
  }

  update(input: InputState, state: BattleState): void {
    const total = state.messages.length;
    const maxScroll = this.maxScroll(total);
    this.hoverUp = hitRect(input.mouse, UP_RECT);
    this.hoverDown = hitRect(input.mouse, DOWN_RECT);
    if (hitRect(input.mouse, COMBAT_MESSAGES_RECT) && input.wheel !== 0) {
      // wheel up (negative) reveals older messages, like the up arrow
      this.scroll = clamp(this.scroll - Math.sign(input.wheel), 0, maxScroll);
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (hitRect(p, UP_RECT)) this.scroll = clamp(this.scroll + 1, 0, maxScroll);
      else if (hitRect(p, DOWN_RECT)) this.scroll = clamp(this.scroll - 1, 0, maxScroll);
    }
    this.scroll = clamp(this.scroll, 0, maxScroll);
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState): void {
    const total = state.messages.length;
    const maxScroll = this.maxScroll(total);
    const endIdx = total - this.scroll; // exclusive
    const startIdx = Math.max(0, endIdx - VISIBLE_ROWS);
    const teams = Array.from(state.teams.values());

    for (let row = 0; row < VISIBLE_ROWS; row++) {
      const box: Rect = { x: BOX_X, y: ROW_YS[row], w: BOX_W, h: BOX_H };
      drawHudBevel(ctx, box, true, HUD.black);
      const idx = startIdx + row;
      if (idx >= endIdx) continue;
      const m = state.messages[idx];
      const { who, body } = splitMessage(m.text, teams);

      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
      ctx.clip();
      setHudFont(ctx, 'small');
      const numLabel = `(${idx + 1})`;
      const numW = ctx.measureText(numLabel).width;
      ctx.fillStyle = HUD.text;
      ctx.fillText(clipTextToWidth(ctx, who, box.w - numW - 10), box.x + 3, box.y + 1);
      ctx.fillStyle = HUD.dim;
      ctx.textAlign = 'right';
      ctx.fillText(numLabel, box.x + box.w - 3, box.y + 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = msgColor(m.kind);
      ctx.fillText(clipTextToWidth(ctx, body.replace(/\s+/g, ' '), box.w - 6), box.x + 3, box.y + 12);
      ctx.restore();
    }

    drawArrowButton(ctx, UP_RECT, 'up', this.hoverUp, this.scroll < maxScroll);
    drawArrowButton(ctx, DOWN_RECT, 'down', this.hoverDown, this.scroll > 0);

    setHudFont(ctx, 'map');
    ctx.fillStyle = HUD.titleRed;
    ctx.textAlign = 'center';
    ctx.fillText('Combat Messages', TITLE_CX, TITLE_Y);
    ctx.textAlign = 'left';
  }
}
