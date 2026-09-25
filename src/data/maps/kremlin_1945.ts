import type { DecorItem, MapDef, MapVectorFeature, Terrain } from '@/shared/types';
import type { ElevationApi } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';

const WIDTH = 230;
const HEIGHT = 170;
const SEED = 1945;

/** Late April 1945: Soviet storm groups fight across the Moltke bridge over the Spree and up
 * the Königsplatz toward the Reichstag, while the government quarter's flak tower and last
 * grenadier positions hold out block by block. */
// ---------------------------------------------------------------- shared geometry (the landform
// must follow the same river and street lines as the tiles; see border_1941.ts)
const RIVER = [
  { x: 0, y: 78 }, { x: 35, y: 81 }, { x: 70, y: 84 }, { x: 110, y: 82 },
  { x: 150, y: 85 }, { x: 190, y: 82 }, { x: 230, y: 80 },
];
const MOLTKE_ROAD = [{ x: 68, y: 0 }, { x: 68, y: 170 }];
const WILHELMSTRASSE = [{ x: 134, y: 0 }, { x: 134, y: 170 }];
const V_STREETS = [114, 164, 192];
const H_STREETS_N = [24, 68];
const H_STREETS_S = [116, 148];
// the embankment quays run parallel to the river on both banks (5 tiles off the centreline,
// clear of the 4-wide channel and its banks)
const NORTH_QUAY = RIVER.map((pt) => ({ x: pt.x, y: pt.y - 5 }));
const SOUTH_QUAY = RIVER.map((pt) => ({ x: pt.x, y: pt.y + 5 }));
// the Soviet approach: a shell-broken track out of the Tiergarten funnelling onto the
// Moltke bridge road from the southwest
const SOUTH_TRACK = [{ x: 0, y: 142 }, { x: 30, y: 130 }, { x: 58, y: 112 }, { x: 68, y: 104 }];

/** Berlin centre rises gently westward: the government quarter stands ~15 m above the eastern
 * suburbs (the Soviet assault is always looking very slightly uphill), the Spree runs in a real
 * valley between the quays, and the Königsplatz/Reichstag stand on a graded terrace ~3 m above
 * the surrounding quarter. Street grades stay inside their 11% ceilings, nothing anywhere above
 * 24% (under VEHICLE_MAX_GRADE, so the valley never traps a tank). */
function paintElevationFor(e: ElevationApi): void {
  e.base(4);
  e.rolling(1.2, 150, 5);
  e.rolling(0.5, 34, 25);
  // the long westward rise: the Ministry quarter and the Tiergarten edge sit ~15 m above the
  // eastern approach, so the assault up the Moltke bridge road works uphill the whole way
  e.slope({ x: 0, y: 0, w: 230, h: 170 }, 15, 0, 0);
  // the Spree in a wide valley between the quays — the banks must stay ≤16%/tile so the
  // graded streets can ramp down to the bridge decks without the pair-relaxation eating the
  // corridor; the channel cut runs before the grading for the same reason
  e.valley(RIVER, 64, 3.5);
  e.cutRiver(RIVER, 4, 0.5);
  // the Königsplatz/Reichstag terrace: a 12 m shelf with a wide feather so the cross streets
  // can build compliant ramps over its edge instead of eroding to a 24% wall
  e.terrace({ x: 78, y: 36, w: 44, h: 34 }, 12, 16);
  e.smoothElevation(2);
  // Road grading caps are a CEILING, not a target (paved ~11%, the Tiergarten track 20%): the
  // corridors follow the already-flat city ground and only cut where the Spree valley falls.
  const gradeStreets = (): void => {
    e.gradeRoad(MOLTKE_ROAD, 6, 11);
    e.gradeRoad(WILHELMSTRASSE, 7, 11);
    for (const x of V_STREETS) e.gradeRoad([{ x, y: 0 }, { x, y: 170 }], 5, 11);
    for (const y of H_STREETS_N) e.gradeRoad([{ x: 78, y }, { x: 230, y }], 5, 11);
    for (const y of H_STREETS_S) e.gradeRoad([{ x: 78, y }, { x: 230, y }], 5, 11);
    e.gradeRoad(NORTH_QUAY, 4, 11);
    e.gradeRoad(SOUTH_QUAY, 4, 11);
    e.gradeRoad(SOUTH_TRACK, 4, 20);
  };
  gradeStreets();
  e.smoothElevation(2);
  // re-assert the road grades: smoothing blends the graded corridor back into the ground
  // beside it, which is what let a "graded" road creep above its ceiling (winter_1941.ts fix)
  gradeStreets();
  // no cliffs, and nothing above VEHICLE_MAX_GRADE (0.25)
  e.limitGrade(24);
  e.clampRange(0, 25);
}

