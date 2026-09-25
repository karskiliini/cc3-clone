import type { BattleState, Camera, CursorKind, Side, Team, Vec2, Vehicle } from '@/shared/types';
import { TILE_M, TILE_PX, otherSide } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { worldToScreen } from '@/engine/camera';
import { dist } from '@/shared/math';
import { eyeHeightM, EYE_VEHICLE_M } from '@/sim/los';
import { aimLineProfile, aimPointClass, type AimClass } from '@/sim/losProfile';
import { ATTACK_PICK_VEHICLE_PAD_TILES, spottedEnemyTeamAt } from '@/sim/orders';
import { penRating, teamPenetrationChance, type PenRating } from '@/sim/penChance';
import { vehicleEyes } from '@/sim/vehicleVision';

/** Where a team looks from when it aims: its leader (or first living man) at his eye height, or —
 * for a vehicle — the turret eye (gunner's sight, or the commander laying the gun himself in a
 * two-man turret; falling back to the commander alone if no gunner lives) since that is the sight
 * the aiming line represents; if no turret crew lives, the hull eye (driver, then radio operator).
 * Only when every crewman is dead does this fall back to the hull centre at commander height. Null
 * when nobody is left to look (dismounted teams only — a vehicle always has the last-resort
 * fallback). */
export function teamObserver(state: BattleState, t: Team): { from: Vec2; eyeM: number } | null {
  if (t.vehicleId != null) {
    const veh = state.vehicles.get(t.vehicleId);
    if (!veh) return null;
    const eyes = vehicleEyes(state, veh);
    const turret = eyes.find((e) => e.role === 'gunner') ?? eyes.find((e) => e.role === 'commander');
    const hull = turret ?? eyes.find((e) => e.role === 'driver') ?? eyes.find((e) => e.role === 'radioOp');
    if (hull) return { from: hull.pos, eyeM: hull.eyeM };
    return { from: veh.pos, eyeM: EYE_VEHICLE_M };
  }
  const leader = state.soldiers.get(t.leaderId);
  const obs = leader && leader.health !== 'dead'
    ? leader
    : t.soldierIds.map((sid) => state.soldiers.get(sid)).find((x) => x && x.health !== 'dead');
  if (!obs) return null;
  return { from: obs.pos, eyeM: eyeHeightM(obs.stance) };
}

function teamFiresIndirect(state: BattleState, t: Team): boolean {
  for (const sid of t.soldierIds) {
    const s = state.soldiers.get(sid);
    if (!s || s.health === 'dead') continue;
    if (WEAPONS[s.weaponId]?.indirect) return true;
  }
  return false;
}

/** Points of the enemy team the player can currently see: spotted living men, or the spotted hull. */
export function spottedMemberPoints(state: BattleState, viewer: Side, target: Team): Vec2[] {
  if (target.vehicleId != null) {
    const v = state.vehicles.get(target.vehicleId);
    return v && state.spottedVehicles[viewer].has(v.id) ? [v.pos] : [];
  }
  const pts: Vec2[] = [];
  for (const sid of target.soldierIds) {
    const s = state.soldiers.get(sid);
    if (!s || s.health === 'dead' || s.vehicleId != null) continue;
    if (state.spotted[viewer].has(sid)) pts.push(s.pos);
  }
  return pts;
}

export type DeadVehicleState = 'knockedOut' | 'burning' | 'abandoned';

export interface TargetHover {
  team: Team;
  cls: AimClass;
  /** Armoured target only: best penetration chance among the selected teams against the armour
   * face each of them sees from where it stands now, and its rating for the cursor colour. Worked
   * out whether or not there is a line of fire: it says how good a hit from this angle would be. */
  penChance?: number;
  pen?: PenRating;
  /** False when none of the selected teams has a line of fire to the target from where it is
   * (armoured targets only — soft targets are only offered with one). */
  lof: boolean;
  /** The spotted vehicle under the pointer is already out: knocked out, burning or abandoned. */
  dead?: DeadVehicleState;
}

/** The spotted enemy vehicle hull under `world` (any state, wrecks included), or null. */
export function spottedEnemyVehicleAt(state: BattleState, playerSide: Side, world: Vec2): Vehicle | null {
  let best: Vehicle | null = null;
  let bd = Infinity;
  for (const vid of state.spottedVehicles[playerSide]) {
    const v = state.vehicles.get(vid);
    if (!v || v.side === playerSide) continue;
    const def = VEHICLE_DEFS[v.defId];
    const half = def ? def.lengthM / TILE_M / 2 : 1;
    const d = dist(v.pos, world);
    if (d <= half + ATTACK_PICK_VEHICLE_PAD_TILES && d < bd) { bd = d; best = v; }
  }
  return best;
}

const DEAD_STATES: readonly string[] = ['knockedOut', 'burning', 'abandoned'];

/** The enemy team under the pointer if it can be made the target of a Fire order right now: it is
 * spotted, and at least one of the selected teams has a line of fire to one of its visible members
 * that is not blocked (mortars fire over obstacles and only need the target spotted). A spotted
 * enemy vehicle is always offered — with `lof` false when nobody can shoot it from here (a tank
 * given the order drives to a firing spot) — and a spotted wreck is reported as `dead`. */
