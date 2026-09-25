import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 230;
const HEIGHT = 170;
const SEED = 1944;

/** July 1944: the German counterstroke at Magnuszew hurls itself against 8th Guards Army's
 * bridgehead over the Vistula — sandy dunes, a low dike and one pontoon crossing stand between
 * the attackers and the river. */
// ---------------------------------------------------------------- shared geometry (the landform
// must follow the same river and road lines as the tiles; see border_1941.ts)
const RIVER = [
  { x: 0, y: 153 }, { x: 40, y: 151 }, { x: 80, y: 154 }, { x: 120, y: 151 },
  { x: 160, y: 154 }, { x: 195, y: 151 }, { x: 230, y: 153 },
];
const MAIN_ROAD = [
  { x: 122, y: 0 }, { x: 119, y: 18 }, { x: 123, y: 36 }, { x: 118, y: 56 },
  { x: 122, y: 76 }, { x: 119, y: 92 }, { x: 122, y: 106 }, { x: 118, y: 124 }, { x: 117, y: 152 },
];
const DIKE_LANE = [
  { x: 0, y: 105 }, { x: 60, y: 102 }, { x: 122, y: 106 }, { x: 180, y: 103 }, { x: 230, y: 105 },
];
const EAST_LANE = [{ x: 124, y: 36 }, { x: 160, y: 33 }, { x: 196, y: 32 }, { x: 230, y: 30 }];
const WEST_LANE = [{ x: 116, y: 32 }, { x: 80, y: 30 }, { x: 40, y: 28 }, { x: 0, y: 26 }];

/** Real relief (round-5 discipline). The northern high ground falls ~13 m of steady slope to
 * the sandy flood plain, the two dune ridges rise 2-3 m out of it, and the dike is a shallow
 * 3 m bank ~45 tiles north of the water. The dip behind the northern dune gives the German
 * assault dead ground for its jump-off; the church looks straight down the road onto the dike
 * and the ford. Nothing steeper than the graded roads themselves. */
