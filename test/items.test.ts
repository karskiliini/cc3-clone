// Spec 2026-09-17 §9: kit as objects on the ground, and picking things up as an individual
// decision. Ammunition pickup when low and compatible; MG takeover by the nearest able man; no
// pickup while pinned or under fire; grenades topped up to the cap; the replaced weapon becomes an
// item; a captured weapon has only the rounds found with it; items move with blasts.
import { describe, it, expect } from 'vitest';
import type { BattleState, GroundItem, Soldier } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { applyHESplash, throwLooseObjects } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { UNARMED, addItem, dropKit, fullLoad, stepItemDrops } from '@/sim/items';
import { GRENADE_CAP, stepPickups } from '@/sim/pickup';
import { Battle } from '@/sim/battle';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { grenade, makeSoldier, makeState, makeTeam, mortar } from './kitHelpers';

function run(state: BattleState, rng: Rng, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    state.time = Math.round((state.time + SIM_DT) * 1000) / 1000;
    stepMovement(state, rng, SIM_DT);
    stepItemDrops(state, rng);
    stepPickups(state, rng, SIM_DT);
    each?.();
  }
}
const weaponItem = (state: BattleState, weaponId: string, x: number, y: number, rounds: number, o: Partial<GroundItem> = {}): GroundItem =>
  addItem(state, { kind: 'weapon', weaponId, rounds, side: 'soviet', pos: { x, y }, dir: 0, sprite: weaponId, ...o });
const ammoItem = (state: BattleState, weaponId: string, x: number, y: number, rounds: number): GroundItem =>
  addItem(state, { kind: 'ammo', weaponId, rounds, side: 'soviet', pos: { x, y }, dir: 0, sprite: 'ammo_pouch' });
const items = (state: BattleState, kind?: string): GroundItem[] => (state.items ?? []).filter((i) => !kind || i.kind === kind);

describe('kit becomes items (§9)', () => {
  it('a dead man leaves his weapon with the rounds in it, his spare ammunition and his grenades, scattered a little', () => {
    const state = makeState();
    const s = makeSoldier({ id: 1, health: 'dead', activity: 'dead', ammo: 3, ammoReserve: 25, grenades: 2 });
    makeTeam(state, 1, [s]);
    stepItemDrops(state, new Rng(1));
    expect(items(state, 'weapon')).toMatchObject([{ weaponId: 'mosin', rounds: 3, side: 'soviet', teamId: 1, sprite: 'mosin' }]);
    expect(items(state, 'ammo')).toMatchObject([{ weaponId: 'mosin', rounds: 25 }]);
    expect(items(state, 'grenades')).toMatchObject([{ count: 2 }]);
    for (const it of items(state)) expect(Math.hypot(it.pos.x - 10.5, it.pos.y - 10.5) * TILE_M).toBeLessThan(1.5);
    expect([s.ammo, s.ammoReserve, s.grenades, s.weaponId]).toEqual([0, 0, 0, UNARMED]);
    stepItemDrops(state, new Rng(1)); // never twice
    expect(items(state).length).toBe(3);
  });

  it('incapacitated men and prisoners drop theirs too', () => {
    const state = makeState();
    const a = makeSoldier({ id: 1, health: 'incapacitated', activity: 'incapacitated' });
    const b = makeSoldier({ id: 2, activity: 'surrendered', pos: { x: 20.5, y: 20.5 } });
    makeTeam(state, 1, [a, b]);
    stepItemDrops(state, new Rng(1));
    expect(items(state, 'weapon').length).toBe(2);
    expect(b.weaponId).toBe(UNARMED);
  });

  it('a man who panics may throw his weapon away (green troops far more often), keeping his grenades', () => {
    const dropped = (experience: number): number => {
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const state = makeState();
        const s = makeSoldier({ id: 1, experience });
        makeTeam(state, 1, [s]);
        const rng = new Rng(seed);
        stepItemDrops(state, rng);
        s.mind.state = 'panicked';
        stepItemDrops(state, rng);
        if (s.weaponId === UNARMED) { n++; expect(s.grenades).toBe(2); expect(items(state, 'weapon').length).toBe(1); }
      }
      return n;
    };
    const green = dropped(15), vet = dropped(90);
    expect(green).toBeGreaterThan(30);
    expect(vet).toBeLessThan(green / 2);
  });

  it("a crew-served weapon is the team's, not kit: a dead HMG gunner drops no weapon item", () => {
    const state = makeState();
    const g = makeSoldier({ id: 1, weaponId: 'maxim', health: 'dead', activity: 'dead', grenades: 0 });
    makeTeam(state, 1, [g], { type: 'mg' });
    stepItemDrops(state, new Rng(1));
    expect(items(state).length).toBe(0);
    expect(g.weaponId).toBe('maxim');
  });

  it('the item list is capped', () => {
    const state = makeState();
    for (let i = 0; i < 700; i++) ammoItem(state, 'mosin', 5 + (i % 30), 5, 5);
    expect(state.items!.length).toBe(600);
  });
});

