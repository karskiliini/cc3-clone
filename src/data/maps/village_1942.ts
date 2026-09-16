import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 220;
const HEIGHT = 160;
const SEED = 1942;

/** Autumn 1942: a Soviet rifle division counterattacks a German-held village strung along the
 * paved main street, anchored on the stone church and school. */
// ---------------------------------------------------------------- shared geometry
const MAIN_STREET = [
  { x: 8, y: 82 }, { x: 40, y: 79 }, { x: 75, y: 81 }, { x: 110, y: 80 },
  { x: 145, y: 78 }, { x: 180, y: 81 }, { x: 212, y: 79 },
];
const TRACK_NW = [{ x: 20, y: 79 }, { x: 22, y: 50 }];
const TRACK_SE = [{ x: 160, y: 80 }, { x: 165, y: 118 }];

/** The village sits on a hill with the church (105,62) on the crown — both deploy zones
 * (Soviet north, German south) are on the low ground and have to climb to reach it, which is
 * exactly the "harder to assault from below" case the manual describes. A subsidiary spur
 * carries the school to the east; the fields fall away north and south. Relief ~13 m,
 * hill slopes 6-9%. */
function paintElevationFor(e: ElevationApi): void {
  e.base(3);
  e.rolling(2.8, 122, 3);
  e.rolling(0.8, 28, 23);
  // the hill the village stands on is the map: 15 m of command over the low ground on both
  // flanks, ~150 tiles (300 m) across, with the church on its crown. Both deploy zones are on the
  // low ground and have to climb to reach it — the manual's "harder to assault from below" case.
  e.hill(105, 68, 78, 15, 'smooth');
  // a lower shoulder running east to the school, so the street is a saddle rather than a ledge
  e.ridge([{ x: 105, y: 74 }, { x: 140, y: 84 }, { x: 160, y: 96 }], 76, 4.5);
  // low ground both sides: the northern crop parcels and the southern meadows
  e.valley([{ x: 0, y: 14 }, { x: 110, y: 8 }, { x: 220, y: 16 }], 64, 3.0);
  e.valley([{ x: 0, y: 150 }, { x: 110, y: 156 }, { x: 220, y: 148 }], 64, 3.2);
  e.smoothElevation(2);
  // Road grading caps are a CEILING, not a target (main roads ~11%, minor tracks 20%): the
  // corridor follows the natural ground where that is already walkable and only cuts where it is
  // not. Forcing a track flatter than the hillside it crosses digs a cutting whose near-vertical
  // shoulders limitGrade then eats back into the road itself.
  e.gradeRoad(MAIN_STREET, 5, 11);
  e.gradeRoad(TRACK_NW, 3, 20);
  e.gradeRoad(TRACK_SE, 3, 20);
  e.smoothElevation(2);
  // re-assert the road grades: the smoothing pass above blends the graded corridor back into
  // the (much steeper) ground beside it, which is what let a "graded" road reach 22%
  e.gradeRoad(MAIN_STREET, 5, 11);
  e.gradeRoad(TRACK_NW, 3, 20);
  e.gradeRoad(TRACK_SE, 3, 20);
  // no cliffs, and nothing above VEHICLE_MAX_GRADE (0.25)
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('grass');

  // irregular crop parcels flanking the village, cut by grass strips and a dirt track
  p.field(35, 40, 26, 18, 'crops', 1);
  p.field(60, 35, 24, 16, 'crops', 2);
  p.field(28, 65, 20, 14, 'tallgrass', 3);
  p.field(165, 115, 28, 18, 'crops', 4);
  p.field(145, 130, 20, 14, 'crops', 5);
  p.field(190, 120, 18, 14, 'mud', 6);
  p.field(15, 115, 18, 14, 'crops', 7);

  p.line([{ x: 5, y: 32 }, { x: 45, y: 30 }, { x: 88, y: 34 }], 'hedge');
  p.line([{ x: 10, y: 78 }, { x: 45, y: 80 }], 'fence');
  p.line([{ x: 125, y: 122 }, { x: 170, y: 118 }, { x: 216, y: 124 }], 'hedge');
  p.treeLine([{ x: 5, y: 30 }, { x: 45, y: 28 }, { x: 88, y: 32 }], 20);
  p.treeLine([{ x: 125, y: 120 }, { x: 170, y: 116 }, { x: 216, y: 122 }], 21);

  // small woods to the south, copse to the north
  p.woods(110, 145, 16, 10);
  p.woods(190, 25, 12, 9);
  p.orchard(95, 110, 14, 12, 2);

  // main street, gently curving, paved; farm tracks feeding it
  const mainStreet = MAIN_STREET;
  p.road(mainStreet, 4, 'pavedroad');
  p.road(TRACK_NW, 2, 'dirtroad');
  p.road(TRACK_SE, 2, 'dirtroad');
  p.decorLine(mainStreet, 'pole', 6);
  p.craterLine(mainStreet, { tStart: 0.3, tEnd: 0.75, seedOffset: 100 });

  // two rows of wood houses along the street, alternating sides, irregular gaps, with garden
  // fences behind each row
  const northY = 63, southY = 96;
  let x = 14;
  for (let i = 0; i < 7; i++) {
    const gap = 4 + Math.round((i * 37) % 5);
    p.building(x, northY, 7, 6, 'wood');
    p.addDecor('flowers', x + 3, northY - 2);
    x += 7 + gap;
  }
  p.line([{ x: 12, y: northY - 5 }, { x: 200, y: northY - 5 }], 'fence');
  x = 20;
  for (let i = 0; i < 7; i++) {
    const gap = 3 + Math.round((i * 53) % 6);
    p.building(x, southY, 7, 5, 'wood');
    p.addDecor('woodpile', x + 5, southY + 6);
    x += 7 + gap;
  }
  p.line([{ x: 18, y: southY + 6 }, { x: 200, y: southY + 6 }], 'fence');

  // church (stone) with a stone wall enclosure and graveyard
  p.building(100, 56, 10, 8, 'stone');
  p.building(103, 48, 4, 8, 'stone'); // tower
  // left edge at x=99 (not 96) so it clears the last north-row house, which reaches x=96
  p.line([{ x: 99, y: 46 }, { x: 116, y: 46 }, { x: 116, y: 68 }, { x: 99, y: 68 }, { x: 99, y: 46 }], 'stonewall');
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 4; gx++) p.addDecor('grave', 98 + gx * 2, 60 + gy * 2);
  }

  // school (stone) with its own yard fence
  p.building(150, 92, 9, 7, 'stone');
  p.line([{ x: 148, y: 90 }, { x: 161, y: 90 }, { x: 161, y: 101 }, { x: 148, y: 101 }, { x: 148, y: 90 }], 'fence');

  // mill (wood) and a well in the little square near the street
  p.building(55, 74, 6, 6, 'wood');
  p.addDecor('well', 66, 82);
  p.addDecor('cart', 68, 84);
  p.addDecor('sign', 63, 79);

  // a couple of farmsteads at the village edges
  p.farmstead(180, 55, 30);
  p.farmstead(35, 130, 32);

  // a few large mud patches near the street and the dirt-track low ground
  p.patch(21, 73, 3, 'mud'); // on the dirt track, clear of the north-row house row
  p.patch(162, 100, 3, 'mud');
  p.patch(100, 84, 3, 'mud');

  // a wrecked vehicle and abandoned cart near the street, stumps/logs at the woods edges
  p.addDecor('wreck', 90, 82);
  p.addDecor('wreck', 130, 76);
  p.scatterDecor('stump', 100, 132, 22, 18, 6, 66);
  p.scatterDecor('log', 178, 15, 20, 16, 5, 67);

  // rural/village decor scatter
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 24, 60);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 12, 61);
  p.scatterDecor('barrel', 5, 70, 210, 20, 8, 62);
  p.scatterDecor('crate', 5, 70, 210, 20, 6, 63);
  p.scatterDecor('puddle', 5, 75, 210, 15, 10, 64);
  p.scatterDecor('stump', 100, 130, 30, 20, 5, 65);
}

