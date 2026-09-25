import type { CursorKind, GameSettings, InputState, BattleState, OrderType, Rect, Screen, Side, Team, Vec2, Camera } from '@/shared/types';
import { ORDER_DOT_COLOR, ORDER_HOTKEYS, ORDER_TYPES, VIEW_H, VIEW_W, TILE_PX, otherSide } from '@/shared/types';
import { COMMAND_RADIUS_TILES } from '@/sim/command';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { teamCanFire, teamHasSmoke } from '@/sim/team';
import { VEHICLE_DEFS } from '@/data/units';
import { clamp } from '@/shared/math';
import { addMessage } from '@/sim/messages';
import { flee } from '@/sim/victory';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { VisibilityOverlay } from '@/render/visibilityOverlay';
import { DepthOverlay } from '@/render/depthOverlay';
import { pickOrderMarker, drawOrderBall } from '@/render/orderMarkers';
import { cycleTeamKey, handleDepthMapKey, offsetOrderPoints, reissueOrderOnMarkerDrag } from './viewKeys';
import { hitRect, setHudFont } from '@/ui/hud/hudChrome';
import { drawLOSLine } from '@/ui/losTool';
import { drawElevationReadout } from '@/ui/elevationReadout';
import { GrassFx } from '@/render/grassFx';
import { BlastFx } from '@/render/blastFx';
import { transportAt } from '@/sim/transport';
import { isRemountTarget } from '@/sim/vehicleCrew';
import { drawText, textWidth } from '@/render/pixelfont';
import { MainMenuScreen } from '@/ui/screens/mainMenu';
import { drawTargetHighlight, targetableEnemyAt, teamObserver, type TargetHover } from '@/ui/targetHover';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { teamSmokeMinRangeM, drawAimRangeFeedback } from '@/ui/losTool';
import { aimLineProfile, aimPointClass } from '@/sim/losProfile';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { drawHudBase } from '@/ui/hud/hudChrome';
import { CommandMenu } from '@/ui/commandMenu';
import { ControlGroups, controlGroupKeyAction } from '@/ui/controlGroups';
import { ControlGroupBar } from '@/ui/hud/controlGroupBar';
import { drawTextCentered, FONT_BIG_H } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import {
  updateCameraEdgeScrollAndKeys, makeEdgeScrollState, pickFriendlyTeamScreen, friendlyCentroid,
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

/** Big gold word on a small 60%-black box, centred in the map viewport — used for
 * the PAUSED overlay and the end-of-battle result word. CC3 shows no whole-view dim
 * for the pause: the banner alone marks it, and a full-view fill made every paused
 * frame measure a fake global ×0.65 tint against reference frames. */
function drawCenteredOverlayBanner(ctx: CanvasRenderingContext2D, word: string): void {
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

/** Press on an order endpoint marker starts dragging that marker; on release the
 * marker's order is re-issued at the drop point (waypoints cleared — a drag
 * redefines the endpoint, keeping the order type). */
interface MarkerDrag {
  teamId: number;
  kind: 'target' | 'waypoint';
  index: number;
  orderType: OrderType;
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
  private commandMenu = new CommandMenu();
  private controlGroupBar = new ControlGroupBar();
  private minimap = new Minimap();
  private controlGroups = new ControlGroups();
  private visionOverlay = new VisibilityOverlay();
  private depthOverlay = new DepthOverlay();
  private grassFx = new GrassFx();
  private blastFx = new BlastFx();
  /** order endpoint/waypoint marker under the pointer (hover shows its line, click selects) */
  private hoveredOrderMarker: { teamId: number; kind: 'target' | 'waypoint'; index: number } | null = null;
  private selectedTeamId: number | null = null;
  private selectedTeamIds: number[] = [];
  /** How many teams the player currently has selected (boot camp reads this to
   * teach lesson 1's "select your rifle team" step). */
  get selectionCount(): number { return this.selectedTeamIds.length; }
  private pendingOrder: OrderType | null = null;
  /** Fire order pending and the pointer is over an enemy team that can be targeted right now. */
  private targetHover: TargetHover | null = null;
  /** Move-type order pending over a vehicle a selected team can board: a transport with room, or
   * the crew's own abandoned vehicle. */
  private mountHover: { pos: Vec2; halfM: number; label: string } | null = null;
  private markerDrag: MarkerDrag | null = null;
  private pendingWaypoints: Vec2[] = [];
  private paused = false;
  /** countdown to the next camera-proximity wounded moan (battle.ts audio sweep) */
  private moanTimer = 2;
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
  /** SPACEBAR (manual input card): overlay circles around every operational
   * command team showing its radio range; teams outside any radius fight and
   * recover morale degraded (command.ts). */
  private showCommandRadii = false;
  /** ESC (manual input card): quit the current battle without saving. Non-null
   * shows the confirm modal and freezes the sim. */
  private quitConfirm: 'yes' | 'no' | null = null;

  /** `terrain` is the deploy screen's renderer, handed over so its baked chunks carry into battle
   * instead of re-baking the whole map on Begin. */
  constructor(battle: Battle, terrain?: TerrainRenderer) {
    this.battle = battle;
    this.terrain = terrain ?? new TerrainRenderer(battle.state.map);
  }

  onEnter(): void {
    const map = this.battle.state.map;
    const centroid = friendlyCentroid(this.battle.state, this.battle.playerSide());
    centerCamera(game.cam, centroid);
    clampCamera(game.cam, map.width, map.height);
  }

  onExit(): void {
    // Stop looping voices so they don't keep playing under the options/debrief
    // screens; update() re-establishes them (ambient/engines) as soon as this
    // screen is active again.
    game.audio?.stopAll();
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
    // Shift-click waypoints are intermediate points in click order, visited before `target`.
    const chain = isMoveType ? this.pendingWaypoints : [];
    for (const id of ids) {
      const team = state.teams.get(id);
      if (!team) continue;
      // Move-type group orders keep each team's relative offset from the primary team on every
      // point of the chain; Fire/Smoke centre every team on the same point.
      const offset = isMoveType && primary && ids.length > 1
        ? { x: team.pos.x - primary.pos.x, y: team.pos.y - primary.pos.y }
        : { x: 0, y: 0 };
      const pts = offsetOrderPoints(world, chain, offset);
      battle.issueOrder(id, {
        type: this.pendingOrder,
        target: pts.target,
        targetTeamId: enemy ? enemy.id : undefined,
        issuedAt: state.time,
        waypoints: pts.waypoints.length > 0 ? pts.waypoints : undefined,
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

    if (this.quitConfirm) {
      this.updateQuitConfirm(input);
      return;
    }

    if (!this.paused && state.phase === 'running') {
      battle.step(dt * game.settings.speed);
    }

    const selectableIds = new Set(battle.selectableTeams(battle.playerSide()).map((team) => team.id));
    this.controlGroups.prune(selectableIds);
    if (this.selectedTeamIds.some((id) => !selectableIds.has(id))) {
      this.setSelection(this.selectedTeamIds.filter((id) => selectableIds.has(id)));
      if (this.selectedTeamIds.length === 0) {
        this.pendingOrder = null;
        this.pendingWaypoints = [];
        this.commandMenu.close();
      }
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
    // While an order is being placed (manual input card: "Right-click mouse:
    // Cancel an order line without placing the order dot"), the right press
    // cancels the aiming line instead of opening the menu or panning.
    for (const c of input.clicks) {
      if (c.button !== 2) continue;
      if (this.commandMenu.isOpen) {
        this.commandMenu.close();
        continue;
      }
      if (this.overHud({ x: c.x, y: c.y })) continue;
      if (this.pendingOrder) {
        this.pendingOrder = null;
        this.pendingWaypoints = [];
        continue;
      }
      const hitTeam = pickFriendlyTeamScreen(state, cam, { x: c.x, y: c.y }, battle.playerSide());
      this.rightDrag = { active: true, startX: c.x, startY: c.y, lastX: c.x, lastY: c.y, moved: 0, startTime: state.time, menuOpenedOnPress: false };
      if (hitTeam) {
        // The original issues a right-click order to the WHOLE current selection; only an
        // unselected team re-targets the menu. Pressing a selected member keeps the group intact.
        if (!this.selectedTeamIds.includes(hitTeam.id)) this.setSelection([hitTeam.id]);
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
      if (this.quitConfirm) { this.quitConfirm = null; }
      else if (this.commandMenu.isOpen) this.commandMenu.close();
      else if (this.pendingOrder) { this.pendingOrder = null; this.pendingWaypoints = []; }
      // deploy/running both count as "the battle" (manual: ESC quits the current
      // battle without saving); ended falls through — the debrief is imminent.
      else if (state.phase !== 'ended') this.quitConfirm = 'no';
    }

    // left mouse: press starts a potential drag (box-select), release decides
    // whether it was a simple click (select/issue order) or a drag (box-select).
    // Suppressed while Space/middle-drag panning is active.
    // Order endpoint markers stay on the map; the one under the pointer shows its line.
    this.hoveredOrderMarker = (!this.overHud(input.mouse) && !this.commandMenu.isOpen && input.pointerInside)
      ? pickOrderMarker(state, cam, input.mouse, battle.playerSide())
      : null;
    for (const c of input.clicks) {
      if (c.button === 0 && !this.overHud({ x: c.x, y: c.y }) && !this.commandMenu.isOpen && !menuWasOpen && !modernPanning) {
        const marker = !this.pendingOrder ? pickOrderMarker(state, cam, { x: c.x, y: c.y }, battle.playerSide()) : null;
        if (marker) {
          // press on a marker: drag it (user request — drag-n-drop the bubble), also select the team
          const team = state.teams.get(marker.teamId);
          const orderType = team?.order?.type;
          if (team && orderType) {
            this.markerDrag = { teamId: marker.teamId, kind: marker.kind, index: marker.index, orderType, startX: c.x, startY: c.y, moved: 0 };
          }
          // clicking a marker selects its team (Shift adds) — no deselect, no marquee
          if (input.keysDown.has('shift')) this.addToSelection([marker.teamId]); else this.setSelection([marker.teamId]);
          continue;
        }
        this.leftDrag = { active: true, startX: c.x, startY: c.y, moved: 0 };
      }
    }
    if (this.leftDrag.active && input.buttons.left && !modernPanning) {
      this.leftDrag.moved = Math.max(this.leftDrag.moved, Math.hypot(input.mouse.x - this.leftDrag.startX, input.mouse.y - this.leftDrag.startY));
    }
    if (this.markerDrag && input.buttons.left && !modernPanning) {
      this.markerDrag.moved = Math.max(this.markerDrag.moved, Math.hypot(input.mouse.x - this.markerDrag.startX, input.mouse.y - this.markerDrag.startY));
    }
    for (const r of input.releases) {
      if (r.button !== 0) continue;
      // Marker drag-n-drop: release re-issues the dragged order at the drop point.
      if (this.markerDrag) {
        const drag = this.markerDrag;
        this.markerDrag = null;
        if (!this.overHud({ x: r.x, y: r.y }) && drag.moved >= DRAG_THRESHOLD_PX) {
          const world = screenToWorld(cam, { x: r.x, y: r.y });
          const team = state.teams.get(drag.teamId);
          // Item 017: dragging the ENDPOINT edits only the final leg — earlier Shift-click
          // waypoints survive. Dragging a WAYPOINT dot rewrites that point in place.
          const reissue = team ? reissueOrderOnMarkerDrag(team.order, drag, world) : null;
          if (reissue) {
            battle.issueOrder(drag.teamId, { ...reissue, issuedAt: state.time });
            game.audio?.play('click');
          }
        }
        continue;
      }
      if (!this.leftDrag.active) continue;
      // Ending on HUD (bottom panel, minimap, soldier monitor) abandons the gesture untouched.
      if (this.overHud({ x: r.x, y: r.y })) {
        this.leftDrag.active = false;
        continue;
      }
      const dragged = this.leftDrag.moved >= DRAG_THRESHOLD_PX;
      const shiftHeld = r.shift ?? input.keysDown.has('shift');
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

    // Tab: depth map view. '.' / ',' cycle teams (Tab did this before the depth map).
    if (handleDepthMapKey(input.keysPressed, game.settings)) {
      addMessage(state, `Depth map ${game.settings.showDepthMap ? 'on' : 'off'}`, 'info');
    }
    const cycled = cycleTeamKey(input.keysPressed, battle.selectableTeams(battle.playerSide()).map((t) => t.id), this.selectedTeamId);
    if (cycled != null) this.setSelection([cycled]);
    if (input.keysDown.has('control') && input.keysPressed.has('a')) {
      this.setSelection(battle.selectableTeams(battle.playerSide()).map((t) => t.id));
    }

    const clickedGroup = this.controlGroupBar.update(input);
    const groupAction = controlGroupKeyAction(input) ?? clickedGroup;
    if (groupAction) {
      if (groupAction.assign) {
        this.controlGroups.assign(groupAction.key, this.selectedTeamIds);
        const count = this.selectedTeamIds.length;
        addMessage(state, `Control group ${groupAction.key}\n${count ? `${count} ${count === 1 ? 'team' : 'teams'} assigned` : 'Cleared'}`, 'info');
        game.audio?.play('click');
      } else {
        const ids = this.controlGroups.recall(groupAction.key);
        if (ids) {
          this.setSelection(ids);
          this.pendingOrder = null;
          this.pendingWaypoints = [];
          this.commandMenu.close();
          this.leftDrag.active = false;
          this.rightDrag.active = false;
          game.audio?.play('click');
        }
      }
    }

    if (this.selectedTeamId != null && !this.commandMenu.isOpen && !input.keysDown.has('control') && !input.keysDown.has('meta')) {
      for (const ot of ORDER_TYPES) {
        const key = ORDER_HOTKEYS[ot];
        if (input.keysPressed.has(key) && !input.keysPressed.has(`mod+${key}`)) { this.pendingOrder = ot; this.pendingWaypoints = []; }
      }
    }


    // Shift release commits the last placed point, after processing any final click and
    // cancellation in this frame. The pointer's current position is not another waypoint.
    if (input.keysReleased.has('shift') && this.pendingOrder && MOVE_TYPES.includes(this.pendingOrder)
      && this.pendingWaypoints.length > 0) {
      const target = this.pendingWaypoints.pop()!;
      this.issueOrderToSelection(input, target);
      this.leftDrag.active = false;
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

    // Fire pending over a targetable enemy: big aiming cross + the enemy team's men highlighted.
    this.targetHover = null;
    if (this.pendingOrder === 'fire' && !this.overHud(input.mouse) && !this.commandMenu.isOpen) {
      const sel = this.selectedTeamIds.map((id) => state.teams.get(id)).filter((t): t is Team => !!t);
      if (sel.length > 0) this.targetHover = targetableEnemyAt(state, battle.playerSide(), sel, screenToWorld(cam, input.mouse));
    }

    this.mountHover = null;
    if (this.pendingOrder && MOVE_TYPES.includes(this.pendingOrder) && !this.overHud(input.mouse) && !this.commandMenu.isOpen) {
      const world = screenToWorld(cam, input.mouse);
      for (const id of this.selectedTeamIds) {
        const t = state.teams.get(id);
        if (!t || t.outOfAction) continue;
        const v = transportAt(state, t, world);
        const own = !v && isRemountTarget(state, t, world) && t.vehicleId != null ? state.vehicles.get(t.vehicleId) : null;
        const hit = v ?? own;
        if (!hit) continue;
        const def = VEHICLE_DEFS[hit.defId];
        this.mountHover = { pos: hit.pos, halfM: (def ? Math.max(def.lengthM, def.widthM) : 6) / 2 + 0.8, label: v ? 'Mount' : 'Re-man' };
        break;
      }
    }

    if (this.showMinimap) this.minimap.update(input, cam, state.map.width, state.map.height);

    this.combatMessages.update(input, state);
    const selTeamForMonitor = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.showSoldierMonitor) this.soldierMonitor.update(input, state, selTeamForMonitor);

    const now = performance.now();
    if (this.fleeArmedUntil !== 0 && now >= this.fleeArmedUntil) this.fleeArmedUntil = 0;
    const action = this.bottomStrip.update(input);
    this.bottomStrip.setFleeArmed(this.fleeArmedUntil !== 0);
    // Hand cursor only over real controls: a hot bottom-strip button, a filled (actionable) team
    // box, an order-bar button, a control-group tile, or the minimap — not the whole bottom panel.
    const roster = this.rosterTeams(battle.playerSide());
    const gridHover = this.teamGrid['hoverIndex'];
    const m = input.mouse;
    const r = this.minimap.rect;
    this.hudHover = !this.commandMenu.isOpen && (
      this.bottomStrip['hover'].size > 0
      || this.controlGroupBar.isHovering()
      || (this.showMinimap && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h));
    if (action === 'truce') {
      // Truce button: accept a standing enemy offer, otherwise offer/withdraw our own
      battle.pressTruce(battle.playerSide());
    } else if (action === 'flee') {
      // Per the manual, Flee ends the battle immediately with the enemy taking the map — it is
      // not a per-team retreat order. Two-step: the first click arms it for 2 s so an overshoot
      // from the adjacent order bar can't forfeit the battle.
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
    if (input.keysDown.has('control') && input.keysPressed.has('t')) {
      this.terrain.showTrees = !this.terrain.showTrees;
      addMessage(state, `Trees ${this.terrain.showTrees ? 'shown' : 'hidden'}`, 'info');
    }
    if (input.keysDown.has('control') && input.keysPressed.has('s') && game.audio) {
      game.audio.setMuted(!game.audio.isMuted());
      addMessage(state, `Sound ${game.audio.isMuted() ? 'off' : 'on'}`, 'info');
    }

    // SPACEBAR (manual input card): show each command radius. Pause stays on
    // F3/PAUSE; space no longer toggles it.
    if (input.keysPressed.has(' ')) this.showCommandRadii = !this.showCommandRadii;
    if (input.keysPressed.has('+') || input.keysPressed.has('=')) {
      const idx = SPEEDS.indexOf(game.settings.speed);
      game.settings.speed = SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)];
    }
    if (input.keysPressed.has('-')) {
      const idx = SPEEDS.indexOf(game.settings.speed);
      game.settings.speed = SPEEDS[Math.max(0, idx - 1)];
    }
    if (input.keysPressed.has('i')) {
      const modes: NonNullable<GameSettings['infoBarMode']>[] = ['morale', 'experience', 'name', 'cover'];
      const cur = game.settings.infoBarMode ?? 'morale';
      game.settings.infoBarMode = modes[(modes.indexOf(cur) + 1) % modes.length];
      addMessage(state, `Info bar: ${game.settings.infoBarMode}`, 'info');
      game.saveSettings();
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

    // The depth map and the vision overlay would fight for the same space: while the depth map is
    // on the vision overlay is hidden; turning it off brings the vision overlay back.
    if (game.settings.showDepthMap) {
      this.visionOverlay.reset();
      this.depthOverlay.update(state.map, cam);
    } else if (game.settings.showUnitVision ?? true) {
      this.depthOverlay.reset();
      this.visionOverlay.update(state, cam, battle.playerSide(), this.selectedTeamIds, performance.now());
    } else {
      this.depthOverlay.reset();
      this.visionOverlay.reset();
    }

    game.audio?.setPaused(this.paused || state.phase !== 'running');
    const events = battle.drainEvents();
    this.blastFx.onEvents(events, state.time);
    game.audio?.handleEvents(events, cam);
    game.audio?.ambient(state.phase === 'running' && !this.paused);
    game.audio?.updateVehicles(
      [...state.vehicles.values()].map((v) => {
        const def = VEHICLE_DEFS[v.defId];
        const maxSpeed = Math.max(1, def?.speedRoadMs ?? 8);
        return {
          id: v.id,
          pos: v.pos,
          speedFactor: clamp(v.speed / maxSpeed, 0, 1),
          active: v.state !== 'knockedOut',
        };
      }),
      cam,
    );

    // wounded men moan when the camera is near (user: audible men are findable) — a slow
    // sweep so a dozen casualties do not become a chorus; one moan at most per pass.
    this.moanTimer -= dt;
    if (this.moanTimer <= 0 && !this.paused && state.phase === 'running') {
      this.moanTimer = 3 + Math.random() * 3;
      let best: { d: number; pos: Vec2 } | null = null;
      for (const s of state.soldiers.values()) {
        if (s.health !== 'wounded' || s.side !== battle.playerSide()) continue;
        const d = Math.hypot(s.pos.x - cam.x, s.pos.y - cam.y);
        if (d <= 12 && (!best || d < best.d)) best = { d, pos: s.pos };
      }
      if (best) game.audio?.play('moan', Math.max(0.15, 1 - best.d / 12));
    }
  }

  /** SPACEBAR overlay (manual input card): a gold dashed circle around every
   * operational command team, at its radio range. Teams outside every radius
   * fight degraded (command.ts). Legend echoes the toggle so the mode is
   * obvious. */
  private drawCommandRadii(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
    const px = TILE_PX * cam.zoom;
    const r = COMMAND_RADIUS_TILES * px;
    const side = this.battle.playerSide();
    let any = false;
    for (const t of state.teams.values()) {
      if (t.side !== side || t.type !== 'command' || t.outOfAction) continue;
      const cmd = state.soldiers.get(t.leaderId);
      if (!cmd || cmd.health === 'dead' || cmd.health === 'incapacitated') continue;
      const c = worldToScreen(cam, cmd.pos);
      ctx.strokeStyle = 'rgba(240,216,64,0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      any = true;
    }
    if (any) {
      const label = 'Command radii (SPACEBAR)';
      drawText(ctx, label, VIEW_W - 10 - textWidth(label, 'small'), VIEW_H - 36, '#f0d840');
    }
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
    // a tank blowing up shakes the view for a moment (undone by the restore below)
    const shake = this.blastFx.shake(cam, state.time);
    if (shake.x || shake.y) ctx.translate(shake.x, shake.y);
    this.terrain.draw(ctx, cam);
    this.terrain.drawOverlays(ctx, cam, state);
    if (this.showCommandRadii) this.drawCommandRadii(ctx, cam, state);
    if (game.settings.showDepthMap) this.depthOverlay.draw(ctx, cam);
    else if (game.settings.showUnitVision ?? true) this.visionOverlay.draw(ctx, cam, state, this.selectedTeamIds);
    // tall growth: flattened wakes under the units, standing blades over their lower edges
    this.grassFx.update(state, battle.playerSide());
    if (!game.settings.showDepthMap) this.grassFx.drawTrails(ctx, cam);
    drawUnits(ctx, cam, state, battle.playerSide(), this.selectedTeamIds, game.settings, this.showDead, this.hoveredOrderMarker, this.hoverTeamId, this.soldierMonitor.watchedSoldierId());
    // The original's drag feel: the dragged marker's ball follows the cursor while held.
    if (this.markerDrag) drawOrderBall(ctx, game.input.state.mouse, 3.2 * 1.4);
    this.grassFx.drawStanding(ctx, cam, state, battle.playerSide());
    drawEffects(ctx, cam, state);
    this.blastFx.draw(ctx, cam, state.time);

    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    const aimingFire = this.pendingOrder === 'fire' || this.pendingOrder === 'smoke';
    if (this.pendingOrder && selTeam && !(aimingFire && (game.settings.losLines ?? true))) {
      // Rubber band: team -> Shift-click waypoints so far -> cursor. Use the order's own color from
      // the very first aiming frame (before commit), matching the line once the order is issued.
      const chain = [selTeam.pos, ...(MOVE_TYPES.includes(this.pendingOrder) ? this.pendingWaypoints : []), screenToWorld(cam, game.input.state.mouse)]
        .map((p) => worldToScreen(cam, p));
      ctx.strokeStyle = ORDER_DOT_COLOR[this.pendingOrder];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chain[0].x, chain[0].y);
      for (let i = 1; i < chain.length; i++) ctx.lineTo(chain[i].x, chain[i].y);
      ctx.stroke();
      ctx.fillStyle = ORDER_DOT_COLOR[this.pendingOrder];
      for (let i = 1; i < chain.length - 1; i++) {
        ctx.beginPath();
        ctx.arc(chain[i].x, chain[i].y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Range feedback while aiming without LOS lines: the manual's range indicator is how the
    // player knows a Fire/Smoke target is in range at all, so with lines off we still draw the
    // cursor label (no line) for the selected team.
    if (aimingFire && selTeam && !(game.settings.losLines ?? true)) {
      const to = screenToWorld(cam, game.input.state.mouse);
      const obs = teamObserver(state, selTeam);
      if (obs) {
        const prof = aimLineProfile(state.map, obs.from, to, { eyeM: obs.eyeM });
        drawAimRangeFeedback(ctx, cam, obs.from, to, state, selTeam, this.pendingOrder, aimPointClass(prof));
      }
    }

    // Aiming line, like the original: while a Fire or Smoke order is being placed, the line from
    // each selected team to the pointer is coloured by what that team can actually see along it
    // (bright green clear, dark green obscured, red blocked). No key needs to be held.
    if (aimingFire && selTeam && (game.settings.losLines ?? true)) {
      const to = screenToWorld(cam, game.input.state.mouse);
      const ids = this.selectedTeamIds.length ? this.selectedTeamIds.slice(0, 8) : [selTeam.id];
      for (const id of ids) {
        const t = state.teams.get(id);
        if (!t || t.outOfAction) continue;
        const primary = id === selTeam.id;
        const obs = teamObserver(state, t);
        if (!obs) continue;
        const { from, eyeM } = obs;
        drawLOSLine(ctx, cam, state.map, from, to, { state, team: t }, { eyeM },
          { label: primary, alpha: primary ? 1 : 0.6, minRangeM: this.pendingOrder === 'smoke' ? teamSmokeMinRangeM(state, t) : null });
      }
    }

    if (this.mountHover) {
      // green corner brackets on the vehicle and a word by the pointer
      const p = worldToScreen(cam, this.mountHover.pos);
      const h = this.mountHover.halfM * 10 * cam.zoom, arm = h * 0.4;
      const corners = (): void => {
        ctx.beginPath();
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const x = p.x + sx * h, y = p.y + sy * h;
          ctx.moveTo(x - sx * arm, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * arm);
        }
        ctx.stroke();
      };
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 3.5; corners();
      ctx.strokeStyle = '#6ee06a'; ctx.lineWidth = 1.5; corners();
      const m = game.input.state.mouse, tw = textWidth(this.mountHover.label);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(m.x + 13, m.y - 2, tw + 6, 11);
      drawText(ctx, this.mountHover.label, m.x + 16, m.y, '#9af09a');
    }
    if (this.targetHover) drawTargetHighlight(ctx, cam, state, battle.playerSide(), this.targetHover, performance.now() / 1000);

    // hover ring: a subtle highlight under the friendly team the pointer is over
    if (this.hoverTeamId != null && this.hoverTeamId !== this.selectedTeamId) {
      const hoverTeam = state.teams.get(this.hoverTeamId);
      const selectedHover = this.hoverTeamId === this.selectedTeamId;
      if (hoverTeam) {
        const p = worldToScreen(cam, hoverTeam.pos);
        // item 029: hovering a tank shows where it is actually going (its sim path) and what
        // it is shooting at — the order line only covers issued orders, not the pending hull path.
        if (hoverTeam.vehicleId != null) {
          const veh = state.vehicles.get(hoverTeam.vehicleId);
          if (veh && veh.path.length > 0) {
            const pts = [veh.pos, ...veh.path].map((w) => worldToScreen(cam, w));
            ctx.strokeStyle = '#9af09a'; // distinct from the blue order line it often parallels
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 3]);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            ctx.setLineDash([]);
            const end = pts[pts.length - 1];
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
            ctx.stroke();
          }
          const atkV = veh?.targetVehicleId != null ? state.vehicles.get(veh.targetVehicleId) : undefined;
          const atkS = veh?.targetSoldierId != null ? state.soldiers.get(veh.targetSoldierId) : undefined;
          const atkPos = atkV?.pos ?? (atkS && atkS.health !== 'dead' ? atkS.pos : undefined);
          if (veh && atkPos) {
            const q = worldToScreen(cam, atkPos);
            ctx.strokeStyle = 'rgba(255,120,90,0.75)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
        if (!selectedHover) {
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, HOVER_RING_R, 0, Math.PI * 2);
          ctx.stroke();
        }
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

    if (game.settings.showDepthMap) this.depthOverlay.drawLegend(ctx);

    // Elevation under the pointer is always shown while it is over the map.
    if (!this.overHud(game.input.state.mouse) && !this.commandMenu.isOpen) drawElevationReadout(ctx, cam, state.map, game.input.state.mouse);
    // Battle clock: the original shows a red HH:MM.S timer dead-centre at the top of the map
    // view (ref e06 ~"09:37.6" / "15:00.0"). Drawn here so the visibility overlay and unit art
    // never cover it.
    {
      const mm = Math.floor(state.time / 60);
      const ss = state.time - mm * 60;
      const text = `${String(mm).padStart(2, '0')}:${ss < 10 ? '0' : ''}${ss.toFixed(1)}`;
      setHudFont(ctx, 'map');
      ctx.fillStyle = '#d81c1c';
      ctx.textAlign = 'center';
      ctx.fillText(text, VIEW_W / 2, 4);
      ctx.textAlign = 'left';
    }

    if (this.paused) {
      drawCenteredOverlayBanner(ctx, 'PAUSED');
    }

    ctx.restore();

    // Minimap and soldier monitor sit over the map viewport itself.
    if (this.showMinimap) this.minimap.draw(ctx, this.terrain, state, cam, battle.playerSide());
    if (this.showSoldierMonitor) this.soldierMonitor.draw(ctx, state, selTeam);

    drawHudBase(ctx);
    if (this.showTeamGrid) this.teamGrid.draw(ctx, this.rosterTeams(battle.playerSide()), state, this.selectedTeamIds);
    this.combatMessages.draw(ctx, state);
    this.bottomStrip.draw(ctx, state, selTeam, this.soldierMonitor.watchedSoldierForTeam(state, selTeam));
    this.controlGroupBar.draw(ctx, this.controlGroups.slots(this.selectedTeamIds));

    if (this.commandMenu.isOpen) this.commandMenu.draw(ctx);
    if (this.quitConfirm) this.drawQuitConfirm(ctx);

    if (this.paused) {
      drawCenteredOverlayBanner(ctx, 'PAUSED');
    }
    if (state.phase === 'ended') {
      const word = (state.result ?? 'draw').toUpperCase();
      drawCenteredOverlayBanner(ctx, word);
    }
  }


  private quitConfirmRects(): { yes: Rect; no: Rect } {
    const w = 300;
    const x = (VIEW_W - w) / 2;
    const y = VIEW_H / 2 - 44;
    return {
      yes: { x: x + 24, y: y + 54, w: 118, h: 30 },
      no: { x: x + 158, y: y + 54, w: 118, h: 30 },
    };
  }

  private updateQuitConfirm(input: InputState): void {
    const r = this.quitConfirmRects();
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      if (hitRect({ x: c.x, y: c.y }, r.yes)) { this.doQuit(); return; }
      if (hitRect({ x: c.x, y: c.y }, r.no)) { this.quitConfirm = null; return; }
    }
    if (input.keysPressed.has('y')) { this.doQuit(); return; }
    if (input.keysPressed.has('n') || input.keysPressed.has('escape')) this.quitConfirm = null;
  }

  /** ESC quit (manual input card): the battle is abandoned without a save and
   * without a debrief — casualties, results and the chronicle are not recorded.
   * The operation keeps its current battle index, so the player can re-fight it
   * from Continue Operation, exactly like the original's quit without saving. */
  private doQuit(): void {
    game.audio?.play('click');
    game.setScreen(new MainMenuScreen());
  }

  private drawQuitConfirm(ctx: CanvasRenderingContext2D): void {
    const w = 300;
    const x = (VIEW_W - w) / 2;
    const y = VIEW_H / 2 - 44;
    ctx.fillStyle = 'rgba(6,8,4,0.78)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = '#14110c';
    ctx.fillRect(x, y, w, 96);
    ctx.strokeStyle = '#c8a028';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, 96 - 3);
    drawTextCentered(ctx, 'QUIT CURRENT BATTLE', x + w / 2, y + 20, '#f0d840');
    drawTextCentered(ctx, 'WITHOUT SAVING?', x + w / 2, y + 36, '#f0d840');
    const r = this.quitConfirmRects();
    for (const [rect, label, hot] of [[r.yes, 'YES', this.quitConfirm === 'yes'], [r.no, 'NO', this.quitConfirm === 'no']] as const) {
      ctx.fillStyle = hot ? '#5a2020' : '#2a2018';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = hot ? '#f0d840' : '#8a7848';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      drawTextCentered(ctx, label, rect.x + rect.w / 2, rect.y + 19, '#f0e8d8');
    }
  }

  cursor(): CursorKind {
    if (this.targetHover) {
      const pen = this.targetHover.pen;
      return pen === 'likely' ? 'targetLikely' : pen === 'maybe' ? 'targetMaybe' : pen === 'none' ? 'targetNone' : 'target';
    }
    if (this.pendingOrder) return 'crosshair';
    if (this.modernPanDrag.active) return 'hand';
    if (this.rightDrag.active && !this.rightDrag.menuOpenedOnPress && this.rightDrag.moved >= RIGHT_GESTURE_PX) return 'hand';
    if (this.hudHover) return 'hand';
    if (this.hoverTeamId != null || this.hoveredOrderMarker) return 'hand';
    return 'arrow';
  }
}
