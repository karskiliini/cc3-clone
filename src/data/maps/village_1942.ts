import type { MapDef, Terrain } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

export const village_1942: MapDef = {
  id: 'village_1942',
  name: 'Ukrainian Village',
  description: 'Autumn 1942: a Soviet rifle division counterattacks a German-held village strung along the paved main street, anchored on the stone church and school.',
  width: 220,
  height: 160,
  season: 'autumn',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, 1942);
    p.fill('grass');

    // crops fields flanking the village
    p.rect(0, 40, 90, 25, 'crops');
    p.rect(130, 105, 90, 25, 'crops');

    // small woods to the south
    p.woods(110, 145, 16, 10);

    // main street
    p.road([{ x: 10, y: 80 }, { x: 210, y: 80 }], 4, 'pavedroad');

    // wood houses along the street, alternating sides
    for (let i = 0; i < 13; i++) {
      const x = 15 + i * 15;
      const y = i % 2 === 0 ? 63 : 96;
      p.building(x, y, 8, 6, 'wood');
    }

    // church (stone) with a stone wall enclosure
    p.building(100, 58, 10, 8, 'stone');
    p.line([{ x: 97, y: 55 }, { x: 113, y: 55 }, { x: 113, y: 69 }, { x: 97, y: 69 }, { x: 97, y: 55 }], 'stonewall');

    // school (stone)
    p.building(130, 95, 9, 7, 'stone');

    // mill and well near the street
    p.building(55, 74, 6, 6, 'wood');

    // hedges around crop fields
    p.line([{ x: 0, y: 40 }, { x: 90, y: 40 }], 'hedge');
    p.line([{ x: 130, y: 130 }, { x: 220, y: 130 }], 'hedge');

    // mud patches near the street and low ground
    p.noiseFill('mud', 0.08, ['grass', 'dirtroad']);
  },
  victoryLocations: [
    { id: 0, name: 'Church', x: 105, y: 62, value: 3 },
    { id: 1, name: 'School', x: 134, y: 98, value: 2 },
    { id: 2, name: 'Main Street', x: 110, y: 80, value: 2 },
    { id: 3, name: 'Mill', x: 58, y: 77, value: 1 },
    { id: 4, name: 'Well', x: 150, y: 80, value: 1 },
  ],
  deployZones: {
    soviet: { x: 0, y: 0, w: 220, h: 30 },
    german: { x: 0, y: 130, w: 220, h: 30 },
  },
};
