import type { Terrain, TerrainProps } from '@/shared/types';

function props(p: Partial<TerrainProps>): TerrainProps {
  return {
    cover: 0,
    concealment: 0,
    blocksLOS: false,
    infantryCost: 1,
    vehicleCost: 1,
    crushable: false,
    speedMul: 1,
    ...p,
  };
}

export const TERRAIN_PROPS: Record<Terrain, TerrainProps> = {
  open: props({ cover: 0, concealment: 0, infantryCost: 1, vehicleCost: 1 }),
  grass: props({ cover: 0.05, concealment: 0.05, infantryCost: 1, vehicleCost: 1 }),
  tallgrass: props({ cover: 0.1, concealment: 0.35, infantryCost: 1.2, vehicleCost: 1.2 }),
  crops: props({ cover: 0.1, concealment: 0.4, infantryCost: 1.3, vehicleCost: 1.3 }),
  dirtroad: props({ cover: 0, concealment: 0, infantryCost: 0.8, vehicleCost: 0.5, speedMul: 1.15 }),
  pavedroad: props({ cover: 0, concealment: 0, infantryCost: 0.7, vehicleCost: 0.4, speedMul: 1.2 }),
  woods: props({ cover: 0.45, concealment: 0.5, blocksLOS: true, infantryCost: 1.8, vehicleCost: Infinity }),
  scatteredtrees: props({ cover: 0.25, concealment: 0.3, infantryCost: 1.3, vehicleCost: 2.5 }),
  buildingWood: props({ cover: 0.6, concealment: 0.7, blocksLOS: true, infantryCost: 1.5, vehicleCost: Infinity }),
  buildingStone: props({ cover: 0.85, concealment: 0.7, blocksLOS: true, infantryCost: 3, vehicleCost: Infinity }),
  floor: props({ cover: 0.5, concealment: 0.6, blocksLOS: false, infantryCost: 1.1, vehicleCost: Infinity }),
  rubble: props({ cover: 0.5, concealment: 0.4, infantryCost: 1.8, vehicleCost: 3 }),
  stonewall: props({ cover: 0.7, concealment: 0.3, blocksLOS: true, infantryCost: 2.5, vehicleCost: Infinity }),
  hedge: props({ cover: 0.3, concealment: 0.6, blocksLOS: false, infantryCost: 2, vehicleCost: 3, crushable: true }),
  fence: props({ cover: 0.05, concealment: 0.2, infantryCost: 1.5, vehicleCost: 1.5, crushable: true }),
  water: props({ cover: 0, concealment: 0, infantryCost: Infinity, vehicleCost: Infinity }),
  bridge: props({ cover: 0, concealment: 0, infantryCost: 0.8, vehicleCost: 0.6 }),
  snow: props({ cover: 0, concealment: 0.05, infantryCost: 1.4, vehicleCost: 1.6, speedMul: 0.8 }),
  mud: props({ cover: 0.05, concealment: 0.05, infantryCost: 1.8, vehicleCost: 2.5, speedMul: 0.6 }),
  crater: props({ cover: 0.5, concealment: 0.3, infantryCost: 1.3, vehicleCost: 2 }),
  trench: props({ cover: 0.8, concealment: 0.5, infantryCost: 1.4, vehicleCost: 2 }),
};

export const TERRAIN_LIST: Terrain[] = [
  'open', 'grass', 'tallgrass', 'crops', 'dirtroad', 'pavedroad',
  'woods', 'scatteredtrees', 'buildingWood', 'buildingStone', 'floor',
  'rubble', 'stonewall', 'hedge', 'fence', 'water', 'bridge',
  'snow', 'mud', 'crater', 'trench',
];
