import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 200;
const HEIGHT = 150;
const SEED = 194112;

/** December 1941: a German drive on the Moscow highway pushes through a snowbound village on
 * the frozen Skhodnya, the Soviet defenders falling back on a dug-in trench line beyond it. */
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
  const river = [
    { x: 104, y: 0 }, { x: 99, y: 25 }, { x: 106, y: 50 }, { x: 99, y: 80 },
    { x: 105, y: 105 }, { x: 100, y: 130 }, { x: 103, y: 150 },
  ];
  p.river(river, 3);
  p.patch(101, 25, 4, 'mud');
  p.patch(103, 105, 4, 'mud');

  // balance: hedge line giving the German advance some concealment on the open final approach
  // to the bridge/church (harness showed the attacker crossing this stretch almost entirely in
  // the open). Added before the road/buildings so those still cut through it cleanly.
  p.line([{ x: 40, y: 70 }, { x: 65, y: 72 }, { x: 92, y: 76 }], 'hedge');

  // main street through the village, gently curving, with telegraph poles and battle damage
  // concentrated in the contested middle third
  const mainRoad = [
    { x: 0, y: 82 }, { x: 30, y: 78 }, { x: 60, y: 82 }, { x: 90, y: 79 },
    { x: 100, y: 80 }, { x: 120, y: 81 }, { x: 150, y: 77 }, { x: 180, y: 80 }, { x: 200, y: 78 },
  ];
  p.road(mainRoad, 4, 'pavedroad');
  // bridge rect computed from the actual road/river intersection (round-3 fix: the old
  // hand-placed rect drifted off the crossing and rendered as two plank blocks straddling the
  // road instead of paving it)
  const bridgePt = p.bridgeAcross(mainRoad, 4, river, 3, { near: { x: 99, y: 80 } }) ?? { x: 99, y: 80 };
  p.decorLine(mainRoad, 'pole', 7);
  p.craterLine(mainRoad, { tStart: 0.3, tEnd: 0.75, seedOffset: 500 });

  // north-south side lane through the village (the Crossroads), linking the railway halt to
  // the trench line in the south
  p.road([{ x: 130, y: 0 }, { x: 132, y: 40 }, { x: 129, y: 81 }, { x: 131, y: 120 }, { x: 130, y: 150 }], 2, 'dirtroad');
  // spur south-west to the kolkhoz (stays on the west bank, no crossing needed)
  p.road([{ x: 60, y: 82 }, { x: 70, y: 96 }, { x: 60, y: 116 }, { x: 55, y: 115 }], 2, 'dirtroad');
  // a farm track fording the river south of the village, well clear of the main bridge
  const fordRoad = [{ x: 92, y: 122 }, { x: 100, y: 130 }, { x: 108, y: 138 }];
  p.road(fordRoad, 2, 'dirtroad');
  const fordPt = p.bridgeAcross(fordRoad, 2, river, 3, { near: { x: 100, y: 130 } }) ?? { x: 100, y: 130 };
  // spur north to the railway halt
  p.road([{ x: 150, y: 77 }, { x: 153, y: 55 }, { x: 155, y: 38 }], 2, 'dirtroad');

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
  victoryLocations: [
    { id: 0, name: 'Church', x: 113, y: 55, value: 3 },
    { id: 1, name: 'Bridge', x: 99, y: 80, value: 3 },
    { id: 2, name: 'Railway Halt', x: 157, y: 37, value: 2 },
    { id: 3, name: 'Kolkhoz', x: 56, y: 118, value: 2 },
    { id: 4, name: 'Crossroads', x: 130, y: 81, value: 1 },
  ],
  deployZones: {
    // balance: widened from w:26 - the old narrow strip put the zone centre ~200m+ from the
    // Church/Bridge objectives, forcing German attackers to cross the entire open snowfield
    // before making contact; this brings the primary axis into the ~150-200m band.
    german: { x: 0, y: 0, w: 50, h: 150 },
    soviet: { x: 178, y: 0, w: 22, h: 150 },
  },
  decor,
  vectors,
};
