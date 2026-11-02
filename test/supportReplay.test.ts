import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {MAPS} from '@/data/maps';
import {Battle} from '@/sim/battle';
import {makeReplayLog,replayBattle,runReplay,runTicks,type ReplayLog} from '@/sim/replay';
import {hashState} from '@/sim/stateHash';
import {SIM_DT,type BattleConfig,type MapDef} from '@/shared/types';

/** Small authored map registered for both construction and replay; no simulation
 * state is patched between commands. The tree screen keeps the two human teams quiet. */
const map:MapDef={id:'support_replay_fixture',name:'Support replay',description:'',width:112,height:48,season:'summer',attacker:'german',
  paint:(tiles,w,h)=>{tiles.fill('open');for(let y=0;y<h;y++)for(let x=78;x<82;x++)tiles[y*w+x]='woods';},
  victoryLocations:[{id:1,name:'Rear',x:104,y:24,value:1}],deployZones:{german:{x:4,y:16,w:12,h:16},soviet:{x:96,y:16,w:12,h:16}}};
beforeAll(()=>{MAPS.push(map);});afterAll(()=>{const i=MAPS.indexOf(map);if(i>=0)MAPS.splice(i,1);});
function config(night=false):BattleConfig{return{mapId:map.id,year:1944,scenarioDate:'1944-07-15',timeOfDay:night?'night':'day',weather:'clear',playerSide:'german',controllers:{german:'human',soviet:'human'},seed:58,durationS:120,difficulty:'normal',neverActOnInitiative:true,forces:{german:['ger_mortar81'],soviet:['sov_command']},airSupport:{german:{missions:1,availableAtS:0},soviet:{missions:0}},illuminationRounds:2};}
function start(b:Battle):void {b.submit('german',{type:'ready'});b.submit('soviet',{type:'ready'});b.step(0);expect(b.state.phase).toBe('running');}
function ticks(b:Battle,n:number,chain:number[]=[]):number[]{for(let i=0;i<n;i++){b.step(SIM_DT);b.drainEvents();chain.push(hashState(b));}return chain;}
const serialized=(b:Battle)=>JSON.parse(JSON.stringify(makeReplayLog(b))) as ReplayLog;
describe('support commands in real Battle replays',()=>{
  it('restores air assignment, pilot stream, release flight and terminal impacts from the command log',()=>{
    const b=new Battle(config());start(b);b.submit('german',{type:'airSupport',target:{x:55,y:24},role:'bombing'});
    const first=ticks(b,175),inFlight=b.state.airSupport!;expect(inFlight.missions).toHaveLength(1);expect(inFlight.missions[0].releaseIndex).toBe(4);expect(inFlight.ordnance.length).toBeGreaterThan(0);
    const mid=serialized(b),restored=runReplay(mid);expect(restored.chain).toEqual(first);expect(hashState(restored.battle)).toBe(mid.final!.hash);expect(restored.battle.state.airSupport).toEqual(b.state.airSupport);
    const suffix=ticks(b,125);const restoredSuffix:number[]=[];runTicks(restored.battle,300,restoredSuffix);expect(restoredSuffix).toEqual(suffix);
    expect(b.state.airSupport!.missions[0].phase).toBe('complete');expect(b.state.airSupport!.ordnance).toEqual([]);expect(b.state.map.craterMarks!.length).toBeGreaterThan(0);
    const complete=serialized(b),replayed=runReplay(complete);expect(replayed.chain).toEqual([...first,...suffix]);expect(hashState(replayed.battle)).toBe(complete.final!.hash);
    expect(complete.commands.some(c=>c.type==='airSupport')).toBe(true);expect(b.battleReport().airMissionsUsed).toEqual({german:1,soviet:0});
  });
  it('restores night illumination stock, actual mortar shot and descending flare with every tick hash',()=>{
    const b=new Battle(config(true));start(b);const chain=ticks(b,1),mortar=[...b.state.teams.values()].find(t=>t.side==='german'&&t.type==='mortar')!;
    expect(mortar.illuminationAmmo).toBe(2);const heBefore=b.state.soldiers.get(mortar.crewWeapon!.gunnerId)!.ammo;
    b.submit('german',{type:'illuminate',teamId:mortar.id,target:{x:55,y:24}});ticks(b,199,chain);
    expect(mortar.illuminationAmmo).toBe(1);expect(b.state.flares!.length).toBe(1);expect(b.state.flares![0].burstAt).toBeLessThan(b.state.time);
    expect(b.state.soldiers.get(mortar.crewWeapon!.gunnerId)!.ammo).toBe(heBefore);expect(b.state.pendingBursts).toEqual([]);
    const log=serialized(b),restored=runReplay(log);expect(log.commands.some(c=>c.type==='illuminate')).toBe(true);expect(restored.chain).toEqual(chain);
    expect(hashState(restored.battle)).toBe(log.final!.hash);expect(restored.battle.state.flares).toEqual(b.state.flares);
    expect(restored.battle.state.teams.get(mortar.id)!.illuminationAmmo).toBe(1);
    const resume=replayBattle(log);runTicks(resume,200);expect(hashState(resume)).toBe(hashState(b));
  });
});
