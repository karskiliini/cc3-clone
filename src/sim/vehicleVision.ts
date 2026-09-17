// ============================================================================
// vehicleVision.ts — where a tank crew's eyes actually are.
//
// A vehicle does not see from one point at its centre: its eyes are its living, conscious crew at
// their seats. Turret crew (commander, gunner, loader) look from the turret ring, which rotates
// with the hull; hull crew (driver, radio operator / bow gunner) look from the bow, through a
// narrow arc along the HULL facing. Casemate SPGs (no turret) have their commander and gunner look
// from the fighting compartment along the hull facing instead. Open-topped vehicles (and halftrack
// passengers riding along beyond the crew seats) see all round, heads out, but nothing here models
// their extra exposure — that belongs to the damage model, not vision.
//
// Dead, incapacitated or bailed-out crew contribute no eye; a man who has moved seats (see
// vehicleDamage.ts's `stepCrewSeats`) is read from his *current* seat via `seatOccupant`, which
// also already returns null while he is still walking over — exactly right, since a crewman
// mid-move isn't looking out of anywhere in particular.
//
// The vehicle's spotting result is the BEST of its eyes per target (spotting.ts folds every eye in
// as its own Spotter), never their sum: a buttoned-up tank can be tracking a target dead ahead
// through the gunner's sight while being stone blind to a man 40 m off its flank.
// ============================================================================
import type { BattleState, CrewRole, Soldier, Vec2, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { ensureSeats, seatOccupant, vehicleLayout } from './vehicleDamage';

const DEG = Math.PI / 180;
const FULL = Math.PI * 2;

/** One eye on the battlefield belonging to a living crewman: his own position, height, facing
 * arc, range and spotting factor. Fed into spotting.ts as its own Spotter. */
export interface VehicleEye {
  pos: Vec2;
  eyeM: number;
  /** radians, 0 = north, clockwise — the direction this eye looks along the centre of its arc */
  facing: number;
  /** total width of the field of view, radians (2*PI = all round) */
  arcRad: number;
  rangeM: number;
  /** spotting factor multiplier, folded in alongside the mind bonus other spotters get */
  factor: number;
  role: CrewRole;
  soldierId: number;
}

// ---- turret crew ---------------------------------------------------------
const TURRET_EYE_M: Record<'commander' | 'gunner' | 'loader', number> = { commander: 2.4, gunner: 2.3, loader: 2.2 };
export const COMMANDER_UNBUTTON_BONUS_M = 0.3;
export const COMMANDER_BUTTONED_FACTOR = 0.35;
export const COMMANDER_UNBUTTONED_FACTOR = 1.1;
export const COMMANDER_BUTTONED_RANGE_M = 150;
export const COMMANDER_UNBUTTONED_RANGE_M = 300;
/** Gunner's sight cone: narrow, but magnified — better spotting at range within it. */
export const GUNNER_ARC_RAD = 24 * DEG; // ~= 12 deg either side of the turret facing
export const GUNNER_FACTOR = 1.4;
export const GUNNER_RANGE_M = 400;
/** Loader: a small periscope, nearly blind. */
export const LOADER_ARC_RAD = 40 * DEG;
export const LOADER_FACTOR = 0.3;
export const LOADER_RANGE_M = 100;
/** Turret ring: hull-local pivot, a touch forward of the hull centre, rotated with the hull. */
const TURRET_FWD_FRAC = 0.05;

// ---- hull crew ------------------------------------------------------------
export const DRIVER_EYE_M = 1.5;
export const DRIVER_ARC_RAD = 70 * DEG; // +-35 deg
export const DRIVER_FACTOR = 0.8;
export const DRIVER_RANGE_M = 150;
export const BOWGUN_EYE_M = 1.4;
export const BOWGUN_ARC_RAD = 50 * DEG; // +-25 deg
export const BOWGUN_FACTOR = 0.6;
export const BOWGUN_RANGE_M = 120;
/** Hull crew sit ~35-40% of the hull length forward of centre. */
const HULL_FWD_FRAC = 0.375;

// ---- casemate SPGs (no turret): commander/gunner look from the fighting compartment ----
const CASEMATE_FWD_FRAC = 0.15;
export const CASEMATE_COMMANDER_EYE_M = 2.1;
export const CASEMATE_GUNNER_EYE_M = 2.0;
export const CASEMATE_GUNNER_ARC_RAD = 20 * DEG;
export const CASEMATE_GUNNER_FACTOR = 1.3;
export const CASEMATE_GUNNER_RANGE_M = 400;

/** Open-topped crew (and halftrack passengers): heads out, unobstructed all round. */
export const OPEN_TOP_FACTOR = 1.0;
const PASSENGER_EYE_M = 1.6;
const PASSENGER_RANGE_M = 300;

/** How long after a buttoned-up commander last took incoming fire he stays buttoned, and the
 * suppression level that keeps him down regardless — deterministic, no dice. */
export const BUTTON_UP_SUPPRESSION = 25;
export const BUTTON_UP_RECENT_FIRE_S = 20;

/** True when this commander has his hatch shut: recent incoming fire, or enough suppression that
 * he is keeping his head down. Purely a function of existing state (mind.lastIncomingAt,
 * suppression) — same inputs every time, so it stays deterministic across repeated calls. */
export function isButtonedUp(state: BattleState, commander: Soldier): boolean {
  if (commander.suppression >= BUTTON_UP_SUPPRESSION) return true;
  return state.time - commander.mind.lastIncomingAt < BUTTON_UP_RECENT_FIRE_S;
}

function forwardVec(facing: number): Vec2 { return { x: Math.sin(facing), y: -Math.cos(facing) }; }
function rightVec(facing: number): Vec2 { return { x: Math.cos(facing), y: Math.sin(facing) }; }

/** `base` offset by `fwdM` metres along `facing` (and optionally `rightM` metres to its right),
 * converted to tile coordinates. */
function offsetPos(base: Vec2, facing: number, fwdM: number, rightM = 0): Vec2 {
  const f = forwardVec(facing), r = rightVec(facing);
  return {
    x: base.x + (f.x * fwdM + r.x * rightM) / TILE_M,
    y: base.y + (f.y * fwdM + r.y * rightM) / TILE_M,
  };
}

/**
 * Every living crewman's eye on this vehicle: turret crew from the turret ring (rotating with the
 * hull), hull crew from the bow, casemate crew from the fighting compartment — each with its own
 * position, height, facing arc, range and spotting factor. Dead/incapacitated/bailed crew and empty
 * seats contribute nothing; a knocked-out or unrecognised vehicle def returns []. At most ~5 eyes
 * (one per living crewman) for any vehicle in the game's roster.
 */
export function vehicleEyes(state: BattleState, v: Vehicle): VehicleEye[] {
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return [];
  const lay = vehicleLayout(def);
  const eyes: VehicleEye[] = [];
  const seats = ensureSeats(state, v);

  const add = (role: CrewRole, s: Soldier, opts: Omit<VehicleEye, 'role' | 'soldierId'>): void => {
    eyes.push({ ...opts, role, soldierId: s.id });
  };

  if (def.hasTurret) {
    const turretPos = offsetPos(v.pos, v.hullFacing, TURRET_FWD_FRAC * def.lengthM);
    const commander = seatOccupant(state, v, 'commander');
    if (commander) {
      const buttoned = !lay.openTop && isButtonedUp(state, commander);
      add('commander', commander, {
        pos: turretPos, eyeM: TURRET_EYE_M.commander + (buttoned ? 0 : COMMANDER_UNBUTTON_BONUS_M),
        facing: v.turretFacing, arcRad: FULL,
        rangeM: buttoned ? COMMANDER_BUTTONED_RANGE_M : COMMANDER_UNBUTTONED_RANGE_M,
        factor: lay.openTop ? OPEN_TOP_FACTOR : buttoned ? COMMANDER_BUTTONED_FACTOR : COMMANDER_UNBUTTONED_FACTOR,
      });
    }
    const gunner = seatOccupant(state, v, 'gunner');
    if (gunner) {
      add('gunner', gunner, {
        pos: turretPos, eyeM: TURRET_EYE_M.gunner, facing: v.turretFacing,
        arcRad: lay.openTop ? FULL : GUNNER_ARC_RAD, rangeM: GUNNER_RANGE_M,
        factor: lay.openTop ? OPEN_TOP_FACTOR : GUNNER_FACTOR,
      });
    }
    const loader = seatOccupant(state, v, 'loader');
    if (loader) {
      add('loader', loader, {
        pos: turretPos, eyeM: TURRET_EYE_M.loader, facing: v.turretFacing,
        arcRad: lay.openTop ? FULL : LOADER_ARC_RAD, rangeM: LOADER_RANGE_M,
        factor: lay.openTop ? OPEN_TOP_FACTOR : LOADER_FACTOR,
      });
    }
  } else {
    const compPos = offsetPos(v.pos, v.hullFacing, CASEMATE_FWD_FRAC * def.lengthM);
    const commander = seatOccupant(state, v, 'commander');
    if (commander) {
      const buttoned = !lay.openTop && isButtonedUp(state, commander);
      add('commander', commander, {
        pos: compPos, eyeM: CASEMATE_COMMANDER_EYE_M + (buttoned ? 0 : COMMANDER_UNBUTTON_BONUS_M),
        facing: v.hullFacing, arcRad: FULL,
        rangeM: buttoned ? COMMANDER_BUTTONED_RANGE_M : COMMANDER_UNBUTTONED_RANGE_M,
        factor: lay.openTop ? OPEN_TOP_FACTOR : buttoned ? COMMANDER_BUTTONED_FACTOR : COMMANDER_UNBUTTONED_FACTOR,
      });
    }
    const gunner = seatOccupant(state, v, 'gunner');
    if (gunner) {
      add('gunner', gunner, {
        pos: compPos, eyeM: CASEMATE_GUNNER_EYE_M, facing: v.hullFacing,
        arcRad: lay.openTop ? FULL : CASEMATE_GUNNER_ARC_RAD, rangeM: CASEMATE_GUNNER_RANGE_M,
        factor: lay.openTop ? OPEN_TOP_FACTOR : CASEMATE_GUNNER_FACTOR,
      });
    }
  }

  // ---- hull crew: driver, radio operator / bow gunner ----
  const hullPos = offsetPos(v.pos, v.hullFacing, HULL_FWD_FRAC * def.lengthM);
  const driver = seatOccupant(state, v, 'driver');
  if (driver) {
    add('driver', driver, {
      pos: hullPos, eyeM: DRIVER_EYE_M, facing: v.hullFacing,
      arcRad: lay.openTop ? FULL : DRIVER_ARC_RAD, rangeM: DRIVER_RANGE_M,
      factor: lay.openTop ? OPEN_TOP_FACTOR : DRIVER_FACTOR,
    });
  }
  const radioOp = seatOccupant(state, v, 'radioOp');
  if (radioOp) {
    add('radioOp', radioOp, {
      pos: hullPos, eyeM: BOWGUN_EYE_M, facing: v.hullFacing,
      arcRad: lay.openTop ? FULL : BOWGUN_ARC_RAD, rangeM: BOWGUN_RANGE_M,
      factor: lay.openTop ? OPEN_TOP_FACTOR : BOWGUN_FACTOR,
    });
  }

  // ---- passengers riding along beyond the crew seats (halftracks): heads out, all round ----
  const team = state.teams.get(v.teamId);
  if (team) {
    const seated = new Set(Object.values(seats).filter((id): id is number => id != null));
    for (const id of team.soldierIds) {
      if (seated.has(id)) continue;
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId !== v.id) continue;
      add('radioOp', s, {
        pos: { ...v.pos }, eyeM: PASSENGER_EYE_M, facing: v.hullFacing, arcRad: FULL,
        rangeM: PASSENGER_RANGE_M, factor: OPEN_TOP_FACTOR,
      });
    }
  }

  return eyes;
}
