// ============================================================================
// tools/uiPreview.ts — dev-only Vite page. Draws the full 1024x768 in-battle
// HUD (team grid, combat messages, bottom strip, soldier monitor, minimap)
// and the command menu with a hand-built fake BattleState so a human can
// eyeball the CC3 chrome look without running the sim. Deliberately does NOT
// import '@/sim/battle', '@/sim/spawn' or any other sim orchestration module
// — only '@/sim/los' via losTool.ts, which is an explicit, declared
// dependency of that module.
// ============================================================================
import type {
  BattleState,
  BattleConfig,
  BattleMessage,
  GameMap,
  MapDef,
  Team,
  Soldier,
  InputState,
  Vec2,
  Side,
} from '@/shared/types';
import { VIEW_H, VIEW_W } from '@/shared/types';
import { createCamera, screenToWorld, zoomIn, zoomOut } from '@/engine/camera';
import { HUD } from '@/render/palette';
import { drawHudBase, setHudFont } from '@/ui/hud/hudChrome';
import { TeamGrid } from '@/ui/hud/teamGrid';
import { CombatMessages } from '@/ui/hud/combatMessages';
import { BottomStrip } from '@/ui/hud/bottomStrip';
import { SoldierMonitorPopup } from '@/ui/hud/soldierMonitor';
import { Minimap } from '@/ui/hud/minimap';
import { TerrainRenderer } from '@/render/terrainRender';
import { CommandMenu } from '@/ui/commandMenu';
import { drawLOSLine } from '@/ui/losTool';

// ---------------------------------------------------------------- fake state
function fakeMapDef(): MapDef {
  return {
    id: 'preview_map',
    name: 'Preview Map',
    description: 'Fake map for the UI preview tool.',
    width: 40,
    height: 24,
    season: 'summer',
    paint: () => {},
    victoryLocations: [
      { id: 1, name: "Pavlov's House", x: 12, y: 10, value: 2 },
      { id: 2, name: 'Hill 227', x: 28, y: 6, value: 1 },
    ],
    deployZones: {
      german: { x: 1, y: 1, w: 5, h: 5 },
      soviet: { x: 34, y: 18, w: 5, h: 5 },
    },
    attacker: 'german',
  };
}

function fakeMap(): GameMap {
  const def = fakeMapDef();
  const n = def.width * def.height;
  return {
    def,
    width: def.width,
    height: def.height,
    tiles: new Array(n).fill('open'),
    buildingId: new Int16Array(n).fill(-1),
    windows: new Uint8Array(n),
    victoryLocations: def.victoryLocations.map((vl) => ({ ...vl, owner: null, captureTimer: 0, capturingSide: null })),
    smoke: new Float32Array(n),
    craters: [],
  };
}

let nextId = 1;
function allocId(): number {
  return nextId++;
}

function makeSoldier(teamId: number, side: Side, isLeader: boolean, rank: string, name: string, weaponId: string): Soldier {
  return {
    id: allocId(),
    teamId,
    side,
    name,
    rank,
    weaponId,
    ammo: weaponId.includes('mg') ? 50 : 5,
    ammoReserve: 60,
    grenades: 2,
    health: 'healthy',
    morale: 80,
    fatigue: 10,
    suppression: 0,
    experience: 40,
    stance: 'standing',
    activity: 'idle',
    pos: { x: 5, y: 5 },
    facing: 4,
    targetSoldierId: null,
    targetVehicleId: null,
    targetPoint: null,
    path: [],
    reloadTimer: 0,
    fireTimer: 0,
    animFrame: 0,
    isLeader,
    vehicleId: null,
    formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999,
    cover: 0,
    kills: 0,
  };
}

