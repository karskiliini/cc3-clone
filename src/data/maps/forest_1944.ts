import type { MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

export const forest_1944: MapDef = {
  id: 'forest_1944',
  name: 'Belarus Forest',
  description: 'Summer 1944: Operation Bagration drives Soviet infantry through dense Belarusian forest toward a German-held river crossing, its bridge and ford the only ways across.',
  width: 200,
  height: 160,
  season: 'summer',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, 1944);
    p.fill('grass');

    // dense woods covering most of the map, leaving clearings unpainted
    p.woods(55, 40, 30, 26);
    p.woods(50, 100, 26, 24);
    p.woods(140, 30, 26, 22);
    p.woods(150, 130, 24, 22);
    p.woods(30, 70, 18, 16);
    p.woods(170, 85, 20, 18);

    // a clearing kept deliberately open in the middle of the forest
    p.rect(140, 90, 24, 20, 'grass');

    // river running roughly north-south with a bridge and a ford
    p.river([{ x: 100, y: 0 }, { x: 104, y: 60 }, { x: 96, y: 120 }, { x: 100, y: 160 }], 3);
    p.bridge(96, 57, 14, 6);
    p.bridge(88, 117, 14, 6);

    // forester's lodge
    p.building(40, 40, 7, 6, 'wood');

    // corduroy (dirt) road winding through the woods
    p.road([{ x: 10, y: 140 }, { x: 60, y: 120 }, { x: 100, y: 90 }, { x: 150, y: 60 }, { x: 190, y: 20 }], 2, 'dirtroad');
  },
  victoryLocations: [
    { id: 0, name: 'Bridge', x: 101, y: 60, value: 3 },
    { id: 1, name: 'Lodge', x: 43, y: 43, value: 2 },
    { id: 2, name: 'Clearing', x: 150, y: 100, value: 1 },
    { id: 3, name: 'Ford', x: 93, y: 120, value: 2 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 25, h: 160 },
    soviet: { x: 175, y: 0, w: 25, h: 160 },
  },
};
