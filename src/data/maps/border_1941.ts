import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 200;
const HEIGHT = 150;
const SEED = 1941;

// ---------------------------------------------------------------- geometry shared by the
// terrain painter and the ground-relief painter (the landform has to follow the same stream and
// road lines the tiles do, or the water runs along a hillside and the road climbs a bank).
// meanders kept shallow (+-3 tiles): a tighter bulge makes cutRiver's channel run beside its own
// polyline vertex, which leaves the "bed" on the vertex sitting above both its banks.
const RIVER = [
  { x: 145, y: 0 }, { x: 142, y: 20 }, { x: 147, y: 40 }, { x: 142, y: 60 },
  { x: 146, y: 75 }, { x: 143, y: 95 }, { x: 148, y: 115 }, { x: 145, y: 135 }, { x: 148, y: 150 },
];
const MAIN_ROAD = [
  { x: 0, y: 78 }, { x: 40, y: 74 }, { x: 80, y: 78 }, { x: 100, y: 75 },
  { x: 130, y: 72 }, { x: 165, y: 76 }, { x: 200, y: 78 },
];
// the north-south road follows the crest of the ridge (a lane on a watershed), so it never has
// to be cut deeply through it — see paintElevationFor.
const CROSS_ROAD = [
  { x: 82, y: 5 }, { x: 92, y: 40 }, { x: 100, y: 75 }, { x: 94, y: 110 }, { x: 99, y: 145 },
];
const TRACK_N = [{ x: 80, y: 40 }, { x: 90, y: 56 }, { x: 100, y: 75 }];
const TRACK_S = [{ x: 82, y: 112 }, { x: 92, y: 94 }, { x: 100, y: 75 }];

/** Real relief (round-5 fix #2: the old 11 m of swell never read on screen, and no crest ever
 * masked anything). A long north-south RIDGE divides the two deploy zones, its crest carrying the
 * crossroads knoll — the commanding ground and the map's main objective. West of the crest two
 * broad HOLLOWS give the German attacker dead ground to work forward in; east of it the land
 * falls into the cut valley of the frontier stream. Total relief ~21 m, ~10-17 m of it visible
 * across a single screen; mean grade ~10%, nothing steeper than 24% (so every tile stays
 * drivable, VEHICLE_MAX_GRADE 0.25) — the steepest ground is the stream's banks and the knoll's
 * south shoulder. */
function paintElevationFor(e: ElevationApi): void {
  e.base(7);
  // broad swells only; the short second call supplies the squad-scale folds a man can vanish in
  e.rolling(3.0, 118, 1);
  e.rolling(0.8, 30, 21);
  // the ridge: crest around x82-100, running the full height of the map, 11 m over the plain and
  // 140 tiles (280 m) wide, so its flanks average ~8% while the crest masks each deploy zone from
  // the other
  e.ridge([{ x: 78, y: -20 }, { x: 94, y: 40 }, { x: 89, y: 88 }, { x: 99, y: 175 }], 140, 11);
  // the commanding knoll the crossroads stands on — the highest ground on the map
  e.hill(100, 75, 46, 4.0, 'smooth');
  // dead ground on the western approach: two wide hollows the attacker can work along
  e.hill(44, 56, 42, -2.6, 'smooth');
  e.hill(54, 110, 38, -2.2, 'smooth');
  // the stream's valley: broad low ground carrying it, ~6 m below the shoulders
  e.valley(RIVER, 130, 6);
  // the far (eastern) bank climbs again out of the stream's trough, so the watercourse really is
  // the low ground rather than the near edge of a slab tilting off the map
  e.slope({ x: 152, y: 0, w: 48, h: 150 }, 0, 3.5, 0);
  e.smoothElevation(2);
  // the stream bed itself, below its banks
  e.cutRiver(RIVER, 5, 1.2);
  // Road grading caps are deliberately loose (main roads ~11%, farm tracks 20%). They are a
  // CEILING, not a target: the corridor follows the natural ground wherever that is already
  // walkable, and only cuts where it is not. Forcing a cart track flatter than the hillside it
  // crosses digs a deep cutting whose near-vertical shoulders limitGrade then eats back into the
  // road itself — which is exactly how a "graded" road ended up at 22% before this pass.
  e.gradeRoad(MAIN_ROAD, 3, 11);
  e.gradeRoad(CROSS_ROAD, 3, 11);
  e.gradeRoad(TRACK_N, 2.5, 20);
  e.gradeRoad(TRACK_S, 2.5, 20);
  e.smoothElevation(2);
  // re-assert the road grades: the smoothing pass above blends the graded corridor back into
  // the (much steeper) ground beside it, which is what let a "graded" road reach 22%
  e.gradeRoad(MAIN_ROAD, 3, 11);
  e.gradeRoad(CROSS_ROAD, 3, 11);
  e.gradeRoad(TRACK_N, 2.5, 20);
  e.gradeRoad(TRACK_S, 2.5, 20);
  // no cliffs: 24% keeps every tile under VEHICLE_MAX_GRADE (0.25), so the relief never splits
  // the map into unreachable vehicle regions
  e.limitGrade(24);
  e.clampRange(0, 25);
}