function buildFakeState(): BattleState {
  const map = fakeMap();
  const config: BattleConfig = {
    mapId: map.def.id,
    playerSide: 'german',
    year: 1943,
    seed: 1,
    durationS: 20 * 60,
    difficulty: 'normal',
    forces: { german: [], soviet: [] },
  };

  const soldiers = new Map<number, Soldier>();
  const teams = new Map<number, Team>();

  function addTeam(name: string, type: Team['type'], side: Side, status: Team['status'], soldierSpecs: [string, string, string][]): Team {
    const id = allocId();
    const built = soldierSpecs.map(([rank, sname, weapon], i) => makeSoldier(id, side, i === 0, rank, sname, weapon));
    for (const s of built) soldiers.set(s.id, s);
    const team: Team = {
      id,
      defId: `${side}_${type}`,
      side,
      name,
      type,
      soldierIds: built.map((s) => s.id),
      leaderId: built[0].id,
      vehicleId: null,
      order: null,
      facing: 4,
      experience: 45,
      morale: 62,
      status,
      pos: { x: 5 + id, y: 5 },
      outOfAction: false,
      kills: 0,
      aiObjective: null,
    };
    teams.set(id, team);
    return team;
  }

  addTeam('Group Leader', 'command', 'german', 'Ambushing', [
    ['Fw', 'Weber', 'kar98k'], ['Gefr', 'Klein', 'mp40'],
  ]);
  addTeam('Light Infantry', 'rifle', 'german', 'Ambushing', [
    ['Uffz', 'Bauer', 'kar98k'], ['Sold', 'Hoffmann', 'kar98k'], ['Sold', 'Schmidt', 'kar98k'], ['Sold', 'Wagner', 'kar98k'],
  ]);
  addTeam('StuG IIIC', 'spg', 'german', 'Defending', [
    ['Uffz', 'Krause', 'kar98k'],
  ]);
  const t4 = addTeam('MG Infantry', 'mg', 'german', 'Firing', [
    ['Uffz', 'Fischer', 'kar98k'], ['Gefr', 'Meyer', 'mg34'], ['Sold', 'Vogel', 'kar98k'],
  ]);
  t4.soldierIds.forEach((id, i) => {
    const s = soldiers.get(id)!;
    if (i === 1) { s.activity = 'firing'; }
  });
  addTeam('Mortar-80mm', 'mortar', 'german', 'Ambushing', [
    ['Uffz', 'Braun', 'kar98k'], ['Sold', 'Wolf', 'kar98k'],
  ]);
  const t6 = addTeam('HMG Infantry', 'mg', 'german', 'Pinned', [
    ['Sgt', 'Strehle', 'mg34'], ['Sold', 'Bingler', 'kar98k'], ['Sold', 'Kubert', 'kar98k'],
  ]);
  soldiers.get(t6.soldierIds[0])!.health = 'dead';
  soldiers.get(t6.soldierIds[0])!.activity = 'dead';
  soldiers.get(t6.soldierIds[1])!.health = 'wounded';
  soldiers.get(t6.soldierIds[2])!.activity = 'pinned';

  const messages: BattleMessage[] = [
    { time: 12, text: 'Battle begins.', kind: 'info' },
    { time: 44, text: 'Light Infantry Strategic Fire out of LOS.', kind: 'good' },
    { time: 61, text: "MG Infantry We're pinned down.", kind: 'warn' },
    { time: 88, text: 'Mortar-80mm Heading for cover.', kind: 'good' },
    { time: 95, text: 'HMG Infantry KIA.', kind: 'bad' },
  ];

  const state: BattleState = {
    config,
    map,
    phase: 'running',
    time: 96,
    soldiers,
    teams,
    vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 70, truceOffered: false, truceAccepted: false, kills: 2, losses: 1, score: 4 },
      soviet: { side: 'soviet', morale: 22, truceOffered: false, truceAccepted: false, kills: 1, losses: 2, score: 1 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages,
    explosions: [],
    tracers: [],
    flashes: [],
    bloodDecals: [],
    result: null,
    events: [],
    nextId,
  };

  return state;
}

// ------------------------------------------------------------------- input
function createLocalInput(canvas: HTMLCanvasElement): { state: InputState; endFrame(): void } {
  const state: InputState = {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    keysReleased: new Set(),
    wheel: 0,
  };

  function toLogical(clientX: number, clientY: number): Vec2 {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / 1024, rect.height / 768);
    const dispW = 1024 * scale;
    const dispH = 768 * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    return { x: (clientX - offX) / (scale || 1), y: (clientY - offY) / (scale || 1) };
  }

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    const p = toLogical(e.clientX, e.clientY);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
  });
  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    const p = toLogical(e.clientX, e.clientY);
    const button = (e.button === 2 ? 2 : e.button === 1 ? 1 : 0) as 0 | 1 | 2;
    if (button === 0) state.buttons.left = true;
    else if (button === 1) state.buttons.middle = true;
    else state.buttons.right = true;
    state.clicks.push({ x: p.x, y: p.y, button });
  });
  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    const p = toLogical(e.clientX, e.clientY);
    const button = (e.button === 2 ? 2 : e.button === 1 ? 1 : 0) as 0 | 1 | 2;
    if (button === 0) state.buttons.left = false;
    else if (button === 1) state.buttons.middle = false;
    else state.buttons.right = false;
    state.releases.push({ x: p.x, y: p.y, button });
  });
  canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (!e.repeat) state.keysPressed.add(key);
    state.keysDown.add(key);
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => state.keysDown.delete(e.key.toLowerCase()));
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    state.wheel += e.deltaY;
    e.preventDefault();
  });

  function endFrame(): void {
    state.clicks.length = 0;
    state.releases.length = 0;
    state.keysPressed.clear();
    state.wheel = 0;
  }

  return { state, endFrame };
}

