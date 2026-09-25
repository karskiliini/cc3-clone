import { describe, it, expect } from 'vitest';
import type { BattleState, Vehicle, Team } from '@/shared/types';
import { driveReversingProbe, stepTrackDriveProbe } from '@/sim/vehicle';

function rig(): { state: BattleState; v: Vehicle; team: Team } {
  const v: Vehicle = {
    id: 1, teamId: 1, side: 'german', defId: 'pz4gh', pos: { x: 12, y: 12 }, hullFacing: 0, turretFacing: 0,
    state: 'ok', mainAmmo: 20, coaxAmmo: 100, bowAmmo: 100, path: [], speed: 0,
  } as unknown as Vehicle;
  const team = { id: 1, side: 'german', name: 'Zug', soldierIds: [1], leaderId: 1 } as unknown as Team;
  const state: BattleState = {
    time: 10, config: { playerSide: 'german' }, teams: new Map([[1, team]]),
    map: { def: { vectors: [], labels: [] }, width: 48, height: 48, tiles: new Array(48 * 48).fill('open'), buildingId: new Int16Array(48 * 48).fill(-1), windows: new Uint8Array(48 * 48), smoke: new Float32Array(48 * 48), craters: [], ground: new Float32Array(48 * 48) },
    vehicles: new Map([[1, v]]), soldiers: new Map(), sides: { german: { kills: 0, losses: 0 }, soviet: { kills: 0, losses: 0 } },
    events: [], messages: [],
  } as unknown as BattleState;
  return { state, v, team };
}

describe('track-only tank kinematics (item 022)', () => {
  it('reversing moves along the rear axis, never straight at the destination', () => {
    const { state, v } = rig();
    // hull facing north (0); threat to the north; dest EAST (sideways) — an old straight-to-dest
    // drive would slide east; the tracks can only carry it SOUTH (rear axis)
    v.hullFacing = 0;
    driveReversingProbe(state, v, 2 /* m/s */, { x: 12, y: 8 }, { x: 20, y: 12 }, 0.5);
    expect(v.pos.x).toBeCloseTo(12, 5); // no lateral motion
    expect(v.pos.y).toBeGreaterThan(12); // it backed straight south
  });

  it('reversing with the hull aligned to dest moves straight toward it', () => {
    const { state, v } = rig();
    // threat and dest both north: hull already faces the threat, rear axis points at dest
    v.hullFacing = 0;
    driveReversingProbe(state, v, 2, { x: 12, y: 8 }, { x: 12, y: 16 }, 0.5);
    expect(v.pos.y).toBeGreaterThan(12); // backed straight down the rear axis
    expect(v.pos.x).toBeCloseTo(12, 5);
  });

  it('a waypoint far off-axis is approached by an arc, not a sideways cut', () => {
    const { state, v } = rig();
    v.hullFacing = 0; // facing north
    v.path = [{ x: 16, y: 8 }]; // ~27° off-axis, beyond TRACK_STRAIGHT_RAD (4°)
    const before = { ...v.pos };
    stepTrackDriveProbe(state, v, 2, 0.5);
    const moved = { x: v.pos.x - before.x, y: v.pos.y - before.y };
    const moveDir = Math.atan2(moved.x, -moved.y); // 0 = north
    // the old straight-to-waypoint code would move at ~27°; tracks move along the hull's
    // (barely rotated) axis — well under half the waypoint offset
    expect(Math.abs(moveDir)).toBeLessThan(0.24); // < 14°
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(0);
  });
});
