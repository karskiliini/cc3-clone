import { describe, it, expect } from 'vitest';
import { TERRAIN_PROPS, TERRAIN_LIST } from '@/sim/terrain';

describe('terrain', () => {
  it('has props for every terrain in the list', () => {
    for (const t of TERRAIN_LIST) {
      expect(TERRAIN_PROPS[t]).toBeDefined();
      expect(typeof TERRAIN_PROPS[t].cover).toBe('number');
      expect(typeof TERRAIN_PROPS[t].infantryCost).toBe('number');
    }
  });

  it('water is impassable for both movers', () => {
    expect(TERRAIN_PROPS.water.infantryCost).toBe(Infinity);
    expect(TERRAIN_PROPS.water.vehicleCost).toBe(Infinity);
  });

  it('woods and buildings block LOS and are impassable for vehicles', () => {
    expect(TERRAIN_PROPS.woods.blocksLOS).toBe(true);
    expect(TERRAIN_PROPS.woods.vehicleCost).toBe(Infinity);
    expect(TERRAIN_PROPS.buildingWood.blocksLOS).toBe(true);
    expect(TERRAIN_PROPS.buildingStone.blocksLOS).toBe(true);
    expect(TERRAIN_PROPS.buildingWood.vehicleCost).toBe(Infinity);
    expect(TERRAIN_PROPS.buildingStone.vehicleCost).toBe(Infinity);
  });

  it('roads are cheaper and faster than open ground', () => {
    expect(TERRAIN_PROPS.dirtroad.infantryCost).toBeLessThan(TERRAIN_PROPS.open.infantryCost);
    expect(TERRAIN_PROPS.pavedroad.speedMul).toBeGreaterThan(1);
  });

  it('hedge and fence are crushable, woods is not', () => {
    expect(TERRAIN_PROPS.hedge.crushable).toBe(true);
    expect(TERRAIN_PROPS.fence.crushable).toBe(true);
    expect(TERRAIN_PROPS.woods.crushable).toBe(false);
  });
});
