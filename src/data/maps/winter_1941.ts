import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 200;
const HEIGHT = 150;
const SEED = 194112;

/** December 1941: a German drive on the Moscow highway pushes through a snowbound village on
 * the frozen Skhodnya, the Soviet defenders falling back on a dug-in trench line beyond it. */
// ---------------------------------------------------------------- shared geometry (see the
// note in border_1941.ts: the landform must follow the same river and road lines as the tiles)
const RIVER = [
  { x: 104, y: 0 }, { x: 99, y: 25 }, { x: 106, y: 50 }, { x: 99, y: 80 },
  { x: 105, y: 105 }, { x: 100, y: 130 }, { x: 103, y: 150 },
];
const MAIN_ROAD = [
  { x: 0, y: 82 }, { x: 30, y: 78 }, { x: 60, y: 82 }, { x: 90, y: 79 },
  { x: 100, y: 80 }, { x: 120, y: 81 }, { x: 150, y: 77 }, { x: 180, y: 80 }, { x: 200, y: 78 },
];
const SIDE_LANE = [{ x: 130, y: 0 }, { x: 132, y: 40 }, { x: 129, y: 81 }, { x: 131, y: 120 }, { x: 130, y: 150 }];
const KOLKHOZ_SPUR = [{ x: 60, y: 82 }, { x: 70, y: 96 }, { x: 60, y: 116 }, { x: 55, y: 115 }];
const FORD_ROAD = [{ x: 92, y: 122 }, { x: 100, y: 130 }, { x: 108, y: 138 }];
const HALT_SPUR = [{ x: 150, y: 77 }, { x: 153, y: 55 }, { x: 155, y: 38 }];

/** Real relief (round-5 fix #2). The frozen Skhodnya runs at the bottom of a genuine VALLEY
 * ~9 m below the shoulders on either side; a RIDGE on each bank carries the two jump-off areas,
 * and the village's church stands on a knoll on the east shoulder looking straight down onto the
 * bridge. A hollow west of the river gives the German attacker dead ground short of the crossing.
 * Total relief ~20 m, ~9-16 m across a screen; mean grade ~9%, nothing above 24% (under
 * VEHICLE_MAX_GRADE, so the valley never traps a tank). */
