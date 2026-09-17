import type { BattleState, Camera, Side, Team, Vec2 } from '@/shared/types';
import { TILE_M, TILE_PX, otherSide } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { worldToScreen } from '@/engine/camera';
import { eyeHeightM, EYE_VEHICLE_M } from '@/sim/los';
import { aimLineProfile, aimPointClass, type AimClass } from '@/sim/losProfile';
import { spottedEnemyTeamAt } from '@/sim/orders';
import { penRating, teamPenetrationChance, type PenRating } from '@/sim/penChance';

/** Where a team looks from when it aims: its leader (or first living man) at his eye height, or
 * the vehicle at commander height. Null when nobody is left to look. */
export function teamObserver(state: BattleState, t: Team): { from: Vec2; eyeM: number } | null {
  if (t.vehicleId != null) {
    const veh = state.vehicles.get(t.vehicleId);
    return { from: veh ? veh.pos : t.pos, eyeM: EYE_VEHICLE_M };
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

export interface TargetHover {
  team: Team;
  cls: AimClass;
  /** Armoured target only: best penetration chance among the selected teams that have a line of
   * fire, against the armour face each of them sees, and its rating for the cursor colour. */
  penChance?: number;
  pen?: PenRating;
}

/** The enemy team under the pointer if it can be made the target of a Fire order right now: it is
 * spotted, and at least one of the selected teams has a line of fire to one of its visible members
 * that is not blocked (mortars fire over obstacles and only need the target spotted). */
export function targetableEnemyAt(state: BattleState, playerSide: Side, selected: Team[], world: Vec2): TargetHover | null {
  const enemy = spottedEnemyTeamAt(state, world, otherSide(playerSide));
  if (!enemy) return null;
  const pts = spottedMemberPoints(state, playerSide, enemy);
  if (pts.length === 0) return null;
  const vehicle = enemy.vehicleId != null ? state.vehicles.get(enemy.vehicleId) : undefined;
  let best: AimClass = 'blocked';
  let penChance = 0;
  for (const t of selected) {
    if (t.outOfAction) continue;
    const obs = teamObserver(state, t);
    if (!obs) continue;
    let cls: AimClass = 'blocked';
    if (teamFiresIndirect(state, t)) cls = 'clear';
    else for (const p of pts) {
      const c = aimPointClass(aimLineProfile(state.map, obs.from, p, { eyeM: obs.eyeM }));
      if (c === 'clear') { cls = c; break; }
      if (c === 'obscured') cls = c;
    }
    if (cls === 'blocked') continue;
    if (cls === 'clear' || best === 'blocked') best = cls;
    if (vehicle) penChance = Math.max(penChance, teamPenetrationChance(state, t, obs.from, vehicle));
  }
  if (best === 'blocked') return null;
  return vehicle ? { team: enemy, cls: best, penChance, pen: penRating(penChance) } : { team: enemy, cls: best };
}

function bracket(ctx: CanvasRenderingContext2D, cx: number, cy: number, hw: number, hh: number, arm: number): void {
  ctx.beginPath();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = cx + sx * hw, y = cy + sy * hh;
    ctx.moveTo(x - sx * arm, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * arm);
  }
  ctx.stroke();
}

/** Pulsing red corner brackets on every visible member of the hovered target team. */
export function drawTargetHighlight(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, hover: TargetHover, timeS: number): void {
  const pxPerM = (TILE_PX * cam.zoom) / TILE_M;
  const pulse = 0.5 + 0.5 * Math.sin(timeS * 7);
  const grow = 1 + 0.12 * pulse;
  ctx.save();
  ctx.lineJoin = 'miter';
  const none = hover.pen === 'none';
  const stroke = (draw: () => void): void => {
    // Same colour language as the cursor: red for men, black / yellow / green against armour.
    ctx.strokeStyle = none ? 'rgba(235,235,225,0.9)' : 'rgba(0,0,0,0.75)'; ctx.lineWidth = none ? 4 : 3.5; draw();
    const k = 0.75 + 0.25 * pulse;
    const rgb = hover.pen === 'likely' ? [60, 230, 80] : hover.pen === 'maybe' ? [255, 212, 40] : none ? [16, 16, 16] : [255, 70, 40];
    ctx.strokeStyle = none ? 'rgb(16,16,16)' : `rgb(${rgb[0] * k | 0},${rgb[1] * k | 0},${rgb[2] * k | 0})`;
    ctx.lineWidth = none ? 2.4 : 1.5; draw();
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
