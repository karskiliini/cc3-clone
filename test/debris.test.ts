// Spec 2026-09-17 §8: bodies stay physical. A corpse inside a blast radius is moved and blocked by
// walls like the living; a severe blast produces debris deterministically and marks the casualty;
// the debris cap holds.
import { describe, it, expect } from 'vitest';
import { TILE_M } from '@/shared/types';
import type { WeaponDef } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { applyHESplash, throwLooseObjects } from '@/sim/combat';
import { DEBRIS_CAP, dismember, isSevereBlast, severeRadiusM } from '@/sim/debris';
import { WEAPONS } from '@/data/weapons';
import { grenade, makeSoldier, makeState, makeTeam, mortar, W } from './kitHelpers';

const lethalMortar: WeaponDef = { ...mortar, lethality: 1 };

describe('corpses are thrown by later blasts (§8)', () => {
  it('a corpse inside the blast radius is moved straight away from the burst, like a living man, and gets a blast record', () => {
    const state = makeState();
    const corpse = makeSoldier({ id: 1, health: 'dead', activity: 'dead', pos: { x: 12, y: 10.5 } });
    const living = makeSoldier({ id: 2, pos: { x: 9, y: 10.5 } });
    makeTeam(state, 1, [corpse, living]);
    applyHESplash(state, new Rng(1), { x: 10.5, y: 10.5 }, mortar, 'german');
    expect(corpse.pos.x).toBeGreaterThan(12 + 1 / TILE_M - 1e-6);
    expect(corpse.pos.y).toBeCloseTo(10.5, 6);
    expect(corpse.blast).toMatchObject({ time: 10, origin: { x: 12, y: 10.5 }, from: { x: 10.5, y: 10.5 } });
    expect(corpse.health).toBe('dead');
    expect(corpse.stunnedUntil).toBeUndefined();
    // same burst, same distance on the other side: the living man flies the same distance
    expect(10.5 - 1.5 - living.pos.x).toBeCloseTo(corpse.pos.x - 12, 6);
  });

  it('an incapacitated man is a body too; a corpse outside the radius stays put; blood stains stay', () => {
    const state = makeState();
    const down = makeSoldier({ id: 1, health: 'incapacitated', activity: 'incapacitated', pos: { x: 11.5, y: 10.5 } });
    const far = makeSoldier({ id: 2, health: 'dead', activity: 'dead', pos: { x: 20, y: 10.5 } });
    makeTeam(state, 1, [down, far]);
    state.bloodDecals.push({ x: 11.5, y: 10.5 });
    throwLooseObjects(state, new Rng(1), { x: 10.5, y: 10.5 }, grenade);
    expect(down.pos.x).toBeGreaterThan(11.5);
    expect(far.pos).toEqual({ x: 20, y: 10.5 });
    expect(state.bloodDecals[0]).toEqual({ x: 11.5, y: 10.5 });
  });

  it('is blocked by a wall like the living: never through it', () => {
    const state = makeState();
    for (let y = 0; y < W; y++) state.map.tiles[y * W + 12] = 'stonewall';
    const corpse = makeSoldier({ id: 1, health: 'dead', activity: 'dead', pos: { x: 11.6, y: 10.5 } });
    makeTeam(state, 1, [corpse]);
    throwLooseObjects(state, new Rng(1), { x: 11.0, y: 10.5 }, mortar);
    expect(corpse.pos.x).toBeLessThan(12);
    expect(corpse.pos.x).toBeGreaterThanOrEqual(11.6);
  });
});

