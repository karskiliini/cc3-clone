// ============================================================================
// combatMessages.ts — the "Combat Messages" column (x 620..1024, y 632..768):
// last 4 messages, each shown as a team-name line + a coloured message line
// with a running message number, scroll arrows, and the red title at bottom.
// ============================================================================
import type { Rect, InputState, BattleState, BattleMessage, Team } from '@/shared/types';
import { HUD } from '@/render/palette';
import { clamp } from '@/shared/math';
import { drawHudBevel, drawHudScrollArrows, hitRect, setHudFont, clipTextToWidth } from './hudChrome';

export const COMBAT_MESSAGES_RECT: Rect = { x: 620, y: 632, w: 168, h: 93 };
const ARROWS_RECT: Rect = { x: 788, y: 632, w: 12, h: 93 };
const TITLE_RECT: Rect = { x: 620, y: 730, w: 180, h: 36 };

const ROW_H = 23;
const VISIBLE_ROWS = 4;

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

/** If `text` begins with a known team's name, split it into (name, rest);
 * otherwise the speaker is displayed as "Report". */
function splitMessage(text: string, teams: Team[]): { who: string; body: string } {
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

export class CombatMessages {
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;

  private maxScroll(total: number): number {
    return Math.max(0, total - VISIBLE_ROWS);
  }

  update(input: InputState, state: BattleState): void {
    const total = state.messages.length;
    const maxScroll = this.maxScroll(total);
    this.hoverUp = hitRect(input.mouse, { x: ARROWS_RECT.x, y: ARROWS_RECT.y, w: ARROWS_RECT.w, h: ARROWS_RECT.h / 2 });
    this.hoverDown = hitRect(input.mouse, { x: ARROWS_RECT.x, y: ARROWS_RECT.y + ARROWS_RECT.h / 2, w: ARROWS_RECT.w, h: ARROWS_RECT.h / 2 });
    if (hitRect(input.mouse, COMBAT_MESSAGES_RECT) && input.wheel !== 0) {
      this.scroll = clamp(this.scroll + Math.sign(input.wheel), 0, maxScroll);
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (this.hoverUp && hitRect(p, { x: ARROWS_RECT.x, y: ARROWS_RECT.y, w: ARROWS_RECT.w, h: ARROWS_RECT.h / 2 })) {
        this.scroll = clamp(this.scroll - 1, 0, maxScroll);
      } else if (this.hoverDown && hitRect(p, { x: ARROWS_RECT.x, y: ARROWS_RECT.y + ARROWS_RECT.h / 2, w: ARROWS_RECT.w, h: ARROWS_RECT.h / 2 })) {
        this.scroll = clamp(this.scroll + 1, 0, maxScroll);
      }
    }
    // Default: pinned to the newest messages unless the user has scrolled back.
    this.scroll = clamp(this.scroll, 0, maxScroll);
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState): void {
    drawHudBevel(ctx, COMBAT_MESSAGES_RECT, true);
    const total = state.messages.length;
    const maxScroll = this.maxScroll(total);
    const endIdx = total - this.scroll; // exclusive
    const startIdx = Math.max(0, endIdx - VISIBLE_ROWS);

    ctx.save();
    ctx.beginPath();
    ctx.rect(COMBAT_MESSAGES_RECT.x, COMBAT_MESSAGES_RECT.y, COMBAT_MESSAGES_RECT.w, COMBAT_MESSAGES_RECT.h);
    ctx.clip();
    const teams = Array.from(state.teams.values());
    for (let row = 0; row < endIdx - startIdx; row++) {
      const idx = startIdx + row;
      const m = state.messages[idx];
      const y = COMBAT_MESSAGES_RECT.y + row * ROW_H;
      const { who, body } = splitMessage(m.text, teams);

      setHudFont(ctx, 'small');
      ctx.fillStyle = HUD.text;
      ctx.fillText(clipTextToWidth(ctx, who, COMBAT_MESSAGES_RECT.w - 30), COMBAT_MESSAGES_RECT.x + 3, y + 1);

      const numLabel = `(${idx + 1})`;
      ctx.fillStyle = HUD.dim;
      ctx.textAlign = 'right';
      ctx.fillText(numLabel, COMBAT_MESSAGES_RECT.x + COMBAT_MESSAGES_RECT.w - 3, y + 1);
      ctx.textAlign = 'left';

      setHudFont(ctx, 'small');
      ctx.fillStyle = msgColor(m.kind);
      ctx.fillText(clipTextToWidth(ctx, body, COMBAT_MESSAGES_RECT.w - 6), COMBAT_MESSAGES_RECT.x + 3, y + 12);
    }
    ctx.restore();

    drawHudScrollArrows(ctx, ARROWS_RECT, this.hoverUp && maxScroll > this.scroll, this.hoverDown && this.scroll > 0);

    setHudFont(ctx, 'map');
    ctx.fillStyle = HUD.titleRed;
    ctx.textAlign = 'right';
    ctx.fillText('Combat Messages', TITLE_RECT.x + TITLE_RECT.w, TITLE_RECT.y + TITLE_RECT.h - 14);
    ctx.textAlign = 'left';
  }
}
