import type { WeaponDef } from '@/shared/types';

function w(d: WeaponDef): WeaponDef { return d; }

/** All weapons used by German and Soviet forces, 1941-45. Values are balanced approximations
 * of real-world performance for gameplay purposes (rate = shots/s counting bursts as one shot).
 *
 * Tuning note (balance round 3): rifle/SMG `accuracy` trimmed ~13% (×0.87) from the original
 * values. Once AI-vs-AI infantry actually closed to engagement range (see the AI bugfixes in
 * ai.ts), the harness (test/harness.test.ts) measured overall small-arms hit rate at ~8.8%,
 * above the 3-8% CC3-feel target; this cut brings it back into range without touching MG/AT/tank
 * weapons (MGs are meant to suppress far more than they kill; that ratio was already fine). */
export const WEAPONS: Record<string, WeaponDef> = {
  // ---------------------------------------------------------------- rifles
  kar98k: w({ id: 'kar98k', name: 'Kar98k', cls: 'rifle', rangeM: 400, rate: 0.4, burst: 1, accuracy: 0.304, lethality: 0.55, suppression: 0.15, penetrationMm: 0, heRadiusM: 0, ammo: 5, reloadS: 3 }),
  mosin: w({ id: 'mosin', name: 'Mosin-Nagant', cls: 'rifle', rangeM: 400, rate: 0.4, burst: 1, accuracy: 0.304, lethality: 0.55, suppression: 0.15, penetrationMm: 0, heRadiusM: 0, ammo: 5, reloadS: 3 }),
  svt40: w({ id: 'svt40', name: 'SVT-40', cls: 'rifle', rangeM: 400, rate: 0.8, burst: 1, accuracy: 0.304, lethality: 0.5, suppression: 0.15, penetrationMm: 0, heRadiusM: 0, ammo: 10, reloadS: 2.5 }),
  kar98k_scoped: w({ id: 'kar98k_scoped', name: 'Kar98k (scoped)', cls: 'rifle', rangeM: 600, rate: 0.3, burst: 1, accuracy: 0.609, lethality: 0.6, suppression: 0.1, penetrationMm: 0, heRadiusM: 0, ammo: 5, reloadS: 3.5 }),
  mosin_scoped: w({ id: 'mosin_scoped', name: 'Mosin (scoped)', cls: 'rifle', rangeM: 600, rate: 0.3, burst: 1, accuracy: 0.609, lethality: 0.6, suppression: 0.1, penetrationMm: 0, heRadiusM: 0, ammo: 5, reloadS: 3.5 }),

  // ------------------------------------------------------------------ smgs
  mp40: w({ id: 'mp40', name: 'MP40', cls: 'smg', rangeM: 150, rate: 2, burst: 3, accuracy: 0.217, lethality: 0.45, suppression: 0.2, penetrationMm: 0, heRadiusM: 0, ammo: 32, reloadS: 3 }),
  ppsh41: w({ id: 'ppsh41', name: 'PPSh-41', cls: 'smg', rangeM: 150, rate: 2.5, burst: 4, accuracy: 0.217, lethality: 0.45, suppression: 0.2, penetrationMm: 0, heRadiusM: 0, ammo: 71, reloadS: 3.5 }),

  // -------------------------------------------------------------- pistols
  pistol_p38: w({ id: 'pistol_p38', name: 'Walther P38', cls: 'pistol', rangeM: 40, rate: 1.5, burst: 1, accuracy: 0.2, lethality: 0.3, suppression: 0.05, penetrationMm: 0, heRadiusM: 0, ammo: 8, reloadS: 2 }),
  pistol_tt: w({ id: 'pistol_tt', name: 'TT-33', cls: 'pistol', rangeM: 40, rate: 1.5, burst: 1, accuracy: 0.2, lethality: 0.3, suppression: 0.05, penetrationMm: 0, heRadiusM: 0, ammo: 8, reloadS: 2 }),

  // -------------------------------------------------------------- lmg/hmg
  mg34: w({ id: 'mg34', name: 'MG34', cls: 'lmg', rangeM: 800, rate: 3, burst: 5, accuracy: 0.3, lethality: 0.5, suppression: 0.35, penetrationMm: 0, heRadiusM: 0, ammo: 50, reloadS: 4 }),
  mg42: w({ id: 'mg42', name: 'MG42', cls: 'lmg', rangeM: 800, rate: 4, burst: 7, accuracy: 0.3, lethality: 0.5, suppression: 0.35, penetrationMm: 0, heRadiusM: 0, ammo: 50, reloadS: 4 }),
  dp28: w({ id: 'dp28', name: 'DP-28', cls: 'lmg', rangeM: 800, rate: 2, burst: 4, accuracy: 0.3, lethality: 0.5, suppression: 0.35, penetrationMm: 0, heRadiusM: 0, ammo: 47, reloadS: 4 }),
  mg34_hmg: w({ id: 'mg34_hmg', name: 'MG34 (tripod)', cls: 'hmg', rangeM: 1000, rate: 3, burst: 8, accuracy: 0.35, lethality: 0.5, suppression: 0.4, penetrationMm: 0, heRadiusM: 0, ammo: 250, reloadS: 6 }),
  mg42_hmg: w({ id: 'mg42_hmg', name: 'MG42 (tripod)', cls: 'hmg', rangeM: 1000, rate: 4, burst: 9, accuracy: 0.35, lethality: 0.5, suppression: 0.42, penetrationMm: 0, heRadiusM: 0, ammo: 250, reloadS: 6 }),
  maxim: w({ id: 'maxim', name: 'Maxim M1910', cls: 'hmg', rangeM: 1000, rate: 3, burst: 8, accuracy: 0.3, lethality: 0.5, suppression: 0.4, penetrationMm: 0, heRadiusM: 0, ammo: 250, reloadS: 6 }),

  // ---------------------------------------------------------- coax weapons
  coax_mg34: w({ id: 'coax_mg34', name: 'MG34 (coax)', cls: 'coaxmg', rangeM: 800, rate: 3, burst: 5, accuracy: 0.3, lethality: 0.5, suppression: 0.35, penetrationMm: 0, heRadiusM: 0, ammo: 250, reloadS: 4 }),
  coax_dt: w({ id: 'coax_dt', name: 'DT (coax)', cls: 'coaxmg', rangeM: 800, rate: 2, burst: 4, accuracy: 0.3, lethality: 0.5, suppression: 0.35, penetrationMm: 0, heRadiusM: 0, ammo: 250, reloadS: 4 }),

  // ------------------------------------------------------------- mortars
  mortar81: w({ id: 'mortar81', name: '8cm GrW 34', cls: 'mortar', rangeM: 1000, minRangeM: 60, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0.6, suppression: 0.6, penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8, smoke: true, indirect: true }),
  mortar82: w({ id: 'mortar82', name: '82-BM-37', cls: 'mortar', rangeM: 1000, minRangeM: 60, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0.6, suppression: 0.6, penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8, smoke: true, indirect: true }),

  // ----------------------------------------------------------- at guns
  pak38: w({ id: 'pak38', name: '5cm PaK 38', cls: 'atgun', rangeM: 800, rate: 0.25, burst: 1, accuracy: 0.6, lethality: 0.7, suppression: 0.3, penetrationMm: 60, heRadiusM: 3, ammo: 20, reloadS: 4 }),
  pak40: w({ id: 'pak40', name: '7.5cm PaK 40', cls: 'atgun', rangeM: 1200, rate: 0.25, burst: 1, accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4, ammo: 20, reloadS: 4.5 }),
  zis3: w({ id: 'zis3', name: 'ZiS-3 76mm', cls: 'atgun', rangeM: 1200, rate: 0.3, burst: 1, accuracy: 0.5, lethality: 0.7, suppression: 0.35, penetrationMm: 75, heRadiusM: 5, ammo: 24, reloadS: 4 }),
  m1937_45mm: w({ id: 'm1937_45mm', name: '45mm M1937', cls: 'atgun', rangeM: 900, rate: 0.3, burst: 1, accuracy: 0.5, lethality: 0.65, suppression: 0.3, penetrationMm: 45, heRadiusM: 3, ammo: 20, reloadS: 4 }),

  // ------------------------------------------------------------ tank guns
  kwk39_50: w({ id: 'kwk39_50', name: '5cm KwK 39', cls: 'tankgun', rangeM: 900, rate: 0.35, burst: 1, accuracy: 0.5, lethality: 0.7, suppression: 0.3, penetrationMm: 70, heRadiusM: 2.5, ammo: 90, reloadS: 3 }),
  kwk37_75: w({ id: 'kwk37_75', name: '7.5cm KwK 37', cls: 'tankgun', rangeM: 700, rate: 0.3, burst: 1, accuracy: 0.45, lethality: 0.7, suppression: 0.3, penetrationMm: 45, heRadiusM: 5, ammo: 80, reloadS: 3.5 }),
  kwk40_75: w({ id: 'kwk40_75', name: '7.5cm KwK 40', cls: 'tankgun', rangeM: 1400, rate: 0.4, burst: 1, accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4, ammo: 87, reloadS: 3 }),
  stuk40: w({ id: 'stuk40', name: '7.5cm StuK 40', cls: 'tankgun', rangeM: 1400, rate: 0.4, burst: 1, accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4, ammo: 54, reloadS: 3 }),
  kwk42_75: w({ id: 'kwk42_75', name: '7.5cm KwK 42 L/70', cls: 'tankgun', rangeM: 1800, rate: 0.35, burst: 1, accuracy: 0.6, lethality: 0.8, suppression: 0.35, penetrationMm: 150, heRadiusM: 4, ammo: 79, reloadS: 3.5 }),
  kwk36_88: w({ id: 'kwk36_88', name: '8.8cm KwK 36', cls: 'tankgun', rangeM: 2000, rate: 0.3, burst: 1, accuracy: 0.6, lethality: 0.85, suppression: 0.4, penetrationMm: 130, heRadiusM: 5, ammo: 92, reloadS: 4 }),
  f34_76: w({ id: 'f34_76', name: '76mm F-34', cls: 'tankgun', rangeM: 1200, rate: 0.35, burst: 1, accuracy: 0.5, lethality: 0.75, suppression: 0.35, penetrationMm: 70, heRadiusM: 5, ammo: 77, reloadS: 3 }),
  kv_zis5: w({ id: 'kv_zis5', name: '76mm ZiS-5', cls: 'tankgun', rangeM: 1200, rate: 0.3, burst: 1, accuracy: 0.5, lethality: 0.75, suppression: 0.35, penetrationMm: 70, heRadiusM: 5, ammo: 114, reloadS: 3.5 }),
  zis_s53_85: w({ id: 'zis_s53_85', name: '85mm ZiS-S-53', cls: 'tankgun', rangeM: 1500, rate: 0.35, burst: 1, accuracy: 0.55, lethality: 0.8, suppression: 0.35, penetrationMm: 105, heRadiusM: 5, ammo: 55, reloadS: 3.5 }),
  d25t_122: w({ id: 'd25t_122', name: '122mm D-25T', cls: 'tankgun', rangeM: 1800, rate: 0.08, burst: 1, accuracy: 0.45, lethality: 0.9, suppression: 0.45, penetrationMm: 160, heRadiusM: 8, ammo: 28, reloadS: 6 }),
  '45mm_20k': w({ id: '45mm_20k', name: '45mm 20K', cls: 'tankgun', rangeM: 800, rate: 0.3, burst: 1, accuracy: 0.45, lethality: 0.6, suppression: 0.3, penetrationMm: 45, heRadiusM: 3, ammo: 90, reloadS: 3.5 }),
  zis3_su76: w({ id: 'zis3_su76', name: '76mm ZiS-3 (SU-76)', cls: 'tankgun', rangeM: 1200, rate: 0.3, burst: 1, accuracy: 0.5, lethality: 0.75, suppression: 0.35, penetrationMm: 75, heRadiusM: 5, ammo: 60, reloadS: 4 }),

  // -------------------------------------------------------------- infantry AT
  grenade: w({ id: 'grenade', name: 'Grenade', cls: 'grenade', rangeM: 25, rate: 0.2, burst: 1, accuracy: 0.4, lethality: 0.5, suppression: 0.5, penetrationMm: 0, heRadiusM: 4, ammo: 2, reloadS: 3 }),
  panzerfaust: w({ id: 'panzerfaust', name: 'Panzerfaust', cls: 'atrocket', rangeM: 40, rate: 0.2, burst: 1, accuracy: 0.5, lethality: 0.85, suppression: 0.3, penetrationMm: 150, heRadiusM: 2, ammo: 1, reloadS: 0 }),
  panzerschreck: w({ id: 'panzerschreck', name: 'Panzerschreck', cls: 'atrocket', rangeM: 120, rate: 0.25, burst: 1, accuracy: 0.45, lethality: 0.85, suppression: 0.3, penetrationMm: 150, heRadiusM: 2.5, ammo: 5, reloadS: 8 }),
  ptrd: w({ id: 'ptrd', name: 'PTRD-41', cls: 'atrifle', rangeM: 300, rate: 0.2, burst: 1, accuracy: 0.35, lethality: 0.4, suppression: 0.15, penetrationMm: 30, heRadiusM: 0, ammo: 5, reloadS: 3 }),
  satchel: w({ id: 'satchel', name: 'Satchel Charge', cls: 'grenade', rangeM: 15, rate: 0.15, burst: 1, accuracy: 0.4, lethality: 0.8, suppression: 0.5, penetrationMm: 80, heRadiusM: 5, ammo: 1, reloadS: 0 }),
};

export const ALL_WEAPON_IDS: string[] = Object.keys(WEAPONS);
