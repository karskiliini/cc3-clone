import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 240;
const HEIGHT = 170;
const SEED = 1943;

/** July 1943: a Soviet rifle regiment storms a dug-in German line on the open Kursk steppe,
 * fighting through a kolkhoz and its sunflower fields toward the trenches and craters beyond. */
// ---------------------------------------------------------------- shared geometry
const MAIN_TRACK = [
  { x: 0, y: 102 }, { x: 45, y: 98 }, { x: 90, y: 103 }, { x: 135, y: 99 },
  { x: 180, y: 104 }, { x: 240, y: 100 },
];
const NS_TRACK = [
  { x: 180, y: 0 }, { x: 176, y: 40 }, { x: 182, y: 80 }, { x: 178, y: 120 }, { x: 182, y: 170 },
];
/** the balka (dry gully) — painted as a trench-terrain line and cut as a real gully below */
const BALKA = [
  { x: 40, y: 115 }, { x: 65, y: 122 }, { x: 90, y: 112 }, { x: 115, y: 118 },
  { x: 145, y: 108 }, { x: 175, y: 116 }, { x: 210, y: 109 },
];
const KOLKHOZ_SPUR = [{ x: 62, y: 93 }, { x: 62, y: 102 }];

/** Open steppe: long, low swells rolling east-west (the German line in the north and the Soviet
 * jump-off in the south each sit on one), a commanding rise carrying the kolkhoz, and the balka
 * cut 3.5 m below the plain as a genuine gully — dead ground an attacker can work along, and the
 * reason the dug-in rifle pits on its southern lip matter. Relief ~15 m, swells 2-5%,
 * gully sides ~20%. */
function paintElevationFor(e: ElevationApi): void {
  e.base(12);
  e.rolling(2.4, 74, 4);
  // long low swells: one carrying the German trench belt, one through the middle
  e.ridge([{ x: -20, y: 30 }, { x: 120, y: 26 }, { x: 260, y: 34 }], 52, 2.2);
  e.ridge([{ x: -20, y: 68 }, { x: 70, y: 74 }, { x: 150, y: 62 }, { x: 260, y: 70 }], 66, 3.0);
  // the commanding rise the kolkhoz stands on — it looks down the whole southern approach
  e.hill(62, 82, 42, 5.0);
  // the ground sags toward the southern (Soviet) edge
  e.slope({ x: 0, y: 130, w: 240, h: 40 }, 0, -2.4, Math.PI / 2);
  e.smoothElevation(2);
  // the balka: 3.5 m deep, ~26 tiles (52 m) across including its sloping sides
  e.valley(BALKA, 26, 3.5);
  e.gradeRoad(MAIN_TRACK, 3, 6);
  e.gradeRoad(NS_TRACK, 3, 7);
  e.gradeRoad(KOLKHOZ_SPUR, 3, 8);
  e.smoothElevation(1);
  // no cliffs: relax anything the composed features made steeper than 30%% (river banks and the
  // balka lip do sit near that cap — those are the deliberate "steep bank" cases)
  e.limitGrade(30);
  e.clampRange(0, 25);
}

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

  // shelterbelt/windbreak tree lines along field edges, the kolkhoz yard and the farm track —
  // round-3 critique #4: summer maps read as under-treed vs. the reference's field-edge tree
  // lines. Kept well clear of the y36-54 open sightline gap above the kolkhoz (see the balance
  // note on p.woods(97,66,...) — that corridor must stay open).
  p.treeLine([{ x: 10, y: 58 }, { x: 60, y: 55 }], 97, 0.2); // beside the NW fence line
  p.treeLine([{ x: 125, y: 91 }, { x: 175, y: 88 }, { x: 225, y: 93 }], 98, 0.15); // beside the E hedge
  p.treeLine([{ x: 0, y: 106 }, { x: 45, y: 102 }], 99, 0.25); // windbreak along the west track
  p.treeLine([{ x: 52, y: 96 }, { x: 72, y: 96 }], 100, 0.2); // kolkhoz south fence

  // balance: a woods belt blocking the open, flat sightline from the German trench line
  // (y36-54) straight down onto the Kolkhoz (the map's highest-value VL) - harness testing
  // showed the defender's long-range suppression across this gap, not any specific weapon,
  // was the dominant factor keeping the attacker from ever reaching/holding it.
  p.woods(97, 66, 9, 7);

  // dirt tracks crossing the steppe, curved, with a junction
  const mainTrack = MAIN_TRACK;
  p.road(mainTrack, 2, 'dirtroad');
  p.road(NS_TRACK, 2, 'dirtroad');
  p.rect(177, 101, 3, 3, 'dirtroad');
  p.decorLine(mainTrack, 'pole', 8);
  p.craterLine(mainTrack, { tStart: 0.3, tEnd: 0.75, seedOffset: 80 });

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
  // dug-in rifle pits along the balka's southern lip, facing the German line to the north: a
  // forward outpost line the Soviet assault fights through and then holds (small staggered
  // groups, clear of the Balka VL)
  const GERMAN_LINE = { x: 110, y: 20 };
  const balkaClear = [{ x: 115, y: 118, r: 6 }];
  p.foxholeLine([{ x: 70, y: 126 }, { x: 95, y: 121 }], GERMAN_LINE, { spacing: 5, stagger: 1.2, seedOffset: 3, keepClear: balkaClear });
  p.foxholeLine([{ x: 130, y: 118 }, { x: 150, y: 114 }], GERMAN_LINE, { spacing: 5, stagger: 1.2, seedOffset: 4, keepClear: balkaClear });
  p.patch(70, 58, 3, 'crater');
  p.patch(150, 44, 2.5, 'crater');
  p.patch(105, 60, 2, 'crater');

  // a balka (dry gully) curving through the middle, also a trench-like feature
  p.line(BALKA, 'trench');
  p.rect(114, 117, 2, 2, 'trench');

  // balance: tallgrass patches giving the approach to the balka gully some concealment short
  // of the trench.
  p.field(100, 127, 16, 6, 'tallgrass', 95);
  p.field(160, 127, 16, 6, 'tallgrass', 96);

  // kolkhoz: three stone buildings around a fenced yard, farm track leading in
  p.building(55, 78, 6, 5, 'stone');
  p.building(63, 78, 6, 5, 'stone');
  p.building(59, 86, 6, 5, 'stone');
  p.line([{ x: 52, y: 75 }, { x: 72, y: 75 }, { x: 72, y: 93 }, { x: 62, y: 93 }], 'fence');
  p.line([{ x: 58, y: 93 }, { x: 52, y: 93 }, { x: 52, y: 75 }], 'fence');
  p.rect(61, 80, 2, 5, 'open'); // trodden farmyard, fit exactly in the gap between the two buildings
  p.road(KOLKHOZ_SPUR, 2, 'dirtroad');
  p.addDecor('well', 62, 84);
  p.addDecor('haystack', 68, 90);
  p.addDecor('cart', 54, 90);
  p.addDecor('woodpile', 70, 82);
  p.addDecor('woodpile', 57, 91);
  p.addDecor('haystack', 51, 82);

  // stumps/log piles at the copse's edge, and a wrecked vehicle near the trench line
  p.scatterDecor('stump', 140, 50, 24, 20, 6, 66);
  p.scatterDecor('log', 145, 44, 20, 16, 5, 67);
  p.addDecor('wreck', 105, 43);
  p.addDecor('wreck', 160, 96);

  // decor: steppe scatter (round-3 density pass toward the original's crater/scatter density)
  p.scatterDecor('bush', 0, 0, WIDTH, HEIGHT, 26, 60);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 22, 61);
  p.scatterDecor('flowers', 20, 60, 200, 60, 16, 62);
  p.scatterDecor('log', 140, 40, 40, 30, 6, 63);
  p.scatterDecor('barrel', 40, 40, 30, 15, 6, 64);
  p.scatterDecor('crate', 90, 95, 40, 20, 6, 68);
  p.scatterDecor('puddle', 0, 90, WIDTH, 40, 10, 69);
  p.scatterDecor('sign', 90, 100, 1, 1, 1, 65);
}