/** June 1941: German spearheads cross the frontier stream, brushing aside a thin Soviet border
 * guard screen holding two farmsteads and a crossroads. */
function paintMap(p: MapPainter): void {
  p.fill('grass');

  // irregular crop parcels either side of the stream, built from overlapping field blobs
  p.field(35, 35, 22, 18, 'crops', 1);
  p.field(52, 48, 16, 14, 'crops', 2);
  p.field(30, 60, 18, 12, 'tallgrass', 3);
  p.field(60, 105, 20, 16, 'crops', 4);
  p.field(80, 118, 14, 12, 'crops', 5);
  p.field(115, 110, 18, 14, 'mud', 6);
  p.field(165, 100, 20, 16, 'crops', 7);
  p.field(20, 20, 12, 10, 'grass', 8); // strip breaking up the NW parcel edge

  // hedge/fence strips separating parcels
  p.line([{ x: 15, y: 20 }, { x: 40, y: 18 }, { x: 62, y: 22 }], 'hedge');
  p.line([{ x: 20, y: 72 }, { x: 55, y: 68 }], 'hedge');
  p.line([{ x: 45, y: 95 }, { x: 90, y: 98 }, { x: 130, y: 96 }], 'hedge');
  p.line([{ x: 130, y: 92 }, { x: 175, y: 88 }], 'fence');

  // balance: concealed corridor from the German jump-off toward the crossroads/bridge — the
  // long open stretch between the two farmsteads (roughly x30-95, y75-90) let the Soviet MG/AT
  // gun screen dominate the advance unopposed (harness: defender out-shot attacker 5-10x on this
  // map). Added early so the roads/farmsteads painted later cut through it cleanly.
  p.line([{ x: 30, y: 82 }, { x: 55, y: 80 }, { x: 80, y: 83 }, { x: 95, y: 79 }], 'hedge');
  p.field(42, 78, 8, 6, 'tallgrass', 92);
  p.field(68, 82, 7, 5, 'tallgrass', 93);

  // woods block NE, a smaller copse SW, denser tree lines along field edges and the road
  // (round-2 critique: the summer map read as under-treed compared to the reference)
  p.woods(170, 30, 22, 18);
  p.woods(38, 132, 13, 9);
  p.treeLine([{ x: 15, y: 18 }, { x: 40, y: 16 }, { x: 62, y: 20 }], 11, 0.05);
  p.treeLine([{ x: 130, y: 90 }, { x: 175, y: 86 }], 12, 0.05);
  p.treeLine([{ x: 20, y: 55 }, { x: 20, y: 72 }], 14, 0.1);
  p.treeLine([{ x: 165, y: 100 }, { x: 185, y: 100 }], 15, 0.1);
  p.treeLine([{ x: 0, y: 78 }, { x: 40, y: 74 }], 16, 0.35); // sparse trees along the road shoulder
  // round-3 critique #4: extra field-edge tree lines around the South Farm / crossroads area,
  // which read visibly sparser than the reference in the captured screenshots.
  p.treeLine([{ x: 45, y: 95 }, { x: 90, y: 98 }, { x: 130, y: 96 }], 17, 0.2); // beside the SE hedge
  p.treeLine([{ x: 58, y: 108 }, { x: 90, y: 108 }], 18, 0.2); // south of the second farmstead

  // orchard between the two farmsteads
  p.orchard(85, 32, 16, 14, 2);

  // stream running roughly north-south with meanders, banks of mud/tallgrass
  const river = RIVER;
  p.river(river, 3);
  p.treeLine([{ x: 145, y: 0 }, { x: 141, y: 20 }, { x: 148, y: 40 }, { x: 140, y: 60 }], 13, 0.4);
  // a few large mud patches along the stream banks and one at the crossroads' worn shoulder
  p.patch(143, 20, 4, 'mud');
  p.patch(145, 60, 4, 'mud');
  p.patch(148, 115, 4, 'mud');
  p.patch(60, 76, 3, 'mud');

  // curving dirt road west-east through the crossroads, spur south, farm tracks
  const mainRoad = MAIN_ROAD;
  // widths: ~2 tiles (~40px) for the main roads, 1.5 for farm tracks (ref_cc3_1479 roads are
  // narrow tracks; 1.5 is the narrowest that still rasterises a 4-connected tile path on
  // diagonals — half-width 0.75 > the 0.707 worst-case tile-centre distance).
  p.road(mainRoad, 2, 'dirtroad');
  p.road(CROSS_ROAD, 2, 'dirtroad');
  p.road(TRACK_N, 1.5, 'dirtroad'); // farm track
  p.road(TRACK_S, 1.5, 'dirtroad'); // farm track
  // bridge rect computed from the actual road/river intersection (round-3 fix: the old
  // hand-placed rect drifted off the true crossing and rendered as planks beside the road)
  const crossing = p.bridgeAcross(mainRoad, 2, river, 3, { near: { x: 141, y: 75 } }) ?? { x: 141, y: 75 };

  // telegraph poles along the main road, and battle damage concentrated in the contested
  // middle third around the crossroads/bridge (round-3: sparser than the original's road
  // scarring, matching the crater density along the roads in ref_cc3_1479.png)
  p.decorLine(mainRoad, 'pole', 7);
  p.craterLine(mainRoad, { tStart: 0.3, tEnd: 0.75, seedOffset: 70 });

  // two farmsteads with yards, fences, orchard, veg patch, decor
  // round-5 fix #8: both farmsteads moved into the contested middle third, between the two
  // (now much closer) deploy zones, so they are objectives to fight over rather than ground one
  // side starts on top of.
  p.farmstead(80, 40, 20);
  p.farmstead(82, 112, 22);

  // stray fence remnants along the near farmstead's field edge, and a hedge line closing off
  // the SE crop parcel from the road shoulder
  p.line([{ x: 20, y: 30 }, { x: 20, y: 55 }], 'fence');
  p.line([{ x: 155, y: 90 }, { x: 190, y: 95 }], 'hedge');

  // a wrecked vehicle and abandoned cart near the crossroads, wood/log piles at the woods edges
  p.addDecor('wreck', 96, 80);
  p.addDecor('cart', 103, 73);
  p.scatterDecor('stump', 150, 12, 45, 30, 8, 46);
  p.scatterDecor('log', 155, 15, 35, 22, 6, 47);
  p.scatterDecor('stump', 20, 118, 30, 22, 6, 48);
  p.scatterDecor('log', 22, 122, 28, 18, 4, 49);

  // decor: rural scatter (round-3 density pass toward the original's 150-200 items/map)
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 20, 40);
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 30, 41);
  p.scatterDecor('flowers', 20, 10, 70, 60, 14, 42);
  p.scatterDecor('stump', 150, 15, 45, 35, 6, 43);
  p.scatterDecor('puddle', 0, 60, WIDTH, 30, 12, 44);
  p.scatterDecor('log', 145, 10, 40, 30, 5, 45);
  p.scatterDecor('barrel', 30, 30, 60, 40, 6, 72);
  p.scatterDecor('crate', 40, 85, 50, 40, 6, 73);
  p.addDecor('sign', 100, 76);
  p.addDecor('sign', crossing.x - 3, crossing.y - 2);
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

export const border_1941: MapDef = {
  id: 'border_1941',
  name: 'Border Crossing',
  description: 'June 1941: German spearheads push across the frontier at dawn, brushing aside a thin Soviet border guard screen holding the crossroads farmsteads along the stream.',
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
    { id: 0, name: 'Crossroads', x: 100, y: 75, value: 3 },
    { id: 1, name: 'North Farm', x: 80, y: 40, value: 1 },
    { id: 2, name: 'South Farm', x: 82, y: 112, value: 2 },
    // the bridge is now well behind the Soviet deploy zone: a deep objective, not the main prize
    { id: 3, name: 'Bridge', x: 149, y: 74, value: 1 },
    { id: 4, name: 'Orchard', x: 92, y: 38, value: 1 },
  ],
  // round-5 fix #8: the old zones were 170 tiles (340 m) apart with each force smeared over the
  // map's full 150-tile height, so a battle spent its first 2-3 minutes walking. Both are now one
  // screen tall and 90 tiles (180 m) apart, with the ridge crest between them.
  deployZones: {
    german: { x: 24, y: 50, w: 26, h: 50 },
    soviet: { x: 114, y: 50, w: 26, h: 50 },
  },
  decor,
  vectors,
};
