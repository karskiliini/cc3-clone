import { beforeEach, describe, expect, it } from 'vitest';
import { crewSoldierDraws, drawCrewWeapons } from '@/render/unitRender';
import { freeAllAtlases, registerAtlas, type AtlasMeta } from '@/render/spriteAtlas';
import { worldToScreen } from '@/engine/camera';
import type { Camera } from '@/shared/types';
import { addGun, makeState } from './vehicleDamageHelpers';

function scene(id = 'mg34_hmg') {
  const state = makeState();
  const { team, men, gunner } = addGun(state, id, { x: 12, y: 12 }, 3);
  const cw = team.crewWeapon!;
  cw.phase = 'packed'; cw.goal = 'pack'; cw.done = [];
  cw.mount = { state: 'carried', carrierId: men[2].id, pos: { ...men[2].pos } };
  for (const s of men) { s.path = [{ x: 30, y: 12 }]; s.activity = 'moving'; }
  return { state, team, men, gunner, cw };
}

describe('separate MG mount crew pictures', () => {
  it.each(['mg34_hmg', 'mg42_hmg', 'maxim'])('puts the %s tripod on its actual carrier, including at a standstill', (id) => {
    const { state, men, gunner } = scene(id);
    men[2].path = []; // the leader is the selected carrier, not the first sorted assistant
    const poses = crewSoldierDraws(state);
    expect(poses.get(gunner.id)?.pose).toBe('carryMg');
    expect(poses.get(men[2].id)?.pose).toBe('carryTripod');
    expect(poses.get(men[2].id)?.pos).toEqual(men[2].pos);
    expect(poses.has(men[1].id)).toBe(false);
  });

  it('keeps a mount placement task visible instead of replacing it with a carrying pose', () => {
    const { state, cw, men } = scene();
    cw.phase = 'settingUp'; cw.goal = 'deploy';
    men[2].path = []; men[2].crewTask = { id: 'placeTripod', progress: 0.4, walking: false };
    const carrier = crewSoldierDraws(state).get(men[2].id)!;
    expect(carrier.keys?.[0]).toBe('crew.tripod');
    expect(carrier.progress).toBe(0.4);
    expect(carrier.pose).not.toBe('carryTripod');
  });

  it('leaves the light gunner in his ordinary LMG animation and poses only the recovery worker', () => {
    const { state, cw, gunner, men } = scene();
    cw.lightMode = true; gunner.weaponId = 'mg34';
    cw.mount = { state: 'ground', carrierId: null, pos: { x: 6, y: 6 } };
    men[2].health = 'incapacitated';
    men[1].crewTask = { id: 'liftTripod', progress: 0.5, walking: false };
    const poses = crewSoldierDraws(state);
    expect(poses.has(gunner.id)).toBe(false);
    expect(poses.has(men[2].id)).toBe(false);
    expect(poses.get(men[1].id)?.keys?.[0]).toBe('crew.tripod');
    expect(poses.get(men[1].id)?.pos).toEqual(men[1].pos);
  });

  it('keeps the existing mortar carry assignments', () => {
    const { state, cw, gunner, men } = scene('mortar81'); cw.mount = undefined;
    const poses = crewSoldierDraws(state);
    expect(poses.get(gunner.id)?.pose).toBe('carryTube');
    expect(poses.get(men[1].id)?.pose).toBe('carryPlate');
  });
});

describe('separate ground mount drawing', () => {
  beforeEach(() => freeAllAtlases());
  it('draws only the left tripod at its position when the active light gun is elsewhere, even offscreen', () => {
    const { state, cw, gunner } = scene();
    cw.lightMode = true; gunner.weaponId = 'mg34'; gunner.pos = { x: 300, y: 300 }; cw.pos = { ...gunner.pos };
    cw.mount = { state: 'ground', carrierId: null, pos: { x: 8, y: 9 } };
    const meta: AtlasMeta = { scale: 1, cell: { w: 36, h: 36 }, anchor: { x: 18, y: 18 }, columns: 32, dirs: 32,
      entries: { 'mg34_hmg.tripod': { start: 0, frames: 1, fps: 0, loop: false },
        'mg34_hmg.setup': { start: 32, frames: 1, fps: 0, loop: false } } };
    registerAtlas('weapons_1', meta, {} as CanvasImageSource);
    const calls: number[][] = [];
    const ctx = { drawImage(_image: unknown, ...args: number[]) { calls.push(args); } } as unknown as CanvasRenderingContext2D;
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    state.flashes.push({ pos: { ...gunner.pos }, facing: 0, t: 0 });
    drawCrewWeapons(ctx, cam, state, 'german');
    const p = worldToScreen(cam, cw.mount.pos);
    expect(calls).toEqual([[0, 0, 36, 36, p.x - 18, p.y - 18, 36, 36]]);
    expect(state.flashes[0].pos).toEqual(gunner.pos); // portable gun effects never jump back to the mount
  });
});