const { decor, vectors }: { decor: DecorItem[]; vectors: MapVectorFeature[] } = (() => {
  const tiles: Terrain[] = new Array(WIDTH * HEIGHT).fill('open');
  const p = new MapPainter(tiles, WIDTH, HEIGHT, SEED);
  paintMap(p);
  const decor = p.decor.filter((d) => {
    const t = tiles[Math.floor(d.y) * WIDTH + Math.floor(d.x)];
    // a foxhole later painted over (e.g. by the balka's tallgrass fields) no longer exists
    if (d.kind === 'foxhole' && t !== 'trench') return false;
    return t !== 'water' && t !== 'buildingWood' && t !== 'buildingStone' && t !== 'floor';
  });
  return { decor, vectors: p.vectors };
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
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Kolkhoz', x: 62, y: 82, value: 3 },
    // balance: Trench Line 2->1, Balka 1->2 - harness runs showed the soviet attacker often
    // fighting reasonably well (comparable/better kills, decent alive fraction) but still
    // drawing or losing on the VL-point-dominated score formula because the German defender
    // held enough VL value even while losing the firefight. VictoryLocation.value is capped
    // at 3 (see shared/types.ts), so instead of raising Kolkhoz further this rebalances the
    // other VLs: the two the soviet attacker starts closest to (Kolkhoz+Balka = 5) now outweigh
    // the three on/near the German trench line (Trench Line+Copse+Track Junction = 3). Do NOT
    // raise Balka to 3 (tying Kolkhoz) - that made every attacking team's preferredIdx (see
    // ai.ts pickVL/allVLsSorted) funnel onto the nearer of the two tied-value VLs instead of
    // spreading pressure across objectives, which was measurably worse in testing.
    { id: 1, name: 'Trench Line', x: 100, y: 39, value: 1 },
    { id: 2, name: 'Copse', x: 150, y: 60, value: 1 },
    { id: 3, name: 'Track Junction', x: 178, y: 102, value: 1 },
    { id: 4, name: 'Balka', x: 115, y: 118, value: 2 },
  ],
  deployZones: {
    german: { x: 0, y: 0, w: 240, h: 25 },
    // balance note: an earlier pass tried enlarging/moving this zone north to shorten the
    // soviet attacker's march, but harness testing showed it made the map MORE lopsided (units
    // engaged the trench line's defenders earlier and less organized, with worse casualties on
    // every seed) - reverted to the original strip; the force-mix and VL-value changes below
    // carry this map's fix instead.
    soviet: { x: 0, y: 145, w: 240, h: 25 },
  },
  decor,
  vectors,
};
