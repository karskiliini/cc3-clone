// ============================================================================
// combatMessages.ts — the "Combat Messages" column, measured from the
// original's frames (cc3-full-11/12.jpg, logical 1024x768):
//   three message boxes x 333..416 at y 671/692/713 (17 tall each), the
//   strip's message box x 334..416 y 739..750 (11 tall), the scroll arrows in
//   the 420..432 column (panel: 674..687 up, 712..725 down; strip: 740..752),
//   the running message number "(N)" inside each box's top-right, and the
//   red "Combat Messages" title centred under the strip box (y ~753).
// Boxes: dark-maroon interior with a light border (no bevel). Sender white,
// body yellow for status/warn reports and white for event reports — the
// original shows "Taking cover from enemy fire." yellow and "Chinikov is
// panicking." white (cc3-full-12.jpg).
// Consecutive identical lines collapse into one row; the number shown is the
// collapsed row's last raw message's running number.
// ============================================================================
import type { Rect, InputState, BattleState, BattleMessage, Team } from '@/shared/types';
import { HUD } from '@/render/palette';
import { clamp } from '@/shared/math';
import { hitRect, setHudFont, clipTextToWidth, teamDisplayName } from './hudChrome';

/** Wheel-scroll area: the message boxes plus their arrow columns. */
export const COMBAT_MESSAGES_RECT: Rect = { x: 333, y: 670, w: 94, h: 98 };
const PANEL_X = 333;
const PANEL_W = 83;
const BOX_H = 21;
const ROW_YS = [671, 692, 713];
const VISIBLE_ROWS = 4; // three panel boxes + the bottom-strip box
/** The newest message lives in the bottom strip row (the original's layout). */
const STRIP_BOX: Rect = { x: 334, y: 739, w: 82, h: 11 };
/** Scroll arrows (refs12/13): pale squares right of the panel boxes at the
 * row-1/row-2 seam and just under row 3; the strip's own red up-arrow. */
const PANEL_UP: Rect = { x: 418.5, y: 682.5, w: 6.5, h: 9 };
const PANEL_DOWN: Rect = { x: 418.5, y: 725, w: 6.5, h: 9 };
const STRIP_UP: Rect = { x: 420, y: 740, w: 12, h: 12 };
/** Red title centred under the strip message box. */
const TITLE_CX = 388;
const TITLE_Y = 753;

function msgColor(kind: BattleMessage['kind']): string {
  switch (kind) {
    case 'warn':
      return HUD.yellow;
    default:
      // the original draws event reports ("Chinikov is panicking.") plain white
      return HUD.text;
  }
}

/** Messages are stored as `${teamName}\n${body}` at the source (sim/victory,
 * sim/morale, sim/combat); split on that newline. Older/unstructured
 * messages fall back to matching a known team's name as a prefix, or
 * "Report" when no team is identifiable. */
export function splitMessage(text: string, teams: Team[]): { who: string; body: string } {
  const nl = text.indexOf('\n');
  if (nl > 0) {
    const who = text.slice(0, nl).trim();
    let body = text.slice(nl + 1).trim();
    // Defensive (round5 critique #6): a producer that (accidentally) repeats the team name at the
    // start of the body — the name is already drawn as its own line above this one — gets it
    // stripped here so a duplicate is never shown, regardless of which sim module wrote it.
    if (who && (body === who || body.startsWith(`${who} `))) body = body.slice(who.length).trimStart();
    return { who, body };
  }
  let best: Team | null = null;
  for (const t of teams) {
    if (!t.name) continue;
    if (text === t.name || text.startsWith(t.name + ':') || text.startsWith(t.name + ' ')) {
      if (!best || t.name.length > best.name.length) best = t;
    }
  }
  if (!best) return { who: 'Report', body: text.replace(/\s+/g, ' ') };
  const body = text.slice(best.name.length).replace(/^\s*[:—-]\s*/, '');
  return { who: best.name, body: body.trimStart() };
}

export interface CollapsedMessage {
  who: string;
  body: string;
  kind: BattleMessage['kind'];
  /** how many consecutive raw messages this row collapsed (round5 critique #6: the exact same
   * line — e.g. a knocked-out report — could post twice in a row with nothing to tell them apart
   * but two identical rows). 1 = not repeated. */
  count: number;
  /** the collapsed row's last raw message's 1-based running number — the original shows "(N)"
   * in each box's top-right (cc3-full-12.jpg: "(1)", "(2)"). */
  num: number;
}

/** Splits every raw message and merges consecutive duplicates (same who+body+kind) into one row
 * with a repeat count, so the log never shows the same line twice in a row. */
export function collapseMessages(messages: readonly BattleMessage[], teams: Team[]): CollapsedMessage[] {
  const out: CollapsedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const { who, body } = splitMessage(m.text, teams);
    const last = out[out.length - 1];
    if (last && last.who === who && last.body === body && last.kind === m.kind) {
      last.count++;
      last.num = i + 1;
    } else {
      out.push({ who, body, kind: m.kind, count: 1, num: i + 1 });
    }
  }
  return out;
}

/** One scroll arrow. Panel arrows are pale squares with a darker glyph
 * (refs12/13); the strip's own up-arrow is red with a steel glyph. */
