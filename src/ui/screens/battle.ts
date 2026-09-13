import type { CursorKind, InputState, OrderType, Screen, Team, Vec2 } from '@/shared/types';
import { ORDER_DOT_COLOR, ORDER_HOTKEYS, ORDER_TYPES, VIEW_H, VIEW_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { teamCanFire, teamHasSmoke } from '@/sim/team';
import { addMessage } from '@/sim/messages';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { drawLOSLine } from '@/ui/losTool';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { drawHudBase } from '@/ui/hud/hudChrome';
import { CommandMenu } from '@/ui/commandMenu';
import { drawTextCentered, FONT_BIG_H } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { updateCameraEdgeScrollAndKeys, makeEdgeScrollState, pickFriendlyTeamScreen, type EdgeScrollState } from './common';
import { DebriefScreen } from './debrief';
import { OverviewScreen } from './overview';
import { OptionsScreen } from './options';

const SPEEDS: (1 | 2 | 4)[] = [1, 2, 4];
const MOVE_TYPES: OrderType[] = ['move', 'moveFast', 'sneak'];
const DRAG_THRESHOLD_PX = 5;
const RIGHT_GESTURE_PX = 5;
const RIGHT_GESTURE_MS = 400;

/** Big gold word on a 60%-black box, centred in the map viewport — used for
 * the PAUSED overlay and the end-of-battle result word. */
function drawCenteredOverlayBanner(ctx: CanvasRenderingContext2D, word: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const boxW = 200;
  const boxH = 24;
  const boxX = Math.round(VIEW_W / 2 - boxW / 2);
  const boxY = Math.round(VIEW_H / 2 - boxH / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  drawTextCentered(ctx, word, VIEW_W / 2, boxY + Math.round((boxH - FONT_BIG_H) / 2), PALETTE.gold, 'big');
}

interface RightDrag {
  active: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: number;
  startTime: number;
  /** true when the press itself landed on a friendly team, opening the
   * command menu immediately — enables the original's press/drag/release
   * gesture (mousedown on team, drag onto a row, release to pick it). */
  menuOpenedOnPress: boolean;
}

interface LeftDrag {
  active: boolean;
  startX: number;
  startY: number;
  moved: number;
}

export class BattleScreen implements Screen {
  private battle: Battle;
  private terrain: TerrainRenderer;
  private teamGrid = new TeamGrid();
  private combatMessages = new CombatMessages();
  private bottomStrip = new BottomStrip('battle');
  private soldierMonitor = new SoldierMonitorPopup();
  private minimap = new Minimap();
  private commandMenu = new CommandMenu();
  private selectedTeamId: number | null = null;
  private selectedTeamIds: number[] = [];
  private pendingOrder: OrderType | null = null;
  private pendingWaypoints: Vec2[] = [];
  private paused = false;
  private endedAt: number | null = null;
  private rightDrag: RightDrag = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: 0, startTime: 0, menuOpenedOnPress: false };
  private leftDrag: LeftDrag = { active: false, startX: 0, startY: 0, moved: 0 };
  private edgeScroll: EdgeScrollState = makeEdgeScrollState();

  // F5/F6/F7 toggles, Ctrl+K show-dead toggle (original CC3 keyboard reference).
  private showTeamGrid = true;
  private showMinimap = true;
  private showSoldierMonitor = true;
  private showDead = true;

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

  private setSelection(ids: number[]): void {
    this.selectedTeamIds = ids;
    this.selectedTeamId = ids.length > 0 ? ids[0] : null;
  }

  private issueOrderToSelection(input: InputState, world: Vec2): void {
    const battle = this.battle;
    const state = battle.state;
    const ids = this.selectedTeamIds.length > 0 ? this.selectedTeamIds : (this.selectedTeamId != null ? [this.selectedTeamId] : []);
    if (ids.length === 0 || !this.pendingOrder) return;
    const primary = state.teams.get(ids[0]);
    const isMoveType = MOVE_TYPES.includes(this.pendingOrder);
    const enemy = battle.teamAt(world, otherSide(battle.playerSide()));
    const waypoints = this.pendingWaypoints.length > 0 ? [...this.pendingWaypoints] : undefined;
    for (const id of ids) {
      const team = state.teams.get(id);
      if (!team) continue;
      // Move-type group orders keep each team's relative offset from the
      // primary team; Fire/Smoke centre every team on the same point.
      const target = isMoveType && primary && ids.length > 1
        ? { x: world.x + (team.pos.x - primary.pos.x), y: world.y + (team.pos.y - primary.pos.y) }
        : world;
      battle.issueOrder(id, {
        type: this.pendingOrder,
        target,
        targetTeamId: enemy ? enemy.id : undefined,
        issuedAt: state.time,
        waypoints,
      });
    }
    game.audio?.play('click');
    this.pendingOrder = null;
    this.pendingWaypoints = [];
  }

  update(dt: number, input: InputState): void {
    const battle = this.battle;
    const state = battle.state;
    const cam = game.cam;

    if (!this.paused && state.phase === 'running') {
      battle.step(dt * game.settings.speed);
    }

    if (state.phase === 'ended') {
      if (this.endedAt === null) this.endedAt = state.time;
      if (state.time - this.endedAt > 2) {
        game.setScreen(new DebriefScreen(battle));
        return;
      }
    }

    updateCameraEdgeScrollAndKeys(cam, input, dt, state.map.width, state.map.height, this.edgeScroll);

    if (input.wheel !== 0) {
      if (input.wheel < 0) zoomIn(cam, state.map.width, state.map.height, input.mouse);
      else zoomOut(cam, state.map.width, state.map.height, input.mouse);
    }

    // right mouse: pressing directly on a friendly team opens the command
    // menu immediately at the press point (like the original's press/drag
    // onto a row/release gesture); pressing elsewhere starts a pan-or-click
    // gesture resolved on release; right-clicking again while the menu is
    // open closes it (so does Escape, handled below).
    for (const c of input.clicks) {
      if (c.button !== 2) continue;
      if (this.commandMenu.isOpen) {
        this.commandMenu.close();
        continue;
      }
      const hitTeam = pickFriendlyTeamScreen(state, cam, { x: c.x, y: c.y }, battle.playerSide());
      this.rightDrag = { active: true, startX: c.x, startY: c.y, lastX: c.x, lastY: c.y, moved: 0, startTime: state.time, menuOpenedOnPress: false };
      if (hitTeam) {
        this.setSelection([hitTeam.id]);
        this.commandMenu.open({ x: c.x, y: c.y }, hitTeam, {
          canSmoke: teamHasSmoke(state, hitTeam),
          canFire: teamCanFire(state, hitTeam),
        });
        this.rightDrag.menuOpenedOnPress = true;
      }
    }
    if (this.rightDrag.active && input.buttons.right && !this.rightDrag.menuOpenedOnPress) {
      const dx = input.mouse.x - this.rightDrag.lastX;
      const dy = input.mouse.y - this.rightDrag.lastY;
      if (dx !== 0 || dy !== 0) {
        panCamera(cam, -dx, -dy);
        clampCamera(cam, state.map.width, state.map.height);
        this.rightDrag.lastX = input.mouse.x;
        this.rightDrag.lastY = input.mouse.y;
      }
      this.rightDrag.moved = Math.max(this.rightDrag.moved, Math.hypot(input.mouse.x - this.rightDrag.startX, input.mouse.y - this.rightDrag.startY));
    }
    for (const r of input.releases) {
      if (r.button !== 2 || !this.rightDrag.active) continue;
      const heldMs = (state.time - this.rightDrag.startTime) * 1000;
      if (!this.rightDrag.menuOpenedOnPress && this.rightDrag.moved < RIGHT_GESTURE_PX && heldMs <= RIGHT_GESTURE_MS
        && this.selectedTeamId != null && !this.commandMenu.isOpen) {
        const team = state.teams.get(this.selectedTeamId);
        if (team) {
          this.commandMenu.open({ x: r.x, y: r.y }, team, {
            canSmoke: teamHasSmoke(state, team),
            canFire: teamCanFire(state, team),
          });
        }
      }
      this.rightDrag.active = false;
    }

    // command menu
    const menuWasOpen = this.commandMenu.isOpen;
    if (this.commandMenu.isOpen) {
      const r = this.commandMenu.update(input);
      if (r === 'cancel') {
        this.commandMenu.close();
      } else if (r) {
        this.pendingOrder = r;
        this.pendingWaypoints = [];
        this.commandMenu.close();
      }
    }

    if (input.keysPressed.has('escape')) {
      if (this.commandMenu.isOpen) this.commandMenu.close();
      else { this.pendingOrder = null; this.pendingWaypoints = []; }
    }

    // left mouse: press starts a potential drag (box-select), release decides
    // whether it was a simple click (select/issue order) or a drag (box-select).
    for (const c of input.clicks) {
      if (c.button === 0 && c.y < VIEW_H && !this.commandMenu.isOpen && !menuWasOpen) {
        this.leftDrag = { active: true, startX: c.x, startY: c.y, moved: 0 };
      }
    }
    if (this.leftDrag.active && input.buttons.left) {
      this.leftDrag.moved = Math.max(this.leftDrag.moved, Math.hypot(input.mouse.x - this.leftDrag.startX, input.mouse.y - this.leftDrag.startY));
    }
    for (const r of input.releases) {
      if (r.button !== 0 || !this.leftDrag.active) continue;
      if (r.y >= VIEW_H) {
        this.leftDrag.active = false;
        continue;
      }
      const dragged = this.leftDrag.moved >= DRAG_THRESHOLD_PX;
      if (dragged && !this.pendingOrder) {
        // box select: any friendly, selectable team whose position falls in the rect
        const x0 = Math.min(this.leftDrag.startX, r.x), x1 = Math.max(this.leftDrag.startX, r.x);
        const y0 = Math.min(this.leftDrag.startY, r.y), y1 = Math.max(this.leftDrag.startY, r.y);
        const inBox = battle.selectableTeams(battle.playerSide()).filter((t) => {
          const p = worldToScreen(cam, t.pos);
          return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        });
        if (inBox.length > 0) this.setSelection(inBox.map((t) => t.id));
      } else {
        const world = screenToWorld(cam, { x: r.x, y: r.y });
        if (this.pendingOrder && this.selectedTeamId != null) {
          const chaining = MOVE_TYPES.includes(this.pendingOrder) && input.keysDown.has('shift');
          if (chaining) {
            this.pendingWaypoints.push(world);
          } else {
            this.issueOrderToSelection(input, world);
          }
        } else {
          const hitTeam = pickFriendlyTeamScreen(state, cam, { x: r.x, y: r.y }, battle.playerSide());
          this.setSelection(hitTeam ? [hitTeam.id] : []);
        }
      }
      this.leftDrag.active = false;
    }

    if (input.keysPressed.has('tab')) {
      const teams = battle.selectableTeams(battle.playerSide());
      if (teams.length > 0) {
        const idx = teams.findIndex((t) => t.id === this.selectedTeamId);
        this.setSelection([teams[(idx + 1) % teams.length].id]);
      }
    }

    if (this.selectedTeamId != null && !this.commandMenu.isOpen) {
      for (const ot of ORDER_TYPES) {
        if (input.keysPressed.has(ORDER_HOTKEYS[ot])) { this.pendingOrder = ot; this.pendingWaypoints = []; }
      }
    }

    const teams = battle.selectableTeams(battle.playerSide());
    const gridClick = this.teamGrid.update(input, teams);
    if (gridClick != null) {
      this.setSelection([gridClick]);
      const team = state.teams.get(gridClick);
      if (team) centerCamera(cam, team.pos);
      clampCamera(cam, state.map.width, state.map.height);
    }

    if (this.showMinimap) this.minimap.update(input, cam, state.map.width, state.map.height);

    this.combatMessages.update(input, state);
    const selTeamForMonitor = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.showSoldierMonitor) this.soldierMonitor.update(input, state, selTeamForMonitor);

    const action = this.bottomStrip.update(input);
    if (action === 'truce') {
      battle.offerTruce(battle.playerSide());
      addMessage(state, 'You have offered a truce', 'info');
    } else if (action === 'flee') {
      if (this.selectedTeamId != null) {
        const team = state.teams.get(this.selectedTeamId);
        const zone = state.map.def.deployZones[battle.playerSide()];
        if (team) {
          battle.issueOrder(this.selectedTeamId, {
            type: 'moveFast',
            target: { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 },
            issuedAt: state.time,
          });
        }
      }
    } else if (action === 'map') {
      this.showMinimap = !this.showMinimap;
    } else if (action === 'options') {
      game.setScreen(new OptionsScreen(this));
      return;
    } else if (action === 'zoomIn') {
      zoomIn(cam, state.map.width, state.map.height);
    } else if (action === 'zoomOut') {
      zoomOut(cam, state.map.width, state.map.height);
    }

    if (input.keysPressed.has('o')) {
      game.setScreen(new OverviewScreen(battle, this));
      return;
    }
    if (input.keysPressed.has('f3') || input.keysPressed.has('pause')) this.paused = !this.paused;
    if (input.keysPressed.has('f5')) this.showTeamGrid = !this.showTeamGrid;
    if (input.keysPressed.has('f6')) this.showMinimap = !this.showMinimap;
    if (input.keysPressed.has('f7')) this.showSoldierMonitor = !this.showSoldierMonitor;
    if (input.keysPressed.has('f8')) { game.setScreen(new OptionsScreen(this)); return; }
    if (input.keysDown.has('control') && input.keysPressed.has('k')) this.showDead = !this.showDead;

    if (input.keysPressed.has(' ')) this.paused = !this.paused;
    if (input.keysPressed.has('+') || input.keysPressed.has('=')) {
      const idx = SPEEDS.indexOf(game.settings.speed);
      game.settings.speed = SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)];
    }
    if (input.keysPressed.has('-')) {
      const idx = SPEEDS.indexOf(game.settings.speed);
      game.settings.speed = SPEEDS[Math.max(0, idx - 1)];
    }
    if (input.keysPressed.has('l')) game.settings.unitLabels = !game.settings.unitLabels;

    game.audio?.handleEvents(battle.drainEvents(), cam);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const battle = this.battle;
    const state = battle.state;
    const cam = game.cam;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.fillStyle = PALETTE.black;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    this.terrain.draw(ctx, cam);
    this.terrain.drawOverlays(ctx, cam, state);
    drawUnits(ctx, cam, state, battle.playerSide(), this.selectedTeamIds, game.settings, this.showDead);
    drawEffects(ctx, cam, state);

    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.pendingOrder && selTeam) {
      const from = { x: selTeam.pos.x, y: selTeam.pos.y };
      const to = screenToWorld(cam, game.input.state.mouse);
      const a = worldToScreen(cam, from);
      const b = worldToScreen(cam, to);
      // Use the order's own color from the very first aiming frame (before
      // commit), matching the color the line will render once the order is
      // actually issued — was hardcoded gold, which briefly looked wrong for
      // every order type except Move.
      ctx.strokeStyle = ORDER_DOT_COLOR[this.pendingOrder];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (this.pendingOrder === 'fire' && selTeam && game.input.state.keysDown.has('alt')) {
      const leader = state.soldiers.get(selTeam.leaderId);
      if (leader) {
        const to = screenToWorld(cam, game.input.state.mouse);
        drawLOSLine(ctx, cam, state.map, leader.pos, to, { state, team: selTeam });
      }
    }

    // group-select marquee
    if (this.leftDrag.active && this.leftDrag.moved >= DRAG_THRESHOLD_PX && !this.pendingOrder) {
      const mouse = game.input.state.mouse;
      const x0 = Math.min(this.leftDrag.startX, mouse.x), x1 = Math.max(this.leftDrag.startX, mouse.x);
      const y0 = Math.min(this.leftDrag.startY, mouse.y), y1 = Math.max(this.leftDrag.startY, mouse.y);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Minimap and soldier monitor sit over the map viewport itself.
    if (this.showMinimap) this.minimap.draw(ctx, this.terrain, state, cam, battle.playerSide());
    if (this.showSoldierMonitor) this.soldierMonitor.draw(ctx, state, selTeam);

    drawHudBase(ctx);
    if (this.showTeamGrid) this.teamGrid.draw(ctx, battle.selectableTeams(battle.playerSide()), state, this.selectedTeamId);
    this.combatMessages.draw(ctx, state);
    this.bottomStrip.draw(ctx, state, selTeam);

    if (this.commandMenu.isOpen) this.commandMenu.draw(ctx);

    if (this.paused) {
      drawCenteredOverlayBanner(ctx, 'PAUSED');
    }
    if (state.phase === 'ended') {
      const word = (state.result ?? 'draw').toUpperCase();
      drawCenteredOverlayBanner(ctx, word);
    }
  }

  cursor(): CursorKind {
    if (this.pendingOrder) return 'crosshair';
    if (this.rightDrag.active && !this.rightDrag.menuOpenedOnPress && this.rightDrag.moved >= RIGHT_GESTURE_PX) return 'hand';
    return 'arrow';
  }
}
