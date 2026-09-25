// Smoke missions (manual: "smoke rounds can be fired by mortars/tanks with smoke"): the round
// leaves a real smoke screen on the map (blocks sight), and a team without smoke rounds gets its
// order refused with a message instead of silently ignoring it.
import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { Rng } from '@/shared/rng';
import { idx } from '@/sim/map';

const config = {
  mapId: 'border_1941', playerSide: 'german' as const, year: 1941, seed: 7, durationS: 600,
  difficulty: 'normal' as const, forces: { german: ['ger_mortar81'], soviet: [] },
};

describe('smoke missions', () => {
  it('an 8cm mortar smoke mission leaves map smoke at the ordered point', () => {
    const b = new Battle(config);
    b.start();
    const mortar = b.selectableTeams('german')[0];
    // aim point ~70-140 m from the tube, inside its 60-1000 m band, open ground
    const target = { x: mortar.pos.x + 40, y: mortar.pos.y + 20 };
    b.issueOrder(mortar.id, { type: 'smoke', target: { ...target }, issuedAt: 0 });
    // step until the mission self-terminates (three rounds gone) and sample right away —
    // smoke decays over ~60 s, so a late sample would read a faded screen
    for (let i = 0; i < 60 && mortar.order?.type === 'smoke'; i++) b.step(1.0);
    // dispersion walks the rounds off the ordered point (obs tier multiplies sigma); any
    // impact within ~6 tiles of the aim point must leave a real screen on the map
    let peak = 0;
    for (let y = Math.max(0, Math.floor(target.y) - 6); y <= Math.floor(target.y) + 6; y++) {
      for (let x = Math.max(0, Math.floor(target.x) - 6); x <= Math.floor(target.x) + 6; x++) {
        if (!b.state.map.smoke[idx(b.state.map, x, y)]) continue;
        peak = Math.max(peak, b.state.map.smoke[idx(b.state.map, x, y)]);
      }
    }
    expect(peak).toBeGreaterThan(0.4);
    // the mission self-terminates into Defend once its three smoke rounds are gone
    expect(mortar.order?.type).toBe('defend');
  });

  it('an infantry team without smoke rounds gets the order refused with a message', () => {
    const b = new Battle({ ...config, forces: { german: ['ger_mortar81', 'ger_mg34_hmg'], soviet: [] } });
    b.start();
    const hmg = b.selectableTeams('german').find((t) => t.type === 'mg')!;
    // give it a prior order the refusal must preserve
    applyOrder(b.state, hmg, { type: 'move', target: { x: hmg.pos.x + 4, y: hmg.pos.y }, issuedAt: 0 }, new Rng(3));
    const before = hmg.order;
    const msgCount = b.state.messages.length;
    applyOrder(b.state, hmg, { type: 'smoke', target: { x: hmg.pos.x + 2, y: hmg.pos.y }, issuedAt: 0 }, new Rng(3));
    expect(hmg.order).toBe(before);
    expect(b.state.messages.length).toBeGreaterThan(msgCount);
    expect(b.state.messages[b.state.messages.length - 1].text).toContain('no smoke rounds');
  });
});
