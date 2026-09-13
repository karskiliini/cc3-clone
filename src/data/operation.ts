import type { OperationBattleDef, OperationState, Side } from '@/shared/types';
import { TEAM_DEFS, teamsForYear } from './units';

/** The six-battle linear operation, June 1941 -> April 1945. */
export const OPERATION: OperationBattleDef[] = [
  {
    mapId: 'border_1941',
    year: 1941,
    title: 'Operation Barbarossa — June 1941',
    requisition: { german: 220, soviet: 190 },
    aiForces: {
      german: ['ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz3j', 'ger_pz4f1'],
      soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_t26', 'sov_bt7'],
    },
  },
  {
    mapId: 'moscow_1941',
    year: 1941,
    title: 'Battle of Moscow — December 1941',
    requisition: { german: 210, soviet: 210 },
    aiForces: {
      german: ['ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz3j', 'ger_sdkfz251'],
      soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_kv1', 'sov_t26'],
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
    aiForces: {
      german: ['ger_rifle_43', 'ger_rifle_43', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz4gh', 'ger_stug3g', 'ger_tiger'],
      soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_su76', 'sov_su85'],
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
  1941: {
    german: ['ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz3j', 'ger_pz4f1', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_command', 'sov_t26', 'sov_bt7', 'sov_kv1'],
  },
  1942: {
    german: ['ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_command', 'sov_t34_76', 'sov_t70', 'sov_kv1'],
  },
  1943: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g', 'ger_tiger'],
    soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_76', 'sov_su76', 'sov_su85'],
  },
  1944: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_pschreck', 'ger_sniper', 'ger_command', 'ger_stug3g', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_su76', 'sov_is2'],
  },
  1945: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_tiger', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_is2', 'sov_su85', 'sov_sappers'],
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
