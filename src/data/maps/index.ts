import type { MapDef } from '@/shared/types';
import { border_1941 } from './border_1941';
import { winter_1941 } from './winter_1941';
import { village_1942 } from './village_1942';
import { stalingrad_1942 } from './stalingrad_1942';
import { steppe_1943 } from './steppe_1943';
import { korsun_1944 } from './korsun_1944';
import { forest_1944 } from './forest_1944';
import { vistula_1944 } from './vistula_1944';
import { berlin_1945 } from './berlin_1945';
import { kremlin_1945 } from './kremlin_1945';

export const MAPS: MapDef[] = [border_1941, winter_1941, village_1942, stalingrad_1942, steppe_1943, korsun_1944, forest_1944, vistula_1944, berlin_1945, kremlin_1945];

export function getMap(id: string): MapDef {
  const m = MAPS.find((d) => d.id === id);
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
}
