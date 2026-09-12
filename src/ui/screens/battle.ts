import type { CursorKind, InputState, OrderType, Screen, Team } from '@/shared/types';
import { ORDER_HOTKEYS, ORDER_TYPES, PANEL_H, PANEL_Y, SCREEN_H, SCREEN_W, VIEW_H, VIEW_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { teamCanFire, teamHasSmoke } from '@/sim/team';
import { addMessage } from '@/sim/messages';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { drawLOSLine } from '@/ui/losTool';
import { TeamListPanel } from '@/ui/teamList';
import { drawSoldierMonitor } from '@/ui/soldierMonitor';
import { MessagePanel } from '@/ui/messagePanel';
import { CommandMenu } from '@/ui/commandMenu';
import { drawTextCentered } from '@/render/pixelfont';
import { PALETTE, ORDER_COLOR } from '@/render/palette';
import { updateCameraEdgeScrollAndKeys } from './common';
import { DebriefScreen } from './debrief';
import { OverviewScreen } from './overview';
import { OptionsScreen } from './options';

const SPEEDS: (1 | 2 | 4)[] = [1, 2, 4];

interface RightDrag {
  active: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: number;
}

export class BattleScreen implements Screen {
  private battle: Battle;
  private terrain: TerrainRenderer;
  private teamList = new TeamListPanel();
  private messagePanel = new MessagePanel();
  private commandMenu = new CommandMenu();
  private selectedTeamId: number | null = null;
  private pendingOrder: OrderType | null = null;
  private paused = false;
  private endedAt: number | null = null;
  private rightDrag: RightDrag = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: 0 };

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

    updateCameraEdgeScrollAndKeys(cam, input, dt, state.map.width, state.map.height);

    if (input.wheel !== 0) {
      const before = screenToWorld(cam, input.mouse);
      cam.zoom = cam.zoom === 1 ? 2 : 1;
      clampCamera(cam, state.map.width, state.map.height);
      const after = screenToWorld(cam, input.mouse);
      cam.x += before.x - after.x;
      cam.y += before.y - after.y;
      clampCamera(cam, state.map.width, state.map.height);
    }

    // right mouse: drag = pan, click (no team) = nothing, click (team selected) = command menu
    for (const c of input.clicks) {
      if (c.button === 2) {
        this.rightDrag = { active: true, startX: c.x, startY: c.y, lastX: c.x, lastY: c.y, moved: 0 };
      }
    }
    if (this.rightDrag.active && input.buttons.right) {
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
      if (r.button === 2 && this.rightDrag.active) {
        if (this.rightDrag.moved < 4 && this.selectedTeamId != null && !this.commandMenu.isOpen) {
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
    }

    // command menu
    if (this.commandMenu.isOpen) {
      const r = this.commandMenu.update(input);
      if (r === 'cancel') {
        this.commandMenu.close();
      } else if (r) {
        this.pendingOrder = r;
        this.commandMenu.close();
      }
    }

    if (input.keysPressed.has('escape')) {
      if (this.commandMenu.isOpen) this.commandMenu.close();
      else this.pendingOrder = null;
    }

    // left click: issue pending order, or select
    for (const c of input.clicks) {
      if (c.button !== 0 || c.y >= VIEW_H) continue;
      if (this.commandMenu.isOpen) continue;
      const world = screenToWorld(cam, { x: c.x, y: c.y });
      if (this.pendingOrder && this.selectedTeamId != null) {
        const enemy = battle.teamAt(world, otherSide(battle.playerSide()));
        battle.issueOrder(this.selectedTeamId, {
          type: this.pendingOrder,
          target: world,
          targetTeamId: enemy ? enemy.id : undefined,
          issuedAt: state.time,
        });
        game.audio?.play('click');
        this.pendingOrder = null;
      } else {
        const soldier = battle.soldierAt(world, battle.playerSide());
        this.selectedTeamId = soldier ? soldier.teamId : null;
      }
    }

    if (input.keysPressed.has('tab')) {
      const teams = battle.selectableTeams(battle.playerSide());
      if (teams.length > 0) {
        const idx = teams.findIndex((t) => t.id === this.selectedTeamId);
        this.selectedTeamId = teams[(idx + 1) % teams.length].id;
      }
    }

    if (this.selectedTeamId != null && !this.commandMenu.isOpen) {
      for (const ot of ORDER_TYPES) {
        if (input.keysPressed.has(ORDER_HOTKEYS[ot])) this.pendingOrder = ot;
      }
    }

    const teams = battle.selectableTeams(battle.playerSide());
    const clickedTeamId = this.teamList.update(input, teams, state);
    if (clickedTeamId != null) {
      this.selectedTeamId = clickedTeamId;
      const team = state.teams.get(clickedTeamId);
      if (team) centerCamera(cam, team.pos);
      clampCamera(cam, state.map.width, state.map.height);
    }

    const action = this.messagePanel.update(input);
    if (action === 'truce') {
      battle.offerTruce(battle.playerSide());
      addMessage(state, 'You have offered a truce', 'info');
    } else if (action === 'overview') {
      game.setScreen(new OverviewScreen(battle, this));
      return;
    } else if (action === 'options') {
      game.setScreen(new OptionsScreen(this));
      return;
    } else if (action === 'pause') {
      this.paused = !this.paused;
    }

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
    drawUnits(ctx, cam, state, battle.playerSide(), this.selectedTeamId, game.settings);
    drawEffects(ctx, cam, state);

    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.pendingOrder && selTeam) {
      const from = { x: selTeam.pos.x, y: selTeam.pos.y };
      const to = screenToWorld(cam, game.input.state.mouse);
      const a = worldToScreen(cam, from);
      const b = worldToScreen(cam, to);
      ctx.strokeStyle = ORDER_COLOR[this.pendingOrder];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (game.settings.losLines && selTeam && game.input.state.keysDown.has('shift')) {
      const leader = state.soldiers.get(selTeam.leaderId);
      if (leader) {
        const to = screenToWorld(cam, game.input.state.mouse);
        drawLOSLine(ctx, cam, state.map, leader.pos, to);
      }
    }

    ctx.restore();

    this.teamList.draw(ctx, battle.selectableTeams(battle.playerSide()), state, this.selectedTeamId);
    drawSoldierMonitor(ctx, state, selTeam);
    this.messagePanel.draw(ctx, state, this.paused);
    if (this.commandMenu.isOpen) this.commandMenu.draw(ctx);

    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      drawTextCentered(ctx, 'PAUSED', VIEW_W / 2, VIEW_H / 2 - 6, PALETTE.gold, 'big');
    }
    if (state.phase === 'ended') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      const word = (state.result ?? 'draw').toUpperCase();
      drawTextCentered(ctx, word, VIEW_W / 2, VIEW_H / 2 - 6, PALETTE.gold, 'big');
    }
  }

  cursor(): CursorKind {
    if (this.pendingOrder) return 'crosshair';
    if (this.rightDrag.active && this.rightDrag.moved >= 4) return 'hand';
    return 'arrow';
  }
}
