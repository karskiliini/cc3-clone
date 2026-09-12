import type { MapDef } from '@/shared/types';
import { border_1941 } from './border_1941';
import { village_1942 } from './village_1942';
import { steppe_1943 } from './steppe_1943';
import { forest_1944 } from './forest_1944';
import { berlin_1945 } from './berlin_1945';

export const MAPS: MapDef[] = [border_1941, village_1942, steppe_1943, forest_1944, berlin_1945];

export function getMap(id: string): MapDef {
  const m = MAPS.find((d) => d.id === id);
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
}