describe('picking things up (§9)', () => {
  it('ammunition: a man below half load walks to compatible rounds, stoops 2-3 s, and fills up; a man with plenty, or another cartridge, does not', () => {
    const state = makeState();
    const low = makeSoldier({ id: 1, ammo: 2, ammoReserve: 3, pos: { x: 10.5, y: 10.5 } });
    const full = makeSoldier({ id: 2, ammo: 5, ammoReserve: 30, pos: { x: 10.5, y: 11.5 } });
    const smg = makeSoldier({ id: 3, weaponId: 'ppsh41', ammo: 1, ammoReserve: 0, pos: { x: 11.5, y: 10.5 }, isLeader: true });
    makeTeam(state, 1, [smg, low, full]);
    const pouch = ammoItem(state, 'dp28', 11.4, 11.2, 60); // 7.62x54R: fits the Mosin, not the PPSh
    const rng = new Rng(1);
    let stoopedFor = 0;
    run(state, rng, 12, () => { if (low.pickup?.until != null) stoopedFor += SIM_DT; });
    expect(low.ammo + low.ammoReserve).toBe(fullLoad(WEAPONS.mosin));
    expect(pouch.rounds).toBe(60 - (fullLoad(WEAPONS.mosin) - 5));
    expect(stoopedFor).toBeGreaterThanOrEqual(1.9);
    expect(stoopedFor).toBeLessThanOrEqual(3.1);
    expect(low.pickup).toBeUndefined();
    expect(full.ammoReserve).toBe(30);
    expect(smg.ammoReserve).toBe(0);
    expect(state.messages.some((m) => /picks up ammunition/.test(m.text))).toBe(true);
  });

  it('out of ammunition he goes up to 5 m for it, otherwise only about 3 m', () => {
    const go = (ammo: number) => {
      const state = makeState();
      const s = makeSoldier({ id: 1, ammo, ammoReserve: 0 });
      makeTeam(state, 1, [s]);
      ammoItem(state, 'mosin', 10.5 + 4.4 / TILE_M, 10.5, 40);
      run(state, new Rng(1), 12);
      return s.ammoReserve;
    };
    expect(go(0)).toBeGreaterThan(0);
    expect(go(1)).toBe(0);
  });

  it("MG takeover: the nearest able rifleman takes over the squad's gun and its belts; the others stay put", () => {
    const state = makeState();
    const leader = makeSoldier({ id: 1, weaponId: 'ppsh41', isLeader: true, pos: { x: 10.2, y: 12 } });
    const gunner = makeSoldier({ id: 2, weaponId: 'dp28', ammo: 30, ammoReserve: 200, grenades: 0, pos: { x: 10.5, y: 10.5 } });
    const nearPinned = makeSoldier({ id: 3, pos: { x: 11.2, y: 10.5 } });
    const near = makeSoldier({ id: 4, pos: { x: 12.5, y: 10.5 } });
    const far = makeSoldier({ id: 5, pos: { x: 14.5, y: 10.5 } });
    makeTeam(state, 1, [leader, gunner, nearPinned, near, far]);
    nearPinned.mind.state = 'pinned'; nearPinned.activity = 'pinned';
    gunner.health = 'dead'; gunner.activity = 'dead';
    const rng = new Rng(3);
    run(state, rng, 1.2, () => { nearPinned.mind.state = 'pinned'; });
    expect(near.pickup).toBeDefined();
    expect(far.pickup).toBeUndefined();
    expect(leader.pickup).toBeUndefined();
    run(state, rng, 14, () => { nearPinned.mind.state = 'pinned'; });
    expect(near.weaponId).toBe('dp28');
    expect(near.ammo).toBe(30);
    expect(near.ammoReserve).toBe(200 + 30);      // the belts came with it; his own 7.62 mm rounds fit too
    expect([far.weaponId, leader.weaponId, nearPinned.weaponId]).toEqual(['mosin', 'ppsh41', 'mosin']);
    expect(items(state, 'weapon').map((i) => i.weaponId)).toEqual(['mosin']); // his rifle lies where the gun was
    expect(state.messages.some((m) => /takes over the DP-28\./.test(m.text))).toBe(true);
  });

  it('no pickup while pinned, stunned or under fire; he gives it up when fire comes in', () => {
    const setup = () => {
      const state = makeState();
      const s = makeSoldier({ id: 1, ammo: 0, ammoReserve: 0 });
      makeTeam(state, 1, [s]);
      ammoItem(state, 'mosin', 11.5, 10.5, 40);
      return { state, s };
    };
    let t = setup();
    run(t.state, new Rng(1), 10, () => { t.s.mind.state = 'pinned'; });
    expect(t.s.ammoReserve).toBe(0);
    t = setup();
    t.s.stunnedUntil = 1e9;
    run(t.state, new Rng(1), 10);
    expect(t.s.ammoReserve).toBe(0);
    t = setup();
    run(t.state, new Rng(1), 10, () => { t.s.mind.lastIncomingAt = t.state.time; });
    expect(t.s.ammoReserve).toBe(0);
    expect(t.s.pickup).toBeUndefined();
    // sets off in a lull, then comes under fire: gives up and the item is free again
    t = setup();
    run(t.state, new Rng(1), 1.1);
    expect(t.s.pickup).toBeDefined();
    t.s.mind.lastIncomingAt = t.state.time;
    run(t.state, new Rng(1), 0.2);
    expect(t.s.pickup).toBeUndefined();
    expect(t.state.items![0].claimedBy).toBeUndefined();
    // control: left alone he gets it
    t = setup();
    run(t.state, new Rng(1), 10);
    expect(t.s.ammoReserve).toBeGreaterThan(0);
  });

  it('grenades are topped up to the cap and the rest stays on the ground; a man with two takes none', () => {
    const state = makeState();
    const s = makeSoldier({ id: 1, grenades: 1 });
    const stocked = makeSoldier({ id: 2, grenades: 2, pos: { x: 12.5, y: 10.5 } });
    makeTeam(state, 1, [s, stocked]);
    const pile = addItem(state, { kind: 'grenades', count: 5, side: 'german', pos: { x: 11.5, y: 10.5 }, dir: 0, sprite: 'grenade_german' });
    run(state, new Rng(1), 12);
    expect(s.grenades).toBe(GRENADE_CAP);
    expect(stocked.grenades).toBe(2);
    expect(pile.count).toBe(5 - (GRENADE_CAP - 1));
    expect(state.items).toContain(pile);
  });

  it('a better weapon: the replaced weapon becomes an item; a captured weapon has only the rounds found with it', () => {
    const state = makeState();
    state.map.tiles.fill('woods'); // an SMG is the better weapon in woods
    const s = makeSoldier({ id: 1, ammo: 5, ammoReserve: 30 });
    makeTeam(state, 1, [s]);
    weaponItem(state, 'mp40', 11.5, 10.5, 17, { side: 'german' });
    run(state, new Rng(1), 12);
    expect(s.weaponId).toBe('mp40');
    expect(s.ammo + s.ammoReserve).toBe(17);      // only what was found with it
    const left = items(state);
    expect(left.find((i) => i.kind === 'weapon')).toMatchObject({ weaponId: 'mosin', rounds: 5 });
    expect(left.find((i) => i.kind === 'ammo')).toMatchObject({ weaponId: 'mosin', rounds: 30 });
    // and he does not swap back
    run(state, new Rng(2), 10);
    expect(s.weaponId).toBe('mp40');
  });

  it('rifle in open country, SMG in woods; leaders and specialists keep their role weapons unless out of ammunition', () => {
    const go = (terrain: 'open' | 'woods', o: Partial<Soldier>, itemId: string) => {
      const state = makeState();
      state.map.tiles.fill(terrain);
      const s = makeSoldier({ id: 1, ...o });
      makeTeam(state, 1, [makeSoldier({ id: 9, isLeader: true, pos: { x: 30, y: 30 } }), s]);
      weaponItem(state, itemId, 11.5, 10.5, 20);
      run(state, new Rng(1), 12);
      return s.weaponId;
    };
    expect(go('open', {}, 'ppsh41')).toBe('mosin');
    expect(go('woods', {}, 'ppsh41')).toBe('ppsh41');
    expect(go('open', {}, 'svt40')).toBe('svt40');
    expect(go('open', { weaponId: 'pistol_tt' }, 'mosin')).toBe('mosin');
    expect(go('woods', { isLeader: true }, 'ppsh41')).toBe('mosin');
    expect(go('woods', { weaponId: 'mosin_scoped' }, 'ppsh41')).toBe('mosin_scoped');
    expect(go('woods', { weaponId: 'mosin_scoped', ammo: 0, ammoReserve: 0 }, 'ppsh41')).toBe('ppsh41');
  });

  it('an AT weapon is taken when the team has none and enemy armour is known — not otherwise', () => {
    const go = (armourKnown: boolean) => {
      const state = makeState();
      const s = makeSoldier({ id: 1, side: 'german', weaponId: 'kar98k' });
      makeTeam(state, 1, [s], { side: 'german' });
      if (armourKnown) {
        state.vehicles.set(50, { id: 50, state: 'ok', pos: { x: 35, y: 35 }, side: 'soviet' } as never);
        state.spottedVehicles.german.add(50);
      }
      weaponItem(state, 'panzerfaust', 11.5, 10.5, 1, { side: 'german' });
      run(state, new Rng(1), 12);
      return s.weaponId;
    };
    expect(go(true)).toBe('panzerfaust');
    expect(go(false)).toBe('kar98k');
  });

  it('takes at most one decision per soldier per second, and two men never go for the same item', () => {
    const state = makeState();
    const a = makeSoldier({ id: 1, ammo: 0, ammoReserve: 0, pos: { x: 10.5, y: 10.5 } });
    const b = makeSoldier({ id: 2, ammo: 0, ammoReserve: 0, pos: { x: 12.5, y: 10.5 } });
    makeTeam(state, 1, [a, b]);
    ammoItem(state, 'mosin', 11.5, 10.5, 40);
    const rng = new Rng(1);
    let both = false;
    run(state, rng, 1.2, () => { if (a.pickup && b.pickup) both = true; });
    expect(both).toBe(false);
    expect(!!a.pickup !== !!b.pickup).toBe(true);
  });

  it('after the pickup he goes on to where he was ordered', () => {
    const state = makeState();
    const s = makeSoldier({ id: 1, ammo: 0, ammoReserve: 0, activity: 'moving', path: [{ x: 25.5, y: 10.5 }] });
    makeTeam(state, 1, [s]);
    ammoItem(state, 'mosin', 12.5, 11.3, 40);
    const rng = new Rng(1);
    // Picking up ammunition leaves him crouched; allow the return route at that posture's pace.
    for (let seconds = 0; seconds < 90 && Math.hypot(s.pos.x - 25.5, s.pos.y - 10.5) >= 1; seconds++) run(state, rng, 1);
    expect(s.ammoReserve).toBeGreaterThan(0);
    expect(Math.hypot(s.pos.x - 25.5, s.pos.y - 10.5)).toBeLessThan(1);
  });
});

