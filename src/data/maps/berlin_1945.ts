import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 220;
const HEIGHT = 160;
const SEED = 1945;

/** April 1945: Soviet assault groups fight block by block through the ruins of Berlin toward the
 * Ministry building, crossing rubble-choked, snow-covered streets under fire. */
// ---------------------------------------------------------------- shared geometry
const V_STREETS = [40, 90, 140, 190];
const H_STREETS = [30, 70, 110, 140];
/** the tram avenue runs in a shallow cutting along y=55 */
const TRAM_AVENUE = [{ x: -10, y: 55 }, { x: 230, y: 55 }];

/** City ground: essentially flat, with a slight rise westward toward the Ministry quarter (so
 * the Soviet assault from the east is always looking very slightly uphill), and the tram avenue
 * running in a shallow sunken cutting — the one piece of dead ground in an otherwise exposed
 * street grid. Relief ~6 m, street grades 1-3%, cutting sides ~17%. */
function paintElevationFor(e: ElevationApi): void {
  e.base(4);
  e.rolling(0.5, 64, 7);
  // the slight rise carrying the Ministry (105,51) and the Platz
  e.hill(104, 50, 64, 2.8, 'plateau');
  // the eastern approach is a touch lower still
  e.slope({ x: 150, y: 0, w: 70, h: 160 }, 0, -1.0, 0);
  e.smoothElevation(2);
  // the tram cutting: 1.5 m below street level, with the cross streets dipping through it
  e.valley(TRAM_AVENUE, 15, 1.5);
  e.smoothElevation(1);
  // no cliffs: relax anything the composed features made steeper than 30%% (river banks and the
  // balka lip do sit near that cap — those are the deliberate "steep bank" cases)
  e.limitGrade(30);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('snow');

  // street grid: 4 vertical, 4 horizontal, plus a wide tram avenue
  const vStreets = V_STREETS;
  const hStreets = H_STREETS;
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
  p.block(95, 44, 22, 16, 'stone', 'pavedroad');

  // small intact houses/sheds tucked into the gaps between blocks (round-3: the original's
  // winter streets keep a scatter of untouched small buildings between the ruined ones,
  // ref_cc3_1484/1485.png) — these stay outside the ruin footprint so they read as standing
  p.building(88, 20, 6, 6, 'stone');
  p.building(30, 60, 6, 5, 'wood');
  p.building(120, 118, 6, 6, 'wood');
  p.building(196, 90, 6, 5, 'stone');
  p.building(65, 130, 5, 5, 'wood');

  // small rubble patches around the craters (not blanket coverage) and light dusting
  // of debris on the streets nearest the ruins
  p.patch(58, 62, 4, 'rubble');
  p.patch(118, 98, 4, 'rubble');
  p.patch(168, 88, 4, 'rubble');
  p.patch(88, 32, 3, 'rubble');
  p.patch(158, 128, 3, 'rubble');
  p.noiseFill('rubble', 0.05, ['pavedroad']);

  // craters pockmarking the streets, plus battle-damage strings along the two long vertical
  // streets closest to the contested Platz/Ministry axis
  p.patch(60, 60, 3, 'crater');
  p.patch(120, 100, 3, 'crater');
  p.patch(170, 90, 3, 'crater');
  p.patch(90, 30, 2.5, 'crater');
  p.patch(160, 130, 2.5, 'crater');
  p.craterLine([{ x: 90, y: 0 }, { x: 90, y: 160 }], { tStart: 0.25, tEnd: 0.75, seedOffset: 110, minGap: 18, maxGap: 28 });
  p.craterLine([{ x: 140, y: 0 }, { x: 140, y: 160 }], { tStart: 0.25, tEnd: 0.75, seedOffset: 111, minGap: 18, maxGap: 28 });
  p.craterLine([{ x: 0, y: 55 }, { x: 220, y: 55 }], { tStart: 0.3, tEnd: 0.7, seedOffset: 112, minGap: 18, maxGap: 28 });
  p.scatterDecor('shellhole', 0, 0, WIDTH, HEIGHT, 20, 50);

  // barricades of rubble/stonewall blocking streets at contested chokepoints
  p.line([{ x: 40, y: 97 }, { x: 40, y: 103 }], 'rubble');
  p.line([{ x: 40, y: 98 }, { x: 46, y: 98 }], 'stonewall');
  p.line([{ x: 90, y: 42 }, { x: 90, y: 48 }], 'rubble');
  p.line([{ x: 140, y: 62 }, { x: 146, y: 62 }], 'rubble');
  p.line([{ x: 140, y: 63 }, { x: 140, y: 68 }], 'stonewall');
  p.line([{ x: 168, y: 108 }, { x: 174, y: 108 }], 'rubble');

  // Volkssturm fighting holes dug into the snow verge behind the Barricade, facing the Soviet
  // push from the east (small staggered group; the barricade VL itself stays clear)
  p.foxholeLine([{ x: 45, y: 88 }, { x: 45.5, y: 108 }], { x: 205, y: 90 }, { spacing: 5, stagger: 1, seedOffset: 9, keepClear: [{ x: 43, y: 98, r: 3 }] });
  p.foxholeLine([{ x: 145, y: 57 }, { x: 145.5, y: 72 }], { x: 205, y: 70 }, { spacing: 4.5, stagger: 1, seedOffset: 10, keepClear: [{ x: 129, y: 63, r: 5 }] });

  // decor: wrecks, barrels/crates, snow drifts, war debris (round-3: heavier street furniture
  // than the other maps, matching the ruined-city density of ref_cc3_1484/1485.png)
  p.addDecor('wreck', 42, 32);
  p.addDecor('wreck', 143, 72);
  p.addDecor('wreck', 92, 110);
  p.addDecor('wreck', 40, 100);
  p.addDecor('wreck', 168, 92);
  p.addDecor('cart', 132, 60);
  p.addDecor('woodpile', 128, 61);
  p.scatterDecor('barrel', 0, 0, WIDTH, HEIGHT, 32, 51);
  p.scatterDecor('crate', 0, 0, WIDTH, HEIGHT, 30, 52);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 14, 53);
  p.scatterDecor('sign', 0, 0, WIDTH, HEIGHT, 8, 54);
  p.scatterDecor('puddle', 0, 0, WIDTH, HEIGHT, 16, 55);
  p.scatterDecor('barrel', 88, 20, 24, 20, 6, 56); // clustered near the small intact buildings
  p.scatterDecor('crate', 30, 60, 24, 16, 6, 57);
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
  elevation: paintElevationFor,
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
  vectors,
};
