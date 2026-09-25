import { describe, it, expect } from 'vitest';
import { TEAM_DEFS, VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { SPEC, HEIGHT_M } from '@/render/vehicleArt';
import { DIMENSIONS } from '@/render/sprites';

describe('vehicle catalog completeness', () => {
  it('every vehicleDefId referenced by a team exists in VEHICLE_DEFS, SPEC, HEIGHT_M and DIMENSIONS', () => {
    for (const team of Object.values(TEAM_DEFS)) {
      if (!team.vehicleDefId) continue;
      const id = team.vehicleDefId;
      expect(VEHICLE_DEFS[id], `team ${team.id}: vehicle ${id}`).toBeDefined();
      expect(SPEC[id], `vehicle ${id}: art spec`).toBeDefined();
      expect(HEIGHT_M[id], `vehicle ${id}: HEIGHT_M`).toBeDefined();
      expect(DIMENSIONS[id], `vehicle ${id}: DIMENSIONS fallback`).toBeDefined();
    }
  });

  it('every weaponId referenced anywhere exists in WEAPONS', () => {
    for (const team of Object.values(TEAM_DEFS)) {
      for (const s of team.soldiers) expect(WEAPONS[s.weaponId], `${team.id}: ${s.weaponId}`).toBeDefined();
    }
    for (const v of Object.values(VEHICLE_DEFS)) {
      for (const w of [v.mainWeaponId, v.coaxWeaponId, v.bowWeaponId]) {
        if (w) expect(WEAPONS[w], `${v.id}: ${w}`).toBeDefined();
      }
    }
  });

  it('the requested catalog pieces are present', () => {
    for (const id of ['tiger2', 'is3', 'su152', 'is1', 'pantherD', 'pantherA', 'stug4', 'su100', 'su122', 'pz4g', 'hetzer', 't28', 'ot34', 'flammpanzer3', 'sherman76', 'bm13', 'sdkfz251_rocket', 'kettenkrad', 'kubelwagen']) {
      expect(VEHICLE_DEFS[id], id).toBeDefined();
    }
    for (const wid of ['kwk43_88', 'd5t_85', 'ml20_152', 'd10_100', 'm30_122', 'kt28_76', 'stuk39_75', 'kwk40_l43', 'nebel41', 'bm13', 'flamewerfer', 'mortar120', 'dshk_hmg', 'm2_hmg', 'bren_lmg', 'thompson', 'lahti_l39']) {
      expect(WEAPONS[wid], wid).toBeDefined();
    }
    for (const tid of ['ger_tiger2', 'ger_hetzer', 'sov_is3', 'sov_su152', 'sov_katyusha', 'sov_dshk', 'sov_m2_hmg', 'sov_mortar120', 'sov_ot34', 'sov_sherman76', 'ger_nebel']) {
      expect(TEAM_DEFS[tid], tid).toBeDefined();
    }
  });
});
