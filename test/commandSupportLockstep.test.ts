import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {MAPS} from '@/data/maps';
import {Battle} from '@/sim/battle';
import {LockstepSession} from '@/net/lockstep';
import {VirtualClock,memoryLink} from '@/net/memoryTransport';
import {hashState} from '@/sim/stateHash';
import type {BattleConfig,MapDef,Side} from '@/shared/types';

const map:MapDef={id:'command_support_lockstep_fixture',name:'Support lockstep',description:'',width:48,height:24,season:'summer',attacker:'german',
  paint:(tiles,w,h)=>{tiles.fill('open');for(let y=0;y<h;y++)for(let x=22;x<26;x++)tiles[y*w+x]='woods';},
  victoryLocations:[{id:1,name:'Rear',x:44,y:12,value:1}],deployZones:{german:{x:2,y:4,w:8,h:16},soviet:{x:38,y:4,w:8,h:16}}};
beforeAll(()=>{MAPS.push(map);});afterAll(()=>{const i=MAPS.indexOf(map);if(i>=0)MAPS.splice(i,1);});
function config():BattleConfig{return{mapId:map.id,year:1944,timeOfDay:'day',weather:'clear',playerSide:'german',multiplayer:true,controllers:{german:'human',soviet:'human'},seed:58,durationS:120,difficulty:'normal',neverActOnInitiative:true,alwaysObeyOrders:true,forces:{german:['ger_command'],soviet:['sov_command']},airSupport:false,artillerySupport:{german:{shells:8,guns:2},soviet:{shells:8,guns:2}}};}
const tick=(s:LockstepSession)=>s.battle.state.tick??0;

/** Both peers construct their own Battle; only user commands cross the memory
 * link. The one intentional corruption is never patched back by this fixture. */
function playAndRecover():Record<Side,LockstepSession>{
  const clock=new VirtualClock(),[a,b]=memoryLink(clock,{seed:58059,minDelayMs:1,maxDelayMs:5,reorderChance:.1,reorderMs:3});
  const peers={german:new LockstepSession({battle:new Battle(config()),side:'german',transport:a,hashInterval:10,rebuildTurnsPerUpdate:32}),soviet:new LockstepSession({battle:new Battle(config()),side:'soviet',transport:b,hashInterval:10,rebuildTurnsPerUpdate:32})};
  const issued={german:{deploy:false,ready:false,support:false},soviet:{deploy:false,ready:false,support:false}};
  let corrupted=false,finished=false;
  for(let now=0;now<=60_000;now+=10){
    clock.advanceTo(now);
    for(const side of ['german','soviet'] as Side[]){
      const s=peers[side],flags=issued[side];
      if(!flags.deploy){
        const team=[...s.battle.state.teams.values()].find(t=>t.side===side&&t.supportForTeamId===undefined)!;
        const pos={x:side==='german'?5.5:42.5,y:12.5};expect(s.battle.canDeployTeam(team.id,pos)).toBe(true);
        s.issue({type:'deployTeam',teamId:team.id,pos});s.issue({type:'planOrder',teamId:team.id,order:{type:'defend',target:pos,issuedAt:0},trigger:{kind:'signal',signal:1}});flags.deploy=true;
      }
      if(!flags.ready&&s.turn>=4){s.issue({type:'ready'});flags.ready=true;}
      if(!flags.support&&s.battle.state.phase==='running'&&tick(s)>=1){
        s.issue({type:'signal',signal:1});s.issue({type:'artillery',target:{x:24,y:12},size:'small'});
        flags.support=true;
      }
      s.update(now);s.battle.drainEvents();
    }
    const {german,soviet}=peers;
    if(!corrupted&&german.turn===soviet.turn&&tick(german)>=40&&tick(soviet)>=40&&german.status==='playing'&&soviet.status==='playing'){
      expect(hashState(german.battle)).toBe(hashState(soviet.battle));
      const state=soviet.battle.state;
      expect(state.artillery!.missions.some(m=>m.phase==='preparing')).toBe(true);state.artillery!.batteries[0].ammo++;
      expect(hashState(german.battle)).not.toBe(hashState(soviet.battle));corrupted=true;
    }
    if([german,soviet].some(s=>s.status==='failed'))break;
    if(corrupted&&[german,soviet].every(s=>tick(s)>=200&&s.status==='playing'&&s.stats.resyncs===1)&&german.turn===soviet.turn){finished=true;break;}
    if(Math.max(tick(german),tick(soviet))>400)break;
  }
  expect(corrupted).toBe(true);expect(finished).toBe(true);
  for(const s of Object.values(peers)){
    expect(s.status).toBe('playing');expect(s.desync).toBeNull();expect(s.stats.resyncs).toBe(1);expect(s.stats.rebuiltTurns).toBeGreaterThan(0);
    expect(s.reports).toHaveLength(1);expect(s.reports[0].recovered).toBe(true);expect(s.reports[0].localHash).not.toBe(s.reports[0].remoteHash);
    expect(s.battle.commandLog().filter(c=>c.type==='deployTeam')).toHaveLength(2);expect(s.battle.commandLog().filter(c=>c.type==='ready')).toHaveLength(2);
  }
  expect(peers.german.reports[0].resumedAt).toEqual(peers.soviet.reports[0].resumedAt);
  const resumed=peers.german.reports[0].resumedAt!.turn;
  const chains=Object.values(peers).map(s=>s.hashChain.filter(([turn])=>turn>=resumed));
  expect(chains[0].length).toBeGreaterThan(3);expect(chains[0]).toEqual(chains[1]);expect(tick(peers.german)).toBe(tick(peers.soviet));
  expect(hashState(peers.german.battle)).toBe(hashState(peers.soviet.battle));return peers;
}
describe('command support lockstep recovery',()=>{
 it('rebuilds private plans, signal execution and queued artillery after real peer desync',()=>{
  const peers=playAndRecover();
  for(const session of Object.values(peers)){
   const state=session.battle.state;
   for(const side of ['german','soviet'] as const){
    expect(state.battlePlans![side].orders).toHaveLength(1);
    expect(state.battlePlans![side].orders[0].status).toBe('executed');
    expect(state.battlePlans![side].signals).toHaveLength(1);
    expect(state.artillery!.batteries.find(b=>b.side===side)!.ammo).toBe(6);
   }
   expect(state.artillery!.missions).toHaveLength(2);
   expect(state.artillery!.missions.every(m=>m.phase==='preparing')).toBe(true);
   for(const type of ['planOrder','signal','artillery'])expect(session.battle.commandLog().filter(c=>c.type===type)).toHaveLength(2);
   expect(state.radioTraffic!.messages.filter(m=>m.payload.kind==='signal')).toHaveLength(2);
  }
  expect(peers.german.battle.state.artillery).toEqual(peers.soviet.battle.state.artillery);
  expect(peers.german.battle.state.battlePlans).toEqual(peers.soviet.battle.state.battlePlans);
 });
});