describe('severe blasts break a body up (§8)', () => {
  it('thresholds: mortar ~1 m, 75 mm+ ~2 m, satchel; never a hand grenade', () => {
    expect(severeRadiusM(WEAPONS.mortar81)).toBe(1);
    expect(severeRadiusM(WEAPONS.kwk40_75 ?? WEAPONS.f34_76)).toBe(2);
    expect(severeRadiusM(WEAPONS.satchel)).toBeGreaterThan(0);
    expect(severeRadiusM(WEAPONS.grenade)).toBe(0);
    expect(severeRadiusM(WEAPONS.kar98k)).toBe(0);
    expect(isSevereBlast(WEAPONS.mortar81, 0.4)).toBe(true);
    expect(isSevereBlast(WEAPONS.mortar81, 1)).toBe(false);
  });

  const run = (seed: number) => {
    const state = makeState();
    const victim = makeSoldier({ id: 1, pos: { x: 10.7, y: 10.5 } });
    const corpse = makeSoldier({ id: 2, health: 'dead', activity: 'dead', pos: { x: 10.5, y: 10.8 } });
    const bystander = makeSoldier({ id: 3, pos: { x: 12.4, y: 10.5 } });
    const green = makeSoldier({ id: 4, side: 'german', experience: 20, pos: { x: 17, y: 10.5 } });
    const veteran = makeSoldier({ id: 5, side: 'german', experience: 90, pos: { x: 17, y: 11.5 } });
    makeTeam(state, 1, [victim, corpse, bystander]);
    makeTeam(state, 2, [green, veteran], { side: 'german' });
    applyHESplash(state, new Rng(seed), { x: 10.5, y: 10.5 }, lethalMortar, 'german');
    return { state, victim, corpse, bystander, green, veteran };
  };

  it('marks the man it kills and the corpse it catches, records their parts along the blast direction, and spares men further out', () => {
    const { state, victim, corpse, bystander } = run(7);
    expect(victim.health).toBe('dead');
    expect(victim.dismembered).toBe(true);
    expect(corpse.dismembered).toBe(true);
    expect(bystander.dismembered).toBeUndefined();
    const debris = state.debris!;
    expect(debris.length).toBeGreaterThanOrEqual(12);
    expect(debris.length).toBeLessThanOrEqual(14);
    for (const kind of ['torso', 'head', 'arm', 'leg'] as const) expect(debris.some((d) => d.kind === kind)).toBe(true);
    for (const d of debris) {
      expect(d.side).toBe('soviet');
      expect(d.season).toBe('summer');
      expect(d.variant).toBeGreaterThanOrEqual(0);
      expect(d.variant).toBeLessThanOrEqual(2);
      const m = Math.hypot(d.pos.x - d.from!.x, d.pos.y - d.from!.y) * TILE_M;
      expect(m).toBeGreaterThan(0.5);
      expect(m).toBeLessThanOrEqual(8 + 1e-6);
    }
    // the victim stood east of the burst: his parts go east
    expect(debris.filter((d) => d.from!.x > 10.6).every((d) => d.pos.x > 10.7)).toBe(true);
    // each part lands with a stain
    expect(state.bloodDecals.length).toBeGreaterThanOrEqual(debris.length);
  });

  it('is deterministic: the same seed gives identical debris, another seed different debris', () => {
    const a = run(7).state.debris!, b = run(7).state.debris!, c = run(8).state.debris!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('witnesses within 20 m take a stress spike, green troops more', () => {
    const { green, veteran } = run(7);
    expect(veteran.mind.stress).toBeGreaterThan(0);
    expect(green.mind.stress).toBeGreaterThan(veteran.mind.stress);
  });

  it('a hand grenade never dismembers; a dismembered body is not thrown again, but its parts are', () => {
    const state = makeState();
    const corpse = makeSoldier({ id: 1, health: 'dead', activity: 'dead', pos: { x: 10.6, y: 10.5 } });
    makeTeam(state, 1, [corpse]);
    throwLooseObjects(state, new Rng(1), { x: 10.5, y: 10.5 }, grenade);
    expect(corpse.dismembered).toBeUndefined();
    throwLooseObjects(state, new Rng(1), { x: corpse.pos.x - 0.1, y: corpse.pos.y }, mortar);
    expect(corpse.dismembered).toBe(true);
    const at = { ...corpse.pos };
    const part = state.debris![0];
    const before = { ...part.pos };
    throwLooseObjects(state, new Rng(2), { x: before.x - 0.3, y: before.y }, mortar);
    expect(corpse.pos).toEqual(at);
    expect(part.pos.x).toBeGreaterThan(before.x);
    expect(part.thrownAt).toBe(10);
  });

  it('the debris cap holds, oldest removed first', () => {
    const state = makeState();
    const rng = new Rng(5);
    for (let i = 0; i < 80; i++) {
      const s = makeSoldier({ id: 1000 + i, health: 'dead', activity: 'dead', pos: { x: 5 + (i % 30), y: 20.5 } });
      state.soldiers.set(s.id, s);
      state.time = 10 + i;
      dismember(state, rng, s, { x: s.pos.x - 0.2, y: 20.5 }, 1);
    }
    expect(state.debris!.length).toBe(DEBRIS_CAP);
    expect(state.debris![state.debris!.length - 1].thrownAt).toBe(89);
    expect(state.debris![0].thrownAt).toBeGreaterThan(10);
  });
});
