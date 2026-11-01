import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { spawnTeam, rotateOffset, formationBaseHeading } from '@/sim/spawn';
import { crewWeaponView } from '@/sim/crewWeapon';
import { hullAngles } from '@/sim/hullMath';
import { hashState } from '@/sim/stateHash';
import { TEAM_DEFS } from '@/data/units';
import { facingFromAngle, pointInRect } from '@/shared/math';
import { ORDER_LABELS, type BattleConfig, type OrderType } from '@/shared/types';
import * as dm from '@/shared/dmath';

const config: BattleConfig = {
  mapId:'border_1941',playerSide:'german',year:1943,seed:17,durationS:600,difficulty:'normal',
  controllers:{german:'human',soviet:'human'},forces:{german:[],soviet:[]},
};
function fixture(defId='ger_rifle_41') {
  const battle=new Battle(structuredClone(config));
  battle.state.map=buildMap({id:'facing',name:'Facing',description:'',width:64,height:64,season:'summer',attacker:'german',
    paint:t=>t.fill('open'),victoryLocations:[],deployZones:{german:{x:1,y:1,w:28,h:62},soviet:{x:34,y:1,w:28,h:62}}});
  const def=TEAM_DEFS[defId],pos={x:def.side==='german'?15.5:48.5,y:30.5};
  const team=spawnTeam(battle.state,def,def.side,pos,battle.rng);
  const members=()=>team.soldierIds.map(id=>battle.state.soldiers.get(id)!);
  const order=(type:OrderType,heading:number)=>battle.issueOrder(team.id,{type,target:{x:team.pos.x+dm.sin(heading)*20,y:team.pos.y-dm.cos(heading)*20},issuedAt:0});
  return {battle,team,members,order};
}

