import type { CursorKind, InputState, Screen, Vec2 } from '@/shared/types';
import { PANEL_H, PANEL_Y, SCREEN_W, VIEW_H, VIEW_W } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { centerCamera, clampCamera, screenToWorld, worldToScreen } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { Button, drawPanel } from '@/ui/chrome';
import { TeamListPanel } from '@/ui/teamList';
import { drawSoldierMonitor } from '@/ui/soldierMonitor';
import { drawText, drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { drawWrappedText, updateCameraEdgeScrollAndKeys, makeDragPanState, updateRightDragPan } from './common';
import { BattleScreen } from './battle';

export class DeployScreen implements Screen {
  private battle: Battle;
  private terrain: TerrainRenderer;
  private teamList = new TeamListPanel();
  private selectedTeamId: number | null = null;
  private draggingTeamId: number | null = null;
  private dragPan = makeDragPanState();
  private invalidTimer = 0;

  private autoBtn = new Button({ x: 620, y: 500, w: 160, h: 20 }, 'AUTO DEPLOY');
  private beginBtn = new Button({ x: 620, y: 526, w: 160, h: 20 }, 'BEGIN');

  constructor(battle: Battle) {
    this.battle = battle;
    this.terrain = new TerrainRenderer(battle.state.map);
  }

  onEnter(): void {
    const map = this.battle.state.map;
    const zone = map.def.deployZones[this.battle.playerSide()];
    centerCamera(game.cam, { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 });
    clampCamera(game.cam, map.width, map.height);
  }

  update(dt: number, input: InputState): void {
    const cam = game.cam;
    const map = this.battle.state.map;

    if (this.invalidTimer > 0) this.invalidTimer -= dt;

    updateCameraEdgeScrollAndKeys(cam, input, dt, map.width, map.height);
    updateRightDragPan(cam, input, this.dragPan, map.width, map.height);

    // left mouse down on a friendly soldier: select + start drag
    for (const c of input.clicks) {
      if (c.button !== 0 || c.y >= VIEW_H) continue;
      const world = screenToWorld(cam, { x: c.x, y: c.y });
      const soldier = this.battle.soldierAt(world, this.battle.playerSide());
      if (soldier) {
        this.selectedTeamId = soldier.teamId;
        this.draggingTeamId = soldier.teamId;
      } else {
        this.draggingTeamId = null;
      }
    }

    // release: drop the dragged team
    for (const r of input.releases) {
      if (r.button !== 0) continue;
      if (this.draggingTeamId != null) {
        const world = screenToWorld(cam, { x: r.x, y: r.y });
        const ok = this.battle.deployTeam(this.draggingTeamId, world);
        if (!ok) this.invalidTimer = 1;
        this.draggingTeamId = null;
      }
    }

    const teams = this.battle.selectableTeams(this.battle.playerSide());
    const clicked = this.teamList.update(input, teams, this.battle.state);
    if (clicked != null) this.selectedTeamId = clicked;

    if (this.autoBtn.update(input)) {
      aiDeploy(this.battle.state, this.battle.playerSide(), this.battle.rng, this.battle);
    }
    if (this.beginBtn.update(input)) {
      this.battle.start();
      game.setScreen(new BattleScreen(this.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const cam = game.cam;
    const map = this.battle.state.map;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.fillStyle = PALETTE.black;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    this.terrain.draw(ctx, cam);
    this.terrain.drawOverlays(ctx, cam, this.battle.state);

    // tint the player's deploy zone
    const zone = map.def.deployZones[this.battle.playerSide()];
    const tl = worldToScreen(cam, { x: zone.x, y: zone.y });
    const br = worldToScreen(cam, { x: zone.x + zone.w, y: zone.y + zone.h });
    ctx.fillStyle = 'rgba(90,160,255,0.18)';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = 'rgba(150,200,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, br.x - tl.x - 1, br.y - tl.y - 1);

    drawUnits(ctx, cam, this.battle.state, this.battle.playerSide(), this.selectedTeamId, game.settings);

    if (this.draggingTeamId != null) {
      const mouse = game.input.state.mouse;
      ctx.strokeStyle = PALETTE.gold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.invalidTimer > 0) {
      const mouse = game.input.state.mouse;
      drawTextCentered(ctx, 'INVALID', mouse.x, mouse.y - 20, PALETTE.red, 'small');
    }
    ctx.restore();

    drawPanel(ctx, { x: 0, y: PANEL_Y, w: SCREEN_W, h: PANEL_H });
    const teams = this.battle.selectableTeams(this.battle.playerSide());
    this.teamList.draw(ctx, teams, this.battle.state, this.selectedTeamId);
    const selTeam = this.selectedTeamId != null ? this.battle.state.teams.get(this.selectedTeamId) ?? null : null;
    drawSoldierMonitor(ctx, this.battle.state, selTeam);

    drawText(ctx, 'DEPLOYMENT', 610, 486, PALETTE.gold, 'small');
    drawWrappedText(ctx, 'Drag teams into the blue zone.', 610, 500, 180, PALETTE.dim, 9, 'small');
    this.autoBtn.draw(ctx);
    this.beginBtn.draw(ctx);
  }

  cursor(): CursorKind {
    return this.dragPan.active ? 'hand' : this.draggingTeamId != null ? 'move' : 'arrow';
  }
}
