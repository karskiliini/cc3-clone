import type { BattleResult, COAKind, COARoute, CursorKind, InputState, MapCOA, MapDef, OperationState, Screen, Side, Vec2, VictoryLocation } from '@/shared/types';
import { game } from '@/game';
import { OPERATION } from '@/data/operation';
import { GRAND_CAMPAIGN, operationForIndex } from '@/data/campaign';
import { beginMenuFrame, toMenuInput, BottomStrip, wordWrapCtx } from './common';
import { getMap } from '@/data/maps';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { availableSoldiers } from '@/campaign/roster';
import { drawDarkPanel, drawScreenTitle } from '@/ui/chrome';
import { MENU_W, MENU_H } from '@/shared/types';
import { OperationScreen } from './operation';
import { BriefingScreen } from './briefing';
import { MainMenuScreen } from './mainMenu';
import { RosterScreen } from './roster';
import { OptionsScreen } from './options';

// ============================================================================
// coa.ts — COA (course of action) planning screen, shown between the debrief of
// one battle and the force-selection briefing of the next (roadmap G21). The
// original CC3 opened every campaign battle with this screen: the objective map
// with numbered victory-location circles and both sides' course-of-action
// overlays (arrows for axes of advance, hatched lines for defences), the plan
// stages for river/urban assaults, and a legend reading
//   Defenses · Tanks · Tactical Advancement · Fire Support · Armor ·
//   Air Support · Assault
// The clone's operation is linear, so the left panel keeps the battle-chain
// progress and the right panel carries the real objective map.
// ============================================================================

/** Stylized front-line path for the 16 grand-campaign battles: east-to-west
 * progress with a gentle weave, in menu-space fractions (0..1 of the panel). */
function nodePos(i: number, n: number): { x: number; y: number } {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return {
    x: 0.12 + col * 0.25 + (row % 2) * 0.06,
    y: 0.08 + (i / Math.max(1, n - 1)) * 0.84,
  };
}

// ------------------------------------------------------------- objective map

/** Geometry of the objective-map thumbnail inside the right panel: the area it
 * occupies plus the tile→panel transform the thumbnail renderer used. */
export interface CoaMapLayout {
  /** thumbnail top-left inside the menu frame (px) */
  x: number;
  y: number;
  /** thumbnail box (px) */
  w: number;
  h: number;
  /** letterbox offsets and pixel-per-tile scale actually used by thumbnail() */
  offX: number;
  offY: number;
  scale: number;
  mapW: number;
  mapH: number;
}

/** Same fit math as TerrainRenderer.thumbnail(): min scale, centred. */
export function coaMapLayout(def: MapDef, x: number, y: number, w: number, h: number): CoaMapLayout {
  const scale = Math.min(w / (def.width * 2), h / (def.height * 2)); // LOWRES_PX_PER_TILE = 2
  const dw = def.width * 2 * scale;
  const dh = def.height * 2 * scale;
  return { x, y, w, h, offX: (w - dw) / 2, offY: (h - dh) / 2, scale: (dw / def.width), mapW: def.width, mapH: def.height };
}

/** Tile coordinate → panel pixel (object-map geometry only; shared with hover). */
export function coaMapToPanel(layout: CoaMapLayout, p: Vec2): Vec2 {
  return { x: layout.x + layout.offX + p.x * layout.scale, y: layout.y + layout.offY + p.y * layout.scale };
}

const COA_KIND_LABEL: Record<COAKind, string> = {
  advance: 'Tactical Advancement',
  armor: 'Armor',
  assault: 'Assault',
  firesupport: 'Fire Support',
  air: 'Air Support',
  defenses: 'Defenses',
};

export interface CoaHoverVl { kind: 'vl'; vlId: number; name: string; value: number }
export interface CoaHoverRoute { kind: 'route'; side: Side; index: number; routeKind: COAKind }
export type CoaHover = CoaHoverVl | CoaHoverRoute;

/** What the pointer sits over: a numbered objective circle, or a COA arrow.
 * Circles win (they sit on top of the arrows). `radius` is the pick radius in
 * px for circles; routes pick within 7 px of any leg. */
