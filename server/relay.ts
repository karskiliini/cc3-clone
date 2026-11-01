import { crc32 } from '../src/net/integrity';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MAPS, getMap } from '../src/data/maps';
import { TEAM_DEFS } from '../src/data/units';
import { SIMULATION_BUILD } from '../src/shared/version';
import { validCommand } from '../src/net/commandValidation';
import {
  RELAY_PROTOCOL, ROOM_TTL_MS, MAX_WIRE_BYTES, MAX_ROOM_HISTORY_BYTES, SIDES,
  isRecord, isSide, validTurn, validSettings,
  type RoomSettings, type RoomView, type ServerFrame, type TurnHistory,
} from '../src/net/relayProtocol';
import type { BattleConfig, Side } from '../src/shared/types';
import type { CommandBody } from '../src/sim/commands';

interface Member {
  token: string; socket: WebSocket | null; disconnectedAt: number | null;
  forces: string[]; ready: boolean; turn: number; frozen: number | null; rebuilt: number | null;
}
interface Room {
  code: string; host: Side; settings: RoomSettings; members: Record<Side, Member | null>;
  phase: RoomView['phase']; generation: number; config?: BattleConfig;
  history: Record<Side, Map<number, CommandBody[]>>;
  sealedTo: Record<Side, number>; bytes: number; createdAt: number; attempts: number;
  freezing: boolean; recoveryTurn: number; recoveryAt:number; recoveryProgress:Record<Side,number>; pending:Record<Side,Set<number>>;
}
interface Client { room?: Room; side?: Side; alive: boolean; rateAt: number; messages: number; bytes: number }
export interface RelayOptions {
  host?: string; port?: number; build?: string; staticDir?: string; allowedOrigins?: string[];
  ttlMs?: number; maintenanceMs?: number; recoveryTimeoutMs?:number;
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const json = (v: unknown) => JSON.stringify(v);

export async function createRelayServer(opts: RelayOptions = {}) {
  const build = opts.build ?? SIMULATION_BUILD, rooms = new Map<string, Room>(), clients = new Map<WebSocket, Client>();
  const ttl = opts.ttlMs ?? ROOM_TTL_MS;
  const server = createServer(async (req, res) => {
    let path:string;
    try{path=new URL(req.url??'/','http://relay').pathname;}catch{res.writeHead(400);res.end();return;}
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/healthz' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(json({ ok: true, protocol: RELAY_PROTOCOL, build, rooms: rooms.size })); return;
    }
    if (!opts.staticDir || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try {
      const root = await realpath(opts.staticDir), requested = resolve(root, '.' + decodeURIComponent(path));
      if (requested !== root && !requested.startsWith(root + sep)) throw new Error('Outside static root');
      let file = requested;
      if (path === '/' || (await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const actual = await realpath(file);
      if (!actual.startsWith(root + sep)) throw new Error('Outside static root');
      const content = await readFile(actual);
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
      res.setHeader('Content-Type', types[extname(actual)] ?? 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false });
  function send(ws: WebSocket | null, frame: ServerFrame): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_WIRE_BYTES * 2) { ws.close(1009, 'Slow receiver'); return; }
    ws.send(json(frame));
  }
  const error = (ws: WebSocket, code: string, message: string) => send(ws, { op: 'error', code, message });
  function view(r: Room): RoomView {
    const member = (s: Side) => { const m = r.members[s]; return m ? { connected: !!m.socket, ready: m.ready, forces: [...m.forces], turn: m.turn, sealedTo:r.sealedTo[s] } : null; };
    return { code: r.code, host: r.host, settings: { ...r.settings }, phase: r.phase, generation: r.generation, members: { german: member('german'), soviet: member('soviet') } };
  }
  function broadcast(r: Room, frame: ServerFrame): void { for (const s of SIDES) send(r.members[s]?.socket ?? null, frame); }
  const changed = (r: Room) => broadcast(r, { op: 'room', room: view(r) });
  function closeRoom(r: Room, reason: string, forfeit?: Side): void {
    r.phase = 'closed'; broadcast(r, { op: 'closed', reason, ...(forfeit ? { forfeit } : {}) }); rooms.delete(r.code);
  }
  function validRoomSettings(s: unknown): s is RoomSettings { return validSettings(s) && MAPS.some(m => m.id === s.mapId); }
  function validRoster(r: Room, side: Side, ids: unknown): ids is string[] {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 15) return false;
    let cost = 0;
    for (const id of ids) {
      const d = typeof id === 'string' ? TEAM_DEFS[id] : null;
      if (!d || d.side !== side || r.settings.year < d.years[0] || r.settings.year > d.years[1]) return false;
      cost += d.cost;
    }
    return cost <= r.settings.points;
  }
  function history(r: Room): TurnHistory {
    return { turn: r.recoveryTurn, sealedTo: { ...r.sealedTo }, bundles: { german: [...r.history.german], soviet: [...r.history.soviet] } };
  }
  function snapshot(r: Room): void {
    if (!SIDES.every(s => r.members[s]?.socket && r.members[s]?.frozen !== null)) return;
    r.recoveryTurn = Math.min(...SIDES.map(s => r.members[s]!.frozen!));
    r.generation++; r.freezing = false; r.recoveryAt=Date.now(); r.recoveryProgress={german:0,soviet:0};
    for (const s of SIDES) { r.members[s]!.rebuilt = null; r.members[s]!.turn = r.recoveryTurn; }
    broadcast(r, { op: 'history', config: r.config!, generation: r.generation, history: history(r) }); changed(r);
  }
  function freeze(r: Room): void {
    r.phase = 'recovering'; r.freezing = true; r.recoveryAt=Date.now();
    for (const s of SIDES) if (r.members[s]) { r.members[s]!.frozen = null; r.members[s]!.rebuilt = null; }
    broadcast(r, { op: 'freeze', generation: r.generation }); changed(r);
  }
  function assign(ws: WebSocket, c: Client, r: Room, side: Side, m: Member): void {
    const old = m.socket; m.socket = ws; m.disconnectedAt = null; c.room = r; c.side = side;
    if (old && old !== ws) old.close(4001, 'Rejoined in another tab');
    send(ws, { op: 'member', side, token: m.token, room: view(r) }); changed(r);
  }
  function onFrame(ws: WebSocket, c: Client, f: unknown): void {
    if (!isRecord(f) || typeof f.op !== 'string') { error(ws, 'BAD_FRAME', 'Invalid room message.'); return; }
    if (['create', 'join', 'rejoin'].includes(f.op)) {
      if (c.room) { error(ws, 'ALREADY_JOINED', 'Already in a room.'); return; }
      if (f.protocol !== RELAY_PROTOCOL || f.build !== build) { error(ws, 'BUILD_MISMATCH', 'Both players and the relay need the same game build.'); return; }
      if (f.op === 'create') {
        if (!isSide(f.side) || !validRoomSettings(f.settings)) { error(ws, 'BAD_SETTINGS', 'Invalid battle settings.'); return; }
        if (rooms.size >= 32) { error(ws, 'FULL', 'Relay is full. Try again later.'); return; }
        let code: string;
        do { code = [...randomBytes(6)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (rooms.has(code));
        const r: Room = { code, host: f.side, settings: { ...f.settings }, members: { german: null, soviet: null }, phase: 'lobby', generation: 1, history: { german: new Map(), soviet: new Map() }, sealedTo: { german: 2, soviet: 2 }, bytes: 0, createdAt: Date.now(), attempts: 0, freezing: false, recoveryTurn: 0, recoveryAt:0, recoveryProgress:{german:0,soviet:0}, pending:{german:new Set(),soviet:new Set()} };
        const m: Member = { token: randomBytes(24).toString('hex'), socket: null, disconnectedAt: null, forces: [], ready: false, turn: 0, frozen: null, rebuilt: null };
        r.members[f.side] = m; rooms.set(code, r); assign(ws, c, r, f.side, m); return;
      }
      if (typeof f.code !== 'string' || !/^[A-Z2-9]{6}$/.test(f.code)) { error(ws, 'BAD_CODE', 'Enter the six-character room code.'); return; }
      const r = rooms.get(f.code);
      if (!r) { error(ws, 'NO_ROOM', 'Room expired or relay restarted. Create a new room.'); return; }
      if (f.op === 'rejoin') {
        const side = SIDES.find(s => typeof f.token === 'string' && r.members[s]?.token === f.token);
        if (!side) { error(ws, 'BAD_TOKEN', 'This browser has no valid player token for that room.'); return; }
        assign(ws, c, r, side, r.members[side]!);
        if (r.config) freeze(r);
        return;
      }
      const side = SIDES.find(s => !r.members[s]);
      if (r.phase !== 'lobby' || !side) { error(ws, 'ROOM_FULL', 'Room is full. Use Rejoin to recover your own seat.'); return; }
      const m: Member = { token: randomBytes(24).toString('hex'), socket: null, disconnectedAt: null, forces: [], ready: false, turn: 0, frozen: null, rebuilt: null };
      r.members[side] = m; assign(ws, c, r, side, m); return;
    }
    const r = c.room, side = c.side;
    if (!r || !side || r.members[side]?.socket !== ws || !rooms.has(r.code)) { error(ws, 'NOT_JOINED', 'Join an active room first.'); return; }
    const m = r.members[side]!, peer = side === 'german' ? 'soviet' : 'german';
    if (f.op === 'leave') { if (!['ai', 'forfeit', 'quit'].includes(f.mode)) return; closeRoom(r, f.mode === 'ai' ? 'Opponent continued locally against AI.' : f.mode === 'forfeit' ? 'Opponent forfeited.' : 'Opponent left the room.', f.mode === 'forfeit' ? side : undefined); return; }
    if (f.op === 'settings') {
      if (r.phase !== 'lobby' || r.host !== side || !validRoomSettings(f.settings)) { error(ws, 'BAD_SETTINGS', 'Only the host can change valid lobby settings.'); return; }
      r.settings = { ...f.settings }; for (const s of SIDES) if (r.members[s]) { r.members[s]!.ready = false; r.members[s]!.forces = []; } changed(r); return;
    }
    if (f.op === 'roster') {
      if (r.phase !== 'lobby' || !validRoster(r, side, f.forces) || typeof f.ready !== 'boolean') { error(ws, 'BAD_ROSTER', 'Choose 1–15 eligible teams within your points.'); return; }
      m.forces = [...f.forces]; m.ready = f.ready; changed(r);
      if (SIDES.every(s => r.members[s]?.ready && r.members[s]?.socket)) {
        r.config = { mapId: r.settings.mapId, playerSide: r.host, year: r.settings.year, durationS: r.settings.durationS, seed: r.settings.seed, difficulty: 'normal', multiplayer: true, controllers: { german: 'human', soviet: 'human' }, forces: { german: [...r.members.german!.forces], soviet: [...r.members.soviet!.forces] } };
        r.phase = 'playing'; broadcast(r, { op: 'start', config: r.config, generation: r.generation }); changed(r);
      }
      return;
    }
    if (f.generation !== r.generation) return; // superseded socket generation
    if(f.op==='rebuildFailed'&&r.phase==='recovering'){closeRoom(r,'Recovery could not rebuild the battle. Download a report, rejoin or continue locally.');return;}
    if(f.op==='rebuilding'&&r.phase==='recovering'&&!r.freezing&&validTurn(f.turn)&&f.turn<=r.recoveryTurn&&f.turn>r.recoveryProgress[side]){r.recoveryProgress[side]=f.turn;r.recoveryAt=Date.now();return;}
    if (f.op === 'progress' && validTurn(f.turn) && f.turn <= Math.min(r.sealedTo.german, r.sealedTo.soviet) + 1) { m.turn = Math.max(m.turn, f.turn); return; }
    if (f.op === 'frozen' && r.phase === 'recovering' && r.freezing && f.sealedTo===r.sealedTo[side] && validTurn(f.turn) && f.turn <= Math.min(r.sealedTo.german, r.sealedTo.soviet) + 1) { m.frozen = f.turn; snapshot(r); return; }
    if (f.op === 'rebuilt' && r.phase === 'recovering' && !r.freezing && f.turn === r.recoveryTurn && Number.isInteger(f.hash) && f.hash >= 0 && f.hash <= 0xffffffff) {
      m.rebuilt = f.hash;
      if (SIDES.every(s => r.members[s]?.rebuilt != null)) {
        if (r.members.german!.rebuilt === r.members.soviet!.rebuilt) { r.phase = 'playing'; r.attempts = 0; broadcast(r, { op: 'play', generation: r.generation }); changed(r); }
        else if (++r.attempts >= 3) closeRoom(r, 'Recovery states still differ after three attempts. Download the report or continue locally.');
        else freeze(r);
      }
      return;
    }
    if (f.op !== 'wire' || !r.config || (r.phase !== 'playing' && !r.freezing)) return;
    if (r.freezing && m.frozen !== null) return;
    const env = f.envelope;
    if (!isRecord(env) || !Number.isSafeInteger(env.seq) || env.seq < 0 || !Number.isInteger(env.crc)) { error(ws, 'BAD_WIRE', 'Invalid simulation envelope.'); return; }
    if (env.k === 'm') {
      if (typeof env.body !== 'string') return;
      if(env.crc!==crc32(env.body)){if(r.phase==='playing')send(r.members[peer]?.socket??null,{op:'wire',generation:r.generation,envelope:env as any});return;}
      let msg: any; try { msg = JSON.parse(env.body); } catch { return; }
      if (!isRecord(msg) || msg.side !== side) { error(ws, 'WRONG_SIDE', 'A player can send only their own side.'); return; }
      if (msg.kind === 'bundle') {
        const mapDef = getMap(r.config.mapId);
        if (!validTurn(msg.turn) || !Array.isArray(msg.commands) || msg.commands.length > 100 || !msg.commands.every((v: unknown) => validCommand(v, mapDef.width, mapDef.height))) { error(ws, 'BAD_COMMAND', 'Invalid battle command bundle.'); return; }
        if (msg.turn > r.sealedTo[side] + 1000) { error(ws, 'BAD_TURN', 'Turn too far ahead.'); return; }
        const old = r.history[side].get(msg.turn);
        if ((msg.turn <= r.sealedTo[side] || r.pending[side].has(msg.turn)) && json(old ?? []) !== json(msg.commands)) { error(ws, 'SEALED', 'A sealed command bundle cannot be changed.'); return; }
        if (msg.turn > r.sealedTo[side] && !r.pending[side].has(msg.turn)) {
          const bytes = msg.commands.length ? Buffer.byteLength(json(msg.commands)) : 0;
          if (r.bytes + bytes > MAX_ROOM_HISTORY_BYTES) { closeRoom(r, 'Battle history limit reached. Save a replay and continue locally.'); return; }
          if (msg.commands.length) r.history[side].set(msg.turn, msg.commands);
          r.bytes += bytes; r.pending[side].add(msg.turn);
          while(r.pending[side].delete(r.sealedTo[side]+1))r.sealedTo[side]++;
        }
      } else if (!['hash', 'resyncRequest', 'resync', 'resynced', 'resyncFailed'].includes(msg.kind)) return;
    } else if (env.k !== 'nack') return;
    if (r.phase === 'playing') send(r.members[peer]?.socket ?? null, { op: 'wire', generation: r.generation, envelope: env as any });
  }
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    let path:string;try{path=new URL(req.url??'/','http://relay').pathname;}catch{socket.destroy();return;}
    let originOK = !req.headers.origin;
    try { if (req.headers.origin) originOK = new URL(req.headers.origin).host === req.headers.host || !!opts.allowedOrigins?.includes(req.headers.origin); } catch { originOK = false; }
    if (path !== '/relay' || !originOK || clients.size >= 64) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const c: Client = { alive: true, rateAt: Date.now(), messages: 0, bytes: 0 }; clients.set(ws, c);
    ws.on('error', () => {}); ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, binary) => {
      if (binary) { error(ws, 'BAD_FRAME', 'JSON text messages only.'); return; }
      const now = Date.now(); if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = 0; c.bytes = 0; }
      const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.isBuffer(data)?data:Buffer.from(data);
      c.messages++; c.bytes += bytes.length;
      if (c.messages > 240 || c.bytes > MAX_WIRE_BYTES * 3) { ws.close(1008, 'Message rate limit'); return; }
      try { onFrame(ws, c, JSON.parse(bytes.toString())); } catch { error(ws, 'BAD_FRAME', 'Malformed room message.'); }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (c.room && c.side && c.room.members[c.side]?.socket === ws) {
        c.room.members[c.side]!.socket = null; c.room.members[c.side]!.disconnectedAt = Date.now(); changed(c.room);
      }
    });
  });
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) if (SIDES.some(s => r.members[s]?.disconnectedAt != null && now - r.members[s]!.disconnectedAt! >= ttl)) closeRoom(r, 'Reconnect grace period expired. Continue locally or create a new room.');
    for(const r of rooms.values())if(r.phase==='recovering'&&now-r.recoveryAt>(opts.recoveryTimeoutMs??60000))closeRoom(r,'Recovery stopped making progress. Download a report or continue locally.');
    for (const [ws, c] of clients) { if (!c.alive) ws.terminate(); else { c.alive = false; ws.ping(); } }
  }, opts.maintenanceMs ?? 10000);
  maintenance.unref();
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => { server.off('error', reject); resolveReady(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listening address');
  return { server, wss, port: address.port, rooms,
    async close(): Promise<void> { clearInterval(maintenance); for (const ws of clients.keys()) ws.terminate(); await Promise.all([new Promise<void>(r => wss.close(() => r())), new Promise<void>(r => server.close(() => r()))]); },
  };
}