function drawArrowButton(ctx: CanvasRenderingContext2D, r: Rect, dir: 'up' | 'down', hot: boolean, enabled: boolean, red = false): void {
  ctx.fillStyle = red ? (hot ? '#a82014' : '#8c1810') : hot ? '#cabb9e' : '#b8a68e';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = enabled ? HUD.bevelLight : HUD.bevelDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2);
  ctx.fillStyle = red ? (enabled ? '#c8c8c0' : '#606058') : enabled ? '#6a5844' : '#8a7c68';
  ctx.beginPath();
  if (dir === 'up') { ctx.moveTo(cx, cy - 3.5); ctx.lineTo(cx - 3.5, cy + 1); ctx.lineTo(cx, cy - 1); ctx.lineTo(cx + 3.5, cy + 1); }
  else { ctx.moveTo(cx, cy + 3.5); ctx.lineTo(cx - 3.5, cy - 1); ctx.lineTo(cx, cy + 1); ctx.lineTo(cx + 3.5, cy - 1); }
  ctx.closePath();
  ctx.fill();
}

function drawBox(ctx: CanvasRenderingContext2D, r: Rect): void {
  ctx.fillStyle = '#2e0e0a';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = HUD.bevelLight;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
}

/** Panel boxes carry two rows (sender + body, refs12); the strip box is a
 * single 11px row — sender and body run together after the (N) number. */
function drawMessage(ctx: CanvasRenderingContext2D, box: Rect, m: CollapsedMessage, withCount: boolean, compact = false): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
  ctx.clip();
  setHudFont(ctx, 'mini');
  const body = m.count > 1 ? `${m.body} (x${m.count})` : m.body;
  if (compact) {
    let x = box.x + 2;
    if (withCount) {
      ctx.fillStyle = HUD.text;
      const label = `(${m.num}) `;
      ctx.fillText(label, x, box.y + 2);
      x += ctx.measureText(label).width;
    }
    ctx.fillStyle = HUD.text;
    ctx.fillText(clipTextToWidth(ctx, m.who, Math.min(28, box.w - 4 - (x - box.x))), x, box.y + 2);
    x += Math.min(28, box.w - 4 - (x - box.x)) + 2;
    ctx.fillStyle = msgColor(m.kind);
    ctx.fillText(clipTextToWidth(ctx, body.replace(/\s+/g, ' '), Math.max(8, box.x + box.w - 2 - x)), x, box.y + 2);
    ctx.restore();
    return;
  }
  const nameW = withCount ? box.w - 22 : box.w - 4;
  ctx.fillStyle = HUD.text;
  ctx.fillText(clipTextToWidth(ctx, m.who, nameW), box.x + 2, box.y + 2);
  if (withCount) {
    ctx.fillStyle = HUD.text;
    const label = `(${m.num})`;
    ctx.fillText(label, box.x + box.w - ctx.measureText(label).width - 3, box.y + 2);
  }
  ctx.fillStyle = msgColor(m.kind);
  ctx.fillText(clipTextToWidth(ctx, body.replace(/\s+/g, ' '), box.w - 4), box.x + 2, box.y + 11.5);
  ctx.restore();
}

export class CombatMessages {
  /** Rows scrolled back from the newest message (0 = pinned to newest). */
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;
  private hoverStrip = false;

  private maxScroll(total: number): number {
    return Math.max(0, total - VISIBLE_ROWS);
  }

  update(input: InputState, state: BattleState): void {
    const teams = Array.from(state.teams.values());
    const total = collapseMessages(state.messages, teams).length;
    const maxScroll = this.maxScroll(total);
    this.hoverUp = hitRect(input.mouse, PANEL_UP);
    this.hoverDown = hitRect(input.mouse, PANEL_DOWN);
    this.hoverStrip = hitRect(input.mouse, STRIP_UP);
    if (hitRect(input.mouse, COMBAT_MESSAGES_RECT) && input.wheel !== 0) {
      // wheel up (negative) reveals older messages, like the up arrow
      this.scroll = clamp(this.scroll - Math.sign(input.wheel), 0, maxScroll);
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (hitRect(p, PANEL_UP)) this.scroll = clamp(this.scroll + 1, 0, maxScroll);
      else if (hitRect(p, PANEL_DOWN)) this.scroll = clamp(this.scroll - 1, 0, maxScroll);
      else if (hitRect(p, STRIP_UP)) this.scroll = clamp(this.scroll + 1, 0, maxScroll);
    }
    this.scroll = clamp(this.scroll, 0, maxScroll);
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState): void {
    const teams = Array.from(state.teams.values());
    const collapsed = collapseMessages(state.messages, teams);
    const total = collapsed.length;
    const maxScroll = this.maxScroll(total);
    const endIdx = total - this.scroll; // exclusive
    const startIdx = Math.max(0, endIdx - VISIBLE_ROWS);
    // The window is 4 slots: the three sunken boxes left of the bottom strip show the OLDER
    // messages, the bottom-strip box shows the newest (the original's layout).
    for (let row = 0; row < 3; row++) {
      const box: Rect = { x: PANEL_X, y: ROW_YS[row], w: PANEL_W, h: BOX_H };
      drawBox(ctx, box);
      const idx = startIdx + row;
      if (idx >= endIdx - 1) continue;
      drawMessage(ctx, box, collapsed[idx], true);
    }
    // the newest message in the bottom-strip box, the original's prominent slot
    if (endIdx > startIdx) {
      drawBox(ctx, STRIP_BOX);
      drawMessage(ctx, STRIP_BOX, collapsed[endIdx - 1], true, true);
    }

    drawArrowButton(ctx, PANEL_UP, 'up', this.hoverUp, this.scroll < maxScroll);
    drawArrowButton(ctx, PANEL_DOWN, 'down', this.hoverDown, this.scroll > 0);
    drawArrowButton(ctx, STRIP_UP, 'up', this.hoverStrip, this.scroll < maxScroll, true);

    setHudFont(ctx, 'micro');
    ctx.fillStyle = HUD.titleRed;
    ctx.textAlign = 'center';
    ctx.fillText('Combat Messages', TITLE_CX, TITLE_Y);
    ctx.textAlign = 'left';
  }
}