describe('items and blasts (§9)', () => {
  it('items move with blasts, away from the burst, and not through walls; items outside the radius stay', () => {
    const state = makeState();
    for (let y = 0; y < 40; y++) state.map.tiles[y * 40 + 8] = 'stonewall';
    const east = weaponItem(state, 'mosin', 11.5, 10.5, 5);
    const west = weaponItem(state, 'dp28', 9.6, 10.5, 47);
    const far = weaponItem(state, 'mosin', 20, 10.5, 5);
    throwLooseObjects(state, new Rng(1), { x: 10.5, y: 10.5 }, mortar);
    expect(east.pos.x).toBeGreaterThan(11.5 + 0.2);
    expect(east.from).toEqual({ x: 11.5, y: 10.5 });
    expect(east.thrownAt).toBe(10);
    expect(west.pos.x).toBeLessThan(9.6);
    expect(west.pos.x).toBeGreaterThanOrEqual(9);
    expect(far.pos).toEqual({ x: 20, y: 10.5 });
    expect(east.rounds).toBe(5);
  });

  it('a man killed by a burst leaves his kit, and it is thrown by that burst', () => {
    let state = makeState();
    let s = makeSoldier({ id: 1 });
    for (let seed = 1; seed < 40; seed++) {
      state = makeState();
      s = makeSoldier({ id: 1, pos: { x: 11.0, y: 10.5 } });
      makeTeam(state, 1, [s]);
      applyHESplash(state, new Rng(seed), { x: 10.5, y: 10.5 }, { ...grenade, lethality: 1 }, 'german');
      if (s.health === 'dead' || s.health === 'incapacitated') break;
    }
    expect(s.health === 'dead' || s.health === 'incapacitated').toBe(true);
    const w = items(state, 'weapon')[0];
    expect(w).toMatchObject({ weaponId: 'mosin', thrownAt: 10 });
    expect(w.pos.x).toBeGreaterThan(11.0);
  });

  it('dropKit is idempotent and deterministic', () => {
    const once = (seed: number) => {
      const state = makeState();
      const s = makeSoldier({ id: 1 });
      makeTeam(state, 1, [s]);
      dropKit(state, new Rng(seed), s);
      dropKit(state, new Rng(seed), s);
      return JSON.stringify(state.items);
    };
    expect(once(4)).toBe(once(4));
    expect(JSON.parse(once(4)).length).toBe(3);
  });
});