function paintElevationFor(e: ElevationApi): void {
  e.base(4);
  e.rolling(2.6, 118, 2);
  e.rolling(0.8, 28, 22);
  // the valley itself, built as two long ramps meeting at the river: the ground falls ~16 m over
  // the 200 m from either map edge down to the water, a steady 8% — the shape you actually walk
  // down, and the reason the far bank's village looks down on the crossing.
  e.slope({ x: 0, y: 0, w: 100, h: 150 }, 16, 0, 0);
  e.slope({ x: 100, y: 0, w: 100, h: 150 }, 0, 17, 0);
  // the east shoulder is a defined ridge line carrying the village above the flood plain
  e.ridge([{ x: 146, y: -20 }, { x: 140, y: 50 }, { x: 148, y: 100 }, { x: 142, y: 170 }], 90, 4.0);
  // the church knoll on the east bank, straight above the bridge, and the kolkhoz swell west
  e.hill(112, 56, 34, 5.0, 'smooth');
  e.hill(58, 112, 38, 2.4, 'smooth');
  // dead ground short of the crossing, on the German side of the river
  e.hill(78, 96, 38, -2.6, 'smooth');
  e.smoothElevation(2);
  e.cutRiver(RIVER, 4, 0.6);
  // Road grading caps are a CEILING, not a target (main roads ~11%, minor tracks 20%): the
  // corridor follows the natural ground where that is already walkable and only cuts where it is
  // not. Forcing a track flatter than the hillside it crosses digs a cutting whose near-vertical
  // shoulders limitGrade then eats back into the road itself.
  e.gradeRoad(MAIN_ROAD, 5, 11);
  e.gradeRoad(SIDE_LANE, 3, 20);
  e.gradeRoad(KOLKHOZ_SPUR, 3, 20);
  e.gradeRoad(FORD_ROAD, 3, 20);
  e.gradeRoad(HALT_SPUR, 3, 20);
  e.smoothElevation(2);
  // re-assert the road grades: the smoothing pass above blends the graded corridor back into
  // the (much steeper) ground beside it, which is what let a "graded" road reach 22%
  e.gradeRoad(MAIN_ROAD, 5, 11);
  e.gradeRoad(SIDE_LANE, 3, 20);
  e.gradeRoad(KOLKHOZ_SPUR, 3, 20);
  e.gradeRoad(FORD_ROAD, 3, 20);
  e.gradeRoad(HALT_SPUR, 3, 20);
  // no cliffs, and nothing above VEHICLE_MAX_GRADE (0.25)
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('snow');

  // snow-covered fields with stubble (crops) showing through the drifts, cut by hedge/fence lines
  p.field(30, 30, 18, 14, 'crops', 1);
  p.field(150, 25, 16, 12, 'crops', 2);
  p.field(40, 132, 20, 14, 'crops', 3);
  p.field(148, 128, 18, 14, 'crops', 4);
  p.field(18, 100, 14, 10, 'crops', 5);
  p.field(185, 100, 12, 10, 'crops', 6);
  p.line([{ x: 10, y: 22 }, { x: 45, y: 18 }, { x: 70, y: 22 }], 'hedge');
  p.line([{ x: 130, y: 18 }, { x: 170, y: 16 }], 'fence');
  p.line([{ x: 15, y: 108 }, { x: 55, y: 104 }], 'hedge');
  p.line([{ x: 128, y: 108 }, { x: 172, y: 104 }], 'fence');

  // woods on the flanks, dense with a scrub fringe, for the attacker's approach and the
  // defender's rear
  p.woods(20, 55, 14, 12);
  p.woods(188, 55, 12, 10);
  p.woods(14, 135, 10, 8);
  p.woods(195, 130, 9, 8);
  p.treeLine([{ x: 10, y: 22 }, { x: 45, y: 18 }, { x: 70, y: 22 }], 21, 0.1);
  p.treeLine([{ x: 15, y: 108 }, { x: 55, y: 104 }], 22, 0.15);

  // the frozen river, a wide bridge carrying the main street across and a narrower ford south
  const river = RIVER;
  p.river(river, 3);
  p.patch(101, 25, 4, 'mud');
  p.patch(103, 105, 4, 'mud');

  // balance: hedge line giving the German advance some concealment on the open final approach
  // to the bridge/church (harness showed the attacker crossing this stretch almost entirely in
  // the open). Added before the road/buildings so those still cut through it cleanly.
  p.line([{ x: 40, y: 70 }, { x: 65, y: 72 }, { x: 92, y: 76 }], 'hedge');

  // main street through the village, gently curving, with telegraph poles and battle damage
  // concentrated in the contested middle third
  const mainRoad = MAIN_ROAD;
  p.road(mainRoad, 4, 'pavedroad');
  // bridge rect computed from the actual road/river intersection (round-3 fix: the old
  // hand-placed rect drifted off the crossing and rendered as two plank blocks straddling the
  // road instead of paving it)
  const bridgePt = p.bridgeAcross(mainRoad, 4, river, 3, { near: { x: 99, y: 80 } }) ?? { x: 99, y: 80 };
  p.decorLine(mainRoad, 'pole', 7);
  p.craterLine(mainRoad, { tStart: 0.3, tEnd: 0.75, seedOffset: 500 });

  // north-south side lane through the village (the Crossroads), linking the railway halt to
  // the trench line in the south
  p.road(SIDE_LANE, 2, 'dirtroad');
  // spur south-west to the kolkhoz (stays on the west bank, no crossing needed)
  p.road(KOLKHOZ_SPUR, 2, 'dirtroad');
  // a farm track fording the river south of the village, well clear of the main bridge
  const fordRoad = FORD_ROAD;
  p.road(fordRoad, 2, 'dirtroad');
  const fordPt = p.bridgeAcross(fordRoad, 2, river, 3, { near: { x: 100, y: 130 } }) ?? { x: 100, y: 130 };
  // spur north to the railway halt
  p.road(HALT_SPUR, 2, 'dirtroad');

  // village houses along the main street, staggered rows on either bank of the river; a curving
  // side lane serves the ones set back from the street
  const westHouses: [number, number][] = [[28, 64], [38, 90], [46, 62], [56, 88], [66, 64], [76, 90], [84, 62], [92, 88]];
  for (const [hx, hy] of westHouses) p.building(hx, hy, 6, 5, 'wood');
  const eastHouses: [number, number][] = [[112, 62], [122, 88], [140, 60], [150, 90], [162, 62], [166, 88]];
  for (const [hx, hy] of eastHouses) p.building(hx, hy, 6, 5, 'wood');
  p.line([{ x: 26, y: 60 }, { x: 178, y: 58 }], 'fence'); // garden fence behind the north row
  p.line([{ x: 26, y: 95 }, { x: 174, y: 96 }], 'fence'); // garden fence behind the south row
  p.line([{ x: 0, y: 116 }, { x: 20, y: 116 }], 'fence'); // side lane serving the western houses

  // the stone church, tower, walled churchyard and graveyard, set back north of the street
  p.building(108, 48, 10, 8, 'stone');
  p.building(111, 40, 4, 8, 'stone'); // tower
  p.line([{ x: 106, y: 38 }, { x: 123, y: 38 }, { x: 123, y: 60 }, { x: 106, y: 60 }, { x: 106, y: 38 }], 'stonewall');
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) p.addDecor('grave', 119 + gx * 1.5, 43 + gy * 5);
  }

  // the railway halt: a small stone station building with a paved platform stub
  p.building(153, 30, 8, 6, 'stone');
  p.rect(152, 36, 10, 2, 'dirtroad');
  p.addDecor('crate', 156, 38);
  p.addDecor('barrel', 159, 38);
  p.addDecor('sign', 154, 37);

  // the kolkhoz: three stone buildings around a fenced yard, well, haystacks, cart, woodpile
  p.building(50, 112, 6, 5, 'stone');
  p.building(58, 112, 6, 5, 'stone');
  p.building(54, 120, 6, 5, 'stone');
  p.line([{ x: 47, y: 109 }, { x: 67, y: 109 }, { x: 67, y: 127 }, { x: 60, y: 127 }], 'fence');
  p.line([{ x: 50, y: 127 }, { x: 47, y: 127 }, { x: 47, y: 109 }], 'fence');
  p.addDecor('well', 56, 116);
  p.addDecor('haystack', 62, 121);
  p.addDecor('haystack', 64, 118);
  p.addDecor('cart', 49, 121);
  p.addDecor('woodpile', 63, 113);

  // the Soviet trench line beyond the village, zig-zag with wire in front of it and craters
  // where the German barrage has already fallen; German attacker, so the Soviets own every VL
  // at the start and this is their fallback line
  p.line([
    { x: 180, y: 10 }, { x: 190, y: 35 }, { x: 183, y: 65 }, { x: 192, y: 95 }, { x: 184, y: 125 }, { x: 191, y: 150 },
  ], 'trench');
  p.line([
    { x: 186, y: 8 }, { x: 196, y: 33 }, { x: 189, y: 63 }, { x: 198, y: 93 }, { x: 190, y: 123 }, { x: 197, y: 148 },
  ], 'trench');
  p.line([
    { x: 174, y: 5 }, { x: 184, y: 32 }, { x: 177, y: 62 }, { x: 186, y: 92 }, { x: 178, y: 122 }, { x: 185, y: 150 },
  ], 'fence'); // wire entanglement in front of the trenches
  // Soviet rifle pits covering the Railway Halt and the gap north of the trench line, facing
  // the German advance from the west; a loose staggered group, clear of the VL itself
  const GERMAN_APPROACH = { x: 20, y: 75 };
  const moscowClear = [{ x: 157, y: 37, r: 5 }, { x: 130, y: 81, r: 5 }];
  p.foxholeLine([{ x: 150, y: 24 }, { x: 148, y: 50 }], GERMAN_APPROACH, { spacing: 5, stagger: 1.5, seedOffset: 5, keepClear: moscowClear });
  p.foxholeLine([{ x: 168, y: 100 }, { x: 170, y: 118 }], GERMAN_APPROACH, { spacing: 5, stagger: 1.2, seedOffset: 6, keepClear: moscowClear });
  p.patch(180, 33, 2.5, 'crater');
  p.patch(184, 92, 2.5, 'crater');
  p.patch(178, 122, 2, 'crater');
  p.scatterDecor('shellhole', 165, 0, 35, 150, 14, 71);

  // a couple of wrecked vehicles and abandoned carts on the approach, wood/log piles at the
  // woods edges
  p.addDecor('wreck', 62, 80);
  p.addDecor('wreck', 128, 82);
  p.addDecor('cart', bridgePt.x - 4, bridgePt.y - 6);
  p.addDecor('sign', fordPt.x + 2, fordPt.y - 2);
  p.scatterDecor('stump', 18, 48, 22, 20, 8, 72);
  p.scatterDecor('log', 20, 52, 18, 16, 5, 73);
  p.scatterDecor('stump', 182, 48, 20, 18, 6, 74);
  p.scatterDecor('log', 185, 52, 16, 14, 4, 75);

  // decor: winter village scatter — bare orchard stumps, haystacks, poles, drifts, war debris
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 26, 60);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 16, 61);
  p.scatterDecor('puddle', 0, 60, WIDTH, 40, 10, 62);
  p.scatterDecor('barrel', 0, 0, WIDTH, HEIGHT, 12, 63);
  p.scatterDecor('crate', 0, 0, WIDTH, HEIGHT, 10, 64);
  p.scatterDecor('woodpile', 0, 55, WIDTH, 45, 8, 65);
  p.scatterDecor('haystack', 0, 55, WIDTH, 45, 6, 66);
  p.scatterDecor('sign', 0, 0, WIDTH, HEIGHT, 4, 67);
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

