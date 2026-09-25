import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 220;
const HEIGHT = 170;
const SEED = 1944;

/** February 1944, Korsun pocket: the German relief spearhead pushes north across the partially
 * frozen Gniloy Tikich into the pocket's snowy southern rim — two balka gullies, a dug-in Soviet
 * trench belt on the ridge crest, and the kolkhoz village of Pochapintsy with its stone church
 * on the high ground beyond. */
// ---------------------------------------------------------------- shared geometry (see the
// note in border_1941.ts: the landform must follow the same river and road lines as the tiles)
export const GNIL = [
  { x: -5, y: 102 }, { x: 35, y: 97 }, { x: 70, y: 104 }, { x: 105, y: 98 },
  { x: 140, y: 102 }, { x: 175, y: 99 }, { x: 205, y: 106 }, { x: 222, y: 114 },
];
// the engineer-cut relief road: German assembly south, over the main bridge, up through the
// breaches in the Soviet trench belt and on to the village's western edge
const MAIN_ROAD = [
  { x: 108, y: 172 }, { x: 104, y: 150 }, { x: 110, y: 132 }, { x: 112, y: 118 },
  { x: 108, y: 108 }, { x: 108, y: 98 }, { x: 104, y: 80 }, { x: 108, y: 62 },
  { x: 104, y: 48 }, { x: 110, y: 34 }, { x: 116, y: 16 }, { x: 122, y: 0 },
];
// farm track fording the river west of the bridge, running up to the village's west end — the
// ford crosses on the flat trough floor, not on the contested crest's flank
const WEST_FORD_ROAD = [
  { x: 50, y: 172 }, { x: 54, y: 148 }, { x: 50, y: 132 }, { x: 54, y: 118 },
  { x: 54, y: 106 }, { x: 56, y: 100 }, { x: 60, y: 80 }, { x: 64, y: 66 },
  { x: 72, y: 58 }, { x: 80, y: 56 },
];
// eastern farm track fording the river and ending on the Soviet rim's east flank — the ford
// crosses on the flat trough floor, not on the contested crest's flank
const EAST_FORD_ROAD = [
  { x: 172, y: 172 }, { x: 168, y: 148 }, { x: 174, y: 130 }, { x: 166, y: 116 },
  { x: 162, y: 106 }, { x: 158, y: 102 }, { x: 154, y: 80 }, { x: 148, y: 62 },
];
const CROSS_LANE = [
  { x: -2, y: 137 }, { x: 45, y: 133 }, { x: 85, y: 136 }, { x: 110, y: 134 },
  { x: 145, y: 131 }, { x: 185, y: 136 }, { x: 222, y: 133 },
];
const VILLAGE_STREET = [{ x: 78, y: 58 }, { x: 100, y: 56 }, { x: 118, y: 54 }, { x: 134, y: 52 }, { x: 150, y: 54 }];
// the two balkas: deep snow-filled gullies running roughly W-E, one on each side of the river
const BALKA_NORTH = [
  { x: 22, y: 68 }, { x: 62, y: 62 }, { x: 100, y: 70 }, { x: 138, y: 64 },
  { x: 176, y: 71 }, { x: 202, y: 65 },
];
const BALKA_SOUTH = [
  { x: 28, y: 120 }, { x: 68, y: 126 }, { x: 106, y: 119 }, { x: 144, y: 125 },
  { x: 182, y: 118 }, { x: 200, y: 113 }, { x: 208, y: 106 }, // mouth bending down to the river
];
// the Soviet rim: two trench lines across the ridge crest, facing south
const TRENCH_1 = [
  { x: 8, y: 92 }, { x: 40, y: 88 }, { x: 72, y: 94 }, { x: 104, y: 89 },
  { x: 136, y: 95 }, { x: 168, y: 90 }, { x: 198, y: 95 }, { x: 216, y: 91 },
];
const TRENCH_2 = [
  { x: 10, y: 82 }, { x: 42, y: 78 }, { x: 74, y: 84 }, { x: 106, y: 79 },
  { x: 138, y: 85 }, { x: 170, y: 80 }, { x: 200, y: 85 }, { x: 218, y: 81 },
];
// wire in front of the forward trench, in the bank strip between trench and water
const WIRE = [
  { x: 6, y: 98 }, { x: 38, y: 94 }, { x: 70, y: 100 }, { x: 102, y: 95 },
  { x: 134, y: 101 }, { x: 166, y: 96 }, { x: 198, y: 101 }, { x: 216, y: 97 },
];