describe('in a real battle', () => {
  it('casualties leave items, and two runs with the same seed agree on every item and body part', () => {
    const play = () => {
      const map = MAPS[0];
      const battle = new Battle({
        mapId: map.id, playerSide: 'german', year: 1941, seed: 5, durationS: 1200, difficulty: 'normal',
        forces: { german: DEFAULT_FORCES[1941].german, soviet: DEFAULT_FORCES[1941].soviet }, aiBothSides: true,
      } as never);
      battle.start();
      for (let i = 0; i < 900 && battle.state.phase === 'running'; i++) battle.step(SIM_DT);
      return battle.state;
    };
    const a = play(), b = play();
    const casualties = Array.from(a.soldiers.values()).filter((s) => s.health === 'dead' && s.vehicleId == null).length;
    if (casualties > 0) expect((a.items ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(a.items ?? [])).toBe(JSON.stringify(b.items ?? []));
    expect(JSON.stringify(a.debris ?? [])).toBe(JSON.stringify(b.debris ?? []));
  }, 60000);
});

describe('feedback (§9)', () => {
  it('the soldier monitor shows the new weapon and rounds straight after a pickup, and the stoop plays the pickup animation', async () => {
    const { weaponReadout } = await import('@/ui/hud/soldierMonitor');
    const { actionFor, frameFor, weaponSuffix, entryKeyChain } = await import('@/render/soldierAnim');
    const state = makeState();
    state.map.tiles.fill('woods');
    const s = makeSoldier({ id: 1 });
    const team = makeTeam(state, 1, [s]);
    weaponItem(state, 'ppsh41', 11.5, 10.5, 35);
    expect(weaponReadout(s, team, undefined, 'Soldat')).toMatchObject({ label: 'Mosin', rounds: 5 });
    const rng = new Rng(1);
    let sawPickup = false; const frames = new Set<number>();
    run(state, rng, 12, () => {
      if (s.pickup?.until != null) {
        sawPickup = true;
        expect(actionFor(s, state.time)).toBe('pickup');
        frames.add(frameFor(s, state.time, 'pickup', { frames: 4, fps: 2, loop: false }));
      }
    });
    expect(sawPickup).toBe(true);
    expect(Array.from(frames).sort()).toEqual([0, 1, 2, 3]);
    expect(entryKeyChain('crouched', 'pickup', 'calm', 'rifle')[0]).toBe('crouched.pickup@rifle');
    expect(weaponReadout(s, team, undefined, 'Soldat')).toMatchObject({ label: 'PPSh', rounds: 35 });
    s.weaponId = UNARMED;
    expect(weaponSuffix(s.weaponId)).toBe('none');
    expect(weaponReadout(s, team, undefined, 'Soldat')).toEqual({ glyph: null, label: '', rounds: null });
  });
});