function paintMap(p: MapPainter): void {
  p.fill('open');
  // season note: late April 1945 — the Season union has no 'spring', so the shell-broken,
  // thaw-muddied city ground is painted as autumn: open verges dusted with mud, no snow.

  // ---------------------------------------------------------------- Tiergarten (west/southwest)
  // the park edge is a belt of tree cover with scattered clearings between it and the bridge;
  // the Soviet jump-off ground sits on the open fringe behind the belt.
  p.field(16, 58, 22, 14, 'grass', 7);
  p.field(22, 104, 18, 12, 'grass', 8);
  p.woods(20, 30, 18, 16);
  p.woods(34, 62, 16, 14);
  p.woods(52, 142, 15, 12);
  p.woods(24, 162, 14, 8);
  // the park's ragged eastern tree line, facing the bridge road
  p.treeLine([{ x: 58, y: 36 }, { x: 60, y: 96 }, { x: 56, y: 126 }], 3, 0.3);

  // ---------------------------------------------------------------- streets and quays
  for (const x of V_STREETS) p.road([{ x, y: 0 }, { x, y: 170 }], 5, 'pavedroad');
  for (const y of H_STREETS_N) p.road([{ x: 78, y }, { x: 230, y }], 5, 'pavedroad');
  for (const y of H_STREETS_S) p.road([{ x: 78, y }, { x: 230, y }], 5, 'pavedroad');
  p.road(WILHELMSTRASSE, 7, 'pavedroad'); // wide government avenue, tram loop the whole length
  p.decorLine(WILHELMSTRASSE, 'tramwire', 9);
  p.decorLine(WILHELMSTRASSE, 'pole', 17);
  p.road([{ x: 78, y: 148 }, { x: 230, y: 148 }], 7, 'pavedroad'); // southern tram avenue
  p.decorLine([{ x: 80, y: 148 }, { x: 228, y: 148 }], 'tramwire', 11);
  p.road(MOLTKE_ROAD, 6, 'pavedroad'); // the Moltke bridge road, through the park
  p.road(NORTH_QUAY, 4, 'pavedroad');
  p.road(SOUTH_QUAY, 4, 'pavedroad');
  p.road(SOUTH_TRACK, 4, 'dirtroad');
  p.decorLine(NORTH_QUAY, 'pole', 18);

  // ---------------------------------------------------------------- the Spree and the Moltke bridge
  p.river(RIVER, 4);
  // the Moltke bridge: wide, paved, exactly on the true road/river crossing (an earlier
  // hand-placed rect drifted off the crossing and rendered as planks beside the road)
  p.bridgeAcross(MOLTKE_ROAD, 6, RIVER, 4, { bankMargin: 2, near: { x: 68, y: 84 } });

  // ---------------------------------------------------------------- Königsplatz and the Reichstag
  // the Reichstag: a very large stone shell with its staircase approach opening onto the
  // paved square on its south side
  p.building(83, 38, 24, 10, 'stone');
  p.rect(91, 48, 10, 2, 'pavedroad'); // staircase approach
  p.rect(82, 50, 28, 16, 'pavedroad'); // Königsplatz
  p.addDecor('sign', 96, 64);
  // burned-out Königstiger the storm groups found in the plaza
  p.addDecor('wreck', 99, 62);

  // ---------------------------------------------------------------- the government quarter
  // stone courtyard blocks in a regular grid; the bombed-out ones collapse to ruins whose
  // rubble stays inside the footprint. Rubble discipline: no blanket coverage.
  p.block(84, 6, 22, 14, 'stone');
  p.block(119, 2, 11, 18, 'stone');
  p.ruin(139, 2, 22, 18, 11);
  p.block(168, 2, 20, 18, 'stone');
  // the flak tower: a huge solid concrete block anchoring the quarter's northeast corner
  p.rect(198, 2, 26, 20, 'buildingStone');
  p.building(88, 28, 16, 8, 'stone');
  p.block(119, 28, 11, 10, 'stone');
  p.block(139, 28, 22, 10, 'stone');
  p.block(168, 28, 20, 10, 'stone');
  p.block(119, 40, 11, 11, 'stone');
  p.ruin(139, 40, 22, 11, 12);
  p.block(168, 40, 20, 11, 'stone');
  p.block(197, 40, 26, 11, 'stone');
  // south of the Spree: the embankment quarter
  p.block(119, 94, 11, 16, 'stone');
  p.block(139, 94, 22, 16, 'stone');
  p.block(168, 94, 20, 16, 'stone');
  p.block(197, 94, 26, 16, 'stone');
  p.ruin(84, 120, 22, 22, 13);
  p.block(119, 120, 11, 22, 'stone');
  p.block(139, 120, 22, 22, 'stone');
  p.block(168, 120, 20, 22, 'stone');
  p.block(197, 120, 26, 22, 'stone');
  p.block(84, 152, 22, 16, 'stone');
  p.block(119, 152, 11, 16, 'stone');
  p.block(139, 152, 22, 16, 'stone');
  p.block(168, 152, 20, 16, 'stone');
  p.block(197, 152, 26, 16, 'stone');

  // ---------------------------------------------------------------- U-Bahn / canal passage corridor
  // the drained canal cutting east of the Reichstag: a short, sunken, covered passage
  p.line([{ x: 120, y: 112 }, { x: 142, y: 112 }], 'trench');
  p.line([{ x: 120, y: 113 }, { x: 142, y: 113 }], 'trench');

  // ---------------------------------------------------------------- anti-tank ditch on the approach
  // a dug-in ditch across the bridge road where the Soviet approach funnels, breached in one
  // rubble-filled gap where the storm groups carried their ladders across
  p.line([{ x: 61, y: 98 }, { x: 66, y: 98 }], 'trench');
  p.line([{ x: 70, y: 98 }, { x: 75, y: 98 }], 'trench');
  p.patch(68, 98, 1.8, 'rubble');
  p.patch(63, 100, 2.5, 'rubble');
  p.patch(72, 96, 2.5, 'rubble');

  // barricades across the contested streets between the bridge and the square
  p.line([{ x: 112, y: 58 }, { x: 116, y: 58 }], 'rubble');
  p.line([{ x: 112, y: 59 }, { x: 114, y: 59 }], 'stonewall');
  p.line([{ x: 131, y: 100 }, { x: 137, y: 100 }], 'rubble');
  p.line([{ x: 133, y: 101 }, { x: 137, y: 101 }], 'stonewall');

  // ---------------------------------------------------------------- battle damage
  // crater strings along the quays and down the avenue; the bridge stretch itself is kept
  // clear so shell holes never punch through the bridge deck (tStart/tEnd avoid it)
  p.craterLine(NORTH_QUAY, { tStart: 0.36, tEnd: 0.95, seedOffset: 200, minGap: 18, maxGap: 28 });
  p.craterLine(SOUTH_QUAY, { tStart: 0.36, tEnd: 0.95, seedOffset: 201, minGap: 18, maxGap: 28 });
  p.craterLine(WILHELMSTRASSE, { tStart: 0.3, tEnd: 0.7, seedOffset: 202, minGap: 18, maxGap: 28 });
  p.craterLine(SOUTH_TRACK, { tStart: 0.4, tEnd: 1.0, seedOffset: 203, minGap: 16, maxGap: 26 });
  p.patch(96, 70, 3, 'crater');
  p.patch(88, 96, 3, 'crater');
  p.patch(150, 120, 3, 'crater');
  p.patch(190, 60, 2.5, 'crater');
  p.patch(120, 28, 2.5, 'crater');

  // rubble: small street patches around the craters and barricades (not blanket coverage)
  p.patch(96, 74, 3, 'rubble');
  p.patch(120, 96, 3, 'rubble');
  p.patch(140, 52, 3, 'rubble');
  p.patch(170, 30, 3, 'rubble');
  p.patch(108, 130, 3, 'rubble');
  p.noiseFill('rubble', 0.05, ['pavedroad']);
  // late-April mud across the shell-broken open ground
  p.noiseFill('mud', 0.07, ['open', 'grass']);

  // ---------------------------------------------------------------- foxholes
  // German grenadiers dug in behind the east quay, covering the bridge; Soviet scouts dug
  // into the park fringe facing the ditch
  p.foxholeLine([{ x: 111, y: 70 }, { x: 113, y: 76 }], { x: 68, y: 84 }, { spacing: 4, stagger: 1, seedOffset: 91, keepClear: [{ x: 68, y: 84, r: 4 }] });
  p.foxholeLine([{ x: 50, y: 92 }, { x: 54, y: 100 }], { x: 68, y: 92 }, { spacing: 5, stagger: 1.5, seedOffset: 92 });

  // ---------------------------------------------------------------- decor dressing
  p.addDecor('wreck', 70, 92);
  p.addDecor('wreck', 136, 108);
  p.addDecor('wreck', 194, 26);
  p.addDecor('woodpile', 104, 68);
  // rubble scatter and debris around the Reichstag and the square
  p.scatterDecor('rocks', 82, 48, 30, 24, 10, 63);
  p.scatterDecor('crate', 82, 54, 30, 14, 8, 64);
  p.scatterDecor('shellhole', 0, 0, WIDTH, HEIGHT, 18, 50);
  p.scatterDecor('barrel', 0, 0, WIDTH, HEIGHT, 26, 51);
  p.scatterDecor('crate', 0, 0, WIDTH, HEIGHT, 22, 52);
  p.scatterDecor('rocks', 0, 0, WIDTH, HEIGHT, 16, 53);
  p.scatterDecor('puddle', 0, 0, WIDTH, HEIGHT, 12, 54);
  p.scatterDecor('sign', 0, 0, WIDTH, HEIGHT, 8, 55);
  p.scatterDecor('log', 8, 30, 56, 120, 10, 56); // fallen timber in the Tiergarten
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

export const kremlin_1945: MapDef = {
  id: 'kremlin_1945',
  name: 'Reichstag Quarter',
  description: 'April 1945: Soviet storm groups fight across the Moltke bridge and up the Königsplatz toward the Reichstag, the last stand of the Third Reich.',
  width: WIDTH,
  height: HEIGHT,
  // autumn = late-April shell-broken mud; the Season union has no 'spring'
  season: 'autumn',
  attacker: 'soviet',
  paint(tiles: Terrain[], w: number, h: number) {
    const p = new MapPainter(tiles, w, h, SEED);
    paintMap(p);
  },
  elevation: paintElevationFor,
  victoryLocations: [
    { id: 0, name: 'Reichstag', x: 96, y: 49, value: 3 },
    { id: 1, name: 'Königsplatz', x: 96, y: 57, value: 2 },
    { id: 2, name: 'Moltke Bridge', x: 68, y: 84, value: 2 },
    // balance: the flak tower anchors the German strongpoint and is worth less than the
    // bridge/square axis the two sides actually fight for (see steppe_1942.ts values note)
    { id: 3, name: 'Flak Tower', x: 210, y: 24, value: 1 },
    { id: 4, name: 'Wilhelmstrasse', x: 134, y: 120, value: 1 },
    { id: 5, name: 'Spree Quay', x: 112, y: 87, value: 1 },
  ],
  // one screen across, ~130 tiles (260 m) apart, straddling the contested bridge/square axis:
  // the Soviets jump off from behind the Tiergarten edge, the grenadiers in the quarter's
  // east-bank blocks north of the Spree
  deployZones: {
    soviet: { x: 6, y: 120, w: 26, h: 26 },
    german: { x: 118, y: 54, w: 28, h: 28 },
  },
  // G7: two concrete pillboxes flanking the Moltke bridge approaches on the east bank
  bunkers: [
    { x: 72, y: 74, w: 2, h: 2, side: 'german' },
    { x: 72, y: 94, w: 2, h: 2, side: 'german' },
  ],
  // COA overlays (G21): the Soviet storm crosses the Moltke bridge and fights up the road to
  // the Reichstag with assault groups on the square and rocket fires from the Tiergarten; the
  // Germans hold the Spree quays and the Reichstag perimeter, reserve armour coming down the
  // Wilhelmstrasse.
  coa: {
    stages: ['Overwatch', 'Cross the Spree', 'Cut wire', 'Reduce flak tower', 'Assault Reichstag', 'Consolidate square'],
    german: [
      { pts: [{ x: 36, y: 90 }, { x: 68, y: 86 }, { x: 112, y: 88 }, { x: 152, y: 92 }], kind: 'defenses' },
      { pts: [{ x: 84, y: 52 }, { x: 110, y: 54 }, { x: 122, y: 60 }], kind: 'defenses' },
      { pts: [{ x: 150, y: 26 }, { x: 132, y: 44 }, { x: 116, y: 54 }], kind: 'armor' },
    ],
    soviet: [
      { pts: [{ x: 22, y: 132 }, { x: 52, y: 110 }, { x: 68, y: 86 }, { x: 70, y: 62 }, { x: 84, y: 52 }, { x: 94, y: 50 }], kind: 'armor' },
      { pts: [{ x: 26, y: 126 }, { x: 56, y: 100 }, { x: 84, y: 68 }, { x: 95, y: 58 }], kind: 'assault' },
      { pts: [{ x: 30, y: 140 }, { x: 92, y: 52 }], kind: 'firesupport' },
    ],
  },
  decor,
  vectors,
};

