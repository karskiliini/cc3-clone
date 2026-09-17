import type { Side, TeamDef, VehicleDef } from '@/shared/types';

// ============================================================================
// Vehicles
// ============================================================================

function v(d: VehicleDef): VehicleDef { return d; }

/* TURN RATES are per-vehicle historical figures; there is no shared default (sim/gunTiming.ts).
 * `turretTraverseDegS`: typical combat traverse (German powered traverse depended on engine revs:
 * the typical, not the best figure): Pz III J 8 (hand only), Pz IV 14 (electric, 360 deg in ~25 s),
 * Panther G 15 (hydraulic), Tiger I 7 (360 deg in ~60 s at normal revs), T-26/BT-7 10 and T-70 9
 * (hand), T-34/76 25 (electric, coarse), KV-1 10, T-34/85 20, IS-2 13; SdKfz 251 pintle MG 60.
 * Casemates have no turret: the gun traverses `gunArcDeg` either side (StuG 12, Marder III 21,
 * SU-76 16, SU-85 10) at 5 deg/s by handwheel; beyond the arc the hull turns.
 * `turretTraverseHandDegS`: with the engine dead a powered turret is cranked by hand (Pz IV 4,
 * Panther 3, Tiger 2, T-34 6, KV 3, IS-2 3; T-34/85 5 by analogy).
 * `hullTurnDegS`: turn in place, from steering type and mass: Pz III 20, Pz IV 18, StuG 20, Marder
 * 22, Panther 16, Tiger 12, T-26 22, BT-7 24, T-70 25, T-34/76 20, T-34/85 18, KV-1 11, IS-2 13,
 * SU-76 22, SU-85 18. The SdKfz 251 steers with its front wheels and cannot pivot: `turnRadiusM`
 * 5.5 (turn rate = speed / radius, zero at rest).
 * `bowWeaponId`: the hull MG of tanks that had one (Pz III/IV, Panther, Tiger: MG34 in a ball
 * mount; T-34, KV-1: DT in a ball mount; IS-2: a fixed DT fired by the driver). None on the StuG,
 * T-26, BT-7, T-70, the SPGs and the halftrack.
 * `readyRack`: rounds to hand in the turret/fighting compartment (4-8); the rest load x1.25. */
/* `layout`: what sits where (defaults by class and crew size in sim/vehicleDamage.ts: rear
 * transmission, no side fuel); `weakSpots`: plates an ace gunner knows, effective mm by aim point. */
