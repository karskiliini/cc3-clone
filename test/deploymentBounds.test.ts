import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { spawnTeam, layoutTeamPositions } from '@/sim/spawn';
import { isPassable } from '@/sim/path';
import { aiDeploy } from '@/sim/ai';
import { hashState } from '@/sim/stateHash';
import { TEAM_DEFS } from '@/data/units';
import { MAPS } from '@/data/maps';
import { pointInRect } from '@/shared/math';
import type { BattleConfig, Side, Team } from '@/shared/types';

const config: BattleConfig = {
  mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 31,
  durationS: 600, difficulty: 'normal', controllers: { german: 'human', soviet: 'human' },
  forces: { german: [], soviet: [] },
};
function fixture(side: Side = 'german') {
  const battle = new Battle(structuredClone(config));
  battle.state.map = buildMap({
    id: 'bounds', name: 'Bounds', description: '', width: 32, height: 32,
    season: 'summer', attacker: 'german', paint: tiles => tiles.fill('open'),
    victoryLocations: [], deployZones: {
      german: { x: 2, y: 2, w: 12, h: 12 }, soviet: { x: 18, y: 18, w: 12, h: 12 },
    },
  });
  const z = battle.state.map.def.deployZones[side];
  const team = spawnTeam(battle.state, TEAM_DEFS[side === 'german' ? 'ger_rifle_41' : 'sov_rifle_41'], side,
    { x: z.x + z.w / 2, y: z.y + z.h / 2 }, battle.rng);
  return { battle, team, zone: z };
}
function members(b: Battle, t: Team) { return t.soldierIds.map(id => b.state.soldiers.get(id)!); }
function expectContained(b: Battle, t: Team) {
  const map = b.state.map, z = map.def.deployZones[t.side];
  const men = members(b, t), tiles = new Set<number>();
  for (const s of men) {
    expect(pointInRect(s.pos, z)).toBe(true);
    expect(s.pos.x).toBeGreaterThanOrEqual(z.x + .5);
    expect(s.pos.x).toBeLessThanOrEqual(z.x + z.w - .5);
    expect(s.pos.y).toBeGreaterThanOrEqual(z.y + .5);
    expect(s.pos.y).toBeLessThanOrEqual(z.y + z.h - .5);
    expect(isPassable(map, Math.floor(s.pos.x), Math.floor(s.pos.y), 'infantry')).toBe(true);
    tiles.add(Math.floor(s.pos.y) * map.width + Math.floor(s.pos.x));
  }
  expect(tiles.size).toBe(men.length);
}

describe('deployment contains every soldier, not just the team anchor', () => {
  for (const side of ['german', 'soviet'] as const) {
    it(`${side}: folds formations inward at all four edges and corners; preview matches drop`, () => {
      const {battle, team, zone: z} = fixture(side);
      const xs = [z.x, z.x + z.w / 2, z.x + z.w - .001];
      const ys = [z.y, z.y + z.h / 2, z.y + z.h - .001];
      for (const x of xs) for (const y of ys) {
        const hash = hashState(battle), rng = battle.rng.state();
        const preview = battle.deploymentPositions(team.id, {x, y});
        expect(preview).not.toBeNull();
        expect(battle.canDeployTeam(team.id, {x, y})).toBe(true);
        expect(hashState(battle)).toBe(hash); expect(battle.rng.state()).toBe(rng);
        expect(battle.deployTeam(team.id, {x, y})).toBe(true);
        expect(members(battle, team).map(s => s.pos)).toEqual(preview);
        expectContained(battle, team);
      }
      for (const pos of [{x:z.x-.001,y:z.y+1},{x:z.x+z.w,y:z.y+1},{x:z.x+1,y:z.y-.001},{x:z.x+1,y:z.y+z.h}])
        expect(battle.deployTeam(team.id, pos)).toBe(false);
    });
  }
  it('never uses nearby forbidden ground when allowed local slots are blocked', () => {
    const {battle, team, zone: z} = fixture();
    const map = battle.state.map;
    for (let y=z.y;y<z.y+z.h;y++) for(let x=z.x;x<z.x+z.w;x++) map.tiles[y*map.width+x]='water';
    map.tiles[z.y*map.width+z.x]='open';
    // The remaining slots lie beyond the old five-tile local search.
    for (let y=10;y<14;y++) for(let x=10;x<14;x++) map.tiles[y*map.width+x]='open';
    expect(battle.deployTeam(team.id,{x:z.x+.5,y:z.y+.5})).toBe(true);
    expectContained(battle, team);
  });
  it('rejects insufficient space atomically instead of stacking or spilling out', () => {
    const {battle, team} = fixture();
    battle.state.map.def.deployZones.german = {x:4,y:4,w:1,h:1};
    const before = hashState(battle), positions = structuredClone(members(battle,team).map(s=>s.pos));
    expect(battle.deploymentPositions(team.id,{x:4.5,y:4.5})).toBeNull();
    expect(battle.canDeployTeam(team.id,{x:4.5,y:4.5})).toBe(false);
    expect(battle.deployTeam(team.id,{x:4.5,y:4.5})).toBe(false);
    expect(hashState(battle)).toBe(before);
    expect(members(battle,team).map(s=>s.pos)).toEqual(positions);
  });
  it('handles a fractional zone boundary with body clearance', () => {
    const {battle, team} = fixture();
    battle.state.map.def.deployZones.german = {x:2.25,y:2.75,w:8.5,h:7.5};
    expect(battle.deployTeam(team.id,{x:2.25,y:2.75})).toBe(true);
    expectContained(battle,team);
  });
  it('contains initial and Auto placements for both sides on real maps', () => {
    for (const {id: mapId} of MAPS) {
      const b = new Battle({...structuredClone(config),mapId, forces:{german:['ger_rifle_41','ger_mg34_hmg'],soviet:['sov_rifle_41']}});
      for (const t of b.state.teams.values()) expectContained(b,t);
      for (const side of ['german','soviet'] as const) aiDeploy(b.state,side,b.rng,b);
      for (const t of b.state.teams.values()) expectContained(b,t);
    }
  });
  it('replays a boundary deployment command to the same exact hash', () => {
    const a=fixture(),b=fixture();
    a.battle.submit('german',{type:'deployTeam',teamId:a.team.id,pos:{x:a.zone.x+a.zone.w-.001,y:a.zone.y}});
    a.battle.flushDue(); b.battle.loadCommands(a.battle.commandLog()); b.battle.flushDue();
    expect(hashState(b.battle)).toBe(hashState(a.battle));
    expectContained(a.battle,a.team); expectContained(b.battle,b.team);
  });
  it('leaves an unrestricted running-battle formation free to cross the deployment boundary', () => {
    const {battle,team,zone} = fixture();
    const pos={x:zone.x+zone.w+.5,y:8.5};
    const offsets=members(battle,team).map(s=>s.formationOffset);
    const slots=layoutTeamPositions(battle.state.map,pos,offsets);
    expect(slots.some(p=>!pointInRect(p,zone))).toBe(true);
  });
});
