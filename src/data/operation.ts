import type { OperationBattleDef, OperationState, Side } from '@/shared/types';
import { TEAM_DEFS, teamsForYear } from './units';

/** The authored battle pool: one entry per map, in campaign order (June 1941 -> May 1945). */
const BATTLE_DEFS: OperationBattleDef[] = [
  {
    mapId: 'border_1941',
    year: 1941,
    title: 'Operation Barbarossa — June 1941',
    requisition: { german: 220, soviet: 190 },
    expectedVLs: 5, // border_1941: take the crossroads (3) plus a farm — briefing expectation
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
    expectedVLs: 6, // moscow_1941 (winter): hold most of the ground at the frozen line
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
    expectedVLs: 6, // village_1942: clear the village (10 pts total, hold 6 to win on land)
    aiForces: {
      german: ['ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz4gh', 'ger_stug3g'],
      soviet: ['sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_ptrd', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_t70'],
    },
  },
  {
    mapId: 'stalingrad_1942',
    year: 1942,
    title: 'Rattan Creek — Red Barricades, October 1942',
    requisition: { german: 220, soviet: 210 },
    expectedVLs: 6, // stalingrad_1942: take the factory halls (3), machinery yard (2), tram street (1)
    aiForces: {
      german: ['ger_rifle_41', 'ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_mortar81', 'ger_engineers', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g'],
      soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t70'],
    },
  },
  {
    mapId: 'steppe_1943',
    year: 1943,
    title: 'Dog Fight at Kursk — July 1943',
    requisition: { german: 240, soviet: 240 },
    expectedVLs: 5, // steppe_1943: hold the kolkhoz line against the Kursk assault
    // DEFAULT_FORCES[1943] note); soviet adds sappers, a second T-34/76 and a second mortar.
    aiForces: {
      german: ['ger_rifle_43', 'ger_rifle_43', 'ger_mg42_hmg', 'ger_mortar81', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_pz4gh', 'ger_stug3g', 'ger_tiger'],
      soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_t34_76', 'sov_su76', 'sov_su85'],
    },
  },
  {
    mapId: 'korsun_1944',
    year: 1944,
    title: 'Korsun Pocket — February 1944',
    requisition: { german: 230, soviet: 230 },
    expectedVLs: 5, // korsun_1944: the relief takes Pochapintsy (3) and the ford (2)
    aiForces: {
      german: ['ger_rifle_43', 'ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_engineers', 'ger_pak40', 'ger_sniper', 'ger_command', 'ger_stug3g', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_su76'],
    },
  },
  {
    mapId: 'forest_1944',
    year: 1944,
    title: 'Operation Bagration — July 1944',
    requisition: { german: 220, soviet: 250 },
    expectedVLs: 6, // forest_1944: Bagration — take and hold the forest line
    aiForces: {
      german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_pschreck', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_stug3g', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_su76', 'sov_is2'],
    },
  },
  {
    mapId: 'vistula_1944',
    year: 1944,
    title: 'Bridgehead on the Vistula — July 1944',
    requisition: { german: 220, soviet: 240 },
    expectedVLs: 5, // vistula_1944: throw the bridgehead back — the church (3) and the dike (2)
    aiForces: {
      german: ['ger_rifle_43', 'ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_engineers', 'ger_pak40', 'ger_sniper', 'ger_command', 'ger_stug3g', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_is2'],
    },
  },
  {
    mapId: 'berlin_1945',
    year: 1945,
    title: 'Battle of Berlin — April 1945',
    requisition: { german: 200, soviet: 260 },
    expectedVLs: 6, // berlin_1945: hold the centre against the counterattacks
    aiForces: {
      german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_stug3g', 'ger_tiger', 'ger_panther'],
      soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_t34_85', 'sov_is2', 'sov_su85'],
    },
  },
  {
    mapId: 'kremlin_1945',
    year: 1945,
    title: 'The Reichstag — April 1945',
    requisition: { german: 190, soviet: 260 },
    expectedVLs: 7, // kremlin_1945: hold the Reichstag (3), Konigsplatz (2) and the Moltke Bridge (2)
    aiForces: {
      german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_engineers', 'ger_stug3g'],
      soviet: ['sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_85', 'sov_is2'],
    },
  },
];

/** The campaign play order: multi-day operations replay the same authored battle, the way the
 * original runs its day-N-of-M chains over the same ground. The flat list is the single source
 * of play order (what `index` in OperationState counts, and what campaign.ts's grand operations
 * slice into contiguous runs). */
export const OPERATION: OperationBattleDef[] = [
  BATTLE_DEFS[0],
  BATTLE_DEFS[1], BATTLE_DEFS[1],
  BATTLE_DEFS[2], BATTLE_DEFS[2],
  BATTLE_DEFS[3], BATTLE_DEFS[3],
  BATTLE_DEFS[4], BATTLE_DEFS[4], BATTLE_DEFS[4], BATTLE_DEFS[4],
  BATTLE_DEFS[5], BATTLE_DEFS[5],
  BATTLE_DEFS[6],
  BATTLE_DEFS[7], BATTLE_DEFS[7],
  BATTLE_DEFS[8],
  BATTLE_DEFS[9],
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
  // Attack-AI pass 2026-09-18 (the attacker now prepares with mortars and tank guns, bounds from
  // cover to cover, keeps its armour with the squads and masses on one objective at a time; a side
  // that is wiped out or exhausted cedes its victory locations). With the old boosts the attacker
  // then won 85-90 % on the 1941, 1944 and 1945 maps, so ATTACKER-side boosts are taken back, one
  // team per year, measured over 36 seeds per map:
  //   1941 german: the second PzKw III J goes again (border 89 -> 52 %, moscow 89 -> 55 %);
  //   1944 soviet: one SMG squad goes (forest 66 -> 48 %);
  //   1945 soviet: the SU-85 goes (berlin 75 -> 45 %).
  // and where the attacker was still under 30 %:
  //   1943 soviet: one T-34/76 becomes a second SU-85, the only Soviet gun of the year with a
  //   chance against the Tiger's front (steppe 9-seed 25 -> 56 %, 36-seed 44 -> 49 %);
  //   1942 soviet: the 45 mm AT gun becomes a ZiS-3 (the one Soviet 1942 weapon that goes through
  //   the 80 mm fronts of the PzKw IV H / StuG III G) and sappers with satchel charges join.
  //   village_1942 stays low all the same (about 10-25 %): nothing else the Soviets have in 1942
  //   can hurt the two German AFVs from the front, and the defender's list is out of bounds here.
  1941: {
    german: ['ger_rifle_41', 'ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz3j', 'ger_pz4f1', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_mortar82', 'sov_45mm_at', 'sov_sniper', 'sov_command', 'sov_t26', 'sov_bt7', 'sov_kv1'],
  },
  1942: {
    german: ['ger_rifle_41', 'ger_assault_42', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak38', 'ger_sniper', 'ger_command', 'ger_pz4gh', 'ger_stug3g', 'ger_sdkfz251'],
    soviet: ['sov_rifle_41', 'sov_rifle_41', 'sov_rifle_41', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_76', 'sov_t34_76', 'sov_t70', 'sov_kv1', 'sov_mortar82', 'sov_sappers'],
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
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_t34_76', 'sov_maxim_hmg', 'sov_mortar82', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_sappers', 'sov_t34_76', 'sov_su85', 'sov_su76', 'sov_su85'],
  },
  1944: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_mortar81', 'ger_pak40', 'ger_pschreck', 'ger_sniper', 'ger_command', 'ger_stug3g', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_maxim_hmg', 'sov_mortar82', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_su76', 'sov_is2'],
  },
  1945: {
    german: ['ger_rifle_43', 'ger_assault_42', 'ger_mg42_hmg', 'ger_pak40', 'ger_pschreck', 'ger_pzfaust_44', 'ger_sniper', 'ger_command', 'ger_tiger', 'ger_panther'],
    soviet: ['sov_rifle_43', 'sov_rifle_43', 'sov_smg_42', 'sov_smg_42', 'sov_maxim_hmg', 'sov_zis3', 'sov_sniper', 'sov_command', 'sov_t34_85', 'sov_is2', 'sov_sappers'],
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
