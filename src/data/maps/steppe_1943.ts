import type { MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

export const steppe_1943: MapDef = {
  id: 'steppe_1943',
  name: 'Kursk Steppe',
  description: 'July 1943: a Soviet rifle regiment storms a dug-in German line on the open Kursk steppe, fighting through a kolkhoz and its sunflower fields toward the trenches beyond.',
  width: 240,
  height: 170,
  season: 'summer',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, 1943);
    p.fill('grass');
    p.noiseFill('open', 0.06, ['grass']);

    // sunflower / crops fields
    p.rect(20, 55, 60, 40, 'crops');
    p.rect(140, 90, 70, 45, 'crops');

    // small copse
    p.patch(150, 60, 8, 'scatteredtrees');
    p.woods(150, 60, 6, 5);

    // dirt tracks crossing the steppe
    p.road([{ x: 0, y: 100 }, { x: 240, y: 100 }], 2, 'dirtroad');
    p.road([{ x: 180, y: 0 }, { x: 180, y: 170 }], 2, 'dirtroad');

    // German trench line (defensive belt in the north)
    p.line([{ x: 20, y: 45 }, { x: 80, y: 42 }, { x: 140, y: 48 }, { x: 200, y: 44 }], 'trench');
    p.line([{ x: 20, y: 50 }, { x: 80, y: 47 }, { x: 140, y: 53 }, { x: 200, y: 49 }], 'trench');

    // a balka (dry gully) curving through the middle, also a trench-like feature
    p.line([{ x: 40, y: 110 }, { x: 90, y: 120 }, { x: 130, y: 105 }, { x: 170, y: 115 }, { x: 210, y: 108 }], 'trench');

    // kolkhoz: three stone buildings with fences
    p.building(55, 78, 6, 5, 'stone');
    p.building(63, 78, 6, 5, 'stone');
    p.building(59, 86, 6, 5, 'stone');
    p.line([{ x: 52, y: 75 }, { x: 72, y: 75 }, { x: 72, y: 93 }, { x: 52, y: 93 }, { x: 52, y: 75 }], 'fence');
  },
  victoryLocations: [
    { id: 0, name: 'Kolkhoz', x: 62, y: 80, value: 3 },
    { id: 1, name: 'Trench Line', x: 120, y: 45, value: 2 },
    { id: 2, name: 'Copse', x: 150, y: 60, value: 1 },
    { id: 3, name: 'Track Junction', x: 180, y: 100, value: 1 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 240, h: 25 },
    soviet: { x: 0, y: 145, w: 240, h: 25 },
  },
};