const { decor, vectors }: { decor: DecorItem[]; vectors: MapVectorFeature[] } = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('open');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  const decor = p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
  return { decor, vectors: p.vectors };
})();

export const village_1942: MapDef = {
  id: 'village_1942',
  name: 'Ukrainian Village',
  description: 'Autumn 1942: a Soviet rifle division counterattacks a German-held village strung along the paved main street, anchored on the stone church and school.',
  width: WIDTH,
  height: HEIGHT,
  season: 'autumn',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Church', x: 105, y: 62, value: 3 },
    // balance (round 5): the School sits behind the German line and North Farm on the Soviet
    // side of the hill, so their values are swapped — the prize stays the hill itself.
    { id: 1, name: 'School', x: 154, y: 95, value: 1 },
    { id: 2, name: 'Main Street', x: 110, y: 80, value: 2 },
    { id: 3, name: 'Mill', x: 58, y: 77, value: 1 },
    { id: 4, name: 'North Farm', x: 180, y: 55, value: 2 },
    { id: 5, name: 'South Farm', x: 35, y: 130, value: 1 },
  ],
  // round-5 fix #8: the deploy zones used to sit on opposite map edges, 130-190 tiles apart,
  // with each force smeared across the map's full width — minutes of walking before contact.
  // They are now one screen across and 90 tiles (180 m) apart, straddling the contested ground.
  deployZones: {
    soviet: { x: 91, y: 12, w: 28, h: 28 },
    german: { x: 91, y: 102, w: 28, h: 28 },
  },
  decor,
  vectors,
};
