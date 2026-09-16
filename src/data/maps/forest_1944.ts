import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 200;
const HEIGHT = 160;
const SEED = 1944;

/** Summer 1944: Operation Bagration drives Soviet infantry through dense Belarusian forest
 * toward a German-held river crossing, its bridge and ford the only ways across. */
// ---------------------------------------------------------------- shared geometry
const RIVER = [
  { x: 100, y: 0 }, { x: 104, y: 25 }, { x: 98, y: 45 }, { x: 104, y: 60 },
  { x: 96, y: 80 }, { x: 100, y: 100 }, { x: 94, y: 120 }, { x: 100, y: 140 }, { x: 98, y: 160 },
];
const MAIN_ROAD = [
  { x: 10, y: 145 }, { x: 40, y: 132 }, { x: 65, y: 118 }, { x: 90, y: 100 },
  { x: 96, y: 88 }, { x: 96, y: 58 }, { x: 110, y: 45 }, { x: 140, y: 32 }, { x: 170, y: 18 }, { x: 190, y: 8 },
];
const FORD_ROAD = [{ x: 60, y: 128 }, { x: 74, y: 122 }, { x: 87, y: 118 }, { x: 100, y: 116 }];

/** Low, undulating forest floor — no commanding ground anywhere, just folds of a few metres that
 * swallow a man at 100 m — with the river lying in a wide, shallow flood plain. Relief ~9 m,
 * slopes mostly 2-6%. */
