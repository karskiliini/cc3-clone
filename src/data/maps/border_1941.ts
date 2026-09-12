import type { MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

export const border_1941: MapDef = {
  id: 'border_1941',
  name: 'Border Crossing',
  description: 'June 1941: German spearheads push across the frontier at dawn, brushing aside a thin Soviet border guard screen holding the crossroads farmsteads along the stream.',
  width: 200,
  height: 150,
  season: 'summer',
  attacker: 'german',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, 1941);
    p.fill('grass');

    // crops fields around the farmsteads
    p.rect(15, 25, 55, 55, 'crops');
    p.rect(45, 90, 40, 35, 'crops');

    // woods block NE
    p.woods(170, 30, 22, 18);

    // scattered orchard trees
    p.patch(90, 40, 9, 'scatteredtrees');

    // stream running roughly north-south with a road bridge
    p.river([{ x: 145, y: 0 }, { x: 141, y: 75 }, { x: 150, y: 150 }], 2);

    // dirt road west-east with a crossroads and a spur south
    p.road([{ x: 0, y: 75 }, { x: 200, y: 75 }], 3, 'dirtroad');
    p.road([{ x: 100, y: 5 }, { x: 100, y: 145 }], 3, 'dirtroad');
    p.bridge(138, 73, 8, 5);

    // farmsteads: wood buildings with fences
    p.building(38, 45, 8, 6, 'wood');
    p.line([{ x: 36, y: 43 }, { x: 48, y: 43 }, { x: 48, y: 53 }, { x: 36, y: 53 }, { x: 36, y: 43 }], 'fence');
    p.building(58, 96, 7, 5, 'wood');
    p.line([{ x: 56, y: 94 }, { x: 67, y: 94 }, { x: 67, y: 103 }, { x: 56, y: 103 }, { x: 56, y: 94 }], 'fence');

    // tallgrass scattered across open ground
    p.noiseFill('tallgrass', 0.12, ['grass']);
  },
  victoryLocations: [
    { id: 0, name: 'Crossroads', x: 100, y: 75, value: 2 },
    { id: 1, name: 'Farm', x: 41, y: 48, value: 1 },
    { id: 2, name: 'Bridge', x: 141, y: 75, value: 3 },
    { id: 3, name: 'Orchard', x: 90, y: 40, value: 1 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 30, h: 150 },
    soviet: { x: 170, y: 0, w: 30, h: 150 },
  },
};
