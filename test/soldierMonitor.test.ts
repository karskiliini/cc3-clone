import { describe, it, expect } from 'vitest';
import type { Soldier, Team, Vehicle } from '@/shared/types';
import {
  weaponReadout, shortWeaponName, MONITOR_TEXT_CELLS, MONITOR_ROLE_WORDS, MONITOR_STATUS_WORDS,
  MONITOR_ACTIVITY_WORDS, MONITOR_ABBREV, MONITOR_DAMAGE_WORDS, MONITOR_DAMAGE_CELL,
} from '@/ui/hud/soldierMonitor';
import { fitHudText, setHudFont } from '@/ui/hud/hudChrome';
import { VEHICLE_DEFS } from '@/data/units';

// Helvetica/Arial advance widths (1/1000 em) — enough to approximate canvas measureText in node.
const REG: Record<string, number> = {
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};
const BOLD: Record<string, number> = {
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889,
  n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
};
const CAPS: Record<string, number> = {
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
};
function fakeCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '11px Arial', textBaseline: 'top',
    measureText(t: string) {
      const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)![1]);
      const tbl = ctx.font.includes('bold') ? BOLD : REG;
      let w = 0;
      for (const ch of t) w += tbl[ch] ?? CAPS[ch] ?? 278;
      return { width: (w / 1000) * px };
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function soldier(weaponId: string, o: Partial<Soldier> = {}): Soldier {
  return { weaponId, ammo: 7, targetSoldierId: null, targetVehicleId: null, targetPoint: null, ...o } as Soldier;
}
const team = (orderType?: string): Team => ({ order: orderType ? { type: orderType } : null } as unknown as Team);
function tank(o: Partial<Vehicle> = {}): Vehicle {
  return { mainAmmo: 42, coaxAmmo: 250, targetVehicleId: null, targetSoldierId: null, targetPoint: null, ...o } as Vehicle;
}

describe('soldier monitor weapon readout', () => {
  it('riflemen and MG men show the short weapon name, not an ammo type', () => {
    expect(weaponReadout(soldier('kar98k'), team(), undefined, 'Soldat').label).toBe('Kar98k');
    expect(weaponReadout(soldier('mp40'), team(), undefined, 'Leader').label).toBe('MP40');
    expect(weaponReadout(soldier('mg34_hmg'), team(), undefined, 'Gunner').label).toBe('MG34');
    expect(weaponReadout(soldier('ppsh41'), team(), undefined, 'Soldat').label).toBe('PPSh');
    expect(shortWeaponName('kar98k_scoped')).toBe('Kar98k');
  });
  it('mortar shows HE, or Smk under a smoke order', () => {
    expect(weaponReadout(soldier('mortar81'), team('defend'), undefined, 'Gunner').label).toBe('HE');
    expect(weaponReadout(soldier('mortar81'), team('smoke'), undefined, 'Gunner').label).toBe('Smk');
  });
  // Ammunition types (req_ammo_damage A5): the monitor shows the round actually LOADED and the
  // rounds of that type left; the old guess from the target is gone.
  it('AT gun shows the round in the breech and the rounds of that type left', () => {
    const gunTeam = (type: 'ap' | 'apcr' | 'he' | undefined): Team => ({
      order: null, crewWeapon: { gunnerId: 1, chambered: !!type, chamberedType: type },
    } as unknown as Team);
    const g = soldier('pak38', { id: 1, ammo: 5, ammoReserve: 0, targetSoldierId: 9, rounds: { ap: 2, apcr: 1, he: 2, smoke: 0 } });
    expect(weaponReadout(g, gunTeam('apcr'), undefined, 'Gunner')).toEqual({ glyph: 'atgun', label: 'APCR', rounds: 1 });
    expect(weaponReadout(g, gunTeam('ap'), undefined, 'Gunner').label).toBe('AP'); // not "HE" because he points at infantry
    expect(weaponReadout(g, gunTeam(undefined), undefined, 'Gunner')).toEqual({ glyph: 'atgun', label: '', rounds: 5 });
  });
  it('vehicle crew: gunner loaded round + rounds of that type, loader rounds only, driver/commander nothing', () => {
    const armed = tank({ defId: realTankDefId(), loadedRound: 'he', rounds: { ap: 20, apcr: 2, he: 19, smoke: 0 }, mainAmmo: 41 });
    const g = weaponReadout(soldier('pistol_p38'), team(), armed, 'Gunner');
    expect(g).toEqual({ glyph: 'tankgun', label: 'HE', rounds: 19 });
    expect(weaponReadout(soldier('pistol_p38'), team(), { ...armed, loadedRound: 'apcr' }, 'Gunner')).toEqual({ glyph: 'tankgun', label: 'APCR', rounds: 2 });
    expect(weaponReadout(soldier('pistol_p38'), team(), { ...armed, loadedRound: undefined }, 'Gunner')).toEqual({ glyph: 'tankgun', label: '', rounds: 41 });
    expect(weaponReadout(soldier('pistol_p38'), team(), armed, 'Loader')).toEqual({ glyph: null, label: '', rounds: 41 });
    for (const r of ['Driver', 'Commander']) {
      expect(weaponReadout(soldier('pistol_p38'), team(), armed, r)).toEqual({ glyph: null, label: '', rounds: null });
    }
  });
});

function realTankDefId(): string {
  return Object.values(VEHICLE_DEFS).find((d) => d.kind === 'tank' && d.mainWeaponId)!.id;
}

describe('soldier monitor text fitting', () => {
  function fits(words: string[], cell: { maxW: number; font: 'map' | 'small' }) {
    const ctx = fakeCtx();
    for (const word of words) {
      setHudFont(ctx, cell.font);
      const fit = fitHudText(ctx, [word, ...(MONITOR_ABBREV[word] ?? [])], cell.maxW);
      ctx.font = fit.font;
      expect(ctx.measureText(fit.text).width, `${word} -> ${fit.text}`).toBeLessThanOrEqual(cell.maxW);
      // never a mid-word cut: result is the word itself or one of its listed abbreviations
      expect([word, ...(MONITOR_ABBREV[word] ?? [])]).toContain(fit.text);
    }
  }
  it('every role word fits the role cell', () => fits(MONITOR_ROLE_WORDS, MONITOR_TEXT_CELLS.role));
  it('every status word fits the status cell', () => fits(MONITOR_STATUS_WORDS, MONITOR_TEXT_CELLS.status));
  it('every activity word fits the activity cell', () => fits(MONITOR_ACTIVITY_WORDS, MONITOR_TEXT_CELLS.activity));
  it('every damaged-system word fits its half of the vehicle header', () => fits(MONITOR_DAMAGE_WORDS, MONITOR_DAMAGE_CELL));
  it('Commander shrinks or abbreviates rather than truncating', () => {
    const ctx = fakeCtx();
    setHudFont(ctx, 'map');
    const fit = fitHudText(ctx, ['Commander', 'Cmdr.'], MONITOR_TEXT_CELLS.role.maxW);
    expect(['Commander', 'Cmdr.']).toContain(fit.text);
    expect(ctx.font).toBe('bold 13px Arial, Helvetica, sans-serif');
  });
});
