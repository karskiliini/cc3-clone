import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 230;
const HEIGHT = 170;
const SEED = 1942;

/** October 1942: German assault groups fight into the Red Barricades ordnance factory between
 * the burned-out workers' settlement and the Volga bluffs — the Soviet defenders hold the halls
 * and the rail embankment that shields their crossing sites on the river. */
// ---------------------------------------------------------------- shared geometry
const RIVER = [
  { x: 224, y: -5 }, { x: 219, y: 40 }, { x: 223, y: 85 }, { x: 218, y: 130 }, { x: 222, y: 175 },
];
/** the sewer/drainage gully between the workers' housing and the factory, bending north-east to
 * drain toward the river */
const SEWER = [
  { x: 100, y: 80 }, { x: 101, y: 52 }, { x: 99, y: 30 }, { x: 112, y: 18 },
  { x: 138, y: 12 }, { x: 170, y: 10 }, { x: 198, y: 10 }, { x: 215, y: 14 },
];
const TRAM_STREET = [
  { x: 107, y: -5 }, { x: 105, y: 40 }, { x: 108, y: 85 }, { x: 106, y: 130 }, { x: 108, y: 175 },
];
const FACTORY_STREET = [
  { x: 58, y: 80 }, { x: 82, y: 78 }, { x: 106, y: 79 }, { x: 132, y: 78 },
  { x: 158, y: 80 }, { x: 186, y: 79 },
];

const GERMAN_APPROACH = [
  { x: -5, y: 98 }, { x: 28, y: 95 }, { x: 56, y: 90 }, { x: 82, y: 84 }, { x: 100, y: 81 },
];
/** the freight line on its embankment; the tram street's grading cuts under it at (107,127) */
const RAIL = [
  { x: -5, y: 127 }, { x: 40, y: 126 }, { x: 80, y: 128 }, { x: 120, y: 127 },
  { x: 160, y: 128 }, { x: 214, y: 127 },
];
/** the Soviet main line of resistance along the bank, facing west */
const SOVIET_MLR = [
  { x: 176, y: 44 }, { x: 180, y: 62 }, { x: 177, y: 80 }, { x: 181, y: 98 }, { x: 178, y: 116 },
];

/** High-bank Volga ground: the factory district stands on the plateau west of the river with the
 * bluff falling away over the eastern ~28 tiles; the German approach comes in over the low plain.
 * Relief ~16 m; the bluff bank relaxes to the 24% ceiling. */
