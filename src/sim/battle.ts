import type {
  BattleConfig, BattleEvent, BattleReport, BattleState, Controller, Order, Rect, Side, Soldier,
  SoldierOutcome, Team, TeamOutcome, Vec2,
} from '@/shared/types';
import {
  AI_INTERVAL, EXPLOSION_LIFE_HE, EXPLOSION_LIFE_SMALL, EXPLOSION_LIFE_SMOKE,
  FLASH_LIFE, SIDES, SIM_DT, SPOT_INTERVAL, TILE_M, TRACER_LIFE, otherSide,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist, pointInRect } from '@/shared/math';
import { buildMap } from './map';
import { isPassable } from './path';
import { spawnTeam, layoutTeamPositions } from './spawn';
import { applyOrder, stepAttackOrders, spottedEnemyTeamAt } from './orders';
import { stepMovement } from './movement';
import { stepVehicles } from './vehicle';
import { getGrowth, stepGrowth } from './growth';
import { flee, stepVictory } from './victory';
import { compareCommands, resolveControllers, type Command, type CommandBody } from './commands';
import { updateSpotting } from './spotting';
import { stepSmoke } from './smoke';
import { stepCombat, stepPendingBursts } from './combat';
import { stepTreeFires } from './trees';
import { stepAI, aiDeploy } from './ai';
import { stepSubordinateInitiative } from './initiative';
import { stepMorale } from './morale';
import { addMessage } from './messages';
import { stepMinds } from './mind';
import { stepCoverSeeking } from './coverSeek';
import { stepItemDrops } from './items';
import { stepPickups } from './pickup';
import { stepMedic } from './medic';
import { TEAM_DEFS, VEHICLE_DEFS } from '@/data/units';
import { getMap } from '@/data/maps';

export { addMessage } from './messages';

const DEPLOY_SPACING_TILES = 6;

/** Seconds the leader's shouted order confirmation takes to land (B7): the team's order
 * markers stay ghosted until then — the shout is visible, audible feedback of latency. */
export const ORDER_SHOUT_CONFIRM_S = 0.8;

/** The AI will not sue for a truce in the opening minutes (manual: a ceasefire needs a
 * fought engagement behind it; mirrors victory.ts's MIN_CEASEFIRE_TIME_S intent). */
const TRUCE_OFFER_MIN_TIME_S = 120;

export class Battle {
  state: BattleState;
  rng: Rng;

  /** Who controls each side (resolved once from the config; the sim reads only this). */
  readonly controllers: Record<Side, Controller>;

  private accumulator = 0;
  private spotAccum = 0;
  private aiAccum = 0;
  /** Submitted commands waiting for their tick, and every command applied so far (the log). */
  private pending: Command[] = [];
  private applied: Command[] = [];
  private seq = 0;
  private ready = new Set<Side>();
  /** Replaying a log (loadCommands): commands apply in the log's own order, see flushCommands. */
  private replaying = false;

