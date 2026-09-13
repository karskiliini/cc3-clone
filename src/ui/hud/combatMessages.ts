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
// Right-aligned anchor only (x+w is where the text ends); kept clear of the
// modern order bar, which now occupies x 620..780 in this same strip row.
const TITLE_RECT: Rect = { x: 820, y: 730, w: 200, h: 36 };

const ROW_H = 31;
const VISIBLE_ROWS = 3;
const BODY_LINE_H = 10;

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

/** Greedily word-wraps `text` to fit `maxW`, at most `maxLines` lines; the
 * final line is hard-trimmed (matching clipTextToWidth's no-ellipsis style)
 * if content still overflows. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(test).width > maxW) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const shown = lines.slice(0, maxLines);
  shown[maxLines - 1] = clipTextToWidth(ctx, shown[maxLines - 1], maxW);
  return shown;
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
      const bodyLines = wrapLines(ctx, body, COMBAT_MESSAGES_RECT.w - 6, 2);
      for (let li = 0; li < bodyLines.length; li++) {
        ctx.fillText(bodyLines[li], COMBAT_MESSAGES_RECT.x + 3, y + 12 + li * BODY_LINE_H);
      }
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
