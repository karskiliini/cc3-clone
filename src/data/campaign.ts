import type { GrandOperationDef, OperationBattleDef } from '@/shared/types';
import { OPERATION } from './operation';

// ============================================================================
// campaign.ts — the 16-operation Grand Campaign structure (roadmap G4).
//
// The six authored battles in data/operation.ts are grouped into the historical
// CC3 Grand Campaign operations (Barbarossa -> Berlin, 1941-45). The flat
// battle list stays the single source of play order: `index` in OperationState
// remains a flat position into the concatenated battles, so saves and the
// advanceOperation fold keep working unchanged; `opIndex` is derived.
// ============================================================================

/** Flatten a grand campaign into the flat battle list (play order). */
export function flattenCampaign(ops: GrandOperationDef[]): OperationBattleDef[] {
  return ops.flatMap((op) => op.battles);
}

/** Cumulative flat index where each operation's battles begin. */
export function battleOffsets(ops: GrandOperationDef[]): number[] {
  const offsets: number[] = [];
  let n = 0;
  for (const op of ops) {
    offsets.push(n);
    n += op.battles.length;
  }
  return offsets;
}

/** Flat index -> operation index (binary search over offsets). */
export function operationForIndex(ops: GrandOperationDef[], index: number): number {
  const offsets = battleOffsets(ops);
  let lo = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (index >= offsets[i]) lo = i;
  }
  return lo;
}

/** Resolve an authored battle by map and year; the requisition argument (the player's per-battle
 * budget) must match one of the def's sides, guarding against silent value drift. */
function battle(mapId: string, year: number, requisition: number): OperationBattleDef {
  const src = OPERATION.find((b) => b.mapId === mapId && b.year === year);
  if (!src) throw new Error(`campaign.ts: no authored battle for ${mapId}/${year}`);
  if (src.requisition.german !== requisition && src.requisition.soviet !== requisition) {
    throw new Error(`campaign.ts: battle ${mapId} requisition changed (${requisition})`);
  }
  return src;
}

/** The 16 historical CC3 Grand Campaign operations (German order of march, June 1941 -> May
 * 1945). One authored battle per operation; the finale carries two (the city fight, then the
 * Reichstag last stand). Operation names and dates follow the original's on-screen structure
 * (roadmap §1): Blitzkrieg, Roads to Moscow, Moscow Retaliates, the two Kharkov operations,
 * Rattan Creek / Red Barricades, Operation Star, Back Hand Blow, Dog Fight at Kursk / Counter
 * Blow at Prokhorovka, the Korsun pocket pair, the Vistula pair, and Götterdämmerung. */