function paintElevationFor(e: ElevationApi): void {
  e.base(14);
  e.rolling(2.2, 118, 5);
  e.rolling(0.7, 26, 25);
  // the Volga's west bank: the city plateau drops away to the water over the eastern edge — the
  // round-5 relief rule wants >=15 m of map-wide relief, so the bank ramps down 18 m over 38
  // tiles (22.5% grade, under the 24% limitGrade ceiling) to the river shelf at 0 m
  e.slope({ x: 190, y: 0, w: 40, h: 170 }, 0, -18, 0);
  e.smoothElevation(2);
  e.cutRiver(RIVER, 8, 2.0);
  // the rail embankment: ~2.4 m of fill carrying the freight line
  e.ridge(RAIL, 7, 2.4);
  // the sewer/drainage gully between the housing quarter and the factory
  e.valley(SEWER, 7, 1.8);
  e.smoothElevation(2);
  // streets are engineered (paved ~11% ceiling, approach track 20%) — a ceiling, not a target,
  // per the note in steppe_1943.ts
  const gradeStreets = (): void => {
    e.gradeRoad(TRAM_STREET, 6, 11);
    e.gradeRoad(FACTORY_STREET, 5, 11);
    e.gradeRoad(GERMAN_APPROACH, 3, 20);
  };
  for (let pass = 0; pass < 3; pass++) gradeStreets();
  e.smoothElevation(1);
  // re-assert the grades: the smoothing pass blends the graded corridors back into their banks,
  // which is what let a "graded" road exceed its ceiling. limitGrade runs last so the corridor
  // repainting never leaves an uncapped cliff behind it.
  gradeStreets();
  // enough sweeps to converge the whole bluff slope: the ramp's relaxation wave has to cross
  // the map, and 400 sweeps stop just short of it
  e.limitGrade(24, 1200);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('open');

  // autumn grass on the open west plain and the bluff top; the built-up ground is bare
  p.field(20, 34, 22, 24, 'grass', 1);
  p.field(16, 122, 24, 26, 'grass', 2);
  p.field(196, 36, 16, 48, 'grass', 3);
  p.field(192, 118, 18, 30, 'grass', 4);
  p.field(24, 66, 12, 10, 'tallgrass', 5);
  p.field(170, 136, 14, 10, 'tallgrass', 6);
  p.field(96, 64, 5, 12, 'mud', 7); // drainage seep at the gully's foot

  // the Volga along the east edge: 4-5 tiles of water at the foot of the bluffs
  p.river(RIVER, 5);

  // streets: the tram avenue, the factory street, and the German approach track
  p.road(GERMAN_APPROACH, 3, 'dirtroad');
  p.road(FACTORY_STREET, 5, 'pavedroad');
  p.road(TRAM_STREET, 6, 'pavedroad');
  p.decorLine(TRAM_STREET, 'tramwire', 7);
  p.decorLine(TRAM_STREET, 'pole', 12);

  // the sewer/drainage gully between housing and factory (trench: it gives cover)
  p.line(SEWER, 'trench');

  // workers' housing: rows of stone kamennye doma with courtyards, and the workers' school
  p.block(66, 32, 12, 9, 'stone');
  p.block(83, 32, 12, 9, 'stone');
  p.block(66, 52, 12, 9, 'stone');
  p.block(83, 52, 12, 9, 'stone');
  p.block(66, 98, 12, 9, 'stone');
  p.block(83, 98, 12, 9, 'stone');
  p.block(68, 74, 15, 11, 'stone'); // the workers' school
  // cellar passage between the two northern housing rows
  p.line([{ x: 80, y: 42 }, { x: 80, y: 51 }], 'trench');

  // the burned-out workers' settlement west of the housing: rubble footprints with surviving
  // wall segments (rubble discipline: confined to the ruin footprints and street patches,
  // like berlin_1945.ts)
  p.ruin(42, 60, 10, 8, 1);
  p.ruin(54, 72, 9, 8, 2);
  p.ruin(40, 84, 9, 9, 3);
  p.ruin(54, 98, 11, 8, 4);
  p.ruin(30, 110, 9, 7, 5);
  p.ruin(46, 34, 8, 7, 6);

  // Red Barricades: three long stone halls with sawtooth annex rows, the machinery yard between
  // the northern pair, a south assembly yard down to the rail sidings
  p.rect(114, 48, 54, 14, 'pavedroad'); // machinery yard
  p.building(114, 32, 54, 13, 'stone'); // hall A
  p.building(114, 62, 50, 13, 'stone'); // hall B
  p.building(118, 90, 44, 12, 'stone'); // hall C
  for (let i = 0; i < 6; i++) {
    p.building(117 + i * 9, 45, 6, 3, 'stone'); // sawtooth bays, yard side
    p.building(116 + i * 9, 58, 5, 3, 'stone');
  }
  p.rect(114, 104, 54, 12, 'pavedroad'); // south assembly yard
  // basement passage around the halls' east end
  p.line([{ x: 170, y: 48 }, { x: 170, y: 61 }], 'trench');

  // the freight line on its embankment, sidings into the south yard, overturned wagons
  p.line(RAIL, 'dirtroad');
  p.line([{ x: 132, y: 127 }, { x: 132, y: 110 }], 'dirtroad');
  p.line([{ x: 152, y: 127 }, { x: 152, y: 112 }], 'dirtroad');
  p.line([{ x: 96, y: 124 }, { x: 104, y: 124 }], 'rubble');
  p.line([{ x: 130, y: 131 }, { x: 138, y: 131 }], 'rubble');
  p.line([{ x: 130, y: 132 }, { x: 136, y: 132 }], 'crater');
  p.line([{ x: 148, y: 123 }, { x: 156, y: 123 }], 'rubble');
  p.addDecor('wreck', 134, 132);
  p.addDecor('wreck', 152, 124);
  p.addDecor('wreck', 100, 125);
  p.addDecor('wreck', 176, 131);
  p.addDecor('wreck', 60, 129);

  // the Soviet main line of resistance along the bank, foxholes facing the German approach
  p.line(SOVIET_MLR, 'trench');
  p.foxholeLine(
    [{ x: 186, y: 56 }, { x: 184, y: 76 }, { x: 187, y: 96 }, { x: 185, y: 114 }],
    { x: 100, y: 85 },
    { spacing: 6, stagger: 1.2, seedOffset: 7 },
  );

  // shellfire: strings along the approach and the two paved streets, plus big misses near the
  // factory; rubble stays in small street patches around the craters
  p.craterLine(GERMAN_APPROACH, { tStart: 0.35, tEnd: 0.9, seedOffset: 110, minGap: 14, maxGap: 22 });
  p.craterLine(FACTORY_STREET, { tStart: 0.25, tEnd: 0.75, seedOffset: 111, minGap: 16, maxGap: 26 });
  p.craterLine(TRAM_STREET, { tStart: 0.3, tEnd: 0.7, seedOffset: 112, minGap: 16, maxGap: 26 });
  p.patch(60, 64, 3, 'crater');
  p.patch(120, 110, 3, 'crater');
  p.patch(88, 52, 2.5, 'crater');
  p.patch(150, 86, 3, 'crater');
  p.patch(44, 104, 2.5, 'crater');
  p.patch(58, 62, 2, 'rubble');
  p.patch(122, 112, 2, 'rubble');
  p.patch(90, 50, 2, 'rubble');

  // autumn tree lines: the west plain's windbreaks and the bluff-top birches above the Volga
  p.treeLine([{ x: 6, y: 52 }, { x: 20, y: 48 }, { x: 38, y: 54 }], 31);
  p.treeLine([{ x: 4, y: 118 }, { x: 26, y: 114 }, { x: 48, y: 120 }], 32);
  p.treeLine([{ x: 200, y: 40 }, { x: 210, y: 60 }, { x: 204, y: 84 }, { x: 212, y: 108 }], 33);
  p.woods(10, 40, 7, 6);
  p.woods(206, 132, 6, 6);

  // scatter: settlement stumps and debris, factory barrels and crates, street furniture
  p.scatterDecor('stump', 36, 56, 30, 56, 10, 20);
  p.scatterDecor('log', 36, 56, 30, 56, 6, 21);
  p.scatterDecor('rocks', 110, 30, 64, 90, 10, 22);
  p.scatterDecor('barrel', 114, 48, 54, 14, 8, 23);
  p.scatterDecor('crate', 114, 104, 54, 12, 8, 24);
  p.scatterDecor('shellhole', 0, 0, WIDTH, HEIGHT, 18, 25);
  p.scatterDecor('puddle', 58, 74, 158, 10, 5, 26);
  p.scatterDecor('wreck', 40, 50, 140, 80, 4, 27);
  p.addDecor('sign', 107, 84);
  p.addDecor('woodpile', 120, 106);
  p.addDecor('barrel', 146, 118);
  p.addDecor('crate', 138, 107);
}

