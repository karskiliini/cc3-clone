import type { Camera, CursorKind, InputState, Screen } from '@/shared/types';
import { VIEW_H, VIEW_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { centerCamera, clampCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { drawHudBase } from '@/ui/hud/hudChrome';
import { drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { updateCameraEdgeScrollAndKeys, makeDragPanState, updateRightDragPan } from './common';
import { BattleScreen } from './battle';

export class DeployScreen implements Screen {
  private battle: Battle;
  private terrain: TerrainRenderer;
  private teamGrid = new TeamGrid();
  private combatMessages = new CombatMessages();
  private bottomStrip = new BottomStrip('deploy');
  private soldierMonitor = new SoldierMonitorPopup();
  private minimap = new Minimap();
  private selectedTeamId: number | null = null;
  private draggingTeamId: number | null = null;
  private dragPan = makeDragPanState();
  private invalidTimer = 0;
  private showMinimap = true;
  private shadeCanvas = document.createElement('canvas');

  constructor(battle: Battle) {
    this.battle = battle;
    this.terrain = new TerrainRenderer(battle.state.map);
  }

  onEnter(): void {
    const map = this.battle.state.map;
    const zone = map.def.deployZones[this.battle.playerSide()];
    centerCamera(game.cam, { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 });
    clampCamera(game.cam, map.width, map.height);

    // Default starting orders per the manual: infantry Ambush, armour Defend.
    for (const team of this.battle.selectableTeams(this.battle.playerSide())) {
      if (team.order) continue;
      this.battle.issueOrder(team.id, {
        type: team.vehicleId != null ? 'defend' : 'ambush',
        target: team.pos,
        issuedAt: 0,
      });
    }
  }

  update(dt: number, input: InputState): void {
    const cam = game.cam;
    const map = this.battle.state.map;
    const state = this.battle.state;

    if (this.invalidTimer > 0) this.invalidTimer -= dt;

    updateCameraEdgeScrollAndKeys(cam, input, dt, map.width, map.height);
    updateRightDragPan(cam, input, this.dragPan, map.width, map.height);
    if (input.wheel !== 0) {
      if (input.wheel < 0) zoomIn(cam, map.width, map.height, input.mouse);
      else zoomOut(cam, map.width, map.height, input.mouse);
    }

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
    const clicked = this.teamGrid.update(input, teams);
    if (clicked != null) {
      this.selectedTeamId = clicked;
      const team = state.teams.get(clicked);
      if (team) centerCamera(cam, team.pos);
      clampCamera(cam, map.width, map.height);
    }

    if (this.showMinimap) this.minimap.update(input, cam, map.width, map.height);
    this.combatMessages.update(input, state);
    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    this.soldierMonitor.update(input, state, selTeam);

    const action = this.bottomStrip.update(input);
    if (action === 'auto') {
      aiDeploy(this.battle.state, this.battle.playerSide(), this.battle.rng, this.battle);
    } else if (action === 'begin') {
      this.battle.start();
      game.setScreen(new BattleScreen(this.battle));
    } else if (action === 'map') {
      this.showMinimap = !this.showMinimap;
    } else if (action === 'zoomIn') {
      zoomIn(cam, map.width, map.height);
    } else if (action === 'zoomOut') {
      zoomOut(cam, map.width, map.height);
    }
    if (input.keysPressed.has('f6')) this.showMinimap = !this.showMinimap;
  }

  /** Deployment shading: own zone unshaded, enemy zone dark gray, everything
   * else (neutral ground) light gray — drawn to an offscreen buffer first so
   * the compositing punch-hole doesn't erase the terrain already drawn. */
  private drawDeploymentShading(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const map = this.battle.state.map;
    this.shadeCanvas.width = VIEW_W;
    this.shadeCanvas.height = VIEW_H;
    const sctx = this.shadeCanvas.getContext('2d')!;
    sctx.clearRect(0, 0, VIEW_W, VIEW_H);
    sctx.fillStyle = 'rgba(0,0,0,0.2)';
    sctx.fillRect(0, 0, VIEW_W, VIEW_H);

    const ownZone = map.def.deployZones[this.battle.playerSide()];
    const otl = worldToScreen(cam, { x: ownZone.x, y: ownZone.y });
    const obr = worldToScreen(cam, { x: ownZone.x + ownZone.w, y: ownZone.y + ownZone.h });
    sctx.save();
    sctx.globalCompositeOperation = 'destination-out';
    sctx.fillStyle = 'rgba(0,0,0,1)';
    sctx.fillRect(otl.x, otl.y, obr.x - otl.x, obr.y - otl.y);
    sctx.restore();

    const enemyZone = map.def.deployZones[otherSide(this.battle.playerSide())];
    const etl = worldToScreen(cam, { x: enemyZone.x, y: enemyZone.y });
    const ebr = worldToScreen(cam, { x: enemyZone.x + enemyZone.w, y: enemyZone.y + enemyZone.h });
    sctx.fillStyle = 'rgba(0,0,0,0.45)';
    sctx.fillRect(etl.x, etl.y, ebr.x - etl.x, ebr.y - etl.y);

    ctx.drawImage(this.shadeCanvas, 0, 0);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const cam = game.cam;
    const map = this.battle.state.map;
    const state = this.battle.state;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.fillStyle = PALETTE.black;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    this.terrain.draw(ctx, cam);
    this.terrain.drawOverlays(ctx, cam, state);

    // Deployment shading (manual): own zone unshaded, enemy zone dark gray,
    // neutral ground light gray.
    this.drawDeploymentShading(ctx, cam);

    drawUnits(ctx, cam, state, this.battle.playerSide(), this.selectedTeamId != null ? [this.selectedTeamId] : [], game.settings);

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

    if (this.showMinimap) this.minimap.draw(ctx, this.terrain, state, cam, this.battle.playerSide());
    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    this.soldierMonitor.draw(ctx, state, selTeam);

    drawHudBase(ctx);
    const teams = this.battle.selectableTeams(this.battle.playerSide());
    this.teamGrid.draw(ctx, teams, state, this.selectedTeamId);
    this.combatMessages.draw(ctx, state);
    this.bottomStrip.draw(ctx, state, selTeam);
  }

  cursor(): CursorKind {
    return this.dragPan.active ? 'hand' : this.draggingTeamId != null ? 'move' : 'arrow';
  }
}
