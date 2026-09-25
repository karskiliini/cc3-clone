import type { BattleState, Camera, CursorKind, InputState, Rect, Screen, Team, Vec2 } from '@/shared/types';
import { VIEW_H, VIEW_W, ORDER_HOTKEYS, ORDER_DOT_COLOR, otherSide, type OrderType } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { centerCamera, clampCamera, panCamera, screenToWorld, worldToScreen, zoomIn, zoomOut } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { VisibilityOverlay } from '@/render/visibilityOverlay';
import { DepthOverlay } from '@/render/depthOverlay';
import { pickOrderMarker, drawOrderMarkers } from '@/render/orderMarkers';
import { drawLOSLine } from '@/ui/losTool';
import { teamObserver } from '@/ui/targetHover';
import { cycleTeamKey, handleDepthMapKey } from './viewKeys';
import { OptionsScreen } from './options';
import { hitRect } from '@/ui/hud/hudChrome';
import { addMessage } from '@/sim/messages';
import { MainMenuScreen } from '@/ui/screens/mainMenu';
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
  updateModernDragPan, pickFriendlyTeamScreen, friendlyCentroid, type EdgeScrollState, type DragPanState,
} from './battleInput';
import { isPassable } from '@/sim/path';
import { pointInRect } from '@/shared/math';
import { BattleScreen } from './battle';
const DRAG_THRESHOLD_PX = 5;
/** Move-family orders accept Shift-click waypoint chaining. */
const MOVE_ORDER_TYPES: OrderType[] = ['move', 'moveFast', 'sneak'];


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
  /** Manual: group-select lets two or more teams move/act together in the deploy
   * phase ("move groups by selecting two or more teams (group select)"). Kept as a
   * parallel list; selectedTeamId stays the primary (first) for camera/LOS/monitor. */
  private selectedTeamIds: number[] = [];
  /** Box-select gesture: press on empty ground, release past the threshold selects. */
  private leftDrag = { active: false, startX: 0, startY: 0, moved: 0 };
  /** Grab tile of an active group drag (the pressed team's tile); null = single-team drag. */
  private grabTile: Vec2 | null = null;
  /** pre-begin order placement (user: units take orders in deploy): pick the order (hotkey),
   * then click a target. LOS preview draws while aiming. */
  private pendingOrder: OrderType | null = null;
  private pendingWaypoints: Vec2[] = [];
  private draggingTeamId: number | null = null;
  /** Left press on a friendly team that hasn't yet moved DRAG_THRESHOLD_PX — becomes a drag
   * (draggingTeamId) only past the threshold, so a plain click just selects. */
  private pressTeamId: number | null = null;
  private pressStart: Vec2 = { x: 0, y: 0 };
  /** What the left press landed on, so the release can react without re-picking:
   * 'marker' selects its team again, 'empty' resolves the forgiving pick at the
   * release point (click between a crew's men selects that crew), null = team. */
  private pressKind: 'marker' | 'empty' | null = null;
  /** ESC (manual input card): quit the battle without saving; non-null shows the
   * confirm modal. Deployment phase counts as the battle in the original. */
  private quitConfirm: boolean = false;
  private dragPan = makeDragPanState();
  private modernPanDrag: DragPanState = makeDragPanState();
  private edgeScroll: EdgeScrollState = makeEdgeScrollState();
  private invalidTimer = 0;
  private showMinimap = true;
  private shadeCanvas = document.createElement('canvas');
  /** true while actively dragging and the current drop point is invalid. */
  private dragInvalid = false;
  /** Per-dragged-team drop legality (item: "teams that would land off-map do not move"):
   * a group drag ghosts each member in its own tint — red for the members that cannot
   * drop here, gold for the ones that can — while the cursor keys off the pressed team. */
  private dragValidById = new Map<number, boolean>();

  private enemyCentre: Vec2 = { x: 0, y: 0 };

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
    const centroid = friendlyCentroid(this.battle.state, this.battle.playerSide());
    centerCamera(game.cam, centroid);
    clampCamera(game.cam, map.width, map.height);
    // Default starting orders per the manual: infantry Ambush, armour Defend. The target is the
    // enemy deploy zone centre (G23): the Defend/Ambush arc — and now the unit's hull/gun —
    // should point toward the enemy, not at the team's own feet (which left facing untouched).
    const enemyZone = map.def.deployZones[otherSide(this.battle.playerSide())];
    this.enemyCentre = { x: enemyZone.x + enemyZone.w / 2, y: enemyZone.y + enemyZone.h / 2 };
    for (const team of this.battle.selectableTeams(this.battle.playerSide())) {
      if (team.order) continue;
      this.issueDefaultOrder(team);
    }
  }

  /** Manual quickstart: "The Defend or Ambush orders are in effect by default."
   * Armour Defends facing the enemy zone, infantry Ambushes (G23: the arc/hull
   * faces the enemy, not the team's own feet). */
  private issueDefaultOrder(team: Team): void {
    this.battle.issueOrder(team.id, {
      type: team.vehicleId != null ? 'defend' : 'ambush',
      target: this.enemyCentre,
      issuedAt: 0,
    });
  }

  private setSelection(ids: number[]): void {
    this.selectedTeamIds = ids;
    this.selectedTeamId = ids.length > 0 ? ids[0] : null;
  }

  private addToSelection(ids: number[]): void {
    this.setSelection([...new Set([...this.selectedTeamIds, ...ids])]);
  }

  private toggleInSelection(id: number): void {
    if (this.selectedTeamIds.includes(id)) {
      this.setSelection(this.selectedTeamIds.filter((t) => t !== id));
    } else {
      this.addToSelection([id]);
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

    if (this.quitConfirm) {
      this.updateQuitConfirm(input);
      return;
    }

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

    // Order placement (user request: pre-begin orders). Hotkey picks the order, next map
    // click issues it; Escape cancels. Same pick-order-first-then-target rule as in battle.
    for (const ot of Object.keys(ORDER_HOTKEYS) as OrderType[]) {
      if (input.keysPressed.has(ORDER_HOTKEYS[ot])) {
        this.pendingOrder = this.pendingOrder === ot ? null : ot;
        if (this.pendingOrder && this.selectedTeamId == null) {
          addMessage(state, 'Select a team first, then the order target.', 'info');
        }
        break;
      }
    }
    if (input.keysPressed.has('escape')) {
      if (this.quitConfirm) {
        this.quitConfirm = false;
      } else if (this.pendingOrder || this.draggingTeamId || this.pressTeamId != null || this.leftDrag.active || this.grabTile) {
        this.pendingOrder = null; this.pendingWaypoints = [];
        this.draggingTeamId = null; this.pressTeamId = null;
        this.leftDrag.active = false;
        this.grabTile = null;
      } else {
        this.quitConfirm = true;
      }
    }

    // click on a team promotes to a drag past the threshold (reposition in the deploy zone).
    // Manual group-select: if the pressed team is already in the multi-selection the press
    // becomes a GROUP drag — every selected team keeps its relative offset and drops at
    // its own new tile.
    if (this.pressTeamId != null && input.buttons.left && !modernPanning
      && Math.hypot(input.mouse.x - this.pressStart.x, input.mouse.y - this.pressStart.y) >= DRAG_THRESHOLD_PX) {
      this.draggingTeamId = this.pressTeamId;
      if (this.selectedTeamIds.length > 1 && this.selectedTeamIds.includes(this.pressTeamId)) {
        // Grab tile = the tile the CURSOR was over at the press, so the delta measures
        // cursor travel: every selected team moves by the same (dx,dy) and keeps the
        // relative positions the manual promises for group moves.
        const grabWorld = screenToWorld(cam, this.pressStart);
        this.grabTile = { x: Math.floor(grabWorld.x), y: Math.floor(grabWorld.y) };
      }
      this.pressTeamId = null;
    }
    this.hoveredOrderMarker = !this.overHud(input.mouse) && input.pointerInside
      ? pickOrderMarker(state, cam, input.mouse, this.battle.playerSide())
      : null;
    for (const c of input.clicks) {
      if (c.button !== 0 || this.overHud({ x: c.x, y: c.y }) || modernPanning) continue;
      if (this.pendingOrder && this.selectedTeamId != null) {
        const world = screenToWorld(cam, { x: c.x, y: c.y });
        if (MOVE_ORDER_TYPES.includes(this.pendingOrder) && input.keysDown.has('shift')) {
          this.pendingWaypoints.push(world);
        } else {
          this.issueDeployOrder(this.pendingOrder, world, input.keysDown.has('shift'));
        }
        continue;
      }
      const hitTeam = pickFriendlyTeamScreen(state, cam, { x: c.x, y: c.y }, this.battle.playerSide(), { circleFallback: false });
      this.draggingTeamId = null;
      this.leftDrag.active = false;
      const marker = hitTeam ? null : pickOrderMarker(state, cam, { x: c.x, y: c.y }, this.battle.playerSide());
      if (marker) {
        if (input.keysDown.has('shift')) this.addToSelection([marker.teamId]);
        else this.setSelection([marker.teamId]);
        this.pressTeamId = null; this.pressKind = 'marker';
      } else if (hitTeam) {
        if (input.keysDown.has('shift')) {
          // Shift-click toggles membership (manual: group select by clicking teams in).
          if (this.selectedTeamIds.includes(hitTeam.id)) {
            this.setSelection(this.selectedTeamIds.filter((id) => id !== hitTeam.id));
          } else {
            this.addToSelection([hitTeam.id]);
          }
          this.pressTeamId = null; this.pressKind = null;
        } else if (this.selectedTeamIds.length > 1 && this.selectedTeamIds.includes(hitTeam.id)) {
          // Plain press on an already-group-selected team: keep the group intact so the
          // press can promote to a GROUP drag; a plain click (release without drag)
          // collapses back to just that team.
          this.pressTeamId = hitTeam.id; this.pressStart = { x: c.x, y: c.y }; this.pressKind = null;
        } else {
          this.setSelection([hitTeam.id]);
          this.pressTeamId = hitTeam.id; this.pressStart = { x: c.x, y: c.y }; this.pressKind = null;
        }
      } else {
        // Empty ground: arm the box-select gesture (manual: "click and hold a spot near
        // one of the groups, and then drag a rectangle around the units you want to group").
        this.pressTeamId = null; this.pressKind = 'empty';
        this.leftDrag = { active: true, startX: c.x, startY: c.y, moved: 0 };
      }
    }
    if (this.leftDrag.active && input.buttons.left && !modernPanning) {
      this.leftDrag.moved = Math.max(this.leftDrag.moved, Math.hypot(input.mouse.x - this.leftDrag.startX, input.mouse.y - this.leftDrag.startY));
    }
    // while dragging: continuously check whether the tile snapped under the
    // cursor is a legal drop point, so the ghost/cursor can reflect it live.
    if (this.draggingTeamId != null) {
      const dropWorld = this.snappedDropPoint(cam, input.mouse);
      const zone = map.def.deployZones[this.battle.playerSide()];
      const delta = this.groupDelta(cam, dropWorld);
      this.dragValidById.clear();
      this.dragInvalid = false;
      for (const id of this.dragTeamIds()) {
        const team = state.teams.get(id);
        if (!team) continue;
        const target = delta ? { x: Math.floor(team.pos.x) + delta.x + 0.5, y: Math.floor(team.pos.y) + delta.y + 0.5 } : dropWorld;
        const mover = team.vehicleId != null ? 'vehicle' : 'infantry';
        const ok = pointInRect(target, zone) && isPassable(map, Math.floor(target.x), Math.floor(target.y), mover);
        this.dragValidById.set(id, ok);
        if (id === this.draggingTeamId) this.dragInvalid = !ok;
      }
    } else {
      this.dragInvalid = false;
    }

    // release: drop the dragged team(s), snapped to the tile under the cursor; finish
    // the box-select gesture. Manual: redeploying a unit cancels its issued order, so
    // every moved team falls back to its default order.
    for (const r of input.releases) {
      if (r.button !== 0) continue;
      const shiftHeld = r.shift ?? input.keysDown.has('shift');
      if (this.pressTeamId != null) {
        // Plain click on a team (drag never promoted, no order pending): the clicked
        // team becomes the sole selection (manual single-select semantics).
        this.setSelection([this.pressTeamId]);
        this.pressTeamId = null; this.pressKind = null;
        continue;
      }
      if (this.pressKind === 'marker') {
        // The marker press already selected its team; a release adds nothing.
        this.pressKind = null;
        continue;
      }
      const wasEmpty = this.pressKind === 'empty';
      this.pressKind = null;
      this.pressTeamId = null;
      if (this.leftDrag.active) {
        const dragged = this.leftDrag.moved >= DRAG_THRESHOLD_PX;
        const x0 = Math.min(this.leftDrag.startX, r.x), x1 = Math.max(this.leftDrag.startX, r.x);
        const y0 = Math.min(this.leftDrag.startY, r.y), y1 = Math.max(this.leftDrag.startY, r.y);
        const inRect = (p: Vec2) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        if (this.overHud({ x: r.x, y: r.y })) continue;
        if (dragged && !this.pendingOrder) {
          const inBox = this.battle.selectableTeams(this.battle.playerSide()).filter((t) => {
            if (inRect(worldToScreen(cam, t.pos))) return true;
            for (const sid of t.soldierIds) {
              const s = state.soldiers.get(sid);
              if (s && s.health !== 'dead' && inRect(worldToScreen(cam, s.pos))) return true;
            }
            return false;
          });
          if (inBox.length > 0) {
            if (shiftHeld) this.addToSelection(inBox.map((t) => t.id));
            else this.setSelection(inBox.map((t) => t.id));
          } else if (!shiftHeld) {
            this.setSelection([]);
          }
          continue;
        }
      }
      if (this.draggingTeamId != null && this.overHud({ x: r.x, y: r.y })) {
        // Released over HUD: abandon the drag, the team stays where it was.
        this.draggingTeamId = null;
        this.grabTile = null;
        this.dragInvalid = false;
        this.dragValidById.clear();
      } else if (this.draggingTeamId != null) {
        const dropWorld = this.snappedDropPoint(cam, { x: r.x, y: r.y });
        const delta = this.groupDelta(cam, dropWorld);
        let movedAny = false;
        let rejected = false;
        for (const id of this.dragTeamIds()) {
          const team = state.teams.get(id);
          if (!team) continue;
          const target = delta ? { x: Math.floor(team.pos.x) + delta.x + 0.5, y: Math.floor(team.pos.y) + delta.y + 0.5 } : dropWorld;
          const ok = this.battle.deployTeam(id, target);
          if (ok) {
            movedAny = true;
            // Manual: "Issuing a second order or redeploying the unit cancels the first
            // order" — the redeployed team falls back to its default Defend/Ambush.
            this.issueDefaultOrder(team);
          } else {
            rejected = true;
          }
        }
        if (movedAny) game.audio?.play('click');
        if (rejected) this.invalidTimer = 1;
        this.draggingTeamId = null;
        this.grabTile = null;
        this.dragInvalid = false;
        this.dragValidById.clear();
      }
      else if (wasEmpty && !this.overHud({ x: r.x, y: r.y })) {
        // A plain click that never landed on a soldier or promoted a drag: the
        // forgiving pick resolves tight clusters the strict press skipped — the
        // tile between a mortar's crew selects that crew. Genuinely empty ground
        // deselects, same as the battle screen.
        const hit = pickFriendlyTeamScreen(state, cam, { x: r.x, y: r.y }, this.battle.playerSide());
        if (hit) {
          if (shiftHeld) this.toggleInSelection(hit.id);
          else this.setSelection([hit.id]);
        } else if (!shiftHeld) {
          this.setSelection([]);
        }
      }
    }

    const teams = this.battle.selectableTeams(this.battle.playerSide());
    const clicked = this.teamGrid.update(input, teams);
    if (clicked != null) {
      this.setSelection([clicked.id]);
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

    const cycled = cycleTeamKey(input.keysPressed, this.battle.selectableTeams(this.battle.playerSide()).map((t) => t.id), this.selectedTeamId);
    if (cycled != null) this.setSelection([cycled]);
    if (game.settings.showDepthMap) {
      this.visionOverlay.reset();
      this.depthOverlay.update(map, cam);
    } else if (game.settings.showUnitVision ?? true) {
      this.depthOverlay.reset();
      this.visionOverlay.update(state, cam, this.battle.playerSide(), this.selectedTeamIds, performance.now());
    } else {
      this.depthOverlay.reset();
      this.visionOverlay.reset();
    }

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
    // '§': depth map view (hides the vision overlay while on). '.' / ',' cycle teams.
    if (handleDepthMapKey(input.keysPressed, game.settings)) {
      addMessage(state, `Depth map ${game.settings.showDepthMap ? 'on' : 'off'}`, 'info');
    }
  }

  /** Issue a pre-begin order. Sim already runs `applyOrder` eagerly for deploy-phase orders
   * (paths/facing pre-commit; see canObey's deploy-phase note), so this is the same
   * battle.issueOrder the running game uses. Clears the pending order unless Shift-chaining
   * a move route. Manual group select: Move/Fast/Sneak keep each team's relative offset
   * from the primary team; Fire/Smoke centre every team on the same point. */
  private issueDeployOrder(type: OrderType, world: Vec2, shiftHeld: boolean): void {
    const ids = this.selectedTeamIds.length > 0 ? this.selectedTeamIds : (this.selectedTeamId != null ? [this.selectedTeamId] : []);
    const primary = ids.length > 0 ? this.battle.state.teams.get(ids[0]) : null;
    if (!primary) { this.pendingOrder = null; return; }
    const chaining = MOVE_ORDER_TYPES.includes(type) && shiftHeld;
    const isMoveType = MOVE_ORDER_TYPES.includes(type);
    for (const id of ids) {
      const team = this.battle.state.teams.get(id);
      if (!team) continue;
      const offset = isMoveType && ids.length > 1
        ? { x: team.pos.x - primary.pos.x, y: team.pos.y - primary.pos.y }
        : { x: 0, y: 0 };
      this.battle.issueOrder(id, {
        type,
        target: { x: world.x + offset.x, y: world.y + offset.y },
        issuedAt: this.battle.state.time,
        waypoints: chaining ? undefined : (this.pendingWaypoints.length > 0 ? this.pendingWaypoints.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) : undefined),
      });
    }
    game.audio?.play('click');
    if (chaining) return;
    this.pendingOrder = null;
    this.pendingWaypoints = [];
  }

  /** Teams carried by the current drag: every selected team when the press started on a
   * team that was already in the multi-selection, else just the dragged one. */
  private dragTeamIds(): number[] {
    if (this.draggingTeamId == null) return [];
    if (this.grabTile != null && this.selectedTeamIds.length > 1 && this.selectedTeamIds.includes(this.draggingTeamId)) {
      return this.selectedTeamIds;
    }
    return [this.draggingTeamId];
  }

  /** Tile delta of a group drag: cursor tile minus the tile the pressed team was on.
   * Null while dragging a single team. */
  private groupDelta(cam: Camera, dropWorld: Vec2): { x: number; y: number } | null {
    if (this.grabTile == null || this.draggingTeamId == null) return null;
    if (!(this.selectedTeamIds.length > 1 && this.selectedTeamIds.includes(this.draggingTeamId))) return null;
    return { x: Math.floor(dropWorld.x) - this.grabTile.x, y: Math.floor(dropWorld.y) - this.grabTile.y };
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
    // item 025: the deploy/blocked split must read instantly — outside is dimmed hard,
    // the deploy zone stays bright with a clean gold border
    sctx.fillStyle = 'rgba(0,0,0,0.42)';
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
    sctx.fillStyle = 'rgba(0,0,0,0.6)';
    sctx.fillRect(etl.x, etl.y, ebr.x - etl.x, ebr.y - etl.y);
    sctx.restore();

    ctx.drawImage(this.shadeCanvas, 0, 0);

    // deploy-zone border + faint fill, drawn crisp (not feathered) so the allowed
    // area is unmistakable
    ctx.save();
    ctx.fillStyle = 'rgba(250,214,110,0.10)';
    ctx.fillRect(otl.x, otl.y, obr.x - otl.x, obr.y - otl.y);
    ctx.strokeStyle = 'rgba(250,214,110,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(Math.round(otl.x) + 1, Math.round(otl.y) + 1, obr.x - otl.x - 2, obr.y - otl.y - 2);
    ctx.restore();
  }

  /** Drag ghost: the whole team's formation, translucent, snapped to the
   * tile under the cursor, plus its team icon. Tinted red (and the cursor
   * switches to 'no', see cursor()) when the drop point isn't legal. */
  private drawDragGhost(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, teamId: number): void {
    const team = state.teams.get(teamId);
    if (!team) return;
    const dropCursor = this.snappedDropPoint(cam, game.input.state.mouse);
    const delta = this.groupDelta(cam, dropCursor);
    const drop = delta
      ? { x: Math.floor(team.pos.x) + delta.x + 0.5, y: Math.floor(team.pos.y) + delta.y + 0.5 }
      : dropCursor;
    const tint = (this.dragValidById.get(team.id) ?? true) ? PALETTE.gold : PALETTE.red;
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
      this.visionOverlay.draw(ctx, cam, state, this.selectedTeamIds.length > 0 ? this.selectedTeamIds : []);
    }

    drawUnits(ctx, cam, state, this.battle.playerSide(), this.selectedTeamIds, game.settings, true, this.hoveredOrderMarker);
    drawOrderMarkers(ctx, cam, state, this.battle.playerSide(), this.selectedTeamIds, null);


    // Pending order visualisation (user: scope the unit's field-of-view / LOS in deploy):
    // move orders get a rubber band with waypoints; Fire/Smoke get the LOS-coloured
    // firing line from each selected team to the pointer, exactly as in battle.
    const selTeam = this.selectedTeamId != null ? state.teams.get(this.selectedTeamId) ?? null : null;
    if (this.pendingOrder && selTeam) {
      const mouse = screenToWorld(cam, game.input.state.mouse);
      if (MOVE_ORDER_TYPES.includes(this.pendingOrder) && !(game.settings.losLines ?? true)) {
        const chain = [selTeam.pos, ...this.pendingWaypoints, mouse].map((p) => worldToScreen(cam, p));
        ctx.strokeStyle = ORDER_DOT_COLOR[this.pendingOrder];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chain[0].x, chain[0].y);
        for (let i = 1; i < chain.length; i++) ctx.lineTo(chain[i].x, chain[i].y);
        ctx.stroke();
      } else if (!MOVE_ORDER_TYPES.includes(this.pendingOrder) && (game.settings.losLines ?? true)) {
        const obs = teamObserver(state, selTeam);
        if (obs) {
          drawLOSLine(ctx, cam, state.map, obs.from, mouse, { state, team: selTeam }, { eyeM: obs.eyeM }, { label: true });
        }
      }
    }

    if (this.draggingTeamId != null) {
      for (const id of this.dragTeamIds()) this.drawDragGhost(ctx, cam, state, id);
    }
    if (this.leftDrag.active && this.leftDrag.moved >= DRAG_THRESHOLD_PX) {
      const x0 = Math.min(this.leftDrag.startX, game.input.state.mouse.x);
      const x1 = Math.max(this.leftDrag.startX, game.input.state.mouse.x);
      const y0 = Math.min(this.leftDrag.startY, game.input.state.mouse.y);
      const y1 = Math.max(this.leftDrag.startY, game.input.state.mouse.y);
      ctx.strokeStyle = 'rgba(120,255,120,0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120,255,120,0.08)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (this.invalidTimer > 0) {
      const mouse = game.input.state.mouse;
      drawTextCentered(ctx, 'INVALID', mouse.x, mouse.y - 20, PALETTE.red, 'small');
    }
    if (game.settings.showDepthMap) this.depthOverlay.drawLegend(ctx);
    ctx.restore();

    if (this.showMinimap) this.minimap.draw(ctx, this.terrain, state, cam, this.battle.playerSide());
    this.soldierMonitor.draw(ctx, state, selTeam);

    drawHudBase(ctx);
    const teams = this.battle.selectableTeams(this.battle.playerSide());
    this.teamGrid.draw(ctx, teams, state, this.selectedTeamId);
    this.combatMessages.draw(ctx, state);
    this.bottomStrip.draw(ctx, state, selTeam, this.soldierMonitor.watchedSoldierForTeam(state, selTeam));

    if (this.quitConfirm) this.drawQuitConfirm(ctx);
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
      if (hitRect({ x: c.x, y: c.y }, r.no)) { this.quitConfirm = false; return; }
    }
    if (input.keysPressed.has('y')) { this.doQuit(); return; }
    if (input.keysPressed.has('n') || input.keysPressed.has('escape')) this.quitConfirm = false;
  }

  /** ESC quit (manual input card): the deployment is abandoned without a save.
   * The operation keeps its current battle so it can be re-fought from Continue
   * Operation; a free battle just returns to the main menu. */
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
    for (const [rect, label] of [[r.yes, 'YES'], [r.no, 'NO']] as const) {
      ctx.fillStyle = '#2a2018';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = '#8a7848';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      drawTextCentered(ctx, label, rect.x + rect.w / 2, rect.y + 19, '#f0e8d8');
    }
  }

  cursor(): CursorKind {
    if (this.dragPan.active || this.modernPanDrag.active) return 'hand';
    if (this.draggingTeamId != null) return this.dragInvalid ? 'no' : 'move';
    if (this.hoveredOrderMarker) return 'hand';
    return 'arrow';
  }
}
