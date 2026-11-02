import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {MAPS} from '@/data/maps';
import {Battle} from '@/sim/battle';
import {LockstepSession} from '@/net/lockstep';
import {VirtualClock,memoryLink} from '@/net/memoryTransport';
import {hashState} from '@/sim/stateHash';
import {flarePose} from '@/sim/illumination';
import type {BattleConfig,MapDef,Side} from '@/shared/types';

const map:MapDef={id:'support_lockstep_fixture',name:'Support lockstep',description:'',width:112,height:48,season:'summer',attacker:'german',
  paint:(tiles,w,h)=>{tiles.fill('open');for(let y=0;y<h;y++)for(let x=78;x<82;x++)tiles[y*w+x]='woods';},
  victoryLocations:[{id:1,name:'Rear',x:104,y:24,value:1}],deployZones:{german:{x:4,y:16,w:12,h:16},soviet:{x:96,y:16,w:12,h:16}}};
beforeAll(()=>{MAPS.push(map);});afterAll(()=>{const i=MAPS.indexOf(map);if(i>=0)MAPS.splice(i,1);});
function config(night:boolean):BattleConfig{return{mapId:map.id,year:1944,scenarioDate:'1944-07-15',timeOfDay:night?'night':'day',weather:'clear',playerSide:'german',multiplayer:true,controllers:{german:'human',soviet:'human'},seed:58,durationS:120,difficulty:'normal',neverActOnInitiative:true,forces:{german:[night?'ger_mortar81':'ger_command'],soviet:['sov_command']},airSupport:{german:{missions:1,availableAtS:0},soviet:{missions:0}},illuminationRounds:2};}
const tick=(s:LockstepSession)=>s.battle.state.tick??0;

/** Both peers construct their own Battle; only user commands cross the memory
 * link. The one intentional corruption is never patched back by this fixture. */
function playAndRecover(night:boolean):Record<Side,LockstepSession>{
  const clock=new VirtualClock(),[a,b]=memoryLink(clock,{seed:58059,minDelayMs:1,maxDelayMs:5,reorderChance:.1,reorderMs:3});
  const peers={german:new LockstepSession({battle:new Battle(config(night)),side:'german',transport:a,hashInterval:10,rebuildTurnsPerUpdate:32}),soviet:new LockstepSession({battle:new Battle(config(night)),side:'soviet',transport:b,hashInterval:10,rebuildTurnsPerUpdate:32})};
  const issued={german:{deploy:false,ready:false,support:false},soviet:{deploy:false,ready:false,support:false}};
  let corrupted=false,finished=false;
  for(let now=0;now<=60_000;now+=10){
    clock.advanceTo(now);
    for(const side of ['german','soviet'] as Side[]){
      const s=peers[side],flags=issued[side];
      if(!flags.deploy){
        const team=[...s.battle.state.teams.values()].find(t=>t.side===side&&t.supportForTeamId===undefined)!;
        const pos={x:side==='german'?8.5:100.5,y:24.5};expect(s.battle.canDeployTeam(team.id,pos)).toBe(true);
        s.issue({type:'deployTeam',teamId:team.id,pos});flags.deploy=true;
      }
      if(!flags.ready&&s.turn>=4){s.issue({type:'ready'});flags.ready=true;}
      if(side==='german'&&!flags.support&&s.battle.state.phase==='running'&&tick(s)>=1){
        if(night){const mortar=[...s.battle.state.teams.values()].find(t=>t.side==='german'&&t.type==='mortar')!;s.issue({type:'illuminate',teamId:mortar.id,target:{x:55,y:24}});}
        else s.issue({type:'airSupport',target:{x:55,y:24},role:'bombing'});
        flags.support=true;
      }
      s.update(now);s.battle.drainEvents();
    }
    const {german,soviet}=peers;
    if(!corrupted&&german.turn===soviet.turn&&tick(german)>=64&&tick(soviet)>=64&&german.status==='playing'&&soviet.status==='playing'){
      expect(hashState(german.battle)).toBe(hashState(soviet.battle));
      const state=soviet.battle.state;
      if(night){const mortar=[...state.teams.values()].find(t=>t.side==='german'&&t.type==='mortar')!;expect(mortar.illuminationAmmo).toBeGreaterThan(0);mortar.illuminationAmmo!--;}
      else{const mission=state.airSupport!.missions[0];expect(mission.pilot.randomStreams?.air).toBeTypeOf('number');mission.pilot.randomStreams!.air=(mission.pilot.randomStreams!.air+1)>>>0;}
      expect(hashState(german.battle)).not.toBe(hashState(soviet.battle));corrupted=true;
    }
    if([german,soviet].some(s=>s.status==='failed'))break;
    if(corrupted&&[german,soviet].every(s=>tick(s)>=300&&s.status==='playing'&&s.stats.resyncs===1)&&german.turn===soviet.turn){finished=true;break;}
    if(Math.max(tick(german),tick(soviet))>500)break;
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
  expect(chains[0].length).toBeGreaterThan(10);expect(chains[0]).toEqual(chains[1]);expect(tick(peers.german)).toBe(tick(peers.soviet));
  expect(hashState(peers.german.battle)).toBe(hashState(peers.soviet.battle));return peers;
}
describe('support state in normal lockstep repair',()=>{
  it('repairs a corrupted pilot RNG, then both peers release the real finite load and finish the mission',()=>{
    const peers=playAndRecover(false);
    for(const s of Object.values(peers)){
      const air=s.battle.state.airSupport!;expect(air.assignments.german).toMatchObject({remaining:0,used:1});expect(air.missions).toHaveLength(1);
      expect(air.missions[0]).toMatchObject({phase:'complete',releaseIndex:4});expect(air.ordnance).toEqual([]);expect(s.battle.state.map.craterMarks!.length).toBeGreaterThan(0);
      expect(s.battle.commandLog().filter(c=>c.type==='airSupport')).toHaveLength(1);
    }
    expect(peers.german.battle.state.airSupport).toEqual(peers.soviet.battle.state.airSupport);
  });
  it('repairs corrupted illumination stock, then both real crews spend one flare round with equal descending light',()=>{
    const peers=playAndRecover(true);
    for(const s of Object.values(peers)){
      const state=s.battle.state,mortar=[...state.teams.values()].find(t=>t.side==='german'&&t.type==='mortar')!;
      expect(mortar.illuminationAmmo).toBe(1);expect(state.flares).toHaveLength(1);expect(state.illuminationShots??[]).toEqual([]);
      expect(flarePose(state,state.flares![0])!.pos.z).toBeLessThan(state.flares![0].origin.z);
      expect(s.battle.commandLog().filter(c=>c.type==='illuminate')).toHaveLength(1);expect(state.pendingBursts).toEqual([]);
    }
    expect(peers.german.battle.state.flares).toEqual(peers.soviet.battle.state.flares);
  });
});
