import type { DecorItem, MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 220;
const HEIGHT = 160;
const SEED = 1945;

/** April 1945: Soviet assault groups fight block by block through the ruins of Berlin toward the
 * Ministry building, crossing rubble-choked, snow-covered streets under fire. */
function paintMap(p: MapPainter): void {
  p.fill('snow');

  // street grid: 4 vertical, 4 horizontal, plus a wide tram avenue
  const vStreets = [40, 90, 140, 190];
  const hStreets = [30, 70, 110, 140];
  for (const x of vStreets) p.road([{ x, y: 0 }, { x, y: 160 }], 5, 'pavedroad');
  for (const y of hStreets) p.road([{ x: 0, y }, { x: 220, y }], 5, 'pavedroad');
  p.road([{ x: 0, y: 55 }, { x: 220, y: 55 }], 7, 'pavedroad'); // tram avenue
  p.decorLine([{ x: 2, y: 55 }, { x: 218, y: 55 }], 'tramwire', 8);

  // central Platz: open paved square with the Ministry on one side
  p.rect(122, 58, 16, 12, 'pavedroad');
  p.addDecor('sign', 130, 60);

  // city blocks, 3x3 grid roughly: ~60% intact (courtyard blocks with paved gateways),
  // ~40% reduced to ruins. Rubble stays confined to ruin footprints and small street
  // patches around craters/barricades — it does not blanket the whole map.
  p.block(48, 8, 18, 14, 'stone');
  p.block(70, 8, 14, 14, 'stone');
  p.ruin(96, 8, 16, 14, 1);
  p.block(148, 8, 18, 14, 'stone');
  p.block(48, 38, 16, 22, 'stone');
  p.block(70, 40, 14, 14, 'stone');
  p.block(148, 38, 20, 12, 'stone');
  p.building(168, 45, 12, 8, 'stone'); // small station building, no courtyard
  p.block(48, 78, 16, 14, 'stone');
  p.ruin(98, 78, 16, 14, 3);
  p.ruin(148, 78, 16, 14, 5);
  p.block(48, 118, 14, 16, 'stone');
  p.ruin(98, 118, 14, 16, 4);
  p.building(30, 130, 6, 6, 'stone');
  p.block(168, 118, 14, 14, 'stone');

  // the Ministry: a large intact stone building with its own courtyard, facing the Platz
  p.block(95, 44, 22, 16, 'stone', 'open');

  // small rubble patches around the craters (not blanket coverage) and light dusting
  // of debris on the streets nearest the ruins
  p.patch(58, 62, 4, 'rubble');
  p.patch(118, 98, 4, 'rubble');
  p.patch(168, 88, 4, 'rubble');
  p.patch(88, 32, 3, 'rubble');
  p.patch(158, 128, 3, 'rubble');
  p.noiseFill('rubble', 0.05, ['pavedroad']);

  // craters pockmarking the streets
  p.patch(60, 60, 3, 'crater');
  p.patch(120, 100, 3, 'crater');
  p.patch(170, 90, 3, 'crater');
  p.patch(90, 30, 2.5, 'crater');
  p.patch(160, 130, 2.5, 'crater');
  p.scatterDecor('shellhole', 0, 0, WIDTH, HEIGHT, 20, 50);

  // a barricade of rubble blocking a street, and a second near the Ministry approach
  p.line([{ x: 40, y: 97 }, { x: 40, y: 103 }], 'rubble');
  p.line([{ x: 40, y: 98 }, { x: 46, y: 98 }], 'stonewall');
  p.line([{ x: 90, y: 42 }, { x: 90, y: 48 }], 'rubble');

  // decor: wrecks, barrels/crates, snow drifts, war debris
  p.addDecor('wreck', 42, 32);
  p.addDecor('wreck', 143, 72);
  p.addDecor('wreck', 92, 110);
  p.scatterDecor('barrel', 0, 0, WIDTH, HEIGHT, 24, 51);
  p.scatterDecor('crate', 0, 0, WIDTH, HEIGHT, 22, 52);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 10, 53);
  p.scatterDecor('sign', 0, 0, WIDTH, HEIGHT, 8, 54);
  p.scatterDecor('puddle', 0, 0, WIDTH, HEIGHT, 14, 55);
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

export const berlin_1945: MapDef = {
  id: 'berlin_1945',
  name: 'Berlin Streets',
  description: 'April 1945: Soviet assault groups fight block by block through the ruins of Berlin toward the Ministry building, crossing rubble-choked streets under snow.',
  width: WIDTH,
  height: HEIGHT,
  season: 'winter',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  victoryLocations: [
    { id: 0, name: 'Ministry', x: 105, y: 51, value: 3 },
    { id: 1, name: 'Platz', x: 129, y: 63, value: 2 },
    { id: 2, name: 'Station', x: 173, y: 49, value: 2 },
    { id: 3, name: 'Barricade', x: 43, y: 98, value: 1 },
    { id: 4, name: 'U-Bahn', x: 33, y: 133, value: 1 },
  ],
  deployZones: {
    soviet: { x: 190, y: 0, w: 30, h: 160 },
    german: { x: 0, y: 0, w: 30, h: 160 },
  },
  decor,
};