function paintElevationFor(e: ElevationApi): void {
  e.base(2);
  e.rolling(0.9, 96, 2);
  e.rolling(0.4, 31, 12);
  // northern high ground: Magnuszew's plateau, falling steadily to the sandy flood plain
  e.slope({ x: 0, y: 0, w: 230, h: 118 }, 14.2, 0, Math.PI / 2);
  // two shallow east-west dunes breaking the lowland, each elongated along its crest
  e.ridge([{ x: 20, y: 51 }, { x: 120, y: 47 }, { x: 210, y: 52 }], 30, 1.4);
  e.hill(70, 50, 26, 1.6, 'smooth');
  e.hill(160, 49, 22, 1.2, 'smooth');
  e.ridge([{ x: 40, y: 67 }, { x: 150, y: 64 }, { x: 220, y: 68 }], 26, 1.2);
  e.hill(85, 66, 22, 1.2, 'smooth');
  // dead ground behind the northern dune for the German jump-off
  e.hill(110, 34, 22, -1.2, 'smooth');
  // the low dike line, a 3 m flood bank with the road bridging it
  e.ridge([{ x: -10, y: 106 }, { x: 60, y: 103 }, { x: 122, y: 106 }, { x: 180, y: 103 }, { x: 240, y: 106 }], 12, 3.2);
  e.smoothElevation(2);
  e.cutRiver(RIVER, 6, 0.9);
  // Road grading caps are a CEILING, not a target (paved ~11%, tracks 20%): the corridors follow
  // the flat valley where it is already walkable and only cut where the dunes and dike rise.
  e.gradeRoad(MAIN_ROAD, 4, 11);
  e.gradeRoad(DIKE_LANE, 2, 20);
  e.gradeRoad(EAST_LANE, 2, 20);
  e.gradeRoad(WEST_LANE, 2, 20);
  e.smoothElevation(2);
  // re-assert the road grades: smoothing blends the graded corridor back into the ground beside
  // it, which is what let a "graded" road creep above its ceiling (winter_1941.ts round-5 fix)
  e.gradeRoad(MAIN_ROAD, 4, 11);
  e.gradeRoad(DIKE_LANE, 2, 20);
  e.gradeRoad(EAST_LANE, 2, 20);
  e.gradeRoad(WEST_LANE, 2, 20);
  // no cliffs, nothing above VEHICLE_MAX_GRADE
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('grass');

  // harvest stubble on the flood plain and the high ground's fields
  p.field(30, 14, 20, 9, 'crops', 1);
  p.field(180, 12, 20, 9, 'crops', 2);
  p.field(60, 84, 18, 8, 'tallgrass', 3);
  p.field(160, 86, 20, 8, 'crops', 4);
  p.field(30, 126, 22, 10, 'crops', 5);
  p.field(160, 126, 24, 10, 'crops', 6);
  p.field(96, 118, 16, 8, 'tallgrass', 7);
  p.field(40, 164, 20, 6, 'crops', 8);
  p.field(180, 163, 18, 6, 'crops', 9);

  // the sandy dune belts and the river bank: open sand against the grass, mud at the water's edge
  p.patch(25, 51, 10, 'open');
  p.patch(62, 49, 11, 'open');
  p.patch(100, 48, 10, 'open');
  p.patch(138, 49, 11, 'open');
  p.patch(176, 50, 10, 'open');
  p.patch(208, 52, 9, 'open');
  p.patch(45, 67, 9, 'open');
  p.patch(82, 66, 10, 'open');
  p.patch(120, 65, 10, 'open');
  p.patch(158, 66, 10, 'open');
  p.patch(192, 67, 9, 'open');
  p.patch(35, 147, 4, 'open');
  p.patch(75, 146, 4, 'open');
  p.patch(140, 147, 4, 'open');
  p.patch(195, 146, 4, 'open');
  p.patch(55, 150, 3, 'mud');
  p.patch(100, 149, 3, 'mud');
  p.patch(150, 150, 3, 'mud');
  p.patch(205, 149, 3, 'mud');

  // sparse pine woods along the dunes
  p.woods(24, 58, 12, 9);
  p.woods(200, 55, 13, 9);
  p.woods(126, 72, 11, 8);
  p.woods(56, 92, 10, 7);
  p.treeLine([{ x: 20, y: 51 }, { x: 120, y: 47 }, { x: 210, y: 52 }], 21, 0.2);

  // the Vistula along the southern edge, then the roads: Magnuszew's street runs dead south
  // off the plateau, over the dike, to the pontoon crossing
  const river = RIVER;
  p.river(river, 6);
  const mainRoad = MAIN_ROAD;
  p.road(mainRoad, 4, 'pavedroad');
  const dikeLane = DIKE_LANE;
  p.road(dikeLane, 2, 'dirtroad');
  p.road(EAST_LANE, 2, 'dirtroad');
  p.road(WEST_LANE, 2, 'dirtroad');

  // the pontoon crossing over the Vistula (rect computed from the true road/river intersection,
  // round-3 fix: a hand-placed bridge drifts off the crossing and renders beside the road)
  const fordPt = p.bridgeAcross(mainRoad, 4, river, 6, { near: { x: 117, y: 151 } }) ?? { x: 117, y: 151 };
  // the road bridges the dike over a culvert; re-span it at dike width after bridgeAcross lays
  // only the lane-width plank
  const dikeX = p.bridgeAcross(mainRoad, 4, dikeLane, 2) ?? { x: 122, y: 106 };
  p.bridge(dikeX.x - 2.5, dikeX.y - 6.5, 5, 13);

  // Magnuszew: wooden houses strung along the street, staggered either side
  const westHouses: [number, number][] = [[104, 16], [103, 26], [105, 36], [96, 30]];
  const eastHouses: [number, number][] = [[128, 8], [144, 30], [136, 42], [146, 44]];
  for (const [hx, hy] of westHouses) p.building(hx, hy, 6, 4, 'wood');
  for (const [hx, hy] of eastHouses) p.building(hx, hy, 6, 4, 'wood');
  // the stone church on the plateau, walled churchyard and graves
  p.building(128, 26, 9, 7, 'stone');
  p.building(131, 20, 3, 6, 'stone'); // tower
  p.line([{ x: 124, y: 19 }, { x: 142, y: 19 }, { x: 142, y: 39 }, { x: 124, y: 39 }, { x: 124, y: 19 }], 'stonewall');
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 3; gx++) p.addDecor('grave', 134 + gx * 2, 34 + gy * 3);
  }
  p.addDecor('well', 108, 34);
  p.addDecor('haystack', 98, 22);
  p.addDecor('woodpile', 146, 36);
  p.addDecor('cart', 102, 44);
  p.addDecor('haystack', 140, 12);

  // Soviet bridgehead defences: a trench line along the dike's north face either side of the
  // road, a reserve line on the bank flanking the ford, and rifle pits facing the dune belt
  p.line([{ x: 44, y: 100 }, { x: 80, y: 97 }, { x: 108, y: 100 }], 'trench');
  p.line([{ x: 134, y: 100 }, { x: 168, y: 97 }, { x: 202, y: 100 }], 'trench');
  p.line([{ x: 20, y: 142 }, { x: 48, y: 139 }, { x: 78, y: 142 }], 'trench');
  p.line([{ x: 130, y: 144 }, { x: 158, y: 141 }, { x: 184, y: 144 }], 'trench');
  const GERMAN_APPROACH = { x: 120, y: 20 };
  const vlClear = [{ x: 121, y: 105, r: 7 }, { x: 117, y: 146, r: 5 }];
  p.foxholeLine([{ x: 50, y: 103 }, { x: 108, y: 104 }], GERMAN_APPROACH, { spacing: 5, seedOffset: 5, keepClear: vlClear });
  p.foxholeLine([{ x: 136, y: 104 }, { x: 190, y: 103 }], GERMAN_APPROACH, { spacing: 5, seedOffset: 6, keepClear: vlClear });
  p.foxholeLine([{ x: 130, y: 138 }, { x: 150, y: 136 }], GERMAN_APPROACH, { spacing: 6, seedOffset: 7, keepClear: vlClear });

  // German barrage fire has chewed the approach between the dunes and the dike; craters
  // concentrate where the assault must funnel past the dike culvert and the ford
  p.craterLine(mainRoad, { tStart: 0.35, tEnd: 0.8, seedOffset: 500 });
  p.craterLine(dikeLane, { tStart: 0.4, tEnd: 0.7, seedOffset: 501 });
  p.scatterDecor('shellhole', 40, 78, 160, 24, 12, 71);

  // battle debris on the pontoon approach; telegraph poles along the street
  p.addDecor('wreck', 113, 136);
  p.addDecor('cart', 110, 139);
  p.addDecor('barrel', 120, 143);
  p.addDecor('crate', 124, 142);
  p.addDecor('sign', 113, 147);
  p.decorLine(mainRoad, 'pole', 8);
  p.decorLine(WEST_LANE, 'pole', 14);

  // decor: summer valley scatter — scrub on the dunes, flowers and driftwood near the bank
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 30, 60);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 18, 61);
  p.scatterDecor('flowers', 0, 0, WIDTH, HEIGHT, 22, 62);
  p.scatterDecor('stump', 12, 48, 30, 22, 7, 63);
  p.scatterDecor('log', 12, 50, 30, 18, 4, 64);
  p.scatterDecor('stump', 188, 46, 30, 22, 7, 65);
  p.scatterDecor('log', 188, 48, 30, 18, 4, 66);
  p.scatterDecor('haystack', 20, 120, 190, 24, 8, 67);
  p.scatterDecor('barrel', 0, 0, WIDTH, HEIGHT, 10, 68);
  p.scatterDecor('crate', 0, 0, WIDTH, HEIGHT, 8, 69);
  p.scatterDecor('puddle', 15, 138, 200, 14, 8, 70);
}