export function coaHoverAt(
  def: MapDef,
  layout: CoaMapLayout,
  coa: MapCOA,
  mouse: Vec2,
): CoaHover | null {
  for (const { vl, x, y } of coaVlPositions(def, layout)) {
    if (Math.hypot(x - mouse.x, y - mouse.y) <= 10) {
      return { kind: 'vl', vlId: vl.id, name: vl.name, value: vl.value };
    }
  }
  const sides: Side[] = ['german', 'soviet'];
  for (const side of sides) {
    const routes = coa[side];
    for (let i = 0; i < routes.length; i++) {
      if (segNearPanel(layout, routes[i], mouse)) return { kind: 'route', side, index: i, routeKind: routes[i].kind };
    }
  }
  return null;
}

/** Panel-space positions for the numbered objective circles, with collision nudging shared by
 * the hover pick and the draw pass so the two never disagree. */
export function coaVlPositions(def: MapDef, layout: CoaMapLayout): { vl: MapDef['victoryLocations'][number]; x: number; y: number }[] {
  const placed: { x: number; y: number }[] = [];
  return def.victoryLocations.map((vl) => {
    let p = coaMapToPanel(layout, { x: vl.x, y: vl.y });
    for (let tries = 0; tries < 6; tries++) {
      if (!placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 19)) break;
      p = { x: Math.min(p.x + 19, layout.x + layout.w - 10), y: p.y };
    }
    placed.push(p);
    return { vl, x: p.x, y: p.y };
  });
}

function segNearPanel(layout: CoaMapLayout, route: COARoute, m: Vec2): boolean {
  const pts = route.pts.map((p) => coaMapToPanel(layout, p));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * t, py = a.y + dy * t;
    if (Math.hypot(px - m.x, py - m.y) <= 7) return true;
  }
  return false;
}

// ------------------------------------------------------------ arrow painters

function arrowHead(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, size: number): void {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const a1 = ang + Math.PI * 0.82;
  const a2 = ang - Math.PI * 0.82;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x + Math.cos(a1) * size, to.y + Math.sin(a1) * size);
  ctx.lineTo(to.x + Math.cos(a2) * size, to.y + Math.sin(a2) * size);
  ctx.closePath();
  ctx.fill();
}

const COA_COLORS = { blue: '#7ec4f2', red: '#ef8a7a' } as const;

/** Draws one COA overlay route in panel pixels. Colors carry meaning: blue =
 * player's COA, red = the enemy's expected one, as on the original's plan map. */