/** Real relief (round-5 discipline). The Gniloy Tikich runs at the bottom of a genuine trough
 * ~9 m below the village ridge in the north and ~12 m below the German jump-off swell in the
 * south; the trench belt sits on the contested crest between trough and village, the two balkas
 * cut 3.2-3.8 m into the snowfields either side of the river, and the church knoll looks down
 * the whole southern approach. Total relief ~20 m; road caps 11%/20%, gully sides ~20-24% after
 * limitGrade — nothing above VEHICLE_MAX_GRADE, so only the water itself walls the map. */
function paintElevationFor(e: ElevationApi): void {
  e.base(5);
  e.rolling(1.0, 240, 3);
  e.rolling(0.3, 110, 21);
  // the trough: ground falls from both rims to the river — but gently: the ramps stay under
  // ~7%/tile so the graded roads that cross the trough can follow the natural bank instead of
  // cutting, and the cuts' own falloff (the bank faces) is the steepest thing on the walls
  e.slope({ x: 0, y: 0, w: 220, h: 100 }, 2, -2.5, Math.PI / 2);
  e.slope({ x: 0, y: 100, w: 220, h: 70 }, -2.5, 3.5, Math.PI / 2);
  // the northern ridge carrying Pochapintsy, and the church knoll at its centre
  e.ridge([{ x: -20, y: 46 }, { x: 110, y: 40 }, { x: 240, y: 50 }], 120, 4.8);
  e.hill(122, 40, 52, 4.2, 'smooth');
  // the contested crest north of the river — the Soviet trench belt sits on it; the bridge road
  // crosses it in a saddle: the ridge splits so the crossing sits on the crest's lowest point
  e.ridge([{ x: -20, y: 88 }, { x: 90, y: 86 }], 200, 2.0);
  e.ridge([{ x: 130, y: 86 }, { x: 240, y: 90 }], 200, 2.0);
  e.ridge([{ x: -20, y: 146 }, { x: 100, y: 142 }, { x: 240, y: 148 }], 104, 3.5);
  e.hill(40, 140, 56, -2.0, 'smooth');
  e.smoothElevation(2);
  e.valley(BALKA_NORTH, 56, 3.2);
  // natural draws down which the bridge road descends into the trough on both banks, keeping
  // the ambient under the road's 3-tile window bound without forcing a cutting the
  // pair-relaxation would erode
  e.valley([{ x: 108, y: 78 }, { x: 112, y: 100 }], 20, 2.8);
  e.valley([{ x: 110, y: 118 }, { x: 108, y: 104 }], 20, 2.3);
  e.valley(BALKA_SOUTH, 62, 3.8);
  // Road grading caps are a CEILING, not a target (main roads ~11%, minor tracks 20%): the
  // corridor follows the natural ground where that is already walkable and only cuts where it
  // is not. Forcing a track flatter than the hillside it crosses digs a cutting whose
  // near-vertical shoulders limitGrade then eats back into the road itself.
  // the channel is cut BEFORE the road corridors: gradeRoad's slope limiter then builds ≤11%
  // ramps down the three overlapping shallow bank faces (each ≤14%/tile) instead of painting a
  // cutting that the cuts' own falloff and the pair-relaxation would erase back to the wall
  e.cutRiver(GNIL, 14, 0.28);
  e.cutRiver(GNIL, 6, 0.21);
  e.cutRiver(GNIL, 2, 0.19);
  e.gradeRoad(MAIN_ROAD, 4, 11);
  e.gradeRoad(CROSS_LANE, 3, 20);
  e.gradeRoad(WEST_FORD_ROAD, 2, 20);
  e.gradeRoad(EAST_FORD_ROAD, 2, 20);
  e.smoothElevation(2);
  // re-assert the road grades: the smoothing pass above blends the graded corridor back into
  // the (much steeper) ground beside it, which is what let a "graded" road reach 22%
  e.gradeRoad(MAIN_ROAD, 4, 11);
  e.gradeRoad(CROSS_LANE, 3, 20);
  e.gradeRoad(VILLAGE_STREET, 3, 20);
  e.gradeRoad(WEST_FORD_ROAD, 2, 20);
  e.gradeRoad(EAST_FORD_ROAD, 2, 20);
  // no cliffs, and nothing above VEHICLE_MAX_GRADE (0.25) — only the water itself walls the map
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('snow');

  // scrub woodland belts in the hollows and off the village flanks — thin winter scrub, the
  // only concealment the open snowfields offer either side
  p.woods(20, 110, 7, 4);
  p.woods(60, 112, 7, 4);
  p.woods(128, 114, 8, 4);
  p.woods(186, 110, 7, 4);
  p.woods(70, 40, 8, 5);
  p.woods(158, 44, 8, 5);
  p.woods(30, 62, 7, 4);
  p.woods(196, 60, 8, 5);
  // bank scrub along both sides of the Gniloy Tikich (the river repaints any water gaps later)
  p.treeLine([{ x: 4, y: 96 }, { x: 44, y: 92 }, { x: 90, y: 95 }, { x: 130, y: 96 }, { x: 172, y: 93 }, { x: 214, y: 96 }], 31, 0.3);
  p.treeLine([{ x: 2, y: 112 }, { x: 46, y: 109 }, { x: 96, y: 113 }, { x: 146, y: 110 }, { x: 196, y: 106 }], 32, 0.3);

  // the Soviet rim, facing south: two trench lines across the ridge crest, wire in the bank
  // strip in front, and the two balkas as trench-terrain gully bottoms (dead ground, not walls)
  p.line(TRENCH_1, 'trench');
  p.line(TRENCH_2, 'trench');
  p.line(BALKA_NORTH, 'trench');
  p.line(BALKA_SOUTH, 'trench');
  p.line(WIRE, 'fence');

  // the partially frozen Gniloy Tikich
  p.river(GNIL, 3);

  // the engineer-cut relief road, gently curving, with the main bridge computed from the actual
  // road/river intersection (round-3 fix: a hand-placed rect drifts off the crossing and renders
  // as planks floating beside the road instead of paving it)
  p.road(MAIN_ROAD, 4, 'dirtroad');
  p.bridgeAcross(MAIN_ROAD, 4, GNIL, 3, { near: { x: 109, y: 99 } });
  // farm tracks fording the river; the fords are mud patches churned into the crossing itself —
  // no planks, the tracks wade the frozen river (paint order: the mud blob overwrites the
  // dirtroad/water at the crossing, flanking banks stay snow)
  p.road(WEST_FORD_ROAD, 2, 'dirtroad');
  const westFord = p.bridgeAcross(WEST_FORD_ROAD, 2, GNIL, 3, { near: { x: 54, y: 100 } }) ?? { x: 54, y: 101 };
  p.road(EAST_FORD_ROAD, 2, 'dirtroad');
  const eastFord = p.bridgeAcross(EAST_FORD_ROAD, 2, GNIL, 3, { near: { x: 159, y: 102 } }) ?? { x: 159, y: 102 };
  p.patch(westFord.x, westFord.y, 3, 'mud');
  p.patch(eastFord.x, eastFord.y, 3, 'mud');
  p.road(CROSS_LANE, 3, 'dirtroad');
  p.road(VILLAGE_STREET, 3, 'dirtroad');
  p.decorLine(MAIN_ROAD, 'pole', 9);
  p.decorLine(CROSS_LANE, 'pole', 10);

  // Pochapintsy: wooden huts along the village street, the walled stone church with its tower
  // and graveyard on the knoll above it, and a small kolkhoz yard on the west flank
  p.building(118, 42, 10, 8, 'stone'); // church
  p.building(121, 34, 4, 8, 'stone'); // tower
  p.line([{ x: 114, y: 32 }, { x: 136, y: 32 }, { x: 136, y: 50 }, { x: 114, y: 50 }, { x: 114, y: 32 }], 'stonewall');
  for (const [gx, gy] of [[116, 36], [126, 36], [116, 40], [126, 40]] as [number, number][]) p.addDecor('grave', gx, gy);
  p.building(96, 46, 6, 4, 'wood');
  p.building(140, 40, 6, 4, 'wood');
  p.building(144, 46, 6, 4, 'wood');
  p.building(96, 60, 6, 4, 'wood');
  p.building(104, 62, 6, 4, 'wood');
  p.building(136, 60, 6, 4, 'wood');
  p.building(86, 38, 7, 5, 'wood'); // kolkhoz barns, west end of the village
  p.building(84, 46, 7, 5, 'wood');
  p.addDecor('well', 132, 46);
  p.addDecor('haystack', 130, 50);
  p.addDecor('haystack', 92, 44);
  p.addDecor('cart', 128, 34);
  p.addDecor('woodpile', 132, 36);
  p.line([{ x: 92, y: 54 }, { x: 118, y: 52 }], 'fence'); // garden fence, north row
  p.line([{ x: 96, y: 66 }, { x: 122, y: 66 }], 'fence'); // garden fence, south row

  // the frozen mill by the west ford — stone, with barrels and crates stacked at its door
  p.building(66, 86, 7, 5, 'stone');
  p.addDecor('barrel', 65, 84);
  p.addDecor('crate', 68, 84);
  p.addDecor('crate', 70, 84);
  p.addDecor('sign', 63, 84);

  // Soviet pillboxes on the village's southern approach (G7)
  // (MapDef.bunkers below)

  // balance: bare orchards flanking the crossroads give the German spearhead's forms-up some
  // concealment on the open snowfield — harness-style read of the approach being almost fully
  // exposed on the final 200 m to the bridge
  p.orchard(86, 140, 16, 12, 3);
  p.orchard(124, 142, 14, 10, 3);

  // wrecked vehicles and abandoned carts where the relief columns stalled at the crossings
  p.addDecor('wreck', 56, 106);
  p.addDecor('wreck', 162, 107);
  p.addDecor('wreck', 112, 124);
  p.addDecor('cart', 48, 108);
  p.addDecor('sign', 52, 104);

  // barrage damage on the Soviet rim: shell craters along the trench belt
  p.patch(94, 90, 2.5, 'crater');
  p.patch(150, 93, 2, 'crater');
  p.patch(44, 90, 2, 'crater');
  p.patch(178, 88, 2, 'crater');

  // dug-in Soviet foxholes facing south: along the bank in front of the forward trench, on the
  // northern balka's lip, and on the village's southern approach — kept clear of the VLs and
  // the ford crossings
  const GERMAN_ADVANCE = { x: 110, y: 150 };
  const vlClear = [
    { x: 54, y: 101, r: 7 }, { x: 78, y: 90, r: 6 }, { x: 159, y: 102, r: 7 },
    { x: 203, y: 109, r: 7 }, { x: 130, y: 40, r: 6 }, { x: 110, y: 134, r: 5 },
  ];
  p.foxholeLine([{ x: 16, y: 97 }, { x: 56, y: 95 }, { x: 96, y: 98 }, { x: 136, y: 99 }, { x: 176, y: 95 }, { x: 212, y: 98 }], GERMAN_ADVANCE, { spacing: 6, stagger: 1.5, seedOffset: 5, keepClear: vlClear });
  p.foxholeLine([{ x: 30, y: 72 }, { x: 70, y: 66 }, { x: 110, y: 73 }, { x: 150, y: 68 }, { x: 190, y: 74 }], GERMAN_ADVANCE, { spacing: 7, stagger: 1.5, seedOffset: 6, keepClear: vlClear });
  p.foxholeLine([{ x: 96, y: 70 }, { x: 120, y: 68 }, { x: 142, y: 72 }], GERMAN_ADVANCE, { spacing: 6, stagger: 1.2, seedOffset: 7, keepClear: vlClear });

  // decor: winter scatter — haystacks on the snowfields, frozen wells and carts, drifts' rocks
  // and stumps, war debris; buildings/water are filtered out at build time below
  p.scatterDecor('haystack', 10, 108, 200, 48, 12, 60);
  p.scatterDecor('haystack', 80, 20, 80, 30, 4, 61);
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 24, 62);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 14, 63);
  p.scatterDecor('stump', 8, 94, 204, 26, 8, 64);
  p.scatterDecor('stump', 40, 24, 50, 24, 5, 65);
  p.scatterDecor('log', 16, 104, 40, 16, 6, 66);
  p.scatterDecor('log', 170, 100, 40, 14, 5, 67);
  p.scatterDecor('crate', 90, 30, 70, 30, 5, 68);
  p.scatterDecor('barrel', 90, 30, 70, 30, 5, 69);
  p.scatterDecor('cart', 20, 120, 180, 36, 5, 70);
  p.scatterDecor('woodpile', 14, 44, 50, 30, 4, 71);
}

