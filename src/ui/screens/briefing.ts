import type { Screen, InputState, CursorKind } from '@/shared/types';
import { BottomStrip, toMenuInput, drawMenuFrame, wrapText } from '@/ui/screens/common';
import { drawShadowText, drawDarkPanel } from '@/ui/chrome';
import { OperationScreen } from './operation';
import { CoaScreen } from './coa';
import { RosterScreen } from './roster';
import { TerrainRenderer } from '@/render/terrainRender';
import { getMap } from '@/data/maps';
import { buildMap } from '@/sim/map';
import { OPERATION } from '@/data/operation';
import { GRAND_CAMPAIGN, operationForIndex } from '@/data/campaign';
import type { MapDef } from '@/shared/types';
import { game } from '@/game';

// ============================================================================
// briefing.ts — the pre-battle briefing screen (roadmap G4/§5): operational
// and battle briefing text over a briefing map with the numbered objectives.
// The original shows this after the COA plan and before the requisition.
// ============================================================================

const MAP_W = 280;
const MAP_H = 210;

export class BriefingScreen implements Screen {
  private strip = new BottomStrip({ next: 'Next →', soldiers: !!game.campaign });
  private op = game.operation!;
  private battleIdx: number;
  private mapId: string;
  private def: MapDef | null = null;
  private thumb: HTMLCanvasElement | null = null;

  constructor() {
    this.battleIdx = Math.min(this.op.index, OPERATION.length - 1);
    this.mapId = OPERATION[this.battleIdx].mapId;
    try {
      const def = getMap(this.mapId);
      const map = buildMap(def);
      this.thumb = new TerrainRenderer(map).thumbnail(MAP_W, MAP_H);
      this.def = def;
    } catch {
      this.thumb = null;
    }
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    const r = this.strip.update(m);
    if (r.soldiers) game.setScreen(new RosterScreen(this));
    else if (r.back) game.setScreen(new CoaScreen());
    else if (r.next) game.setScreen(new OperationScreen());
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'BRIEFING', () => this.drawBody(ctx));
  }

  private drawBody(ctx: CanvasRenderingContext2D): void {
    const opIx = operationForIndex(GRAND_CAMPAIGN, Math.min(this.op.index, OPERATION.length - 1));
    const grandOp = GRAND_CAMPAIGN[opIx];
    const battleDef = OPERATION[this.battleIdx];
    const mapDef: MapDef = this.def ?? getMap(this.mapId);

    drawDarkPanel(ctx, { x: 16, y: 46, w: 768, h: 30 });
    drawShadowText(ctx, `BATTLE ${this.op.index + 1} OF ${OPERATION.length}: ${battleDef.title}`, 26, 66, 'bold 13px Arial, Helvetica, sans-serif', '#f0d840');

    // operational briefing — the grand campaign situation, left column
    drawDarkPanel(ctx, { x: 16, y: 150, w: 384, h: 150 });
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0e8c8';
    ctx.fillText('OPERATIONAL SITUATION', 28, 166);
    ctx.font = 'bold italic 11px Arial, Helvetica, sans-serif';
    ctx.fillText(grandOp.title + ' — ' + grandOp.startDate, 28, 186);
    ctx.font = '11px Arial, Helvetica, sans-serif';
    const opLines = wrapText(ctx, grandOp.situation, 360);
    let y = 202;
    for (let i = 0; i < Math.min(opLines.length, 6); i++) {
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(opLines[i], 28, y);
      y += 14;
    }

    // battle briefing — the map name/description + the objectives to take
    drawDarkPanel(ctx, { x: 406, y: 150, w: 378, h: 178 });
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0e8c8';
    ctx.fillText('BATTLE BRIEFING', 418, 166);
    ctx.fillText(mapDef.name, 418, 186);
    ctx.font = '11px Arial, Helvetica, sans-serif';
    const mapLines = wrapText(ctx, mapDef.description, 354);
    let by = 202;
    for (let i = 0; i < Math.min(mapLines.length, 3); i++) {
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(mapLines[i], 418, by);
      by += 14;
    }
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0d840';
    ctx.fillText('OBJECTIVES:', 418, by + 2);
    by += 18;
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#e8e8e0';
    for (let i = 0; i < Math.min(mapDef.victoryLocations.length, 4); i++) {
      const vl = mapDef.victoryLocations[i];
      ctx.fillText(`${i + 1}. ${vl.name} — worth ${vl.value} point${vl.value === 1 ? '' : 's'}`, 424, by);
      by += 14;
    }
    if (mapDef.victoryLocations.length > 4) {
      ctx.fillStyle = '#c8b890';
      ctx.fillText(`+ ${mapDef.victoryLocations.length - 4} more on the map`, 424, by);
    }

    // briefing map with the numbered objectives, centred below the text panels
    if (this.thumb) {
      drawDarkPanel(ctx, { x: 252, y: 336, w: 296, h: 222 });
      ctx.drawImage(this.thumb, 260, 342);
      const sx = MAP_W / mapDef.width;
      const sy = MAP_H / mapDef.height;
      ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
      for (let i = 0; i < mapDef.victoryLocations.length; i++) {
        const vl = mapDef.victoryLocations[i];
        const px = 260 + vl.x * sx;
        const py = 342 + vl.y * sy;
        ctx.fillStyle = '#2a2620';
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f0e8c8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), px, py);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }

    this.strip.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