export const GRAND_CAMPAIGN: GrandOperationDef[] = [
  {
    id: 'blitzkrieg', title: 'Operation Barbarossa', year: 1941, startDate: '22 June 1941',
    situation: 'Axis forces pour across the Soviet frontier. Fast panzer spearheads have broken the border defences and the infantry must consolidate the corridor. Take the victory locations before the Soviet reserve arrives.',
    battles: [battle('border_1941', 1941, 220)],
  },
  {
    id: 'roadsToMoscow', title: 'Roads to Moscow', year: 1941, startDate: 'November 1941',
    situation: 'Operation Typhoon grinds toward the capital. The first fortified line before Moscow stands on a frozen river; armour must lead across the open ground.',
    battles: [battle('moscow_1941', 1941, 210)],
  },
  {
    id: 'moscowRetaliates', title: 'Moscow Retaliates', year: 1941, startDate: 'December 1941',
    situation: 'The Soviet counter-offensive has thrown the frostbitten spearheads back. Hold the frozen line and give ground only at a price.',
    battles: [battle('moscow_1941', 1941, 210)],
  },
  {
    id: 'secondKharkov', title: 'Second Battle of Kharkov', year: 1942, startDate: '12 May 1942',
    situation: 'The Soviet spring offensive has bitten deep around Kharkov. A village anchors the flank; retake it and cut the salient.',
    battles: [battle('village_1942', 1942, 210)],
  },
  {
    id: 'counterStrokeKharkov', title: 'Counter Stroke at Kharkov', year: 1942, startDate: 'May 1942',
    situation: 'Fredericus closes the trap. The salient is shrinking; hold what you hold and roll the Soviet spearhead back on itself.',
    battles: [battle('village_1942', 1942, 210)],
  },
  {
    id: 'rattanCreek', title: 'Rattan Creek / Red Barricades', year: 1942, startDate: 'October 1942',
    situation: 'The drive has reached the Volga. A workers\' quarter of housing blocks and factory halls stands between you and the river; every cellar is a fortress, and the Red Barricades halls are the last line before the water. Take the factory, house by house, wall by wall.',
    battles: [battle('stalingrad_1942', 1942, 220), battle('stalingrad_1942', 1942, 220)],
  },
  {
    id: 'operationStar', title: 'Operation Star', year: 1943, startDate: 'January 1943',
    situation: 'The Soviet winter drive reaches for the Dnieper. The steppe is open and frozen; delaying actions must bleed the columns at every balka.',
    battles: [battle('steppe_1943', 1943, 240)],
  },
  {
    id: 'backHandBlow', title: 'Back Hand Blow', year: 1943, startDate: 'February 1943',
    situation: 'Manstein\'s counterstroke rips through the over-extended Soviet spearheads. The kolkhoz line is where the blow lands hardest.',
    battles: [battle('steppe_1943', 1943, 240)],
  },
  {
    id: 'dogFightKursk', title: 'Dog Fight at Kursk', year: 1943, startDate: '5 July 1943',
    situation: 'Zitadelle. The greatest armoured battle in history. Dug-in Soviet defences await the panzer wedge on the open steppe.',
    battles: [battle('steppe_1943', 1943, 240)],
  },
  {
    id: 'prokhorovka', title: 'Counter Blow at Prokhorovka', year: 1943, startDate: '12 July 1943',
    situation: 'The Soviet armoured reserve masses at Prokhorovka. Hold the line against the counterattack — the fate of the offensive hangs here.',
    battles: [battle('steppe_1943', 1943, 240)],
  },
  {
    id: 'korsunPocket', title: 'Korsun Pocket', year: 1944, startDate: 'February 1944',
    situation: 'Six divisions are cut off in the Korsun pocket. Deep snow, balkas and a half-frozen river between the pocket and freedom.',
    battles: [battle('korsun_1944', 1944, 230)],
  },
  {
    id: 'reliefAttempt', title: 'Korsun Relief Attempt', year: 1944, startDate: 'February 1944',
    situation: 'The relief spearhead pushes north through the snow to reach the pocket. Pochapintsy village and the ford are the keys.',
    battles: [battle('korsun_1944', 1944, 230)],
  },
  {
    id: 'bagration', title: 'Operation Bagration', year: 1944, startDate: '22 July 1944',
    situation: 'Army Group Centre collapses under the Soviet summer offensive. The forest road is the last escape route.',
    battles: [battle('forest_1944', 1944, 220)],
  },
  {
    id: 'magnuszew', title: 'Bridgehead on the Vistula', year: 1944, startDate: '27 July 1944',
    situation: 'The Soviets have crossed the Vistula at Magnuszew. Throw the bridgehead back into the river before it can grow.',
    battles: [battle('vistula_1944', 1944, 220)],
  },
  {
    id: 'goeringAttacks', title: 'Hermann Göring Attacks', year: 1944, startDate: 'August 1944',
    situation: 'The Reichsmarschall\'s armoured divisions counterattack along the Vistula. The dike line and the ford are where the blow must fall.',
    battles: [battle('vistula_1944', 1944, 220)],
  },
  {
    id: 'gotterdammerung', title: 'Götterdämmerung', year: 1945, startDate: '30 April 1945',
    situation: 'The end. Soviet storm groups fight through the rubble and across the Spree; hold the Reichstag, the square and the bridge — then hold them again.',
    battles: [battle('berlin_1945', 1945, 200), battle('kremlin_1945', 1945, 190)],
  },
];