export const VEHICLE_DEFS: Record<string, VehicleDef> = {
  // ------------------------------------------------------------- German
  pz3j: v({
    id: 'pz3j', name: 'PzKw III J', kind: 'tank', lengthM: 5.6, widthM: 2.9,
    speedRoadMs: 11, speedOffroadMs: 5, turretTraverseDegS: 8, turretTraverseHandDegS: 8, hullTurnDegS: 20, readyRack: 6,
    armor: { front: 50, side: 30, rear: 30, top: 10 },
    mainWeaponId: 'kwk39_50', coaxWeaponId: 'coax_mg34', bowWeaponId: 'bow_mg34', hasTurret: true, crew: 5, mainAmmo: 90,
    layout: { transmission: 'front' }, weakSpots: { lowerHull: 40 },
  }),
  pz4f1: v({
    id: 'pz4f1', name: 'PzKw IV F1', kind: 'tank', lengthM: 5.9, widthM: 2.9,
    speedRoadMs: 11, speedOffroadMs: 5, turretTraverseDegS: 14, turretTraverseHandDegS: 4, hullTurnDegS: 18, readyRack: 8,
    armor: { front: 50, side: 30, rear: 20, top: 10 },
    mainWeaponId: 'kwk37_75', coaxWeaponId: 'coax_mg34', bowWeaponId: 'bow_mg34', hasTurret: true, crew: 5, mainAmmo: 80,
    layout: { transmission: 'front' }, weakSpots: { turretRing: 40 },
  }),
  pz4gh: v({
    id: 'pz4gh', name: 'PzKw IV H', kind: 'tank', lengthM: 5.9, widthM: 2.9,
    speedRoadMs: 11, speedOffroadMs: 5, turretTraverseDegS: 14, turretTraverseHandDegS: 4, hullTurnDegS: 18, readyRack: 8,
    armor: { front: 80, side: 30, rear: 20, top: 12 },
    mainWeaponId: 'kwk40_75', coaxWeaponId: 'coax_mg34', bowWeaponId: 'bow_mg34', hasTurret: true, crew: 5, mainAmmo: 87,
    layout: { transmission: 'front' }, weakSpots: { turretRing: 50 },
  }),
  stug3g: v({
    id: 'stug3g', name: 'StuG III G', kind: 'spg', lengthM: 5.4, widthM: 2.9,
    speedRoadMs: 11, speedOffroadMs: 5, turretTraverseDegS: 5, turretTraverseHandDegS: 5, hullTurnDegS: 20, gunArcDeg: 12, readyRack: 8,
    armor: { front: 80, side: 30, rear: 30, top: 16 },
    mainWeaponId: 'stuk40', coaxWeaponId: 'coax_mg34', hasTurret: false, crew: 4, mainAmmo: 54,
    layout: { transmission: 'front' }, weakSpots: { lowerHull: 50 },
  }),
  panther: v({
    id: 'panther', name: 'Panther G', kind: 'tank', lengthM: 6.9, widthM: 3.4,
    speedRoadMs: 12, speedOffroadMs: 5, turretTraverseDegS: 15, turretTraverseHandDegS: 3, hullTurnDegS: 16, readyRack: 6,
    armor: { front: 110, side: 45, rear: 40, top: 16 },
    mainWeaponId: 'kwk42_75', coaxWeaponId: 'coax_mg34', bowWeaponId: 'bow_mg34', hasTurret: true, crew: 5, mainAmmo: 79,
    layout: { transmission: 'front' }, weakSpots: { gunMantlet: 70, sideHull: 40 },
  }),
  tiger: v({
    id: 'tiger', name: 'Tiger I', kind: 'tank', lengthM: 6.3, widthM: 3.6,
    speedRoadMs: 10, speedOffroadMs: 4, turretTraverseDegS: 7, turretTraverseHandDegS: 2, hullTurnDegS: 12, readyRack: 6,
    armor: { front: 100, side: 80, rear: 80, top: 25 },
    mainWeaponId: 'kwk36_88', coaxWeaponId: 'coax_mg34', bowWeaponId: 'bow_mg34', hasTurret: true, crew: 5, mainAmmo: 92,
    layout: { transmission: 'front' },
  }),
  sdkfz251: v({
    id: 'sdkfz251', name: 'SdKfz 251', kind: 'halftrack', lengthM: 5.8, widthM: 2.1,
    speedRoadMs: 14, speedOffroadMs: 6, turretTraverseDegS: 60, turretTraverseHandDegS: 60, hullTurnDegS: 0, turnRadiusM: 5.5,
    armor: { front: 14, side: 8, rear: 8, top: 6 },
    mainWeaponId: null, coaxWeaponId: 'coax_mg34', hasTurret: false, crew: 2, mainAmmo: 0,
    layout: { transmission: 'front', openTop: true, bowMg: false }, passengers: 10,
  }),
  marder3: v({
    id: 'marder3', name: 'Marder III', kind: 'spg', lengthM: 4.65, widthM: 2.95,
    speedRoadMs: 12, speedOffroadMs: 5, turretTraverseDegS: 5, turretTraverseHandDegS: 5, hullTurnDegS: 22, gunArcDeg: 21, readyRack: 6,
    armor: { front: 15, side: 10, rear: 10, top: 0 },
    mainWeaponId: 'pak40', coaxWeaponId: null, hasTurret: false, crew: 4, mainAmmo: 38,
    layout: { transmission: 'front', openTop: true, bowMg: false },
  }),

  // ------------------------------------------------------------- Soviet
  t26: v({
    id: 't26', name: 'T-26', kind: 'tank', lengthM: 4.6, widthM: 2.4,
    speedRoadMs: 8, speedOffroadMs: 4, turretTraverseDegS: 10, turretTraverseHandDegS: 10, hullTurnDegS: 22, readyRack: 6,
    armor: { front: 15, side: 15, rear: 10, top: 10 },
    mainWeaponId: '45mm_20k', coaxWeaponId: 'coax_dt', hasTurret: true, crew: 3, mainAmmo: 96,
    layout: { transmission: 'front', twoManTurret: true, bowMg: false, radio: false },
  }),
  bt7: v({
    id: 'bt7', name: 'BT-7', kind: 'tank', lengthM: 5.7, widthM: 2.3,
    speedRoadMs: 14, speedOffroadMs: 6, turretTraverseDegS: 10, turretTraverseHandDegS: 10, hullTurnDegS: 24, readyRack: 6,
    armor: { front: 20, side: 13, rear: 10, top: 10 },
    mainWeaponId: '45mm_20k', coaxWeaponId: 'coax_dt', hasTurret: true, crew: 3, mainAmmo: 132,
    layout: { twoManTurret: true, bowMg: false, radio: false },
  }),
  t34_76: v({
    id: 't34_76', name: 'T-34/76', kind: 'tank', lengthM: 6.7, widthM: 3.0,
    speedRoadMs: 14, speedOffroadMs: 7, turretTraverseDegS: 25, turretTraverseHandDegS: 6, hullTurnDegS: 20, readyRack: 6,
    armor: { front: 60, side: 45, rear: 40, top: 20 },
    mainWeaponId: 'f34_76', coaxWeaponId: 'coax_dt', bowWeaponId: 'bow_dt', hasTurret: true, crew: 4, mainAmmo: 77,
    layout: { twoManTurret: true, sideFuel: true }, weakSpots: { driverPlate: 45, turretRing: 45 },
  }),
  kv1: v({
    id: 'kv1', name: 'KV-1', kind: 'tank', lengthM: 6.8, widthM: 3.3,
    speedRoadMs: 9, speedOffroadMs: 4, turretTraverseDegS: 10, turretTraverseHandDegS: 3, hullTurnDegS: 11, readyRack: 8,
    armor: { front: 75, side: 75, rear: 70, top: 20 },
    mainWeaponId: 'kv_zis5', coaxWeaponId: 'coax_dt', bowWeaponId: 'bow_dt', hasTurret: true, crew: 5, mainAmmo: 114,
    layout: { sideFuel: true }, weakSpots: { turretRing: 60, rear: 60 },
  }),
  t70: v({
    id: 't70', name: 'T-70', kind: 'tank', lengthM: 4.3, widthM: 2.3,
    speedRoadMs: 10, speedOffroadMs: 5, turretTraverseDegS: 9, turretTraverseHandDegS: 9, hullTurnDegS: 25, readyRack: 6,
    armor: { front: 35, side: 20, rear: 15, top: 10 },
    mainWeaponId: '45mm_20k', coaxWeaponId: 'coax_dt', hasTurret: true, crew: 2, mainAmmo: 90,
    layout: { twoManTurret: true, bowMg: false },
  }),
  t34_85: v({
    id: 't34_85', name: 'T-34/85', kind: 'tank', lengthM: 6.7, widthM: 3.0,
    speedRoadMs: 14, speedOffroadMs: 7, turretTraverseDegS: 20, turretTraverseHandDegS: 5, hullTurnDegS: 18, readyRack: 8,
    armor: { front: 90, side: 45, rear: 45, top: 20 },
    mainWeaponId: 'zis_s53_85', coaxWeaponId: 'coax_dt', bowWeaponId: 'bow_dt', hasTurret: true, crew: 5, mainAmmo: 55,
    layout: { sideFuel: true }, weakSpots: { driverPlate: 60 },
  }),
  is2: v({
    id: 'is2', name: 'IS-2', kind: 'tank', lengthM: 6.8, widthM: 3.1,
    speedRoadMs: 10, speedOffroadMs: 5, turretTraverseDegS: 13, turretTraverseHandDegS: 3, hullTurnDegS: 13, readyRack: 4,
    armor: { front: 120, side: 90, rear: 60, top: 30 },
    mainWeaponId: 'd25t_122', coaxWeaponId: 'coax_dt', bowWeaponId: 'bow_dt', hasTurret: true, crew: 4, mainAmmo: 28,
    weakSpots: { lowerHull: 100 },
  }),
  su76: v({
    id: 'su76', name: 'SU-76', kind: 'spg', lengthM: 5.0, widthM: 2.7,
    speedRoadMs: 12, speedOffroadMs: 6, turretTraverseDegS: 5, turretTraverseHandDegS: 5, hullTurnDegS: 22, gunArcDeg: 16, readyRack: 8,
    armor: { front: 35, side: 15, rear: 15, top: 0 },
    mainWeaponId: 'zis3_su76', coaxWeaponId: null, hasTurret: false, crew: 4, mainAmmo: 60,
    layout: { openTop: true, bowMg: false },
  }),
  su85: v({
    id: 'su85', name: 'SU-85', kind: 'spg', lengthM: 6.1, widthM: 3.0,
    speedRoadMs: 14, speedOffroadMs: 7, turretTraverseDegS: 5, turretTraverseHandDegS: 5, hullTurnDegS: 18, gunArcDeg: 10, readyRack: 6,
    armor: { front: 45, side: 45, rear: 40, top: 20 },
    mainWeaponId: 'zis_s53_85', coaxWeaponId: null, hasTurret: false, crew: 4, mainAmmo: 48,
    layout: { sideFuel: true, bowMg: false },
  }),
};