describe('setup direction orders arrange the entire unit',()=>{
  for(const type of ['defend','ambush'] as const) {
    it(`${type}: rotates every canonical slot about the fixed anchor and faces all men in parallel`,()=>{
      const {battle,team,members,order}=fixture(),anchor={...team.pos};
      const original=members().map(s=>({...s.formationOffset}));
      for(const heading of [0,Math.PI/2,Math.PI,-Math.PI/2,.37,-1.2]) {
        order(type,heading);
        expect(team.pos).toEqual(anchor);
        expect(team.deploymentFacing).toBeCloseTo(heading,12);
        members().forEach((s,i)=>{
          const off=rotateOffset(original[i],heading-formationBaseHeading(battle.state.map,team.side));
          expect(s.pos.x).toBeCloseTo(anchor.x+off.x,12);
          expect(s.pos.y).toBeCloseTo(anchor.y+off.y,12);
          expect(s.formationOffset).toEqual(original[i]);
          expect(s.facing).toBe(facingFromAngle(heading));
          expect(s.activity).toBe(type==='defend'?'defending':'ambushing');
          expect(s.path).toEqual([]);
          expect(s.mind.pendingOrderAt).toBeUndefined();
        });
      }
    });
    it(`${type}: keeps the complete reoriented formation inside the allowed zone at a corner`,()=>{
      const {battle,team,members,order}=fixture();
      const z=battle.state.map.def.deployZones.german;
      battle.deployTeam(team.id,{x:z.x+.5,y:z.y+.5});
      for(const heading of [0,Math.PI/2,Math.PI,-Math.PI/2]) {
        order(type,heading);
        for(const s of members())expect(pointInRect(s.pos,z)).toBe(true);
        expect(new Set(members().map(s=>Math.floor(s.pos.y)*64+Math.floor(s.pos.x))).size).toBe(members().length);
      }
    });
    it(`${type}: rotates hull, turret and physical body before any simulation tick`,()=>{
      for(const def of ['ger_pz3j','ger_kettenkrad','sov_jeep']) {
        const {battle,team,order}=fixture(def),v=battle.state.vehicles.get(team.vehicleId!)!;
        const pos={...v.pos}; order(type,.37);
        expect(v.pos).toEqual(pos);
        expect(v.hullFacing).toBeCloseTo(.37,12);expect(v.turretFacing).toBeCloseTo(.37,12);
        expect(hullAngles(v.body!.orientation).heading).toBeCloseTo(.37,12);
        expect(battle.state.time).toBe(0);
      }
    });
  }
  it('rotates support-weapon preview immediately and preserves the exact bearing at Begin',()=>{
    for(const def of ['ger_pak38','ger_mg34_hmg','ger_mortar81']) {
      const {battle,team,order}=fixture(def); order('defend',.37);
      const before=hashState(battle),view=crewWeaponView(battle.state,team)!;
      expect(view.facing).toBeCloseTo(.37,12);
      expect(hashState(battle)).toBe(before);
      battle.start();battle.step(.1);
      expect(team.crewWeapon!.facing).toBeCloseTo(.37,12);
    }
  });
  it('moves an already materialized crew weapon and its deployed mount with the arranged crew',()=>{
    const {battle,team,order}=fixture('ger_mg34_hmg');
    team.crewWeapon=crewWeaponView(battle.state,team)!;
    team.crewWeapon.mount={state:'deployed',pos:{...team.crewWeapon.pos},carrierId:null};
    order('ambush',.37);
    expect(team.crewWeapon.facing).toBeCloseTo(.37,12);
    expect(team.crewWeapon.mount.pos).toEqual(team.crewWeapon.pos);
  });
  it('retains the requested formation direction in relocation previews and drops',()=>{
    const {battle,team,members,order}=fixture();order('ambush',.37);
    const target={x:18.5,y:40.5},preview=battle.deploymentPositions(team.id,target);
    expect(battle.deployTeam(team.id,target)).toBe(true);
    expect(members().map(s=>s.pos)).toEqual(preview);
    const expected=rotateOffset(members()[1].formationOffset,.37-formationBaseHeading(battle.state.map,team.side));
    expect(members()[1].pos.x-target.x).toBeCloseTo(expected.x,12);
  });
  it('a direction click at the anchor preserves the existing direction and layout',()=>{
    const {battle,team,members,order}=fixture();order('defend',.37);
    const positions=members().map(s=>({...s.pos}));
    battle.issueOrder(team.id,{type:'ambush',target:{...team.pos},issuedAt:0});
    expect(team.deploymentFacing).toBeCloseTo(.37,12);expect(members().map(s=>s.pos)).toEqual(positions);
  });
  it('a running-battle direction order does not teleport a formation or snap a hull',()=>{
    for(const def of ['ger_rifle_41','ger_pz3j']) {
      const {battle,team,members,order}=fixture(def);order('defend',.37);
      battle.start();const positions=members().map(s=>({...s.pos}));
      const v=team.vehicleId!=null?battle.state.vehicles.get(team.vehicleId)!:null;
      const rotation=v?{...v.body!.orientation}:null;
      order('ambush',-1.2);
      expect(members().map(s=>s.pos)).toEqual(positions);
      expect(team.deploymentFacing).toBeUndefined();
      if(v)expect(v.body!.orientation).toEqual(rotation);
    }
  });
  it('rejects an impossible setup turn without replacing the old order or formation',()=>{
    const {battle,team,members,order}=fixture();order('defend',.37);
    const positions=structuredClone(members().map(s=>s.pos)),previous=team.order,heading=team.deploymentFacing;
    battle.state.map.def.deployZones.german={x:15,y:30,w:1,h:1};
    order('ambush',-1.2);
    expect(team.order).toBe(previous);expect(team.deploymentFacing).toBe(heading);
    expect(members().map(s=>s.pos)).toEqual(positions);
  });
  it('hashes exact setup bearing and replays direction commands identically',()=>{
    const a=fixture(),b=fixture();
    a.battle.submit('german',{type:'order',teamId:a.team.id,order:{type:'defend',target:{x:20.5,y:12.5},issuedAt:0}});
    a.battle.flushDue();b.battle.loadCommands(a.battle.commandLog());b.battle.flushDue();
    expect(hashState(a.battle)).toBe(hashState(b.battle));
    const before=hashState(a.battle);a.team.deploymentFacing!+=1e-12;
    expect(hashState(a.battle)).not.toBe(before);
  });
  it('shows Hide as the same command as Ambush',()=>{
    expect(ORDER_LABELS.ambush).toBe('AMBUSH / HIDE');
  });
});