const { decor, vectors }: { decor: DecorItem[]; vectors: MapVectorFeature[] } = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('snow');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  const decor = p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    // a foxhole later painted over (e.g. by the mill or the orchards) no longer exists
    if (d.kind === 'foxhole' && t !== 'trench') return false;
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
  return { decor, vectors: p.vectors };
})();

export const korsun_1944: MapDef = {
  id: 'korsun_1944',
  name: 'Korsun Pocket Rim',
  description: "February 1944: the German relief spearhead pushes north across the partially frozen Gniloy Tikich into the pocket's snowy southern rim, fighting through the balka gullies toward Pochapintsy Village and its stone church.",
  width: WIDTH,
  height: HEIGHT,
  season: 'winter',
  attacker: 'german',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Pochapintsy Village', x: 130, y: 40, value: 3 },
    { id: 1, name: 'Gniloy Tikich Ford', x: 54, y: 101, value: 2 },
    // balance: the two value-2 points sit on the ground the relief actually fights for — the
    // ford the spearhead must wade and the gully mouth covering its eastern flank — while the
    // crossroads and the mill are worth 1 each (total 9, within the 8-10 band).
    { id: 2, name: 'Southern Gully', x: 203, y: 109, value: 2 },
    { id: 3, name: 'Orchard Crossroads', x: 110, y: 134, value: 1 },
    { id: 4, name: 'Frozen Mill', x: 78, y: 90, value: 1 },
  ],
  deployZones: {
    // The Soviets deploy IN their trench belt on the crest: the old zone sat 76 tiles north in
    // the open snowfield behind the churchyard, where cover-seeking found nothing and the
    // German relief's prep (mortars + tank guns) wiped 27 of 50 Soviet falls in the first 200 s
    // with every man standing in the open (harness korsun seed=3: D open=40, openUnderFire 410 s).
    // On the crest the trench cover blunts the prep, and the relief must actually fight through
    // the belt as it did historically instead of sweeping an empty field.
    // The Germans form up BEHIND the southern swell (ridge y=142-148): the crest looks straight
    // into the old zone, so the Soviet trench line had every German team in its sights from the
    // first second and the whole infantry arm was destroyed inside 150 s without moving (diag
    // seed=2: 8 of 10 teams Dest at t=150). Behind the swell the relief gathers unseen.
    german: { x: 88, y: 154, w: 30, h: 16 },
    soviet: { x: 86, y: 70, w: 46, h: 26 },
  },
  // Soviet pillboxes dug into the village's southern approach (G7)
  bunkers: [{ x: 100, y: 64, w: 2, h: 1, side: 'soviet' }, { x: 126, y: 64, w: 2, h: 1, side: 'soviet' }],
  // COA overlays (G21): the relief's axes as they actually went — armour up the bridge road,
  // infantry assault on the trench belt's western flank, fire support from the southern swell,
  // and the eastern gully feint toward the balka mouth — against the Soviet defence on the
  // crest and its armour counterattack down the road.
  coa: {
    stages: ['Overwatch', 'Reconnoitre fords', 'Bridge or ford', 'Cut wire', 'Reduce trench line', 'Assault village'],
    german: [
      { pts: [{ x: 102, y: 146 }, { x: 108, y: 120 }, { x: 108, y: 98 }, { x: 118, y: 72 }, { x: 128, y: 48 }, { x: 130, y: 42 }], kind: 'armor' },
      { pts: [{ x: 94, y: 142 }, { x: 92, y: 112 }, { x: 90, y: 88 }], kind: 'assault' },
      { pts: [{ x: 112, y: 158 }, { x: 108, y: 96 }], kind: 'firesupport' },
      { pts: [{ x: 150, y: 150 }, { x: 180, y: 128 }, { x: 203, y: 110 }], kind: 'advance' },
    ],
    soviet: [
      { pts: [{ x: 20, y: 90 }, { x: 70, y: 86 }, { x: 120, y: 86 }, { x: 170, y: 88 }, { x: 208, y: 84 }], kind: 'defenses' },
      { pts: [{ x: 130, y: 42 }, { x: 122, y: 62 }, { x: 114, y: 84 }], kind: 'armor' },
      { pts: [{ x: 54, y: 64 }, { x: 54, y: 100 }], kind: 'firesupport' },
    ],
  },
  decor,
  vectors,
};
