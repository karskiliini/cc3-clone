import type { BattleState, Camera, CursorKind, InputState, Screen, Vec2 } from '@/shared/types';
import { VIEW_H, VIEW_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { VisibilityOverlay } from '@/render/visibilityOverlay';
import { DepthOverlay } from '@/render/depthOverlay';
import { pickOrderMarker } from '@/render/orderMarkers';
import { cycleTeamKey, handleDepthMapKey } from './viewKeys';
import { hitRect } from '@/ui/hud/hudChrome';
import { addMessage } from '@/sim/messages';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { drawHudBase } from '@/ui/hud/hudChrome';
import { getTeamIcon } from '@/render/sprites';
import { drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import {
  updateCameraEdgeScrollAndKeys, makeDragPanState, makeEdgeScrollState, updateRightDragPan,
  updateModernDragPan, pickFriendlyTeamScreen, type EdgeScrollState, type DragPanState,
} from './battleInput';
import { isPassable } from '@/sim/path';
import { pointInRect } from '@/shared/math';
import { BattleScreen } from './battle';
import { OptionsScreen } from './options';

const DRAG_THRESHOLD_PX = 5;

export class DeployScreen implements Screen {
  private battle: Battle;
  private terrain: TerrainRenderer;
  private teamGrid = new TeamGrid();
  private combatMessages = new CombatMessages();
  private bottomStrip = new BottomStrip('deploy');
  private soldierMonitor = new SoldierMonitorPopup();
  private minimap = new Minimap();
  private visionOverlay = new VisibilityOverlay();
  private depthOverlay = new DepthOverlay();
  /** order endpoint marker under the pointer (hover shows its line, click selects its team) */
  private hoveredOrderMarker: { teamId: number; kind: 'target' | 'waypoint'; index: number } | null = null;
  private selectedTeamId: number | null = null;
  private draggingTeamId: number | null = null;
  /** Left press on a friendly team that hasn't yet moved DRAG_THRESHOLD_PX — becomes a drag
   * (draggingTeamId) only past the threshold, so a plain click just selects. */
  private pressTeamId: number | null = null;
  private pressStart: Vec2 = { x: 0, y: 0 };
  private dragPan = makeDragPanState();
  private modernPanDrag: DragPanState = makeDragPanState();
  private edgeScroll: EdgeScrollState = makeEdgeScrollState();
  private invalidTimer = 0;
  private showMinimap = true;
  private shadeCanvas = document.createElement('canvas');
  /** true while actively dragging and the current drop point is invalid. */
  private dragInvalid = false;

  constructor(battle: Battle) {
    this.battle = battle;
    this.terrain = new TerrainRenderer(battle.state.map);
  }

  /** onEnter runs again when Options / the overview map hand control back: only the
   * first entry centres the camera on the deployment zone. */
  private entered = false;

  onEnter(): void {
    if (this.entered) return;
    this.entered = true;
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

  /** Bottom panel, or the minimap / soldier monitor insets floating over the map viewport:
   * presses and releases there never select, pick up or drop a team. */
  private overHud(p: Vec2): boolean {
    if (p.y >= VIEW_H) return true;
    if (this.showMinimap && hitRect(p, this.minimap.rect)) return true;
    const state = this.battle.state;
    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    const r = this.soldierMonitor.bounds(state, selTeam);
    return !!r && hitRect(p, r);
  }

  update(dt: number, input: InputState): void {
    const cam = game.cam;
    const map = this.battle.state.map;
    const state = this.battle.state;

    if (this.invalidTimer > 0) this.invalidTimer -= dt;

    updateCameraEdgeScrollAndKeys(cam, input, dt, map.width, map.height, this.edgeScroll);
    updateRightDragPan(cam, input, this.dragPan, map.width, map.height);
    const modernPanning = updateModernDragPan(cam, input, this.modernPanDrag, map.width, map.height);
    // Ctrl/Cmd+wheel (pinch) zooms around the pointer; plain wheel pans.
    if (input.wheel !== 0) {
      if (input.wheel < 0) zoomIn(cam, map.width, map.height, input.mouse);
      else zoomOut(cam, map.width, map.height, input.mouse);
    }
    if (input.wheelDX !== 0 || input.wheelDY !== 0) {
      panCamera(cam, input.wheelDX, input.wheelDY);
      clampCamera(cam, map.width, map.height);
    }

    // left mouse down on a friendly soldier/vehicle: select + start drag
    // (suppressed while Space+drag is panning the map)
    this.hoveredOrderMarker = !this.overHud(input.mouse) && input.pointerInside
      ? pickOrderMarker(state, cam, input.mouse, this.battle.playerSide())
      : null;
    for (const c of input.clicks) {
      if (c.button !== 0 || this.overHud({ x: c.x, y: c.y }) || modernPanning) continue;
      const hitTeam = pickFriendlyTeamScreen(state, cam, { x: c.x, y: c.y }, this.battle.playerSide());
      this.draggingTeamId = null;
      const marker = hitTeam ? null : pickOrderMarker(state, cam, { x: c.x, y: c.y }, this.battle.playerSide());
      if (marker) {
        this.selectedTeamId = marker.teamId;
        this.pressTeamId = null;
      } else if (hitTeam) {
        this.selectedTeamId = hitTeam.id;
        this.pressTeamId = hitTeam.id;
        this.pressStart = { x: c.x, y: c.y };
      } else {
        this.pressTeamId = null;
      }
    }
    if (this.pressTeamId != null && input.buttons.left && !modernPanning
      && Math.hypot(input.mouse.x - this.pressStart.x, input.mouse.y - this.pressStart.y) >= DRAG_THRESHOLD_PX) {
      this.draggingTeamId = this.pressTeamId;
      this.pressTeamId = null;
    }
    // Escape abandons the drag; the team stays where it was.
    if (input.keysPressed.has('escape')) {
      this.draggingTeamId = null;
      this.pressTeamId = null;
    }

    // while dragging: continuously check whether the tile snapped under the
    // cursor is a legal drop point, so the ghost/cursor can reflect it live.
    if (this.draggingTeamId != null) {
      const dragTeam = state.teams.get(this.draggingTeamId);
      const dropWorld = this.snappedDropPoint(cam, input.mouse);
      const zone = map.def.deployZones[this.battle.playerSide()];
      const mover = dragTeam?.vehicleId != null ? 'vehicle' : 'infantry';
      this.dragInvalid = !pointInRect(dropWorld, zone) || !isPassable(map, Math.floor(dropWorld.x), Math.floor(dropWorld.y), mover);
    } else {
      this.dragInvalid = false;
    }

    // release: drop the dragged team, snapped to the tile under the cursor
    for (const r of input.releases) {
      if (r.button !== 0) continue;
      this.pressTeamId = null;
      if (this.draggingTeamId != null && this.overHud({ x: r.x, y: r.y })) {
        // Released over HUD: abandon the drag, the team stays where it was.
        this.draggingTeamId = null;
        this.dragInvalid = false;
      } else if (this.draggingTeamId != null) {
        const dropWorld = this.snappedDropPoint(cam, { x: r.x, y: r.y });
        const ok = this.battle.deployTeam(this.draggingTeamId, dropWorld);
        if (ok) game.audio?.play('click');
        else this.invalidTimer = 1;
        this.draggingTeamId = null;
        this.dragInvalid = false;
      }
    }

    const teams = this.battle.selectableTeams(this.battle.playerSide());
    const clicked = this.teamGrid.update(input, teams);
    if (clicked != null) {
      this.selectedTeamId = clicked.id;
      if (clicked.doubleClick) {
        const team = state.teams.get(clicked.id);
        if (team) centerCamera(cam, team.pos);
        clampCamera(cam, map.width, map.height);
      }
    }

    if (this.showMinimap) this.minimap.update(input, cam, map.width, map.height);
    this.combatMessages.update(input, state);
    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    this.soldierMonitor.update(input, state, selTeam);

    const action = this.bottomStrip.update(input);
    if (action === 'auto') {
      aiDeploy(this.battle.state, this.battle.playerSide(), this.battle.rng, this.battle);
      game.audio?.play('click');
    } else if (action === 'begin') {
      this.battle.start();
      game.audio?.play('click');
      game.setScreen(new BattleScreen(this.battle, this.terrain));
    } else if (action === 'map') {
      this.showMinimap = !this.showMinimap;
    } else if (action === 'options') {
      game.setScreen(new OptionsScreen(this, true));
      return;
    } else if (action === 'zoomIn') {
      zoomIn(cam, map.width, map.height);
    } else if (action === 'zoomOut') {
      zoomOut(cam, map.width, map.height);
    }
    if (input.keysPressed.has('f6')) this.showMinimap = !this.showMinimap;
    if (input.keysPressed.has('l')) {
      if (input.keysDown.has('shift')) {
        game.settings.unitLabels = !game.settings.unitLabels;
      } else {
        game.settings.showUnitVision = !(game.settings.showUnitVision ?? true);
        addMessage(state, `View overlay ${game.settings.showUnitVision ? 'on' : 'off'}`, 'info');
      }
      game.saveSettings();
    }
    // Tab: depth map view (hides the vision overlay while on). '.' / ',' cycle teams.
    if (handleDepthMapKey(input.keysPressed, game.settings)) {
      addMessage(state, `Depth map ${game.settings.showDepthMap ? 'on' : 'off'}`, 'info');
    }
    const cycled = cycleTeamKey(input.keysPressed, this.battle.selectableTeams(this.battle.playerSide()).map((t) => t.id), this.selectedTeamId);
    if (cycled != null) this.selectedTeamId = cycled;
    if (game.settings.showDepthMap) {
      this.visionOverlay.reset();
      this.depthOverlay.update(map, cam);
    } else if (game.settings.showUnitVision ?? true) {
      this.depthOverlay.reset();
      this.visionOverlay.update(state, cam, this.battle.playerSide(), this.selectedTeamId != null ? [this.selectedTeamId] : [], performance.now());
    } else {
      this.depthOverlay.reset();
      this.visionOverlay.reset();
    }
  }

  /** World point under a screen point, snapped to the centre of its tile —
   * dropping a dragged team always lands cleanly on a tile, not at whatever
   * fractional world coordinate the cursor happened to be over. */
  private snappedDropPoint(cam: Camera, screenPt: Vec2): Vec2 {
    const world = screenToWorld(cam, screenPt);
    return { x: Math.floor(world.x) + 0.5, y: Math.floor(world.y) + 0.5 };
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
    // Feathered punch-out: blur the own-zone shape so the shading fades over ~12 px
    // instead of a hard tone step that reads like a terrain seam.
    sctx.save();
    sctx.globalCompositeOperation = 'destination-out';
    sctx.filter = 'blur(6px)';
    sctx.fillStyle = 'rgba(0,0,0,1)';
    sctx.fillRect(otl.x, otl.y, obr.x - otl.x, obr.y - otl.y);
    sctx.restore();

    const enemyZone = map.def.deployZones[otherSide(this.battle.playerSide())];
    const etl = worldToScreen(cam, { x: enemyZone.x, y: enemyZone.y });
    const ebr = worldToScreen(cam, { x: enemyZone.x + enemyZone.w, y: enemyZone.y + enemyZone.h });
    sctx.save();
    sctx.filter = 'blur(6px)';
    sctx.fillStyle = 'rgba(0,0,0,0.45)';
    sctx.fillRect(etl.x, etl.y, ebr.x - etl.x, ebr.y - etl.y);
    sctx.restore();

    ctx.drawImage(this.shadeCanvas, 0, 0);
  }

  /** Drag ghost: the whole team's formation, translucent, snapped to the
   * tile under the cursor, plus its team icon. Tinted red (and the cursor
   * switches to 'no', see cursor()) when the drop point isn't legal. */
  private drawDragGhost(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, teamId: number): void {
    const team = state.teams.get(teamId);
    if (!team) return;
    const drop = this.snappedDropPoint(cam, game.input.state.mouse);
    const tint = this.dragInvalid ? PALETTE.red : PALETTE.gold;
    ctx.save();
    // Target tile outline, full strength so the snap point reads clearly.
    const tl = worldToScreen(cam, { x: Math.floor(drop.x), y: Math.floor(drop.y) });
    const br = worldToScreen(cam, { x: Math.floor(drop.x) + 1, y: Math.floor(drop.y) + 1 });
    ctx.strokeStyle = tint;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.max(1, Math.round(br.x - tl.x) - 1), Math.max(1, Math.round(br.y - tl.y) - 1));
    ctx.globalAlpha = 0.8;
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s) continue;
      const p = worldToScreen(cam, team.vehicleId != null ? drop : { x: drop.x + s.formationOffset.x, y: drop.y + s.formationOffset.y });
      ctx.fillStyle = tint;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); // 5 px dot
      ctx.fill();
      ctx.stroke();
    }
    const centre = worldToScreen(cam, drop);
    const icon = getTeamIcon(team.type);
    ctx.drawImage(icon, Math.round(centre.x - icon.width / 2), Math.round(centre.y - icon.height));
    ctx.strokeStyle = tint;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
    if (game.settings.showDepthMap) {
      this.depthOverlay.draw(ctx, cam);
    } else if (game.settings.showUnitVision ?? true) {
      this.visionOverlay.draw(ctx, cam, state, this.selectedTeamId != null ? [this.selectedTeamId] : []);
    }

    drawUnits(ctx, cam, state, this.battle.playerSide(), this.selectedTeamId != null ? [this.selectedTeamId] : [], game.settings, true, this.hoveredOrderMarker);

    if (this.draggingTeamId != null) {
      this.drawDragGhost(ctx, cam, state, this.draggingTeamId);
    }
    if (this.invalidTimer > 0) {
      const mouse = game.input.state.mouse;
      drawTextCentered(ctx, 'INVALID', mouse.x, mouse.y - 20, PALETTE.red, 'small');
    }
    if (game.settings.showDepthMap) this.depthOverlay.drawLegend(ctx);
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
    if (this.dragPan.active || this.modernPanDrag.active) return 'hand';
    if (this.draggingTeamId != null) return this.dragInvalid ? 'no' : 'move';
    if (this.hoveredOrderMarker) return 'hand';
    return 'arrow';
  }
}