export function drawCoaRoute(
  ctx: CanvasRenderingContext2D,
  pts: Vec2[],
  kind: COAKind,
  side: Side,
  hover: boolean,
): void {
  const color = COA_COLORS[side === 'german' ? 'blue' : 'red'];
  const span = (pts: Vec2[]): { a: Vec2; b: Vec2 } | null => {
    if (pts.length < 2) return null;
    return { a: pts[0], b: pts[pts.length - 1] };
  };
  const legs = span(pts);
  if (!legs) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = hover ? 1 : 0.85;

  if (kind === 'defenses') {
    // hatched defensive line: solid spine plus perpendicular ticks
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.floor(segLen / 14));
      const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * 5, y - Math.sin(ang) * 5);
        ctx.lineTo(x + Math.cos(ang) * 5, y + Math.sin(ang) * 5);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  const widths: Record<COAKind, number> = { advance: 2.5, armor: 5, assault: 7, firesupport: 2.5, air: 2.5, defenses: 2.5 };
  const dash: Record<COAKind, number[]> = { advance: [], armor: [], assault: [], firesupport: [7, 5], air: [3, 6], defenses: [] };
  const w = widths[kind];
  // dark casing first so light arrows read on the terrain thumbnail
  ctx.strokeStyle = '#1a120c';
  ctx.lineWidth = w + 2;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.setLineDash(dash[kind]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (kind !== 'firesupport' && kind !== 'air') {
    const tail = pts[pts.length - 2] ?? pts[0];
    const head = pts[pts.length - 1];
    arrowHead(ctx, tail, head, w * 2.4 + 4);
  }
  if (kind === 'air') {
    // small swept-wing glyph at the route's head
    const head = pts[pts.length - 1];
    ctx.fillStyle = color;
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(Math.atan2(head.y - (pts[pts.length - 2]?.y ?? head.y), head.x - (pts[pts.length - 2]?.x ?? head.x)));
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-3, -4);
    ctx.lineTo(-1, 0);
    ctx.lineTo(-3, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  if (kind === 'firesupport') {
    const head = pts[pts.length - 1];
    ctx.fillStyle = color;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(head.x + Math.cos(ang) * 5, head.y + Math.sin(ang) * 5, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** One legend-entry symbol in isolation (the legend cannot reuse the route
 * painter: it needs fixed 22px samples that don't depend on route geometry). */
export function drawCoaLegendSymbol(ctx: CanvasRenderingContext2D, kind: COAKind | 'tanks', x: number, y: number, side: Side): void {
  if (kind === 'tanks') {
    // small tank silhouette in the side's color
    ctx.save();
    ctx.strokeStyle = COA_COLORS[side === 'german' ? 'blue' : 'red'];
    ctx.fillStyle = COA_COLORS[side === 'german' ? 'blue' : 'red'];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(x, y - 5, 18, 10, 2); // hull
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(x + 6, y - 9, 8, 5, 1.5); // turret
    ctx.stroke();
    ctx.fillRect(x + 13, y - 7.5, 7, 2); // barrel
    ctx.beginPath();
    ctx.arc(x + 5, y + 5, 2.2, 0, Math.PI * 2); // wheels
    ctx.arc(x + 10, y + 5, 2.2, 0, Math.PI * 2);
    ctx.arc(x + 15, y + 5, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  drawCoaRoute(ctx, [
    { x: x + 2, y },
    { x: x + 16, y },
    { x: x + 24, y },
  ], kind, side, false);
}

// ------------------------------------------------------------------- screen

export class CoaScreen implements Screen {
  private op: OperationState;
  private strip: BottomStrip;
  private battleIdx: number;
  private mapId: string;
  private thumb: HTMLCanvasElement | null = null;
  private layout: CoaMapLayout | null = null;
  private def: MapDef | null = null;
  private hover: CoaHover | null = null;

  constructor() {
    this.op = game.operation!;
    this.battleIdx = Math.min(this.op.index, OPERATION.length - 1);
    this.mapId = OPERATION[this.battleIdx].mapId;
    this.strip = new BottomStrip({ showBack: true, nextLabel: 'Briefing →', soldiersEnabled: !!game.campaign });
    // Build the thumbnail up front; it is static per battle.
    try {
      const def = getMap(this.mapId);
      const map = buildMap(def);
      const rx = 16 + 210 + 12;
      const rw = MENU_W - (rx - 16) - 16;
      // map sits below the situation text (up to 3 wrapped lines) so neither overlaps
      const layout = coaMapLayout(def, rx + 10, 64 + 96, Math.min(330, rw - 260), 250);
      this.thumb = new TerrainRenderer(map).thumbnail(layout.w, layout.h);
      this.layout = layout;
      this.def = def;
    } catch {
      this.thumb = null;
    }
  }

  update(dt: number, input: InputState): void {
    // ESC = Back in every menu screen, like the original (round7 UI pass).
    if (input.keysPressed.has('escape')) { game.setScreen(new MainMenuScreen()); return; }
    const m = toMenuInput(input);
    const r = this.strip.update(m);
    if (r.soldiers) { game.setScreen(new RosterScreen(this)); return; }
    if (r.quitOrBack) game.setScreen(new MainMenuScreen());
    else if (r.main) game.setScreen(new MainMenuScreen());
    else if (r.options) game.setScreen(new OptionsScreen(this));
    else if (r.next) game.setScreen(new BriefingScreen());
    if (this.def && this.layout && this.def.coa) {
      this.hover = coaHoverAt(this.def, this.layout, this.def.coa, m.mouse);
    } else this.hover = null;
    void dt;
  }

  cursor(): CursorKind {
    return this.hover ? 'hand' : 'arrow';
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawScreenTitle(ctx, 'COURSE OF ACTION');
    const op = this.op;
    const flat = GRAND_CAMPAIGN.flatMap((o) => o.battles);
    const opIx = operationForIndex(GRAND_CAMPAIGN, Math.min(op.index, OPERATION.length - 1));
    const grandOp = GRAND_CAMPAIGN[opIx];

    // ---- left panel: progress front line ----
    const leftW = 210;
    const panelY = 64;
    const panelH = MENU_H - panelY - 96;
    drawDarkPanel(ctx, { x: 16, y: panelY, w: leftW, h: panelH });
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0e8c8';
    ctx.fillText('OPERATION PROGRESS', 28, panelY + 20);

    ctx.strokeStyle = '#8a7a4a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < flat.length; i++) {
      const p = nodePos(i, flat.length);
      const px = 16 + p.x * (leftW - 32);
      const py = panelY + 34 + p.y * (panelH - 60);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    for (let i = 0; i < flat.length; i++) {
      const p = nodePos(i, flat.length);
      const px = 16 + p.x * (leftW - 32);
      const py = panelY + 34 + p.y * (panelH - 60);
      const fought = i < op.results.length;
      const isNext = i === op.index;
      ctx.beginPath();
      ctx.arc(px, py, isNext ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = fought
        ? (isVictory(op.results[i]) ? '#7ec97e' : '#d06a5a')
        : isNext ? '#f0d060' : '#55504a';
      ctx.fill();
      ctx.strokeStyle = isNext ? '#fff8d0' : '#2a2620';
      ctx.lineWidth = isNext ? 2 : 1;
      ctx.stroke();
      if (isNext) {
        ctx.font = 'bold 10px Arial, Helvetica, sans-serif';
        ctx.fillStyle = '#fff0b0';
        ctx.fillText('NEXT', px + 9, py + 4);
      }
    }
    ctx.font = '10px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#a09878';
    ctx.fillText('green = victory   red = defeat   yellow = next', 26, panelY + panelH - 14);

    // ---- right panel: objective map + COA overlays ----
    const rx = 16 + leftW + 12;
    const rw = MENU_W - (rx - 16) - 16;
    drawDarkPanel(ctx, { x: rx, y: panelY, w: rw, h: panelH });

    let y = panelY + 24;
    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0e8c8';
    ctx.fillText(grandOp.title.toUpperCase() + ' — ' + grandOp.startDate, rx + 14, y);
    y += 20;
    const sitText = wordWrapCtx(ctx, grandOp.situation, rw - 32, '11px Arial, Helvetica, sans-serif');
    const sitLines = sitText.slice(0, 3);
    if (sitText.length > 3) sitLines[sitLines.length - 1] += '…';
    for (const line of sitLines) {
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.fillText(line, rx + 14, y);
      y += 14;
    }
    y += 6;

    const battle = op.index < OPERATION.length ? OPERATION[op.index] : null;
    if (!battle) {
      ctx.fillStyle = '#f0e8c8';
      ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
      ctx.fillText('OPERATION COMPLETE', rx + 14, y);
      this.strip.draw(ctx);
      ctx.restore();
      return;
    }

    if (this.thumb && this.layout && this.def) {
      ctx.drawImage(this.thumb, this.layout.x, this.layout.y);
      this.drawObjectiveOverlay(ctx, this.def, this.layout);
      this.drawLegend(ctx, rx + 10 + this.layout.w + 12, this.layout.y + 6, rw - this.layout.w - 34);
      this.drawStages(ctx, rx + 14, this.layout.y + this.layout.h + 18, rw - 28);
    }
    this.drawHoverReadout(ctx, rx, rw, panelY, panelH);
    this.strip.draw(ctx);
    ctx.restore();
  }

  private drawObjectiveOverlay(ctx: CanvasRenderingContext2D, def: MapDef, layout: CoaMapLayout): void {
    const coa = def.coa;
    const playerSide = this.op.playerSide;
    const enemy: Side = playerSide === 'german' ? 'soviet' : 'german';
    if (coa) {
      for (const r of coa[enemy]) this.drawRouteOnMap(ctx, layout, r, enemy);
      for (const r of coa[playerSide]) this.drawRouteOnMap(ctx, layout, r, playerSide);
    }
    // numbered objective circles on top; labels that would collide get nudged right so both
    // stay legible (VLs on neighbouring hills can sit a dozen tiles apart on the thumbnail)
    for (const { vl, x: px, y: py } of coaVlPositions(def, layout)) {
      const hot = this.hover?.kind === 'vl' && this.hover.vlId === vl.id;
      ctx.beginPath();
      ctx.arc(px, py, hot ? 9 : 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(16,10,6,0.78)';
      ctx.fill();
      ctx.strokeStyle = hot ? '#fff0b0' : '#e8dcc0';
      ctx.lineWidth = hot ? 2.4 : 1.6;
      ctx.stroke();
      ctx.fillStyle = '#fff0b0';
      ctx.font = 'bold 9px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(vl.id + 1), px, py);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawRouteOnMap(ctx: CanvasRenderingContext2D, layout: CoaMapLayout, route: COARoute, side: Side): void {
    const pts = route.pts.map((p) => coaMapToPanel(layout, p));
    const hot = this.hover?.kind === 'route' && this.hover.side === side && this.hover.index === this.indexOfRoute(side, route);
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.x, layout.y, layout.w, layout.h);
    ctx.clip();
    drawCoaRoute(ctx, pts, route.kind, side, !!hot);
    ctx.restore();
  }

  private indexOfRoute(side: Side, route: COARoute): number {
    const coa = this.def?.coa;
    if (!coa) return 0;
    return coa[side].indexOf(route);
  }

  private drawLegend(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
    const entries: { label: string; kind: COAKind | 'tanks' }[] = [
      { label: 'Defenses', kind: 'defenses' },
      { label: 'Tanks', kind: 'tanks' },
      { label: 'Tactical Advancement', kind: 'advance' },
      { label: 'Fire Support', kind: 'firesupport' },
      { label: 'Armor', kind: 'armor' },
      { label: 'Air Support', kind: 'air' },
      { label: 'Assault', kind: 'assault' },
    ];
    ctx.save();
    ctx.font = '9px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#c8c0a0';
    ctx.textAlign = 'left';
    ctx.fillText('COA LEGEND', x, y);
    y += 16;
    for (let i = 0; i < entries.length; i++) {
      const ex = x;
      const ey = y + i * 20;

      drawCoaLegendSymbol(ctx, entries[i].kind, ex, ey, 'german');
      ctx.fillStyle = '#c8c0a0';
      ctx.fillText(entries[i].label, ex + 34, ey);
    }
    ctx.restore();
  }

  private drawStages(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
    const stages = this.def?.coa?.stages;
    if (!stages?.length) return;
    ctx.save();
    ctx.font = 'bold 10px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0d060';
    ctx.fillText('PLAN STAGES', x, y);
    ctx.font = '10px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#c8c0a0';
    let px = x + 82;
    for (let i = 0; i < stages.length; i++) {
      if (px + ctx.measureText(stages[i]).width > x + w) break;
      ctx.fillStyle = '#e8dcc0';
      ctx.fillText(stages[i], px, y);
      px += ctx.measureText(stages[i]).width;
      // the arrow only goes in when the next stage still fits on the line
      if (i < stages.length - 1 && px + 16 + ctx.measureText(stages[i + 1]).width <= x + w) {
        ctx.fillStyle = '#8a7a4a';
        ctx.fillText('→', px + 4, y);
        px += 16;
      }
    }
    ctx.restore();
  }

  /** Objective/COA hover readout pinned above the bottom strip. */
  private drawHoverReadout(ctx: CanvasRenderingContext2D, _rx: number, rw: number, panelY: number, panelH: number): void {
    const hover = this.hover;
    if (!hover) return;
    ctx.save();
    const label = hover.kind === 'vl'
      ? `${hover.name} — objective ${hover.vlId + 1}, worth ${hover.value}`
      : `${hover.side === 'german' ? 'German' : 'Soviet'} plan: ${COA_KIND_LABEL[hover.routeKind]}`;
    ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
    const w = ctx.measureText(label).width + 20;
    const x = 16 + rw - w;
    const y = panelY + panelH + 12;
    ctx.fillStyle = 'rgba(16,10,6,0.9)';
    ctx.fillRect(x, y, w, 18);
    ctx.strokeStyle = '#8a7a4a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 17);
    ctx.fillStyle = '#f0e8c8';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 10, y + 13);
    ctx.restore();
  }
}

function isVictory(r: BattleResult): boolean {
  return r === 'totalVictory' || r === 'decisiveVictory' || r === 'majorVictory' || r === 'minorVictory';
}

