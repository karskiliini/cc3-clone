import type { DecorItem, MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 240;
const HEIGHT = 170;
const SEED = 1943;

/** July 1943: a Soviet rifle regiment storms a dug-in German line on the open Kursk steppe,
 * fighting through a kolkhoz and its sunflower fields toward the trenches and craters beyond. */
function paintMap(p: MapPainter): void {
  p.fill('grass');
  p.patch(25, 40, 10, 'open');
  p.patch(95, 45, 8, 'open');
  p.patch(200, 60, 12, 'open');
  p.patch(50, 140, 9, 'open');
  p.patch(210, 40, 8, 'open');

  // sunflower / crops fields as irregular overlapping parcels, cut by dirt tracks
  p.field(35, 68, 26, 22, 'crops', 1);
  p.field(58, 78, 22, 18, 'crops', 2);
  p.field(30, 95, 18, 14, 'tallgrass', 3);
  p.field(160, 105, 32, 22, 'crops', 4);
  p.field(190, 122, 24, 18, 'crops', 5);
  p.field(140, 90, 18, 14, 'mud', 6);
  p.line([{ x: 10, y: 55 }, { x: 60, y: 52 }], 'fence');
  p.line([{ x: 125, y: 88 }, { x: 175, y: 85 }, { x: 225, y: 90 }], 'hedge');

  // small copse near the centre
  p.woods(150, 60, 7, 6);
  p.orchard(158, 46, 12, 10, 2);

  // dirt tracks crossing the steppe, curved, with a junction
  p.road([
    { x: 0, y: 102 }, { x: 45, y: 98 }, { x: 90, y: 103 }, { x: 135, y: 99 },
    { x: 180, y: 104 }, { x: 240, y: 100 },
  ], 2, 'dirtroad');
  p.road([
    { x: 180, y: 0 }, { x: 176, y: 40 }, { x: 182, y: 80 }, { x: 178, y: 120 }, { x: 182, y: 170 },
  ], 2, 'dirtroad');
  p.rect(177, 101, 3, 3, 'dirtroad');

  // German trench belt in the north, zig-zag, with barbed-wire-style fence in front and craters
  p.line([
    { x: 15, y: 42 }, { x: 35, y: 46 }, { x: 55, y: 40 }, { x: 80, y: 45 }, { x: 100, y: 39 },
    { x: 130, y: 46 }, { x: 160, y: 41 }, { x: 190, y: 47 }, { x: 220, y: 42 },
  ], 'trench');
  p.line([
    { x: 15, y: 50 }, { x: 35, y: 53 }, { x: 55, y: 48 }, { x: 80, y: 52 }, { x: 100, y: 47 },
    { x: 130, y: 53 }, { x: 160, y: 49 }, { x: 190, y: 54 }, { x: 220, y: 50 },
  ], 'trench');
  p.line([{ x: 10, y: 36 }, { x: 225, y: 36 }], 'fence');
  p.scatterDecor('shellhole', 5, 30, 230, 20, 22, 30);
  p.scatterDecor('shellhole', 20, 55, 210, 40, 16, 31);
  p.patch(70, 58, 3, 'crater');
  p.patch(150, 44, 2.5, 'crater');
  p.patch(105, 60, 2, 'crater');

  // a balka (dry gully) curving through the middle, also a trench-like feature
  p.line([
    { x: 40, y: 115 }, { x: 65, y: 122 }, { x: 90, y: 112 }, { x: 115, y: 118 },
    { x: 145, y: 108 }, { x: 175, y: 116 }, { x: 210, y: 109 },
  ], 'trench');
  p.rect(114, 117, 2, 2, 'trench');

  // kolkhoz: three stone buildings around a fenced yard, farm track leading in
  p.building(55, 78, 6, 5, 'stone');
  p.building(63, 78, 6, 5, 'stone');
  p.building(59, 86, 6, 5, 'stone');
  p.line([{ x: 52, y: 75 }, { x: 72, y: 75 }, { x: 72, y: 93 }, { x: 62, y: 93 }], 'fence');
  p.line([{ x: 58, y: 93 }, { x: 52, y: 93 }, { x: 52, y: 75 }], 'fence');
  p.rect(60, 80, 4, 5, 'open'); // trodden farmyard between the buildings
  p.road([{ x: 62, y: 93 }, { x: 62, y: 102 }], 2, 'dirtroad');
  p.addDecor('well', 62, 84);
  p.addDecor('haystack', 68, 90);
  p.addDecor('cart', 54, 90);
  p.addDecor('woodpile', 70, 82);

  // decor: steppe scatter
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 20, 60);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 16, 61);
  p.scatterDecor('flowers', 20, 60, 200, 60, 14, 62);
  p.scatterDecor('log', 140, 40, 40, 30, 6, 63);
  p.scatterDecor('barrel', 40, 40, 30, 15, 4, 64);
  p.scatterDecor('sign', 90, 100, 1, 1, 1, 65);
}

const decor: DecorItem[] = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('open');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  return p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
})();

export const steppe_1943: MapDef = {
  id: 'steppe_1943',
  name: 'Kursk Steppe',
  description: 'July 1943: a Soviet rifle regiment storms a dug-in German line on the open Kursk steppe, fighting through a kolkhoz and its sunflower fields toward the trenches beyond.',
  width: WIDTH,
  height: HEIGHT,
  season: 'summer',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  victoryLocations: [
    { id: 0, name: 'Kolkhoz', x: 62, y: 82, value: 3 },
    { id: 1, name: 'Trench Line', x: 100, y: 39, value: 2 },
    { id: 2, name: 'Copse', x: 150, y: 60, value: 1 },
    { id: 3, name: 'Track Junction', x: 178, y: 102, value: 1 },
    { id: 4, name: 'Balka', x: 115, y: 118, value: 1 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 240, h: 25 },
    soviet: { x: 0, y: 145, w: 240, h: 25 },
  },
  decor,
};