function paintElevationFor(e: ElevationApi): void {
  e.base(3);
  e.rolling(3.2, 124, 5);
  e.rolling(1.0, 26, 25);
  // the river runs in the bottom of a real valley: the forest floor falls ~14 m over the 200 m
  // from either map edge down to the water, so the two sides genuinely look across at each other
  e.slope({ x: 0, y: 0, w: 100, h: 160 }, 14, 0, 0);
  e.slope({ x: 100, y: 0, w: 100, h: 160 }, 0, 15, 0);
  // the flood plain: a flat shelf either side of the channel inside that fall
  e.valley(RIVER, 64, 2.6);
  // wooded shoulders east and west, with the lodge standing on the western one
  e.hill(43, 43, 44, 3.5, 'smooth');
  e.hill(158, 108, 44, 3.2, 'smooth');
  // dead ground on the approach to the ford
  e.hill(72, 122, 34, -2.2, 'smooth');
  e.smoothElevation(2);
  e.cutRiver(RIVER, 4, 0.6);
  // Road grading caps are a CEILING, not a target (main roads ~11%, minor tracks 20%): the
  // corridor follows the natural ground where that is already walkable and only cuts where it is
  // not. Forcing a track flatter than the hillside it crosses digs a cutting whose near-vertical
  // shoulders limitGrade then eats back into the road itself.
  e.gradeRoad(MAIN_ROAD, 3, 11);
  e.gradeRoad(FORD_ROAD, 3, 20);
  e.smoothElevation(2);
  // re-assert the road grades: the smoothing pass above blends the graded corridor back into
  // the (much steeper) ground beside it, which is what let a "graded" road reach 22%
  e.gradeRoad(MAIN_ROAD, 3, 11);
  e.gradeRoad(FORD_ROAD, 3, 20);
  // no cliffs, and nothing above VEHICLE_MAX_GRADE (0.25)
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('grass');

  // dense woods covering most of the map, built from several overlapping blobs per mass so
  // edges are ragged rather than single clean ellipses
  p.woods(50, 38, 26, 22);
  p.woods(68, 46, 16, 14);
  p.woods(48, 98, 24, 20);
  p.woods(64, 112, 14, 12);
  p.woods(138, 28, 24, 20);
  p.woods(156, 42, 14, 12);
  p.woods(148, 128, 22, 20);
  p.woods(165, 112, 14, 12);
  p.woods(28, 68, 16, 14);
  p.woods(168, 84, 18, 16);
  p.woods(32, 22, 12, 10);
  p.woods(165, 150, 12, 9);

  // clearings deliberately kept open inside the forest mass
  p.field(140, 92, 13, 10, 'grass', 1);
  p.field(70, 75, 11, 9, 'tallgrass', 2);
  p.orchard(40, 35, 8, 8, 2); // remnants of an old homestead orchard gone wild

  // river running roughly north-south with meanders, a bridge and a ford, banked with mud
  const river = RIVER;
  p.river(river, 3);
  // a few large mud patches along the riverbanks
  p.patch(102, 25, 4, 'mud');
  p.patch(97, 70, 4, 'mud');
  p.patch(97, 130, 4, 'mud');

  // forester's lodge with a woodpile and a small fenced garden
  p.building(40, 40, 7, 6, 'wood');
  p.line([{ x: 38, y: 38 }, { x: 50, y: 38 }, { x: 50, y: 48 }, { x: 38, y: 48 }, { x: 38, y: 38 }], 'fence');
  p.addDecor('woodpile', 44, 47);
  p.addDecor('cart', 42, 46);

  // a second small logging camp shed near the eastern woods
  p.building(160, 95, 5, 4, 'wood');
  p.addDecor('log', 163, 100);
  p.addDecor('log', 165, 101);

  // corduroy (dirt) road winding through the woods, crossing the main bridge
  const mainRoad = MAIN_ROAD;
  p.road(mainRoad, 2, 'dirtroad');
  // bridge rect computed from the actual road/river intersection (round-3 fix: the old
  // hand-placed rect sat well north of where the road really meets the river)
  p.bridgeAcross(mainRoad, 2, river, 3, { near: { x: 103, y: 57 } });
  // spur to the ford — extended so it actually reaches and crosses the river (it used to stop
  // one bank short, leaving a "ford" bridge tile floating on dry ground)
  const fordRoad = FORD_ROAD;
  p.road(fordRoad, 2, 'dirtroad');
  p.bridgeAcross(fordRoad, 2, river, 3, { near: { x: 96, y: 118 } });
  p.treeLine([{ x: 10, y: 145 }, { x: 40, y: 132 }, { x: 65, y: 118 }], 3, 0.35);
  p.decorLine(mainRoad, 'pole', 9);
  p.craterLine(mainRoad, { tStart: 0.3, tEnd: 0.75, seedOffset: 90 });

  // German rifle pits dug into the west bank between the bridge and the ford, facing the Soviet
  // approach from the east, in two small staggered groups clear of both crossings' VLs
  const SOVIET_APPROACH = { x: 190, y: 80 };
  const riverClear = [{ x: 101, y: 53, r: 7 }, { x: 95, y: 117, r: 7 }];
  p.foxholeLine([{ x: 91, y: 66 }, { x: 88, y: 84 }], SOVIET_APPROACH, { spacing: 5, stagger: 1.2, seedOffset: 7, keepClear: riverClear });
  p.foxholeLine([{ x: 92, y: 92 }, { x: 87, y: 106 }], SOVIET_APPROACH, { spacing: 5, stagger: 1.2, seedOffset: 8, keepClear: riverClear });

  // stumps/log piles ringing the big wood masses where logging has bitten into their edges,
  // and a wrecked vehicle bogged near the ford
  p.scatterDecor('stump', 30, 55, 30, 30, 10, 46);
  p.scatterDecor('stump', 130, 100, 30, 30, 10, 47);
  p.scatterDecor('log', 55, 90, 26, 26, 8, 48);
  p.addDecor('wreck', 90, 116);
  p.addDecor('cart', 44, 45);

  // decor: forest scatter (round-3 density pass)
  p.scatterDecor('stump', 0, 0, WIDTH, HEIGHT, 30, 40);
  p.scatterDecor('log', 0, 0, WIDTH, HEIGHT, 24, 41);
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 26, 42);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 16, 43);
  p.scatterDecor('puddle', 60, 70, 90, 60, 10, 44);
  p.scatterDecor('flowers', 130, 80, 30, 25, 6, 45);
  p.scatterDecor('barrel', 30, 30, 30, 20, 4, 49);
  p.scatterDecor('crate', 150, 90, 30, 20, 4, 50);
  p.addDecor('sign', 104, 55);
  p.addDecor('sign', 92, 116);
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

export const forest_1944: MapDef = {
  id: 'forest_1944',
  name: 'Belarus Forest',
  description: 'Summer 1944: Operation Bagration drives Soviet infantry through dense Belarusian forest toward a German-held river crossing, its bridge and ford the only ways across.',
  width: WIDTH,
  height: HEIGHT,
  season: 'summer',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Bridge', x: 101, y: 53, value: 3 },
    { id: 1, name: 'Lodge', x: 43, y: 43, value: 2 },
    { id: 2, name: 'Clearing', x: 140, y: 92, value: 1 },
    { id: 3, name: 'Ford', x: 95, y: 117, value: 2 },
    { id: 4, name: 'Logging Camp', x: 161, y: 97, value: 1 },
  ],
  // round-5 fix #8: the deploy zones used to sit on opposite map edges, 130-190 tiles apart,
  // with each force smeared across the map's full width — minutes of walking before contact.
  // They are now one screen across and 82 tiles (164 m) apart, straddling the contested ground.
  deployZones: {
    german: { x: 50, y: 58, w: 28, h: 28 },
    soviet: { x: 132, y: 58, w: 28, h: 28 },
  },
  decor,
  vectors,
};
