import type {
  BattleConfig, BattleEvent, BattleState, Order, Rect, Side, Soldier, Team, Vec2,
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
import { stepGrowth } from './growth';
import { stepVictory } from './victory';
import { updateSpotting } from './spotting';
import { stepSmoke } from './smoke';
import { stepCombat } from './combat';
import { stepMorale } from './morale';
import { stepAI, aiDeploy } from './ai';
import { addMessage } from './messages';
import { stepMinds } from './mind';
import { stepCoverSeeking } from './coverSeek';
import { stepItemDrops } from './items';
import { stepPickups } from './pickup';
import { TEAM_DEFS, VEHICLE_DEFS } from '@/data/units';
import { getMap } from '@/data/maps';

export { addMessage } from './messages';

const DEPLOY_SPACING_TILES = 6;

export class Battle {
  state: BattleState;
  rng: Rng;

  private accumulator = 0;
  private spotAccum = 0;
  private aiAccum = 0;

  constructor(config: BattleConfig) {
    this.rng = new Rng(config.seed);
    const mapDef = getMap(config.mapId);
    const map = buildMap(mapDef);

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
    };

    for (const side of SIDES) {
      const zone = this.state.map.def.deployZones[side];
      const defIds = config.forces[side] ?? [];
      this.autoDeployForce(side, zone, defIds);
    }

    const aiSide = otherSide(config.playerSide);
    aiDeploy(this.state, aiSide, this.rng, this);

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
    stepPickups(state, this.rng, dt);
    stepVictory(state, dt);
    stepSmoke(state.map, dt);

    this.aiAccum += dt;
    if (this.aiAccum >= AI_INTERVAL) {
      this.aiAccum -= AI_INTERVAL;
      const aiSide = otherSide(state.config.playerSide);
      stepAI(state, this.rng, this, aiSide);
      this.evaluateTruce();
      if (state.config.aiBothSides) stepAI(state, this.rng, this, state.config.playerSide);
    }

    this.ageEffects(dt);

    if (state.messages.length > 200) {
      state.messages.splice(0, state.messages.length - 200);
    }
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
  }

  issueOrder(teamId: number, order: Order): void {
    const team = this.state.teams.get(teamId);
    if (!team) return;
    const full: Order = { ...order, issuedAt: this.state.time };
    applyOrder(this.state, team, full, this.rng);
  }

  deployTeam(teamId: number, pos: Vec2): boolean {
    if (this.state.phase !== 'deploy') return false;
    const team = this.state.teams.get(teamId);
    if (!team) return false;
    const zone = this.state.map.def.deployZones[team.side];
    if (!pointInRect(pos, zone)) return false;
    const mover = team.vehicleId != null ? 'vehicle' : 'infantry';
    if (!isPassable(this.state.map, Math.floor(pos.x), Math.floor(pos.y), mover)) return false;

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
      addMessage(state, 'Truce offer withdrawn.', 'info');
      return;
    }
    state.sides[side].truceOffered = true;
    state.sides[side].truceAccepted = true;
    addMessage(state, 'You have offered a truce.', 'info');
    this.evaluateTruce();
  }

  /** A standing truce offer is re-evaluated by the AI side every AI tick (manual: both sides must agree). */
  private evaluateTruce(): void {
    const state = this.state;
    const ai = otherSide(state.config.playerSide);
    const player = state.config.playerSide;
    if (!state.sides[player].truceOffered || state.sides[ai].truceAccepted) return;
    const s = state.sides;
    const losing = s[ai].morale < 50 || s[ai].score < s[player].score || s[ai].losses > s[player].losses * 1.5;
    if (losing) {
      s[ai].truceOffered = true;
      s[ai].truceAccepted = true;
      addMessage(state, 'The enemy has accepted the truce.', 'info');
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

  /** Team of `side` at `p`. For the enemy of the player this is forgiving but spotted-only (nearest
   * spotted soldier within ~1.2 tiles or a spotted hull + 0.5 tile), so a Fire click near a visible
   * enemy becomes an attack-unit order and a click on a hidden enemy stays area fire. */
  teamAt(p: Vec2, side: Side): Team | null {
    if (side !== this.state.config.playerSide) return spottedEnemyTeamAt(this.state, p, side);
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

  playerSide(): Side {
    return this.state.config.playerSide;
  }

  drainEvents(): BattleEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }
}