  constructor(config: BattleConfig) {
    this.rng = new Rng(config.seed);
    this.controllers = resolveControllers(config);
    config.controllers = { ...this.controllers };
    const mapDef = getMap(config.mapId);
    const map = buildMap(mapDef);
    // the growth field is built now, from the map's original tiles: built lazily it would depend
    // on when a reader (the UI's elevation readout, the AI) first asked, after craters may have
    // turned crops into 'crater' tiles (multiplayer plan D1)
    getGrowth(map);

    this.state = {
      config,
      map,
      phase: 'deploy',
      time: 0,
      soldiers: new Map(),
      teams: new Map(),
      vehicles: new Map(),
      sides: {
        german: { side: 'german', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
        soviet: { side: 'soviet', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      },
      spotted: { german: new Set(), soviet: new Set() },
      spottedVehicles: { german: new Set(), soviet: new Set() },
      messages: [],
      explosions: [],
      tracers: [],
      flashes: [],
      bloodDecals: [],
      result: null,
      events: [],
      nextId: 1,
      projectiles: [],
      sparks: [],
      pendingBursts: [],
      structureFx: [],
      results: null,
      tick: 0,
      speed: 1,
    };

    for (const side of SIDES) {
      const zone = this.state.map.def.deployZones[side];
      const defIds = config.forces[side] ?? [];
      this.autoDeployForce(side, zone, defIds);
    }

    // AI-controlled sides deploy themselves. Historically only the non-viewer side did, even in
    // AI-vs-AI harness runs; keep that order of RNG use so seeded battles replay unchanged.
    for (const side of this.aiDeployOrder()) aiDeploy(this.state, side, this.rng, this);

    this.state.phase = 'deploy';
  }

  private autoDeployForce(side: Side, zone: Rect, defIds: string[]): void {
    const cols = Math.max(1, Math.floor(zone.w / DEPLOY_SPACING_TILES));
    let i = 0;
    for (const defId of defIds) {
      const def = TEAM_DEFS[defId];
      if (!def) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const rawX = zone.x + DEPLOY_SPACING_TILES / 2 + col * DEPLOY_SPACING_TILES;
      const rawY = zone.y + DEPLOY_SPACING_TILES / 2 + row * DEPLOY_SPACING_TILES;
      const x = Math.min(rawX, zone.x + zone.w - 1);
      const y = Math.min(rawY, zone.y + zone.h - 1);
      const mover = def.vehicleDefId ? 'vehicle' : 'infantry';
      const pos = this.findPassableNear({ x, y }, mover);
      spawnTeam(this.state, def, side, pos, this.rng);
      i++;
    }
  }

  private findPassableNear(p: Vec2, mover: 'infantry' | 'vehicle'): Vec2 {
    const bx = Math.floor(p.x), by = Math.floor(p.y);
    if (isPassable(this.state.map, bx, by, mover)) return { x: bx + 0.5, y: by + 0.5 };
    for (let r = 1; r < 10; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = bx + dx, y = by + dy;
          if (isPassable(this.state.map, x, y, mover)) return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return p;
  }

  /** AI sides that deploy themselves, in the historical order (the non-viewer side only when
   * both are AI, since the harness always let the viewer side keep its auto-deployment). */
  private aiDeployOrder(): Side[] {
    const viewer = this.state.config.playerSide;
    const enemy = otherSide(viewer);
    return this.controllers[enemy] === 'ai' ? [enemy] : [];
  }

  sideIsAI(side: Side): boolean {
    return this.controllers[side] === 'ai';
  }

  /** Queue a command from `side`, applied at the start of tick `atTick` (default: the next tick;
   * while the battle is not running, on the next `step` call). Returns the stamped command. */
  submit(side: Side, body: CommandBody, atTick?: number): Command {
    const tick = Math.max(this.state.tick ?? 0, atTick ?? 0);
    // a deep copy: the log must not change if the caller later edits what it submitted
    const cmd = { ...structuredClone(body), side, tick, seq: this.seq++ } as Command;
    this.pending.push(cmd);
    return cmd;
  }

  /** Every command applied so far, in application order (the battle's command log). */
  commandLog(): readonly Command[] {
    return this.applied;
  }

  /** Queues a recorded command log (`commandLog()` of an earlier run of the same config) so this
   * battle replays it. Each command applies at its recorded tick and in its recorded order: while
   * the battle is not running several step() calls can each apply commands of one tick, so the
   * canonical (tick, side, sequence) sort of a single flush would not always restore the order. */
  loadCommands(log: readonly Command[]): void {
    this.replaying = true;
    this.pending = log.map((c, i) => ({ ...structuredClone(c), seq: i }));
    this.seq = log.length;
  }

  /** Commands submitted but not applied yet. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Applies the commands due by the current tick without running a tick: a replay stopping at
   * the recorded last tick takes the commands the original applied after it (a flee ending the
   * battle at a flush) before it compares the state hash. */
  flushDue(): void {
    this.flushCommands();
  }

  /** Apply every pending command due by the current tick, in canonical order. */
  private flushCommands(): void {
    if (this.pending.length === 0) return;
    const now = this.state.tick ?? 0;
    const due = this.pending.filter((c) => c.tick <= now)
      .sort(this.replaying ? (a, b) => a.seq - b.seq : compareCommands);
    if (due.length === 0) return;
    this.pending = this.pending.filter((c) => c.tick > now);
    for (const cmd of due) {
      // after the end only the viewing speed may change: a late order or flee would alter the
      // state after the result, and the log (and so a replay) would have to carry it too
      if (this.state.phase === 'ended' && cmd.type !== 'setSpeed') continue;
      this.applied.push(cmd);
      this.applyCommand(cmd);
    }
  }

  private applyCommand(cmd: Command): void {
    const state = this.state;
    switch (cmd.type) {
      case 'order': {
        const team = state.teams.get(cmd.teamId);
        if (team && team.side === cmd.side) this.issueOrder(cmd.teamId, cmd.order);
        return;
      }
      case 'deployTeam': {
        const team = state.teams.get(cmd.teamId);
        if (team && team.side === cmd.side) this.deployTeam(cmd.teamId, cmd.pos);
        return;
      }
      case 'autoDeploy':
        if (state.phase === 'deploy') aiDeploy(state, cmd.side, this.rng, this);
        return;
      case 'truce':
        if (state.phase === 'running') this.pressTruce(cmd.side);
        return;
      case 'flee':
        flee(state, cmd.side);
        return;
      case 'pause':
        this.pause();
        return;
      case 'resume':
        this.resume();
        return;
      case 'setSpeed':
        if (cmd.speed > 0 && Number.isFinite(cmd.speed)) state.speed = cmd.speed;
        return;
      case 'ready':
        this.ready.add(cmd.side);
        if ((['german', 'soviet'] as Side[]).every((s) => this.controllers[s] === 'ai' || this.ready.has(s))) this.start();
        return;
    }
  }

  start(): void {
    if (this.state.phase === 'deploy') this.state.phase = 'running';
  }

  pause(): void {
    if (this.state.phase === 'running') this.state.phase = 'paused';
  }

  resume(): void {
    if (this.state.phase === 'paused') this.state.phase = 'running';
  }

  /** Advances the sim by exactly `dt` in fixed SIM_DT sub-steps; no-op unless running. */
  step(dt: number): void {
    // outside a running battle no tick runs, so due commands (deploy moves, resume) apply now
    if (this.state.phase !== 'running') this.flushCommands();
    if (this.state.phase !== 'running') return;
    this.accumulator += dt;
    while (this.accumulator >= SIM_DT - 1e-6) {
      this.accumulator -= SIM_DT;
      this.subStep(SIM_DT);
      if (this.state.phase !== 'running') break;
    }
  }

  private subStep(dt: number): void {
    const state = this.state;
    this.flushCommands();
    if (state.phase !== 'running') return;
    state.tick = (state.tick ?? 0) + 1;
    state.time = Math.round((state.time + dt) * 1000) / 1000;

    stepCoverSeeking(state, this.rng, dt);
    stepMovement(state, this.rng, dt);
    stepVehicles(state, this.rng, dt);
    stepGrowth(state);

    this.spotAccum += dt;
    if (this.spotAccum >= SPOT_INTERVAL) {
      this.spotAccum -= SPOT_INTERVAL;
      updateSpotting(state, this.rng);
    }

    stepMinds(state, this.rng, dt);

    stepAttackOrders(state, this.rng);
    stepCombat(state, this.rng, dt);
    stepMorale(state, this.rng, dt);
    // kit as objects (spec 2026-09-17 §9): casualties leave theirs, able men pick things up
    stepItemDrops(state, this.rng);
    stepPendingBursts(state, this.rng);
    stepTreeFires(state, this.rng, dt);
    stepPickups(state, this.rng, dt);
    stepMedic(state, this.rng, dt);
    stepVictory(state, dt);
    stepSmoke(state.map, dt);

    this.aiAccum += dt;
    if (this.aiAccum >= AI_INTERVAL) {
      this.aiAccum -= AI_INTERVAL;
      // the historical per-tick order: the viewer's enemy, truce and initiative, then the viewer
      const viewer = state.config.playerSide;
      const enemy = otherSide(viewer);
      if (this.controllers[enemy] === 'ai') stepAI(state, this.rng, this, enemy);
      this.evaluateTruce();
      this.maybeAiTruceOffer();
      this.subordinateInitiative();
      if (this.controllers[viewer] === 'ai') stepAI(state, this.rng, this, viewer);
    }

    this.ageEffects(dt);

  }

  private ageEffects(dt: number): void {
    const state = this.state;
    for (const e of state.explosions) e.t += dt;
    state.explosions = state.explosions.filter((e) => e.t < (
      e.kind === 'he' ? EXPLOSION_LIFE_HE : e.kind === 'smoke' ? EXPLOSION_LIFE_SMOKE : EXPLOSION_LIFE_SMALL
    ));
    for (const t of state.tracers) t.t += dt;
    state.tracers = state.tracers.filter((t) => t.t < TRACER_LIFE);
    for (const f of state.flashes) f.t += dt;
    state.flashes = state.flashes.filter((f) => f.t < FLASH_LIFE);
    // projectiles in flight: the visual plays the arrival when it lands (sim damage already applied)
    if (state.projectiles.length > 0) {
      for (const p of state.projectiles) {
        if (!p.preResolved && state.time >= p.t0 + p.flightS) p.preResolved = true;
      }
      state.projectiles = state.projectiles.filter((p) => state.time < p.t0 + p.flightS + (p.kind === 'mortar' ? 0.25 : 0.1));
    }
    // impact sparks / puffs (A2): t = spawn time; the renderer fades on state.time - t
    if (state.sparks.length > 0) state.sparks = state.sparks.filter((s) => state.time - s.t < 0.8);
    // delayed grenade/satchel bursts are consumed by sim/combat.ts stepPendingBursts
    // structure FX visuals linger for the renderer, capped (B3)
    if (state.structureFx.length > 32) state.structureFx.splice(0, state.structureFx.length - 32);
  }

  issueOrder(teamId: number, order: Order): void {
    const team = this.state.teams.get(teamId);
    if (!team) return;
    const full: Order = { ...order, issuedAt: this.state.time };
    applyOrder(this.state, team, full, this.rng);
    // B7: the leader shouts the order back — a beat later (voice over the din, not radio),
    // so the audio reads as human latency rather than a UI click echo. Until the shout lands
    // (ORDER_SHOUT_CONFIRM_S) the team's order marker renders ghosted (orderMarkers.ts).
    const leader = this.state.soldiers.get(team.leaderId);
    if (leader && leader.health !== 'dead' && leader.health !== 'incapacitated') {
      team.shoutAt = this.state.time + ORDER_SHOUT_CONFIRM_S;
      this.state.events.push({
        kind: 'orderShout', pos: { ...leader.pos }, side: leader.side,
        weaponId: order.type, teamId: team.id,
      });
    }
  }

  /** Whether `deployTeam(teamId, pos)` would succeed now (the deploy screen checks a drop
   * before submitting it). */
  canDeployTeam(teamId: number, pos: Vec2): boolean {
    if (this.state.phase !== 'deploy') return false;
    const team = this.state.teams.get(teamId);
    if (!team) return false;
    const zone = this.state.map.def.deployZones[team.side];
    if (!pointInRect(pos, zone)) return false;
    const mover = team.vehicleId != null ? 'vehicle' : 'infantry';
    return isPassable(this.state.map, Math.floor(pos.x), Math.floor(pos.y), mover);
  }

  deployTeam(teamId: number, pos: Vec2): boolean {
    if (!this.canDeployTeam(teamId, pos)) return false;
    const team = this.state.teams.get(teamId)!;

    team.pos = { x: pos.x, y: pos.y };
    if (team.vehicleId != null) {
      const veh = this.state.vehicles.get(team.vehicleId);
      if (veh) veh.pos = { x: pos.x, y: pos.y };
    }
    const members = team.soldierIds.map((sid) => this.state.soldiers.get(sid)).filter((s): s is Soldier => !!s);
    // Natural formation shape (spawn.ts), each man on his own passable tile.
    const slots = team.vehicleId != null ? null : layoutTeamPositions(this.state.map, pos, members.map((s) => s.formationOffset));
    members.forEach((s, i) => {
      s.pos = slots ? slots[i] : { x: pos.x, y: pos.y };
    });
    return true;
  }

  offerTruce(side: Side): void {
    const state = this.state;
    if (state.sides[side].truceOffered) {
      // second click withdraws the standing offer
      state.sides[side].truceOffered = false;
      state.sides[side].truceAccepted = false;
      addMessage(state, 'Truce offer withdrawn.', 'info', side);
      addMessage(state, 'The enemy has withdrawn its truce offer.', 'info', otherSide(side));
      return;
    }
    state.sides[side].truceOffered = true;
    state.sides[side].truceAccepted = true;
    addMessage(state, 'You have offered a truce.', 'info', side);
    if (!this.sideIsAI(otherSide(side))) {
      addMessage(state, 'The enemy requests a truce — press TRUCE to accept.', 'info', otherSide(side));
    }
    this.evaluateTruce();
  }

  /** A side accepts a standing offer from the other (the Truce button does this when the
   * other side has asked). */
  acceptTruce(side: Side): void {
    const s = this.state.sides;
    const other = otherSide(side);
    if (!s[other].truceOffered) return;
    s[side].truceAccepted = true;
    s[other].truceAccepted = true;
    addMessage(this.state, 'Truce agreed.', 'info');
  }

  /** The Truce button: accepts a standing enemy offer, otherwise offers/withdraws our own. */
  pressTruce(side: Side): void {
    if (this.state.sides[otherSide(side)].truceOffered && !this.state.sides[side].truceAccepted) {
      this.acceptTruce(side);
    } else {
      this.offerTruce(side);
    }
  }

  /** True when `side` is doing badly enough to want the fighting stopped. */
  private losing(side: Side): boolean {
    const s = this.state.sides;
    const other = otherSide(side);
    return s[side].morale < 50 || s[side].score < s[other].score || s[side].losses > s[other].losses * 1.5;
  }

  /** Every AI tick, an AI side re-evaluates a standing truce offer from the other side, and its
   * own unanswered offer (manual: both sides must agree). Human sides answer with the button. */
  private evaluateTruce(): void {
    const state = this.state;
    const s = state.sides;
    for (const ai of this.truceOrder()) {
      if (!this.sideIsAI(ai)) continue;
      const other = otherSide(ai);
      // the other side's standing offer, evaluated against the AI's situation
      if (s[other].truceOffered && !s[ai].truceAccepted) {
        if (this.losing(ai)) {
          s[ai].truceOffered = true;
          s[ai].truceAccepted = true;
          addMessage(state, 'The enemy has accepted the truce.', 'info', other);
        }
      }
      // the AI's own standing offer: withdraw it if the situation recovers
      if (s[ai].truceOffered && !s[ai].truceAccepted && !s[other].truceAccepted) {
        if (!this.losing(ai)) {
          s[ai].truceOffered = false;
          addMessage(state, 'The enemy has withdrawn its truce offer.', 'info', other);
        }
      }
    }
  }

  /** Sides in the order the truce rules visit them: the viewer's enemy first (the only AI
   * side in single player), so a seeded single-player battle uses the RNG as it always did. */
  private truceOrder(): Side[] {
    const viewer = this.state.config.playerSide;
    return [otherSide(viewer), viewer];
  }

  /** G18 subordinate initiative: once per AI tick, an idle confident team of a human side
   * may act on its own and take the nearest enemy-held VL (E13 flavour). The commander
   * is told in the message log; he overrules by simply issuing a new order. */
  private subordinateInitiative(): void {
    // item 024: the 'Never Act On Initiative' realism toggle silences team initiative
    if (this.state.config.neverActOnInitiative) return;
    for (const side of this.truceOrder().reverse()) {
      if (this.sideIsAI(side)) continue;
      const res = stepSubordinateInitiative(this.state, this.rng, side, (teamId, target) => {
        this.issueOrder(teamId, { type: 'moveFast', target: { ...target }, issuedAt: this.state.time });
      });
      if (res) {
        const team = this.state.teams.get(res.teamId);
        if (team) addMessage(this.state, `${team.name} is acting on its own initiative — moving on the objective.`, 'info', side);
        this.state.events.push({ kind: 'subordinateInitiative', teamId: res.teamId, pos: res.target, side });
      }
    }
  }

  /** An AI side asks for a truce when it is clearly losing (called each AI tick; roadmap G14). */
  private maybeAiTruceOffer(): void {
    const state = this.state;
    if (state.phase !== 'running' || state.time < TRUCE_OFFER_MIN_TIME_S) return;
    const s = state.sides;
    for (const ai of this.truceOrder()) {
      if (!this.sideIsAI(ai)) continue;
      const other = otherSide(ai);
      if (s[ai].truceOffered || s[ai].truceAccepted) continue;
      const badlyLosing = s[ai].morale < 25 && (s[ai].losses > s[other].losses * 1.5 || s[ai].score < s[other].score * 0.5);
      if (!badlyLosing) continue;
      s[ai].truceOffered = true;
      addMessage(state, 'The enemy requests a truce — press TRUCE to accept.', 'info', other);
    }
  }

  selectableTeams(side: Side): Team[] {
    return [...this.state.teams.values()]
      .filter((t) => t.side === side && !t.outOfAction)
      .sort((a, b) => a.id - b.id);
  }

  /** Nearest alive soldier of `side` (or any side) within 0.8 tiles of `p`. */
  soldierAt(p: Vec2, side?: Side): Soldier | null {
    let best: Soldier | null = null;
    let bd = 0.8;
    for (const s of this.state.soldiers.values()) {
      if (s.health === 'dead') continue;
      if (side && s.side !== side) continue;
      const d = dist(s.pos, p);
      if (d <= bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Team of `side` at `p`, as `viewer` sees it. For the viewer's enemy this is forgiving but
   * spotted-only (nearest spotted soldier within ~1.2 tiles or a spotted hull + 0.5 tile), so a Fire
   * click near a visible enemy becomes an attack-unit order and a click on a hidden enemy stays
   * area fire. */
  teamAt(p: Vec2, side: Side, viewer: Side = this.state.config.playerSide): Team | null {
    if (side !== viewer) return spottedEnemyTeamAt(this.state, p, side);
    const s = this.soldierAt(p, side);
    if (s) return this.state.teams.get(s.teamId) ?? null;
    for (const v of this.state.vehicles.values()) {
      if (v.side !== side) continue;
      const def = VEHICLE_DEFS[v.defId];
      const half = def ? def.lengthM / TILE_M / 2 : 1;
      if (dist(v.pos, p) <= half) return this.state.teams.get(v.teamId) ?? null;
    }
    return null;
  }

  /** The local viewer's side (UI perspective only; the sim itself reads `controllers`). */
  playerSide(): Side {
    return this.state.config.playerSide;
  }

  drainEvents(): BattleEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }

  /** End-of-battle export for the campaign layer (G1): a read-only snapshot of every team and
   * soldier of `side` (the viewer's by default). Pure — does not touch the sim state. */
  battleReport(side: Side = this.state.config.playerSide): BattleReport {
    const teams: TeamOutcome[] = [];
    for (const team of this.state.teams.values()) {
      if (team.side !== side) continue;
      const soldiers: SoldierOutcome[] = [];
      for (const id of team.soldierIds) {
        const s = this.state.soldiers.get(id);
        if (!s) continue;
        soldiers.push({
          uid: s.uid ?? `b${id}`,
          name: s.name,
          rank: s.rank,
          weaponId: s.weaponId,
          health: s.health === 'dead' ? 'dead' : s.health === 'wounded' ? 'wounded' : 'ok',
          kills: s.kills,
          experience: s.experience,
          isLeader: !!s.isLeader,
        });
      }
      // vehicle damage carry-over (G3): the hull the team brings to the next battle
      let vehicleDamage: TeamOutcome['vehicleDamage'] | undefined;
      const veh = team.vehicleId != null ? this.state.vehicles.get(team.vehicleId) : null;
      if (veh) {
        if (veh.state === 'immobilized' || veh.state === 'knockedOut' || veh.state === 'abandoned') vehicleDamage = 'immobilised';
        else if (veh.hits > 0) vehicleDamage = 'damaged';
      }
      teams.push({ defId: team.defId, kills: team.kills, soldiers, vehicleDamage });
    }
    return { result: this.state.results?.[side] ?? this.state.result ?? 'draw', fledSide: this.state.fledSide ?? null, teams };
  }
}