const { decor, vectors }: { decor: DecorItem[]; vectors: MapVectorFeature[] } = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('grass');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  const decor = p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
  return { decor, vectors: p.vectors };
})();

export const vistula_1944: MapDef = {
  id: 'vistula_1944',
  name: 'Bridgehead on the Vistula',
  description: 'July 1944: at Magnuszew the German counterattack drives south through the sand dunes to throw 8th Guards Army back over the Vistula — the dike line and the pontoon crossing are all that stand between the bridgehead and destruction.',
  width: WIDTH,
  height: HEIGHT,
  season: 'summer',
  attacker: 'german',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Magnuszew Church', x: 134, y: 37, value: 3 },
    { id: 1, name: 'Dike Line', x: 110, y: 105, value: 2 },
    { id: 2, name: 'River Ford', x: 117, y: 146, value: 2 },
    // balance: the dune belt sits in the German jump-off ground, behind their own start line —
    // it costs the defender little and is worth less than the dike or the crossing
    { id: 3, name: 'Northern Dunes', x: 90, y: 47, value: 1 },
    { id: 4, name: 'Pine Wood', x: 26, y: 58, value: 1 },
    { id: 5, name: 'South Fields', x: 172, y: 130, value: 1 },
  ],
  // the Soviet bridgehead holds the dike line and the ground in front of the river; the Germans
  // jump off north of the dunes. Both zones are one screen across and ~90 tiles apart,
  // straddling the dike, on walkable ground clear of water and buildings.
  deployZones: {
    german: { x: 60, y: 12, w: 30, h: 26 },
    soviet: { x: 96, y: 96, w: 30, h: 26 },
  },
  // prepared bridgehead defences: a casemate over the ford approach and a second dug into the
  // dike west of the culvert
  bunkers: [
    { x: 124, y: 137, w: 4, h: 3, side: 'soviet' },
    { x: 100, y: 101, w: 4, h: 3, side: 'soviet' },
  ],
  // COA overlays (G21): the German counterattack comes down the main road onto the dike line
  // with a second assault column over the dunes, mortar fires from the northern ridge; the
  // bridgehead's reserve is the church armour counterattacking to the dike, with the dike
  // itself the spine of the defence.
  coa: {
    stages: ['Overwatch', 'Reconnoitre fords', 'Bridge the dike', 'Reduce strongpoints', 'Assault church'],
    german: [
      { pts: [{ x: 78, y: 26 }, { x: 92, y: 50 }, { x: 104, y: 80 }, { x: 110, y: 104 }], kind: 'armor' },
      { pts: [{ x: 64, y: 26 }, { x: 86, y: 60 }, { x: 108, y: 102 }], kind: 'assault' },
      { pts: [{ x: 96, y: 26 }, { x: 110, y: 100 }], kind: 'firesupport' },
    ],
    soviet: [
      { pts: [{ x: 70, y: 104 }, { x: 110, y: 106 }, { x: 150, y: 104 }], kind: 'defenses' },
      { pts: [{ x: 136, y: 60 }, { x: 120, y: 78 }, { x: 112, y: 102 }], kind: 'armor' },
      { pts: [{ x: 140, y: 120 }, { x: 114, y: 106 }], kind: 'firesupport' },
    ],
  },
  decor,
  vectors,
};