// --------------------------------------------------------------------- main
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

const state = buildFakeState();
const terrain = new TerrainRenderer(state.map);
const teamGrid = new TeamGrid();
const combatMessages = new CombatMessages();
const bottomStrip = new BottomStrip('battle');
const soldierMonitor = new SoldierMonitorPopup();
const minimap = new Minimap();
const commandMenu = new CommandMenu();
const { state: input, endFrame } = createLocalInput(canvas);

let selectedTeamId: number | null = state.teams.values().next().value?.id ?? null;

const cam = createCamera();
const losFrom: Vec2 = { x: 8, y: 6 };

function friendlyTeams(): Team[] {
  return Array.from(state.teams.values());
}

function pushMessage(text: string, kind: BattleMessage['kind'] = 'info'): void {
  state.messages.push({ time: Math.round(state.time), text, kind });
  if (state.messages.length > 50) state.messages.shift();
}

function frame(): void {
  const teams = friendlyTeams();

  if (commandMenu.isOpen) {
    const result = commandMenu.update(input);
    if (result && result !== 'cancel') {
      pushMessage(`Order issued: ${result.toUpperCase()}`, 'good');
    } else if (result === 'cancel') {
      pushMessage('Command menu cancelled.', 'info');
    }
  } else {
    const clickedId = teamGrid.update(input, teams);
    if (clickedId != null) selectedTeamId = clickedId;

    minimap.update(input, cam, state.map.width, state.map.height);
    combatMessages.update(input, state);
    const selTeam = selectedTeamId != null ? state.teams.get(selectedTeamId) ?? null : null;
    soldierMonitor.update(input, state, selTeam);

    for (const c of input.clicks) {
      if (c.button === 2 && c.y < VIEW_H) {
        const team = selectedTeamId != null ? state.teams.get(selectedTeamId) : null;
        if (team) {
          commandMenu.open({ x: c.x, y: c.y }, team, { canSmoke: team.type === 'mortar', canFire: true });
        }
      }
    }

    const action = bottomStrip.update(input);
    if (action === 'truce') pushMessage('Truce offered.', 'warn');
    else if (action === 'flee') pushMessage('Flee ordered.', 'warn');
    else if (action === 'map') pushMessage('Map requested.', 'info');
    else if (action === 'options') pushMessage('Options requested.', 'info');
    else if (action === 'zoomIn') zoomIn(cam, state.map.width, state.map.height);
    else if (action === 'zoomOut') zoomOut(cam, state.map.width, state.map.height);
  }

  if (input.wheel !== 0) {
    if (input.wheel < 0) zoomIn(cam, state.map.width, state.map.height, input.mouse);
    else zoomOut(cam, state.map.width, state.map.height, input.mouse);
  }

  draw();
  endFrame();
  requestAnimationFrame(frame);
}

function draw(): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  terrain.draw(ctx, cam);
  ctx.restore();
  setHudFont(ctx, 'small');
  ctx.fillStyle = HUD.dim;
  ctx.fillText('MAP VIEWPORT (fake) — hold Shift + move mouse here for the LOS tool', 8, 8);

  if (input.keysDown.has('shift')) {
    const to = screenToWorld(cam, input.mouse);
    drawLOSLine(ctx, cam, state.map, losFrom, to);
  }

  minimap.draw(ctx, terrain, state, cam, 'german');
  const selectedTeam = selectedTeamId != null ? state.teams.get(selectedTeamId) ?? null : null;
  soldierMonitor.draw(ctx, state, selectedTeam);

  drawHudBase(ctx);
  teamGrid.draw(ctx, friendlyTeams(), state, selectedTeamId);
  combatMessages.draw(ctx, state);
  bottomStrip.draw(ctx, state, selectedTeam);

  commandMenu.draw(ctx);
}

requestAnimationFrame(frame);
