// ============================================================================
// tools/uiPreview.ts — dev-only Vite page. Draws the full 800x600 bottom
// panel (team list + soldier monitor + message panel) and the command menu
// with a hand-built fake BattleState so a human can eyeball the CC3 chrome
// look without running the sim. Deliberately does NOT import '@/sim/battle',
// '@/sim/spawn' or any other sim orchestration module — only '@/sim/los' via
// losTool.ts, which is an explicit, declared dependency of that module.
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
import { SIDES } from '@/shared/types';
import { createCamera, screenToWorld } from '@/engine/camera';
import { PALETTE } from '@/render/palette';
import { drawText } from '@/render/pixelfont';
import { TeamListPanel } from '@/ui/teamList';
import { drawSoldierMonitor } from '@/ui/soldierMonitor';
import { MessagePanel } from '@/ui/messagePanel';
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
    victoryLocations: [],
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
    victoryLocations: [],
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

  // --- Team 1: German Rifle Squad (6 soldiers, leader healthy, some casualties) ---
  const t1Id = allocId();
  const t1Soldiers: Soldier[] = [
    makeSoldier(t1Id, 'german', true, 'Fw', 'Weber', 'kar98k'),
    makeSoldier(t1Id, 'german', false, 'Gefr', 'Klein', 'mp40'),
    makeSoldier(t1Id, 'german', false, 'Ogefr', 'Bauer', 'kar98k'),
    makeSoldier(t1Id, 'german', false, 'Sold', 'Hoffmann', 'mg34'),
    makeSoldier(t1Id, 'german', false, 'Sold', 'Schmidt', 'kar98k'),
    makeSoldier(t1Id, 'german', false, 'Sold', 'Wagner', 'kar98k'),
  ];
  t1Soldiers[3].health = 'wounded';
  t1Soldiers[3].activity = 'pinned';
  t1Soldiers[4].health = 'incapacitated';
  t1Soldiers[4].activity = 'incapacitated';
  t1Soldiers[1].activity = 'firing';
  t1Soldiers[0].activity = 'defending';
  for (const s of t1Soldiers) soldiers.set(s.id, s);

  const team1: Team = {
    id: t1Id,
    defId: 'ger_rifle_43',
    side: 'german',
    name: 'Rifle Squad',
    type: 'rifle',
    soldierIds: t1Soldiers.map((s) => s.id),
    leaderId: t1Soldiers[0].id,
    vehicleId: null,
    order: { type: 'defend', target: { x: 10, y: 10 }, issuedAt: 0 },
    facing: 4,
    experience: 45,
    morale: 62,
    status: 'Defending',
    pos: { x: 5, y: 5 },
    outOfAction: false,
    kills: 2,
    aiObjective: null,
  };
  teams.set(team1.id, team1);

  // --- Team 2: Soviet Rifle Squad (6 soldiers, badly mauled, out of action test) ---
  const t2Id = allocId();
  const t2Soldiers: Soldier[] = [
    makeSoldier(t2Id, 'soviet', true, 'Serzh', 'Ivanov', 'mosin'),
    makeSoldier(t2Id, 'soviet', false, 'Ryad', 'Petrov', 'ppsh41'),
    makeSoldier(t2Id, 'soviet', false, 'Ryad', 'Kuznetsov', 'mosin'),
    makeSoldier(t2Id, 'soviet', false, 'Ryad', 'Volkov', 'dp28'),
    makeSoldier(t2Id, 'soviet', false, 'Ryad', 'Sokolov', 'mosin'),
    makeSoldier(t2Id, 'soviet', false, 'Ryad', 'Popov', 'svt40'),
  ];
  t2Soldiers[1].health = 'dead';
  t2Soldiers[1].activity = 'dead';
  t2Soldiers[2].health = 'wounded';
  t2Soldiers[2].activity = 'cowering';
  t2Soldiers[3].activity = 'panicked';
  t2Soldiers[4].stance = 'prone';
  t2Soldiers[4].activity = 'sneaking';
  t2Soldiers[5].activity = 'moving';
  for (const s of t2Soldiers) soldiers.set(s.id, s);

  const team2: Team = {
    id: t2Id,
    defId: 'sov_rifle_43',
    side: 'soviet',
    name: 'Rifle Squad',
    type: 'rifle',
    soldierIds: t2Soldiers.map((s) => s.id),
    leaderId: t2Soldiers[0].id,
    vehicleId: null,
    order: { type: 'moveFast', target: { x: 20, y: 20 }, issuedAt: 0 },
    facing: 2,
    experience: 30,
    morale: 22,
    status: 'Panicked',
    pos: { x: 20, y: 20 },
    outOfAction: false,
    kills: 0,
    aiObjective: null,
  };
  teams.set(team2.id, team2);

  const messages: BattleMessage[] = [
    { time: 12, text: 'Battle begins.', kind: 'info' },
    { time: 44, text: 'Rifle Squad spots the enemy.', kind: 'info' },
    { time: 61, text: 'Klein opens fire.', kind: 'info' },
    { time: 88, text: 'Rifle Squad is pinned down!', kind: 'warn' },
    { time: 95, text: 'Petrov is killed.', kind: 'bad' },
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
// A minimal, self-contained InputState feed (mirrors src/engine/input.ts's
// shape) so this preview never has to import '@/game' — that module chains
// into screens/battle orchestration this tool intentionally stays clear of.
function createLocalInput(canvas: HTMLCanvasElement): { state: InputState; endFrame(): void } {
  const state: InputState = {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    wheel: 0,
  };

  function toLogical(clientX: number, clientY: number): Vec2 {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / 800, rect.height / 600);
    const dispW = 800 * scale;
    const dispH = 600 * scale;
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
const teamListPanel = new TeamListPanel();
const messagePanel = new MessagePanel();
const commandMenu = new CommandMenu();
const { state: input, endFrame } = createLocalInput(canvas);

let selectedTeamId: number | null = state.teams.values().next().value?.id ?? null;
let paused = false;
let speed: 1 | 2 | 4 = 1;

const cam = createCamera();
const losFrom: Vec2 = { x: 8, y: 6 };

function friendlyTeams(): Team[] {
  // Preview shows both sides in the roster so both TeamListPanel rows and
  // dimmed/out-of-action styling can be inspected side by side.
  return Array.from(state.teams.values());
}

function pushMessage(text: string, kind: BattleMessage['kind'] = 'info'): void {
  state.messages.push({ time: Math.round(state.time), text, kind });
  if (state.messages.length > 50) state.messages.shift();
}

function frame(): void {
  const teams = friendlyTeams();

  // Command menu takes input priority while open.
  if (commandMenu.isOpen) {
    const result = commandMenu.update(input);
    if (result && result !== 'cancel') {
      pushMessage(`Order issued: ${result.toUpperCase()}`, 'good');
    } else if (result === 'cancel') {
      pushMessage('Command menu cancelled.', 'info');
    }
  } else {
    const clickedId = teamListPanel.update(input, teams, state);
    if (clickedId != null) selectedTeamId = clickedId;

    for (const c of input.clicks) {
      if (c.button === 2 && c.y < 480) {
        const team = selectedTeamId != null ? state.teams.get(selectedTeamId) : null;
        if (team) {
          commandMenu.open({ x: c.x, y: c.y }, team, { canSmoke: team.type === 'mortar', canFire: true });
        }
      }
    }

    const action = messagePanel.update(input);
    if (action === 'pause') paused = !paused;
    else if (action === 'truce') pushMessage('Truce offered.', 'warn');
    else if (action === 'overview') pushMessage('Overview requested.', 'info');
    else if (action === 'options') pushMessage('Options requested.', 'info');
    if (action) pushMessage(`Button: ${action.toUpperCase()}`, 'info');
  }

  if (input.keysPressed.has('+')) speed = speed === 1 ? 2 : speed === 2 ? 4 : 4;
  if (input.keysPressed.has('-')) speed = speed === 4 ? 2 : 1;

  draw();
  endFrame();
  requestAnimationFrame(frame);
}

function draw(): void {
  ctx.fillStyle = '#1a2e1c';
  ctx.fillRect(0, 0, 800, 480);
  drawText(ctx, 'MAP VIEWPORT (fake) — hold Shift + move mouse here for the LOS tool', 8, 8, PALETTE.dim, 'small');

  if (input.keysDown.has('shift')) {
    const to = screenToWorld(cam, input.mouse);
    drawLOSLine(ctx, cam, state.map, losFrom, to);
  }

  const selectedTeam = selectedTeamId != null ? state.teams.get(selectedTeamId) ?? null : null;
  teamListPanel.draw(ctx, friendlyTeams(), state, selectedTeamId);
  drawSoldierMonitor(ctx, state, selectedTeam);
  messagePanel.draw(ctx, state, paused, speed);

  commandMenu.draw(ctx);
}

requestAnimationFrame(frame);
