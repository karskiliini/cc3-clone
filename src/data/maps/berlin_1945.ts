import type { MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

export const berlin_1945: MapDef = {
  id: 'berlin_1945',
  name: 'Berlin Streets',
  description: 'April 1945: Soviet assault groups fight block by block through the ruins of Berlin toward the Ministry building, crossing rubble-choked streets under snow.',
  width: 220,
  height: 160,
  season: 'winter',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, 1945);
    p.fill('snow');

    // street grid
    const vStreets = [40, 90, 140, 190];
    const hStreets = [30, 70, 110, 140];
    for (const x of vStreets) p.road([{ x, y: 0 }, { x, y: 160 }], 6, 'pavedroad');
    for (const y of hStreets) p.road([{ x: 0, y }, { x: 220, y }], 6, 'pavedroad');
    // wide tram street
    p.road([{ x: 0, y: 55 }, { x: 220, y: 55 }], 7, 'pavedroad');

    // city blocks of stone buildings with courtyards
    p.building(48, 8, 18, 14, 'stone');
    p.building(70, 8, 14, 14, 'stone');
    p.building(48, 38, 16, 22, 'stone');
    p.building(148, 8, 18, 14, 'stone');
    p.building(148, 38, 20, 12, 'stone');
    p.building(48, 78, 16, 14, 'stone');
    p.building(98, 78, 16, 14, 'stone');
    p.building(148, 78, 16, 14, 'stone');
    p.building(48, 118, 14, 16, 'stone');
    p.building(98, 118, 14, 16, 'stone');
    p.building(168, 45, 12, 8, 'stone');
    p.building(30, 130, 6, 6, 'stone');

    // the Ministry: a large stone building near the centre
    p.building(95, 45, 20, 14, 'stone');

    // rubble scattered through the ruins
    p.noiseFill('rubble', 0.1, ['snow']);

    // craters
    p.patch(60, 60, 3, 'crater');
    p.patch(120, 100, 3, 'crater');
    p.patch(170, 90, 3, 'crater');

    // a barricade blocking a street
    p.line([{ x: 40, y: 98 }, { x: 46, y: 98 }], 'stonewall');
  },
  victoryLocations: [
    { id: 0, name: 'Ministry', x: 105, y: 51, value: 3 },
    { id: 1, name: 'Platz', x: 140, y: 70, value: 2 },
    { id: 2, name: 'Station', x: 173, y: 49, value: 2 },
    { id: 3, name: 'Barricade', x: 43, y: 98, value: 1 },
    { id: 4, name: 'U-Bahn', x: 33, y: 133, value: 1 },
  ],
  deployZones: {
    soviet: { x: 190, y: 0, w: 30, h: 160 },
    german: { x: 0, y: 0, w: 30, h: 160 },
  },
};
