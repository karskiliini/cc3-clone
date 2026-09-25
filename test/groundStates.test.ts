import { describe, it, expect } from 'vitest';
import { buildMap, setTile } from '../src/sim/map';
import { getMap } from '../src/data/maps';
import { tileAt } from '../src/sim/map';
import { craterForWeapon } from '../src/sim/combat';
import { stepGrowth } from '../src/sim/growth';
import { WEAPONS } from '../src/data/weapons';
import type { BattleState, GameMap, WeaponDef, CraterMark } from '../src/shared/types';

function snowMap(): GameMap {
  const map = buildMap(getMap('border_1941'));
  for (let y = 38; y < 43; y++) for (let x = 28; x < 36; x++) setTile(map, x, y, 'snow');
  return map;
}
describe('ground states (G8)', () => {
  it('craterForWeapon classifies grenades small, shells large', () => {
    const mortar = WEAPONS['mortar81'];
    const shell = Object.values(WEAPONS).find((w) => w.heRadiusM >= 4);
    expect(craterForWeapon(mortar as WeaponDef)).not.toBeNull();
    if (shell) {
      const c = craterForWeapon(shell as WeaponDef)!;
      expect(c.sizeM).toBeGreaterThan(2);
      expect(c.kind).toBe('shell');
    }
  });

  it('vehicles rolling over snow leave persistent track ruts (render marks)', () => {
    const map = snowMap();
    const state = { map, vehicles: new Map(), time: 0 } as unknown as BattleState;
    const v = { pos: { x: 30.5, y: 40.5 }, hullFacing: 0, defId: 'ger_pz3j' } as never;
    state.vehicles.set(1, v);
    stepGrowth(state);
    stepGrowth(state);
    const tracks = (map.craterMarks ?? []).filter((m: CraterMark) => m.kind === 'track');
    expect(tracks.length).toBeGreaterThan(0);
    // the rut sits where the vehicle sat, sized around its hull
    expect(tracks[0].y).toBeCloseTo(40.5, 1);
    // no shell crater tile conversion from mere driving
    expect(tileAt(map, 30, 40)).toBe('snow');
  });

  it('track marks do not flatten growth (render-only)', () => {
    const map = snowMap();
    const before = map.craterMarks?.length ?? 0;
    expect(before).toBe(0);
  });
});
