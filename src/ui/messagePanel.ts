// ============================================================================
// messagePanel.ts — bottom-right panel (600,480,200,120): scrolling message
// log, TRUCE/OVERVIEW/OPTIONS/PAUSE button grid, and the battle clock.
// ============================================================================
import type { Rect, InputState, BattleState, BattleMessage } from '@/shared/types';
import { PALETTE } from '@/render/palette';
import { drawText, drawTextCentered, textWidth, FONT_SMALL_H } from '@/render/pixelfont';
import { drawPanel, drawBevelBox, Button } from '@/ui/chrome';

export const MESSAGE_PANEL_RECT: Rect = { x: 600, y: 480, w: 200, h: 120 };

const MESSAGES_RECT: Rect = { x: 602, y: 482, w: 196, h: 64 };
const MSG_LINES = 5;
const MSG_LINE_H = 12;

const BTN_W = 96;
const BTN_H = 16;
const BTN_GAP_X = 2;
const BTN_COL0_X = 602;
const BTN_COL1_X = BTN_COL0_X + BTN_W + BTN_GAP_X;
const BTN_ROW0_Y = 548;
const BTN_ROW1_Y = 566;

const CLOCK_Y0 = 584;
const CLOCK_Y1 = 598;

export type MessagePanelAction = 'truce' | 'overview' | 'options' | 'pause';

function msgColor(kind: BattleMessage['kind']): string {
  switch (kind) {
    case 'warn':
      return PALETTE.yellow;
    case 'bad':
      return PALETTE.red;
    case 'good':
      return PALETTE.green;
    default:
      return PALETTE.text;
  }
}

function truncateToWidth(text: string, maxW: number): string {
  if (textWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 0 && textWidth(s) > maxW) s = s.slice(0, -1);
  return s;
}

/** Greedy word-wrap into at most `maxLines` lines no wider than `maxW`; a
 * single word wider than `maxW` is hard-truncated rather than overflowing. */
function wrapToLines(text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (lines.length >= maxLines) break;
    const test = cur ? cur + ' ' + word : word;
    if (cur && textWidth(test) > maxW) {
      lines.push(cur);
      cur = word;
      if (lines.length >= maxLines) { cur = ''; break; }
    } else {
      cur = test;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = truncateToWidth(lines[last], maxW);
  }
  return lines;
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export class MessagePanel {
  private truceBtn = new Button({ x: BTN_COL0_X, y: BTN_ROW0_Y, w: BTN_W, h: BTN_H }, 'TRUCE');
  private overviewBtn = new Button({ x: BTN_COL1_X, y: BTN_ROW0_Y, w: BTN_W, h: BTN_H }, 'OVERVIEW');
  private optionsBtn = new Button({ x: BTN_COL0_X, y: BTN_ROW1_Y, w: BTN_W, h: BTN_H }, 'OPTIONS');
  private pauseBtn = new Button({ x: BTN_COL1_X, y: BTN_ROW1_Y, w: BTN_W, h: BTN_H }, 'PAUSE');

  update(input: InputState): MessagePanelAction | null {
    if (this.truceBtn.update(input)) return 'truce';
    if (this.overviewBtn.update(input)) return 'overview';
    if (this.optionsBtn.update(input)) return 'options';
    if (this.pauseBtn.update(input)) return 'pause';
    return null;
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState, paused: boolean, speed?: number): void {
    drawPanel(ctx, MESSAGE_PANEL_RECT);

    // message log — each message wraps onto up to 2 lines within the box's
    // width rather than overflowing the panel's right edge.
    drawBevelBox(ctx, MESSAGES_RECT, true);
    const maxW = MESSAGES_RECT.w - 4;
    let lines: { text: string; color: string }[] = [];
    for (const m of state.messages.slice(-MSG_LINES)) {
      const color = msgColor(m.kind);
      for (const text of wrapToLines(m.text, maxW, 2)) lines.push({ text, color });
    }
    lines = lines.slice(-MSG_LINES);
    const padTop = MSG_LINES - lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      drawText(ctx, line.text, MESSAGES_RECT.x + 2, MESSAGES_RECT.y + 2 + (padTop + i) * MSG_LINE_H, line.color, 'small');
    }

    // buttons
    this.pauseBtn.label = paused ? 'RESUME' : 'PAUSE';
    this.truceBtn.draw(ctx);
    this.overviewBtn.draw(ctx);
    this.optionsBtn.draw(ctx);
    this.pauseBtn.draw(ctx);

    // clock strip, centred
    const remaining = state.config.durationS - state.time;
    let clockText = `TIME ${fmtClock(remaining)}`;
    if (speed && speed !== 1) clockText += ` x${speed}`;
    drawTextCentered(
      ctx,
      clockText,
      MESSAGE_PANEL_RECT.x + MESSAGE_PANEL_RECT.w / 2,
      CLOCK_Y0 + (CLOCK_Y1 - CLOCK_Y0 - FONT_SMALL_H) / 2,
      PALETTE.gold,
      'small',
    );
  }
}
