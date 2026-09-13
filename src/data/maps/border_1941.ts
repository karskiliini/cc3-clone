import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 200;
const HEIGHT = 150;
const SEED = 1941;

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

  // woods block NE, a smaller copse SW, denser tree lines along field edges and the road
  // (round-2 critique: the summer map read as under-treed compared to the reference)
  p.woods(170, 30, 22, 18);
  p.woods(38, 132, 13, 9);
  p.treeLine([{ x: 15, y: 18 }, { x: 40, y: 16 }, { x: 62, y: 20 }], 11, 0.05);
  p.treeLine([{ x: 130, y: 90 }, { x: 175, y: 86 }], 12, 0.05);
  p.treeLine([{ x: 20, y: 55 }, { x: 20, y: 72 }], 14, 0.1);
  p.treeLine([{ x: 165, y: 100 }, { x: 185, y: 100 }], 15, 0.1);
  p.treeLine([{ x: 0, y: 78 }, { x: 40, y: 74 }], 16, 0.35); // sparse trees along the road shoulder

  // orchard between the two farmsteads
  p.orchard(85, 32, 16, 14, 2);

  // stream running roughly north-south with meanders, banks of mud/tallgrass
  p.river([
    { x: 145, y: 0 }, { x: 141, y: 20 }, { x: 148, y: 40 }, { x: 140, y: 60 },
    { x: 150, y: 75 }, { x: 143, y: 95 }, { x: 152, y: 115 }, { x: 148, y: 135 }, { x: 152, y: 150 },
  ], 3);
  p.treeLine([{ x: 145, y: 0 }, { x: 141, y: 20 }, { x: 148, y: 40 }, { x: 140, y: 60 }], 13, 0.4);
  // a few large mud patches along the stream banks and one at the crossroads' worn shoulder
  p.patch(143, 20, 4, 'mud');
  p.patch(145, 60, 4, 'mud');
  p.patch(148, 115, 4, 'mud');
  p.patch(60, 76, 3, 'mud');

  // curving dirt road west-east through the crossroads, spur south, farm tracks
  p.road([
    { x: 0, y: 78 }, { x: 40, y: 74 }, { x: 80, y: 78 }, { x: 100, y: 75 },
    { x: 130, y: 72 }, { x: 165, y: 76 }, { x: 200, y: 78 },
  ], 3, 'dirtroad');
  p.road([
    { x: 100, y: 5 }, { x: 96, y: 40 }, { x: 100, y: 75 }, { x: 104, y: 110 }, { x: 100, y: 145 },
  ], 3, 'dirtroad');
  p.road([{ x: 41, y: 48 }, { x: 60, y: 60 }, { x: 100, y: 75 }], 2, 'dirtroad'); // farm track
  p.road([{ x: 58, y: 96 }, { x: 75, y: 85 }, { x: 100, y: 75 }], 2, 'dirtroad'); // farm track
  p.bridge(138, 73, 8, 5);

  // two farmsteads with yards, fences, orchard, veg patch, decor
  p.farmstead(41, 45, 20);
  p.farmstead(60, 98, 22);

  // stray fence remnants along the near farmstead's field edge
  p.line([{ x: 20, y: 30 }, { x: 20, y: 55 }], 'fence');

  // decor: rural scatter
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 14, 40);
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 20, 41);
  p.scatterDecor('flowers', 20, 10, 70, 60, 10, 42);
  p.scatterDecor('stump', 150, 15, 45, 35, 6, 43);
  p.scatterDecor('puddle', 0, 60, WIDTH, 30, 8, 44);
  p.scatterDecor('log', 145, 10, 40, 30, 5, 45);
  p.addDecor('sign', 100, 76);
  p.addDecor('sign', 138, 72);
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
  victoryLocations: [
    { id: 0, name: 'Crossroads', x: 100, y: 75, value: 2 },
    { id: 1, name: 'North Farm', x: 41, y: 45, value: 1 },
    { id: 2, name: 'South Farm', x: 60, y: 98, value: 1 },
    { id: 3, name: 'Bridge', x: 141, y: 75, value: 3 },
    { id: 4, name: 'Orchard', x: 92, y: 38, value: 1 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 30, h: 150 },
    soviet: { x: 170, y: 0, w: 30, h: 150 },
  },
  decor,
  vectors,
};