// ============================================================================
// Team defs
// ============================================================================

const Y41 = [1941];
const Y41_42 = [1941, 1942];
const Y42_45 = [1942, 1943, 1944, 1945];
const Y42_43 = [1942, 1943];
const Y43_45 = [1943, 1944, 1945];
const Y44_45 = [1944, 1945];
const Y41_43 = [1941, 1942, 1943];
const ALL_YEARS = [1941, 1942, 1943, 1944, 1945];

/* `quality`: how the team's men compare with the side's line troops of the year
 * (data/experience.ts: Germans 1941-42 a veteran army, sliding to the replacements of 1944-45; the
 * Red Army the other way). Elite: snipers, company command (Soviet from 1943), Tiger and IS-2
 * (Guards heavy tank regiment) crews, Guards SMG companies of 1944-45. Seasoned: assault squads,
 * pioneers and sappers, StuG (artillery arm) and Panther crews, KV-1, T-34/85 and SU-85 crews,
 * SMG squads before 1944. Militia: the Panzerfaust teams of 1944-45 (Volkssturm and hasty
 * replacements). */
function t(d: TeamDef): TeamDef { return d; }

export const TEAM_DEFS: Record<string, TeamDef> = {
  // ================================================================ GERMAN
  ger_rifle_41: t({
    id: 'ger_rifle_41', name: 'Rifle Squad', type: 'rifle', side: 'german', years: Y41_42, cost: 30,
    soldiers: [
      { rank: 'Uffz', weaponId: 'mp40' },
      { rank: 'Gefr', weaponId: 'mg34' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'rifle',
  }),
  ger_rifle_43: t({
    id: 'ger_rifle_43', name: 'Rifle Squad', type: 'rifle', side: 'german', years: Y43_45, cost: 30,
    soldiers: [
      { rank: 'Uffz', weaponId: 'mp40' },
      { rank: 'Gefr', weaponId: 'mg42' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'rifle',
  }),
  ger_assault_42: t({
    id: 'ger_assault_42', name: 'Assault Squad', type: 'smg', side: 'german', years: Y42_45, cost: 35, quality: 'seasoned',
    soldiers: [
      { rank: 'Uffz', weaponId: 'mp40' },
      { rank: 'Gefr', weaponId: 'mp40' }, { rank: 'Gefr', weaponId: 'mp40' },
      { rank: 'Schtz', weaponId: 'mp40' }, { rank: 'Schtz', weaponId: 'mp40' },
      { rank: 'Schtz', weaponId: 'mp40' }, { rank: 'Schtz', weaponId: 'mp40' },
      { rank: 'Schtz', weaponId: 'mp40' },
    ],
    iconId: 'smg',
  }),
  ger_mg34_hmg: t({
    id: 'ger_mg34_hmg', name: 'MG34 HMG', type: 'mg', side: 'german', years: Y41_43, cost: 25,
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Gefr', weaponId: 'mg34_hmg' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'mg',
  }),
  ger_mg42_hmg: t({
    id: 'ger_mg42_hmg', name: 'MG42 HMG', type: 'mg', side: 'german', years: Y43_45, cost: 25,
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Gefr', weaponId: 'mg42_hmg' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'mg',
  }),
  ger_mortar81: t({
    id: 'ger_mortar81', name: '8cm Mortar', type: 'mortar', side: 'german', years: ALL_YEARS, cost: 25,
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Gefr', weaponId: 'mortar81' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'mortar',
  }),
  ger_pak38: t({
    id: 'ger_pak38', name: '5cm PaK 38', type: 'atgun', side: 'german', years: Y41_42, cost: 30,
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Gefr', weaponId: 'pak38' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'atgun',
  }),
  ger_pak40: t({
    id: 'ger_pak40', name: '7.5cm PaK 40', type: 'atgun', side: 'german', years: Y43_45, cost: 40,
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Gefr', weaponId: 'pak40' },
      { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'atgun',
  }),
  ger_sniper: t({
    id: 'ger_sniper', name: 'Sniper', type: 'sniper', side: 'german', years: ALL_YEARS, cost: 20, quality: 'elite',
    soldiers: [{ rank: 'Fw', weaponId: 'kar98k_scoped' }],
    iconId: 'sniper',
  }),
  ger_pschreck: t({
    id: 'ger_pschreck', name: 'Panzerschreck', type: 'atteam', side: 'german', years: Y44_45, cost: 25,
    soldiers: [
      { rank: 'Gefr', weaponId: 'panzerschreck' },
      { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'atteam',
  }),
  ger_pzfaust_44: t({
    id: 'ger_pzfaust_44', name: 'Panzerfaust Team', type: 'atteam', side: 'german', years: Y44_45, cost: 20, quality: 'militia',
    soldiers: [
      { rank: 'Uffz', weaponId: 'kar98k' },
      { rank: 'Schtz', weaponId: 'panzerfaust' },
      { rank: 'Schtz', weaponId: 'panzerfaust' },
    ],
    iconId: 'atteam',
  }),
  ger_command: t({
    id: 'ger_command', name: 'Command', type: 'command', side: 'german', years: ALL_YEARS, cost: 20, quality: 'elite',
    soldiers: [
      { rank: 'Lt', weaponId: 'mp40' },
      { rank: 'Uffz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' }, { rank: 'Schtz', weaponId: 'kar98k' },
    ],
    iconId: 'command',
  }),
  ger_engineers: t({
    id: 'ger_engineers', name: 'Pioneers', type: 'engineer', side: 'german', years: ALL_YEARS, cost: 30, quality: 'seasoned',
    soldiers: [
      { rank: 'Uffz', weaponId: 'mp40' },
      { rank: 'Gefr', weaponId: 'satchel' }, { rank: 'Gefr', weaponId: 'satchel' },
      { rank: 'Schtz', weaponId: 'mp40' }, { rank: 'Schtz', weaponId: 'mp40' }, { rank: 'Schtz', weaponId: 'mp40' },
    ],
    iconId: 'engineer',
  }),
  ger_pz3j: t({
    id: 'ger_pz3j', name: 'PzKw III J', type: 'tank', side: 'german', years: Y41_42, cost: 50,
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'pz3j', iconId: 'tank',
  }),
  ger_pz4f1: t({
    id: 'ger_pz4f1', name: 'PzKw IV F1', type: 'tank', side: 'german', years: Y41, cost: 45,
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'pz4f1', iconId: 'tank',
  }),
  ger_pz4gh: t({
    id: 'ger_pz4gh', name: 'PzKw IV H', type: 'tank', side: 'german', years: Y42_45, cost: 55,
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'pz4gh', iconId: 'tank',
  }),
  ger_stug3g: t({
    id: 'ger_stug3g', name: 'StuG III G', type: 'spg', side: 'german', years: Y42_45, cost: 55, quality: 'seasoned',
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'stug3g', iconId: 'spg',
  }),
  ger_panther: t({
    id: 'ger_panther', name: 'Panther G', type: 'tank', side: 'german', years: Y43_45, cost: 75, quality: 'seasoned',
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'panther', iconId: 'tank',
  }),
  ger_tiger: t({
    id: 'ger_tiger', name: 'Tiger I', type: 'tank', side: 'german', years: Y43_45, cost: 90, quality: 'elite',
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'tiger', iconId: 'tank',
  }),
  ger_sdkfz251: t({
    id: 'ger_sdkfz251', name: 'SdKfz 251', type: 'halftrack', side: 'german', years: ALL_YEARS, cost: 30,
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'sdkfz251', iconId: 'halftrack',
  }),
  ger_marder3: t({
    id: 'ger_marder3', name: 'Marder III', type: 'spg', side: 'german', years: Y42_45, cost: 45,
    soldiers: [
      { rank: 'Uffz', weaponId: 'pistol_p38' }, { rank: 'Gefr', weaponId: 'pistol_p38' },
      { rank: 'Gefr', weaponId: 'pistol_p38' }, { rank: 'Schtz', weaponId: 'pistol_p38' },
    ],
    vehicleDefId: 'marder3', iconId: 'spg',
  }),

  // ================================================================ SOVIET
  sov_rifle_41: t({
    id: 'sov_rifle_41', name: 'Rifle Squad', type: 'rifle', side: 'soviet', years: Y41_42, cost: 28,
    soldiers: [
      { rank: 'Serzh', weaponId: 'ppsh41' },
      { rank: 'Efr', weaponId: 'dp28' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
      { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'rifle',
  }),
  sov_rifle_43: t({
    id: 'sov_rifle_43', name: 'Rifle Squad', type: 'rifle', side: 'soviet', years: Y43_45, cost: 30,
    soldiers: [
      { rank: 'Serzh', weaponId: 'ppsh41' },
      { rank: 'Efr', weaponId: 'dp28' }, { rank: 'Efr', weaponId: 'dp28' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
      { rank: 'Ryad', weaponId: 'svt40' }, { rank: 'Ryad', weaponId: 'svt40' }, { rank: 'Ryad', weaponId: 'svt40' },
    ],
    iconId: 'rifle',
  }),
  sov_smg_42: t({
    id: 'sov_smg_42', name: 'SMG Squad', type: 'smg', side: 'soviet', years: Y42_45, cost: 32, quality: { default: 'seasoned', 1944: 'elite', 1945: 'elite' },
    soldiers: [
      { rank: 'Serzh', weaponId: 'ppsh41' },
      { rank: 'Efr', weaponId: 'ppsh41' }, { rank: 'Efr', weaponId: 'ppsh41' },
      { rank: 'Ryad', weaponId: 'ppsh41' }, { rank: 'Ryad', weaponId: 'ppsh41' },
      { rank: 'Ryad', weaponId: 'ppsh41' }, { rank: 'Ryad', weaponId: 'ppsh41' },
      { rank: 'Ryad', weaponId: 'ppsh41' },
    ],
    iconId: 'smg',
  }),
  sov_maxim_hmg: t({
    id: 'sov_maxim_hmg', name: 'Maxim HMG', type: 'mg', side: 'soviet', years: ALL_YEARS, cost: 22,
    soldiers: [
      { rank: 'Serzh', weaponId: 'mosin' },
      { rank: 'Efr', weaponId: 'maxim' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'mg',
  }),
  sov_mortar82: t({
    id: 'sov_mortar82', name: '82mm Mortar', type: 'mortar', side: 'soviet', years: ALL_YEARS, cost: 22,
    soldiers: [
      { rank: 'Serzh', weaponId: 'mosin' },
      { rank: 'Efr', weaponId: 'mortar82' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'mortar',
  }),
  sov_45mm_at: t({
    id: 'sov_45mm_at', name: '45mm AT Gun', type: 'atgun', side: 'soviet', years: Y41_43, cost: 25,
    soldiers: [
      { rank: 'Serzh', weaponId: 'mosin' },
      { rank: 'Efr', weaponId: 'm1937_45mm' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'atgun',
  }),
  sov_zis3: t({
    id: 'sov_zis3', name: 'ZiS-3 76mm', type: 'atgun', side: 'soviet', years: Y42_45, cost: 35,
    soldiers: [
      { rank: 'Serzh', weaponId: 'mosin' },
      { rank: 'Efr', weaponId: 'zis3' },
      { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'atgun',
  }),
  sov_sniper: t({
    id: 'sov_sniper', name: 'Sniper', type: 'sniper', side: 'soviet', years: ALL_YEARS, cost: 18, quality: 'elite',
    soldiers: [{ rank: 'StSzh', weaponId: 'mosin_scoped' }],
    iconId: 'sniper',
  }),
  sov_ptrd: t({
    id: 'sov_ptrd', name: 'PTRD Team', type: 'atteam', side: 'soviet', years: Y41_43, cost: 15,
    soldiers: [
      { rank: 'Efr', weaponId: 'ptrd' },
      { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'atteam',
  }),
  sov_command: t({
    id: 'sov_command', name: 'Command', type: 'command', side: 'soviet', years: ALL_YEARS, cost: 20, quality: { default: 'seasoned', 1943: 'elite', 1944: 'elite', 1945: 'elite' },
    soldiers: [
      { rank: 'Lt', weaponId: 'ppsh41' },
      { rank: 'Serzh', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' }, { rank: 'Ryad', weaponId: 'mosin' },
    ],
    iconId: 'command',
  }),
  sov_sappers: t({
    id: 'sov_sappers', name: 'Sappers', type: 'engineer', side: 'soviet', years: ALL_YEARS, cost: 30, quality: 'seasoned',
    soldiers: [
      { rank: 'Serzh', weaponId: 'ppsh41' },
      { rank: 'Efr', weaponId: 'satchel' }, { rank: 'Efr', weaponId: 'satchel' },
      { rank: 'Ryad', weaponId: 'ppsh41' }, { rank: 'Ryad', weaponId: 'ppsh41' }, { rank: 'Ryad', weaponId: 'ppsh41' },
    ],
    iconId: 'engineer',
  }),
  sov_t26: t({
    id: 'sov_t26', name: 'T-26', type: 'tank', side: 'soviet', years: Y41, cost: 35,
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 't26', iconId: 'tank',
  }),
  sov_bt7: t({
    id: 'sov_bt7', name: 'BT-7', type: 'tank', side: 'soviet', years: Y41, cost: 35,
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 'bt7', iconId: 'tank',
  }),
  sov_t34_76: t({
    id: 'sov_t34_76', name: 'T-34/76', type: 'tank', side: 'soviet', years: Y41_43, cost: 60,
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 't34_76', iconId: 'tank',
  }),
  sov_kv1: t({
    id: 'sov_kv1', name: 'KV-1', type: 'tank', side: 'soviet', years: Y41_42, cost: 80, quality: 'seasoned',
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 'kv1', iconId: 'tank',
  }),
  sov_t70: t({
    id: 'sov_t70', name: 'T-70', type: 'tank', side: 'soviet', years: Y42_43, cost: 30,
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 't70', iconId: 'tank',
  }),
  sov_t34_85: t({
    id: 'sov_t34_85', name: 'T-34/85', type: 'tank', side: 'soviet', years: Y44_45, cost: 70, quality: 'seasoned',
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 't34_85', iconId: 'tank',
  }),
  sov_is2: t({
    id: 'sov_is2', name: 'IS-2', type: 'tank', side: 'soviet', years: Y44_45, cost: 95, quality: 'elite',
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 'is2', iconId: 'tank',
  }),
  sov_su76: t({
    id: 'sov_su76', name: 'SU-76', type: 'spg', side: 'soviet', years: Y43_45, cost: 40,
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 'su76', iconId: 'spg',
  }),
  sov_su85: t({
    id: 'sov_su85', name: 'SU-85', type: 'spg', side: 'soviet', years: Y43_45, cost: 55, quality: 'seasoned',
    soldiers: [
      { rank: 'Serzh', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
      { rank: 'Ryad', weaponId: 'pistol_tt' }, { rank: 'Ryad', weaponId: 'pistol_tt' },
    ],
    vehicleDefId: 'su85', iconId: 'spg',
  }),
};

export function teamsForYear(side: Side, year: number): TeamDef[] {
  return Object.values(TEAM_DEFS).filter((d) => d.side === side && d.years.includes(year));
}
