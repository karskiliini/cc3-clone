import type { CursorKind, InputState, OrderType, Screen, Side, Team, Vec2 } from '@/shared/types';
import { ORDER_DOT_COLOR, ORDER_HOTKEYS, ORDER_TYPES, VIEW_H, VIEW_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { teamCanFire, teamHasSmoke } from '@/sim/team';
import { addMessage } from '@/sim/messages';
import { flee } from '@/sim/victory';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { VisibilityOverlay } from '@/render/visibilityOverlay';
import { hitRect } from '@/ui/hud/hudChrome';
import { drawLOSLine } from '@/ui/losTool';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { drawHudBase } from '@/ui/hud/hudChrome';
import { CommandMenu } from '@/ui/commandMenu';
import { OrderBar } from '@/ui/hud/orderBar';
import { drawTextCentered, FONT_BIG_H } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import {
  updateCameraEdgeScrollAndKeys, makeEdgeScrollState, pickFriendlyTeamScreen,
  makeDragPanState, updateModernDragPan, type EdgeScrollState, type DragPanState,
} from './common';
import { DebriefScreen } from './debrief';
import { OverviewScreen } from './overview';
import { OptionsScreen } from './options';

const SPEEDS: (1 | 2 | 4)[] = [1, 2, 4];
const MOVE_TYPES: OrderType[] = ['move', 'moveFast', 'sneak'];
const DRAG_THRESHOLD_PX = 5;
const RIGHT_GESTURE_PX = 5;
const RIGHT_GESTURE_MS = 400;
const DOUBLE_CLICK_MS = 350;
const HOVER_RING_R = 14;
const FLEE_CONFIRM_MS = 2000;

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
  private orderBar = new OrderBar();
  private visionOverlay = new VisibilityOverlay();
  private selectedTeamId: number | null = null;
  private selectedTeamIds: number[] = [];
  private pendingOrder: OrderType | null = null;
  private pendingWaypoints: Vec2[] = [];
  private paused = false;
  /** Real seconds elapsed since the battle ended, driving the debrief transition below — must be
   * wall-clock dt, not state.time, since the sim stops advancing state.time once phase !== 'running'. */
  private endedElapsed = 0;
  private rightDrag: RightDrag = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: 0, startTime: 0, menuOpenedOnPress: false };
  private leftDrag: LeftDrag = { active: false, startX: 0, startY: 0, moved: 0 };
  private edgeScroll: EdgeScrollState = makeEdgeScrollState();
  private modernPanDrag: DragPanState = makeDragPanState();
  private hoverTeamId: number | null = null;
  private hudHover = false;
  private lastMapClickTeamId: number | null = null;
  private lastMapClickTime = 0;
  /** performance.now() deadline for the second Flee click; 0 = not armed. */
  private fleeArmedUntil = 0;

  // F5/F6/F7 toggles, Ctrl+K show-dead toggle (original CC3 keyboard reference).
  private showTeamGrid = true;
  private showMinimap = true;
  private showSoldierMonitor = true;
  private showDead = true;

  /** `terrain` is the deploy screen's renderer, handed over so its baked chunks carry into battle
   * instead of re-baking the whole map on Begin. */
  constructor(battle: Battle, terrain?: TerrainRenderer) {
    this.battle = battle;
    this.terrain = terrain ?? new TerrainRenderer(battle.state.map);
  }

  onEnter(): void {
    const map = this.battle.state.map;
    const zone = map.def.deployZones[this.battle.playerSide()];
    centerCamera(game.cam, { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 });
    clampCamera(game.cam, map.width, map.height);
  }

  /** Team-grid roster: every team of `side`, including out-of-action ones (unlike
   * battle.selectableTeams, which selection hotkeys/drag-select/orders rely on). */
  private rosterTeams(side: Side): Team[] {
    return [...this.battle.state.teams.values()].filter((t) => t.side === side).sort((a, b) => a.id - b.id);
  }

  private setSelection(ids: number[]): void {
    this.selectedTeamIds = ids;
    this.selectedTeamId = ids.length > 0 ? ids[0] : null;
  }

  /** Shift-click/drag semantics: toggle a single id into/out of the current
   * selection, or union a whole set in (never removes the others). */
  private toggleInSelection(id: number): void {
    const set = new Set(this.selectedTeamIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    this.setSelection([...set]);
  }

  /** True when a screen point lies on HUD chrome rather than the open map: the bottom panel, or
   * the minimap / soldier monitor insets that float over the map viewport. Presses and releases
   * there must never select, deselect, box-select or issue orders. */
  private overHud(p: Vec2): boolean {
    if (p.y >= VIEW_H) return true;
    if (this.showMinimap && hitRect(p, this.minimap.rect)) return true;
    if (this.showSoldierMonitor) {
      const state = this.battle.state;
      const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
      const r = this.soldierMonitor.bounds(state, selTeam);
      if (r && hitRect(p, r)) return true;
    }
    return false;
  }

  private addToSelection(ids: number[]): void {
    this.setSelection([...new Set([...this.selectedTeamIds, ...ids])]);
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
      this.endedElapsed += dt;
      if (this.endedElapsed > 2) {
        game.setScreen(new DebriefScreen(battle));
        return;
      }
    }

    updateCameraEdgeScrollAndKeys(cam, input, dt, state.map.width, state.map.height, this.edgeScroll);

    // Ctrl/Cmd+wheel = trackpad pinch = zoom around the pointer. Plain wheel
    // (two-finger scroll) pans instead — modern-app trackpad conventions.
    if (input.wheel !== 0) {
      if (input.wheel < 0) zoomIn(cam, state.map.width, state.map.height, input.mouse);
      else zoomOut(cam, state.map.width, state.map.height, input.mouse);
    }
    if (input.wheelDX !== 0 || input.wheelDY !== 0) {
      panCamera(cam, input.wheelDX, input.wheelDY);
      clampCamera(cam, state.map.width, state.map.height);
    }

    // Middle-drag or Space+left-drag: a modern pan gesture that doesn't tie
    // up the right button. While active, suppress the normal left-click
    // select/box-select/order handling below.
    const modernPanning = updateModernDragPan(cam, input, this.modernPanDrag, state.map.width, state.map.height);

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
      if (this.overHud({ x: c.x, y: c.y })) continue;
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
        && !this.overHud({ x: r.x, y: r.y })
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
    // Suppressed while Space/middle-drag panning is active.
    for (const c of input.clicks) {
      if (c.button === 0 && !this.overHud({ x: c.x, y: c.y }) && !this.commandMenu.isOpen && !menuWasOpen && !modernPanning) {
        this.leftDrag = { active: true, startX: c.x, startY: c.y, moved: 0 };
      }
    }
    if (this.leftDrag.active && input.buttons.left && !modernPanning) {
      this.leftDrag.moved = Math.max(this.leftDrag.moved, Math.hypot(input.mouse.x - this.leftDrag.startX, input.mouse.y - this.leftDrag.startY));
    }
    for (const r of input.releases) {
      if (r.button !== 0 || !this.leftDrag.active) continue;
      // Ending on HUD (bottom panel, minimap, soldier monitor) abandons the gesture untouched.
      if (this.overHud({ x: r.x, y: r.y })) {
        this.leftDrag.active = false;
        continue;
      }
      const dragged = this.leftDrag.moved >= DRAG_THRESHOLD_PX;
      const shiftHeld = input.keysDown.has('shift');
      if (dragged && !this.pendingOrder) {
        // Rect-select: any friendly, selectable team whose centre OR any
        // living soldier's screen position falls inside the marquee.
        const x0 = Math.min(this.leftDrag.startX, r.x), x1 = Math.max(this.leftDrag.startX, r.x);
        const y0 = Math.min(this.leftDrag.startY, r.y), y1 = Math.max(this.leftDrag.startY, r.y);
        const inRect = (p: Vec2) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        const inBox = battle.selectableTeams(battle.playerSide()).filter((t) => {
          if (inRect(worldToScreen(cam, t.pos))) return true;
          for (const sid of t.soldierIds) {
            const s = state.soldiers.get(sid);
            if (s && s.health !== 'dead' && inRect(worldToScreen(cam, s.pos))) return true;
          }
          return false;
        });
        if (inBox.length > 0) {
          const ids = inBox.map((t) => t.id);
          if (shiftHeld) this.addToSelection(ids); else this.setSelection(ids);
        } else if (!shiftHeld) {
          // An empty marquee deselects, same as a plain click on empty ground; Shift keeps it.
          this.setSelection([]);
        }
      } else {
        const world = screenToWorld(cam, { x: r.x, y: r.y });
        if (this.pendingOrder && this.selectedTeamId != null) {
          const chaining = MOVE_TYPES.includes(this.pendingOrder) && shiftHeld;
          if (chaining) {
            this.pendingWaypoints.push(world);
          } else {
            this.issueOrderToSelection(input, world);
          }
        } else {
          const hitTeam = pickFriendlyTeamScreen(state, cam, { x: r.x, y: r.y }, battle.playerSide());
          if (hitTeam) {
            const now = performance.now();
            const isDouble = this.lastMapClickTeamId === hitTeam.id && now - this.lastMapClickTime < DOUBLE_CLICK_MS;
            this.lastMapClickTeamId = hitTeam.id;
            this.lastMapClickTime = now;
            if (shiftHeld) this.toggleInSelection(hitTeam.id); else this.setSelection([hitTeam.id]);
            if (isDouble) {
              centerCamera(cam, hitTeam.pos);
              clampCamera(cam, state.map.width, state.map.height);
            }
          } else {
            this.lastMapClickTeamId = null;
            if (!shiftHeld) this.setSelection([]);
          }
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
    if (input.keysDown.has('control') && input.keysPressed.has('a')) {
      this.setSelection(battle.selectableTeams(battle.playerSide()).map((t) => t.id));
    }

    if (this.selectedTeamId != null && !this.commandMenu.isOpen) {
      for (const ot of ORDER_TYPES) {
        if (input.keysPressed.has(ORDER_HOTKEYS[ot])) { this.pendingOrder = ot; this.pendingWaypoints = []; }
      }
    }

    // Order bar: a modern, no-right-click-required way to pick an order —
    // same order set/colours/hotkeys as the classic menu.
    const orderBarResult = this.orderBar.update(input, { enabled: this.selectedTeamIds.length > 0, pending: this.pendingOrder });
    if (orderBarResult === 'cancel') {
      this.pendingOrder = null;
      this.pendingWaypoints = [];
    } else if (orderBarResult) {
      this.pendingOrder = orderBarResult;
      this.pendingWaypoints = [];
    }

    // The roster keeps out-of-action teams (greyed, status in red); TeamGrid ignores clicks on them.
    const gridClick = this.teamGrid.update(input, this.rosterTeams(battle.playerSide()));
    if (gridClick != null) {
      if (gridClick.shift) this.toggleInSelection(gridClick.id);
      else this.setSelection([gridClick.id]);
      if (gridClick.doubleClick) {
        const team = state.teams.get(gridClick.id);
        if (team) centerCamera(cam, team.pos);
        clampCamera(cam, state.map.width, state.map.height);
      }
    }

    // Hover feedback: which friendly team (if any) sits under the pointer
    // right now, for the subtle map-ring highlight + hand cursor.
    this.hoverTeamId = (!this.pendingOrder && !this.overHud(input.mouse) && !this.commandMenu.isOpen)
      ? (pickFriendlyTeamScreen(state, cam, input.mouse, battle.playerSide())?.id ?? null)
      : null;

    if (this.showMinimap) this.minimap.update(input, cam, state.map.width, state.map.height);

    this.combatMessages.update(input, state);
    const selTeamForMonitor = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.showSoldierMonitor) this.soldierMonitor.update(input, state, selTeamForMonitor);

    if (this.fleeArmedUntil !== 0 && performance.now() >= this.fleeArmedUntil) this.fleeArmedUntil = 0;
    this.bottomStrip.setFleeArmed(this.fleeArmedUntil !== 0);
    const action = this.bottomStrip.update(input);
    // Hand cursor only over real controls: a hot bottom-strip button, a filled (actionable) team
    // box, an order-bar button, or the minimap — not the whole bottom panel.
    const roster = this.rosterTeams(battle.playerSide());
    const gridHover = this.teamGrid['hoverIndex'];
    const m = input.mouse;
    const r = this.minimap.rect;
    this.hudHover = !this.commandMenu.isOpen && (
      this.bottomStrip['hover'].size > 0
      || (this.showTeamGrid && gridHover >= 0 && gridHover < roster.length && !roster[gridHover].outOfAction)
      || this.orderBar.isHovering()
      || (this.showMinimap && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h));
    if (action === 'truce') {
      battle.offerTruce(battle.playerSide());
    } else if (action === 'flee') {
      // Per the manual, Flee ends the battle immediately with the enemy taking the map — it is
      // not a per-team retreat order. Two-step: the first click arms it for 2 s so an overshoot
      // from the adjacent order bar can't forfeit the battle.
      const now = performance.now();
      if (now < this.fleeArmedUntil) {
        this.fleeArmedUntil = 0;
        flee(state, battle.playerSide());
      } else {
        this.fleeArmedUntil = now + FLEE_CONFIRM_MS;
        addMessage(state, 'Flee?\nClick again to confirm', 'warn');
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
    if (input.keysPressed.has('l')) {
      if (input.keysDown.has('shift')) {
        game.settings.unitLabels = !game.settings.unitLabels;
      } else {
        game.settings.showUnitVision = !(game.settings.showUnitVision ?? true);
        addMessage(state, `View overlay ${game.settings.showUnitVision ? 'on' : 'off'}`, 'info');
      }
      game.saveSettings();
    }

    if (game.settings.showUnitVision ?? true) {
      this.visionOverlay.update(state, cam, battle.playerSide(), this.selectedTeamIds, performance.now());
    } else {
      this.visionOverlay.reset();
    }

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
    if (game.settings.showUnitVision ?? true) this.visionOverlay.draw(ctx, cam, state, this.selectedTeamIds);
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

    // hover ring: a subtle highlight under the friendly team the pointer is over
    if (this.hoverTeamId != null && this.hoverTeamId !== this.selectedTeamId) {
      const hoverTeam = state.teams.get(this.hoverTeamId);
      if (hoverTeam) {
        const p = worldToScreen(cam, hoverTeam.pos);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, HOVER_RING_R, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // rect-select marquee: white dashed outline with a translucent fill
    if (this.leftDrag.active && this.leftDrag.moved >= DRAG_THRESHOLD_PX && !this.pendingOrder) {
      const mouse = game.input.state.mouse;
      const x0 = Math.min(this.leftDrag.startX, mouse.x), x1 = Math.max(this.leftDrag.startX, mouse.x);
      const y0 = Math.min(this.leftDrag.startY, mouse.y), y1 = Math.max(this.leftDrag.startY, mouse.y);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
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
    if (this.showTeamGrid) this.teamGrid.draw(ctx, this.rosterTeams(battle.playerSide()), state, this.selectedTeamIds);
    this.combatMessages.draw(ctx, state);
    this.bottomStrip.draw(ctx, state, selTeam);
    this.orderBar.draw(ctx, { enabled: this.selectedTeamIds.length > 0, pending: this.pendingOrder });

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
    if (this.modernPanDrag.active) return 'hand';
    if (this.rightDrag.active && !this.rightDrag.menuOpenedOnPress && this.rightDrag.moved >= RIGHT_GESTURE_PX) return 'hand';
    if (this.hudHover) return 'hand';
    if (this.hoverTeamId != null) return 'hand';
    return 'arrow';
  }
}