const { decor, vectors }: { decor: DecorItem[]; vectors: MapVectorFeature[] } = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('open');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  const decor = p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    // a foxhole later painted over (e.g. by the bluff-top grass fields) no longer exists
    if (d.kind === 'foxhole' && t !== 'trench') return false;
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
  return { decor, vectors: p.vectors };
})();

export const stalingrad_1942: MapDef = {
  id: 'stalingrad_1942',
  name: 'Red Barricades',
  description: 'October 1942: German assault groups fight into the Red Barricades ordnance factory between the burned-out workers\' settlement and the Volga bluffs, with the Soviet defenders holding the halls and the rail embankment above the river.',
  width: WIDTH,
  height: HEIGHT,
  season: 'autumn',
  attacker: 'german',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    // balance: the listed value scheme sums to 11; the 8-10 contract caps it at 10, so the
    // forward Workers' Housing objective carries 1 instead of 2 — the factory fight stays
    // the decisive objective while the housing quarter remains a stepping-stone.
    { id: 0, name: 'Red Barricades Halls', x: 126, y: 55, value: 3 },
    { id: 1, name: 'Machinery Yard', x: 140, y: 55, value: 2 },
    { id: 2, name: 'Rail Yard', x: 150, y: 128, value: 2 },
    { id: 3, name: 'Workers\' Housing', x: 81, y: 47, value: 1 },
    { id: 4, name: 'Tram Street', x: 105, y: 96, value: 1 },
    { id: 5, name: 'Volga Cliff', x: 206, y: 92, value: 1 },
  ],
  // one screen across, the two zones 160 tiles (320 m) apart, straddling the factory district:
  // the Germans deploy on the west plain, the Soviets on the bluff plateau by the bank
  deployZones: {
    german: { x: 16, y: 66, w: 32, h: 28 },
    soviet: { x: 180, y: 66, w: 28, h: 28 },
  },
  // Soviet pillboxes dug into the rubble edge of the burned-out settlement, covering the
  // approach track
  bunkers: [
    { x: 64, y: 76, w: 3, h: 3, side: 'soviet' },
    { x: 66, y: 92, w: 3, h: 3, side: 'soviet' },
  ],
  // COA overlays (G21): the German assault comes down the factory street into the halls with
  // armour hugging the tram street, mortar fires from the west plain; the Soviets defend the
  // halls and counterattack westward from the Volga-bank reserve, Katyushas behind.
  coa: {
    stages: ['Overwatch', 'Wire cutting', 'Reduce strongpoints', 'Assault factory halls', 'Consolidate'],
    german: [
      { pts: [{ x: 34, y: 80 }, { x: 90, y: 88 }, { x: 126, y: 58 }], kind: 'assault' },
      { pts: [{ x: 28, y: 96 }, { x: 70, y: 98 }, { x: 104, y: 92 }, { x: 124, y: 60 }], kind: 'armor' },
      { pts: [{ x: 36, y: 72 }, { x: 122, y: 54 }], kind: 'firesupport' },
    ],
    soviet: [
      { pts: [{ x: 108, y: 56 }, { x: 142, y: 58 }, { x: 150, y: 64 }], kind: 'defenses' },
      { pts: [{ x: 192, y: 78 }, { x: 164, y: 76 }, { x: 142, y: 68 }], kind: 'armor' },
      { pts: [{ x: 196, y: 68 }, { x: 150, y: 56 }], kind: 'firesupport' },
    ],
  },
  decor,
  vectors,
};