export const winter_1941: MapDef = {
  id: 'moscow_1941',
  name: 'Moscow Outskirts',
  description: 'December 1941: a German drive on the Moscow highway pushes through a snowbound village on the frozen Skhodnya, the Soviet defenders falling back on a dug-in trench line beyond it.',
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
    { id: 0, name: 'Church', x: 113, y: 55, value: 3 },
    { id: 1, name: 'Bridge', x: 99, y: 80, value: 3 },
    // balance (round 5): with the deploy zones pulled in to 90 tiles apart, the Halt sits deep
    // behind the Soviet line and the Kolkhoz behind the German one, so their values are swapped —
    // the points now sit on the ground the two sides actually contest across the river.
    { id: 2, name: 'Railway Halt', x: 157, y: 37, value: 1 },
    { id: 3, name: 'Kolkhoz', x: 56, y: 118, value: 2 },
    { id: 4, name: 'Crossroads', x: 130, y: 81, value: 1 },
  ],
  // round-5 fix #8: the old zones were 164 tiles (328 m) apart across the whole map height. Both
  // are now one screen across, 90 tiles (180 m) apart and straddling the river valley, so the
  // Germans make contact at the crossing in the first minute or two.
  deployZones: {
    german: { x: 32, y: 60, w: 28, h: 28 },
    soviet: { x: 122, y: 60, w: 28, h: 28 },
  },
  // COA overlays (G21): the drive goes over the Skhodnya bridge for the church, a rifle column
  // crosses downstream, fires from the village; the Soviets hold a trench line east of the
  // river and counterattack armour back at the bridge.
  coa: {
    stages: ['Overwatch', 'Obstacles', 'Cut Fence', 'Reduce', 'Assault'],
    german: [
      { pts: [{ x: 42, y: 70 }, { x: 72, y: 78 }, { x: 100, y: 80 }, { x: 112, y: 58 }], kind: 'armor' },
      { pts: [{ x: 64, y: 88 }, { x: 98, y: 80 }], kind: 'assault' },
      { pts: [{ x: 56, y: 100 }, { x: 98, y: 80 }], kind: 'firesupport' },
    ],
    soviet: [
      { pts: [{ x: 136, y: 62 }, { x: 156, y: 72 }, { x: 148, y: 92 }, { x: 128, y: 98 }], kind: 'defenses' },
      { pts: [{ x: 150, y: 52 }, { x: 124, y: 66 }, { x: 106, y: 79 }], kind: 'armor' },
      { pts: [{ x: 152, y: 84 }, { x: 106, y: 80 }], kind: 'firesupport' },
    ],
  },
  decor,
  vectors,
};
