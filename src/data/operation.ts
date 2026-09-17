import type { OperationBattleDef, OperationState, Side } from '@/shared/types';
import { TEAM_DEFS, teamsForYear } from './units';

/** The six-battle linear operation, June 1941 -> April 1945. */
export const OPERATION: OperationBattleDef[] = [
  {
    mapId: 'border_1941',
    year: 1941,
    title: 'Operation Barbarossa — June 1941',
    requisition: { german: 220, soviet: 190 },
    // Balance pass: german gets a second mortar and PzKw III J; soviet loses its Maxim HMG (see
    // DEFAULT_FORCES[1941] note - its suppression volume dominated the harness on this map).
    aiForces: {
      german: ['ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz3j', 'ger_pz3j', 'ger_pz4f1'],
      soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_t26', 'sov_bt7'],
    },
  },
  {
    mapId: 'moscow_1941',
    year: 1941,
    title: 'Battle of Moscow — December 1941',
    requisition: { german: 210, soviet: 210 },
    // Balance pass: same rationale as border_1941 above.
    aiForces: {
      german: ['ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz3j', 'ger_pz3j', 'ger_sdkfz251'],
      soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_kv1', 'sov_t26'],
    },
  },
  {
    mapId: 'village_1942',
    year: 1942,
    title: 'Kharkov Counterattack — May 1942',
    requisition: { german: 210, soviet: 220 },
    aiForces: {
      german: ['ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz4gh', 'ger_stug3g'],
      soviet: ['sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_t70'],
    },
  },
  {
    mapId: 'steppe_1943',
    year: 1943,
    title: 'Battle of Kursk — July 1943',
    requisition: { german: 240, soviet: 240 },
    // Balance pass (attacker=soviet on this map): german loses its PaK 40 (see
    // DEFAULT_FORCES[1943] note); soviet adds sappers, a second T-34/76 and a second mortar.
    aiForces: {
      german: ['ger_rifle_43', 'ger_rifle_43', 'ger_mg42_hmg', 'ger_mortar81', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz4gh', 'ger_stug3g', 'ger_tiger'],
      soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_t34_76', 'sov_su76', 'sov_su85'],
    },
  },
  {
    mapId: 'forest_1944',
    year: 1944,
    title: 'Operation Bagration — July 1944',
    requisition: { german: 220, soviet: 250 },
    aiForces: {
      german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_pschreck', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_stug3g', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_su76', 'sov_is2'],
    },
  },
  {
    mapId: 'berlin_1945',
    year: 1945,
    title: 'Battle of Berlin — April 1945',
    requisition: { german: 200, soviet: 260 },
    aiForces: {
      german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_stug3g', 'ger_tiger', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_t34_85', 'sov_is2', 'sov_su85'],
    },
  },
];

/** Default forces for free "Battle" mode, keyed by year, for both sides. */
export const DEFAULT_FORCES: Record<number, Record<Side, string[]>> = {
  // Balance pass 2026-09 (after slower tank gunnery, re-manned tanks and blast daze the 9-seed
  // attacker win rate fell to ~21%): the ATTACKER of each year's maps (german 1941, soviet
  // 1942-45) gets more infantry (one to two extra squads) — an attack at even strength with two
  // squads could not carry the victory locations before the clock ran out. Timings untouched.
  // Balance pass (border_1941/moscow_1941 attacker=german came in far under CC3's historical
  // norm of a stronger attacker): german gets a second mortar and a second PzKw III J; soviet
  // loses its Maxim HMG, whose suppression volume was the single biggest driver of the lopsided
  // harness results on these two maps (defender out-shot attacker 5-10x pre-change).
  1941: {
    german: ['ger_rifle_41', 'ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz3j', 'ger_pz3j', 'ger_pz4f1', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_command', 'sov_t26', 'sov_bt7', 'sov_kv1'],
  },
  1942: {
    german: ['ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_command', 'sov_t34_76', 'sov_t34_76', 'sov_t70', 'sov_kv1', 'sov_mortar82'],
  },
  // Balance pass (steppe_1943 attacker=soviet, defending on a dug-in trench line): the AI's
  // combat/targeting behavior on this map turned out very sensitive to soviet force SIZE -
  // both a 3rd mortar and reverting to no extra units at all tested worse (more one-sided
  // decisive german wins) than the config below, which was the best result found: german loses
  // its redundant PaK 40 (Tiger/StuG/PzIV already carry plenty of AT punch); soviet adds
  // sappers (satchel charges vs. entrenched troops per the manual), a second T-34/76, and a
  // second mortar - no more, no less. The map's fix leans on this plus the VL-value rebalance
  // below (see steppe_1943.ts).
  1943: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g', 'ger_tiger'],
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_t34_76', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_t34_76', 'sov_su76', 'sov_su85'],
  },
  1944: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_pschreck', 'ger_sniper', 'ger_command', 'ger_stug3g', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_su76', 'sov_is2'],
  },
  1945: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_tiger', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_is2', 'sov_su85', 'sov_sappers'],
  },
};

/** Starting force pool for a fresh operation: everything available in the first battle's year. */
/** Starting roster for a fresh operation: greedily picks teams (in their
 * defined order) for that year until the starting requisition budget is
 * spent, so the player opens Operation 1 with an affordable roster instead
 * of an over-budget one they must immediately trim. */
export function initialForcePool(side: Side): OperationState['forcePool'] {
  const year = OPERATION[0].year;
  const budget = OPERATION[0].requisition[side];
  let spent = 0;
  const picked: OperationState['forcePool'] = [];
  for (const d of teamsForYear(side, year)) {
    if (!(d.id in TEAM_DEFS)) continue;
    if (spent + d.cost > budget) continue;
    spent += d.cost;
    picked.push({ defId: d.id, experience: 30, alive: d.soldiers.length });
  }
  return picked;
}