export function targetableEnemyAt(state: BattleState, playerSide: Side, selected: Team[], world: Vec2): TargetHover | null {
  const enemy = spottedEnemyTeamAt(state, world, otherSide(playerSide));
  if (!enemy) {
    const wreck = spottedEnemyVehicleAt(state, playerSide, world);
    if (!wreck || !DEAD_STATES.includes(wreck.state)) return null;
    const team = state.teams.get(wreck.teamId);
    return team ? { team, cls: 'blocked', lof: false, dead: wreck.state as DeadVehicleState } : null;
  }
  const pts = spottedMemberPoints(state, playerSide, enemy);
  if (pts.length === 0) return null;
  const vehicle = enemy.vehicleId != null ? state.vehicles.get(enemy.vehicleId) : undefined;
  let best: AimClass = 'blocked';
  let penChance = 0;
  let looked = false;
  for (const t of selected) {
    if (t.outOfAction) continue;
    const obs = teamObserver(state, t);
    if (!obs) continue;
    looked = true;
    // how good a hit would be from this team's position and angle, line of fire or not
    if (vehicle) penChance = Math.max(penChance, teamPenetrationChance(state, t, obs.from, vehicle));
    let cls: AimClass = 'blocked';
    if (teamFiresIndirect(state, t)) cls = 'clear';
    else for (const p of pts) {
      const c = aimPointClass(aimLineProfile(state.map, obs.from, p, { eyeM: obs.eyeM }));
      if (c === 'clear') { cls = c; break; }
      if (c === 'obscured') cls = c;
    }
    if (cls === 'blocked') continue;
    if (cls === 'clear' || best === 'blocked') best = cls;
  }
  if (vehicle) return looked ? { team: enemy, cls: best, penChance, pen: penRating(penChance), lof: best !== 'blocked' } : null;
  if (best === 'blocked') return null;
  return { team: enemy, cls: best, lof: true };
}

/** Which aiming cross the pointer shows over a Fire target: grey for a wreck; against armour
 * black / yellow / green by the penetration chance from here, drawn broken when there is no line
 * of fire; red for men and soft targets. */
export function targetCursorKind(h: TargetHover): CursorKind {
  if (h.dead) return 'targetDead';
  if (!h.pen) return 'target';
  const base = h.pen === 'likely' ? 'targetLikely' : h.pen === 'maybe' ? 'targetMaybe' : 'targetNone';
  return h.lof ? base : `${base}Blocked`;
}

/** Short status word shown by the pointer with the cross: the wreck's state, or that the selected
 * teams cannot fire on it from where they are. Null when the cross says it all. */
export function targetStatusText(h: TargetHover): string | null {
  if (h.dead) return h.dead === 'knockedOut' ? 'KO' : h.dead;
  if (!h.lof) return 'no line of fire';
  return null;
}

function bracket(ctx: CanvasRenderingContext2D, cx: number, cy: number, hw: number, hh: number, arm: number): void {
  ctx.beginPath();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = cx + sx * hw, y = cy + sy * hh;
    ctx.moveTo(x - sx * arm, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * arm);
  }
  ctx.stroke();
}

/** Pulsing corner brackets on every visible member of the hovered target team: red on men, black /
 * yellow / green on armour (dashed when there is no line of fire from here), steady grey on a wreck. */
export function drawTargetHighlight(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, hover: TargetHover, timeS: number): void {
  const pxPerM = (TILE_PX * cam.zoom) / TILE_M;
  const pulse = hover.dead ? 0 : 0.5 + 0.5 * Math.sin(timeS * 7);
  const grow = 1 + 0.12 * pulse;
  ctx.save();
  ctx.lineJoin = 'miter';
  const none = hover.pen === 'none' && !hover.dead;
  const stroke = (draw: () => void): void => {
    // Same colour language as the cursor: red for men, black / yellow / green against armour.
    if (!hover.lof && !hover.dead) ctx.setLineDash([4, 3]);
    ctx.strokeStyle = none ? 'rgba(235,235,225,0.9)' : 'rgba(0,0,0,0.75)'; ctx.lineWidth = none ? 4 : 3.5; draw();
    const k = 0.75 + 0.25 * pulse;
    const rgb = hover.dead ? [150, 150, 144] : hover.pen === 'likely' ? [60, 230, 80] : hover.pen === 'maybe' ? [255, 212, 40] : none ? [16, 16, 16] : [255, 70, 40];
    ctx.strokeStyle = none ? 'rgb(16,16,16)' : `rgb(${rgb[0] * k | 0},${rgb[1] * k | 0},${rgb[2] * k | 0})`;
    ctx.lineWidth = none ? 2.4 : 1.5; draw();
    ctx.setLineDash([]);
  };
  const team = hover.team;
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    if (v) {
      const def = VEHICLE_DEFS[v.defId];
      const half = ((def ? Math.max(def.lengthM, def.widthM) : 6) / 2 + 1) * pxPerM * grow;
      const p = worldToScreen(cam, v.pos);
      stroke(() => bracket(ctx, p.x, p.y, half, half, half * 0.45));
    }
  } else {
    const r = Math.max(7, 1.1 * pxPerM) * grow;
    for (const pt of spottedMemberPoints(state, playerSide, team)) {
      const p = worldToScreen(cam, pt);
      stroke(() => bracket(ctx, p.x, p.y, r, r, r * 0.55));
    }
  }
  ctx.restore();
}
