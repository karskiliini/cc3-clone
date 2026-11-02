import {describe,expect,it,vi} from 'vitest';
import {AIR_LOADS,airArmourAvailable,airLoadFor} from '@/data/airSupport';
import {airOrdnancePosition,airSupportStatus,initializeAirSupport,requestAirSupport,stepAirSupport} from '@/sim/airSupport';
import {recordVisual} from '@/sim/perception';
import {ensureDamage} from '@/sim/vehicleDamage';
import {TILE_M} from '@/shared/types';
import type {AirOrdnance,BattleState,Side} from '@/shared/types';
import {addTank,makeState,mkTeam,soldier} from './vehicleDamageHelpers';

// Keep pilots blind in knowledge-isolation fixtures. Collision remains the actual 3D path.
const {transmission}=vi.hoisted(()=>({transmission:vi.fn(()=>0)}));
vi.mock('@/sim/illumination',()=>({skyTransmission:transmission}));
function fixture(year=1944):BattleState {
  const s=makeState(year);s.map.width=80;s.map.height=80;
  s.config.airSupport={german:{missions:1,availableAtS:0},soviet:{missions:1,availableAtS:0}};
  initializeAirSupport(s);return s;
}
function run(s:BattleState,seconds:number):void {for(let i=0;i<Math.ceil(seconds/.1);i++){s.time+=.1;stepAirSupport(s,.1);}}
function caller(s:BattleState,side:Side='german'){
  const man=soldier(1,1,side,{x:30,y:30},'kar98k',{isLeader:true});s.soldiers.set(man.id,man);s.teams.set(1,mkTeam(1,'command',[1],side,man.pos));return man;
}
function drop(s:BattleState,weaponId:string,point={x:40,y:40},side:Side='german'){
  expect(requestAirSupport(s,side,point,'bombing')).toBe(true);const m=s.airSupport!.missions[0];m.phase='complete';
  const o:AirOrdnance={id:s.nextId++,missionId:m.id,side,weaponId,from:{x:point.x*TILE_M,y:point.y*TILE_M,z:30},impact:{...point},releasedAt:0,impactAt:1};
  s.airSupport!.ordnance.push(o);return o;
}
describe('assigned air support',()=>{
  it('uses finite assignments, delayed availability, actual ready announcement and clear daytime only',()=>{
    const s=makeState();initializeAirSupport(s);const a=s.airSupport!.assignments.german;
    expect(a.remaining).toBe(1);expect(a.availableAt).toBeGreaterThanOrEqual(45);expect(a.availableAt).toBeLessThanOrEqual(90);
    expect(requestAirSupport(s,'german',{x:30,y:30})).toBe(false);s.time=a.availableAt;stepAirSupport(s,.1);
    expect(s.messages.filter(m=>m.text==='Air support is available.'&&m.side==='german')).toHaveLength(1);
    stepAirSupport(s,.1);expect(s.messages.filter(m=>m.text==='Air support is available.'&&m.side==='german')).toHaveLength(1);
    expect(requestAirSupport(s,'german',{x:30,y:30})).toBe(true);expect(requestAirSupport(s,'german',{x:30,y:30})).toBe(false);expect(a.used).toBe(1);
    for(const config of [{timeOfDay:'night' as const},{weather:'rain' as const},{weather:'overcast' as const},{airSupport:false as const}]){
      const unavailable=makeState();Object.assign(unavailable.config,config);initializeAirSupport(unavailable);unavailable.time=999;
      expect(airSupportStatus(unavailable,'german').available).toBe(false);expect(requestAirSupport(unavailable,'german',{x:20,y:20})).toBe(false);
    }
  });
  it('gates anti-armour loads by service date and distinguishes assigned cassette capacity',()=>{
    expect(airArmourAvailable({year:1942,scenarioDate:'1942-12-01'})).toBe(false);
    expect(airArmourAvailable({year:1943})).toBe(false);
    expect(airArmourAvailable({year:1943,scenarioDate:'1943-07-04'})).toBe(false);
    expect(airArmourAvailable({year:1943,scenarioDate:'1943-07-05'})).toBe(true);
    expect(airLoadFor({year:1944},'german',true).id).toBe('bk37');expect(airLoadFor({year:1944},'soviet',true).id).toBe('ptab');
    expect(AIR_LOADS.ptab.count).toBe(192);expect(AIR_LOADS.sc50.count).toBe(4);expect(AIR_LOADS.fab100.count).toBe(4);
  });
  it('never selects loads or aims from hidden live armour or another soldier’s private knowledge',()=>{
    const a=fixture(),b=fixture();caller(a);caller(b);
    const tankA=addTank(a,'t34_76',{x:40,y:40}).v,tankB=addTank(b,'t34_76',{x:40,y:40}).v;
    const isolated=soldier(9,9,'german',{x:70,y:70},'kar98k');a.soldiers.set(9,isolated);recordVisual(a,isolated,tankA,'vehicle');
    tankB.pos={x:55,y:55};b.vehicles.set(9000,{...tankB,id:9000,pos:{x:41,y:41}});
    expect(requestAirSupport(a,'german',{x:40,y:40})).toBe(true);expect(requestAirSupport(b,'german',{x:40,y:40})).toBe(true);
    run(a,17);run(b,17);expect(a.airSupport!.missions[0].loadId).toBe('sc50');
    expect(b.airSupport!.missions[0].loadId).toBe('sc50');expect(a.airSupport!.missions[0].attackTarget).toEqual(b.airSupport!.missions[0].attackTarget);
  });
  it('copies only requester evidence, delivers after two seconds and preserves observation age',()=>{
    const s=fixture(),hq=caller(s),tank=addTank(s,'t34_76',{x:42,y:40}).v;s.time=5;recordVisual(s,hq,tank,'vehicle');s.time=8;
    expect(requestAirSupport(s,'german',{x:40,y:40},'auto',hq.id)).toBe(true);
    const m=s.airSupport!.missions[0];expect(m.loadId).toBe('sc50');expect(m.pilot.perception).toBeUndefined();expect(m.reporterId).toBe(hq.id);
    tank.pos={x:60,y:60};hq.perception!.memory![0].pos.x=70;
    s.time=9;stepAirSupport(s,1);expect(m.pilot.perception?.reports??[]).toHaveLength(0);
    s.time=10;stepAirSupport(s,1);expect(m.pilot.perception!.reports[0]).toMatchObject({pos:{x:42,y:40},observedAt:5,receivedAt:10});expect(m.loadId).toBe('bk37');
    expect(s.messages.some(message=>message.text.includes('BK 3.7')&&message.text.includes('delivered target report'))).toBe(true);
    s.time=24;stepAirSupport(s,14);expect(m.attackTarget).toEqual({x:42,y:40});expect(s.soldiers.has(m.pilot.id)).toBe(false);
  });
  it('a rifle leader without radio cannot transmit private sightings, with or without an HQ',()=>{
    for(const hasHq of [false,true]){
      const s=fixture(),hq=hasHq?caller(s):undefined,rifle=soldier(9,9,'german',{x:30,y:30},'kar98k',{isLeader:true});
      s.soldiers.set(9,rifle);s.teams.set(9,mkTeam(9,'rifle',[9],'german',rifle.pos));const tank=addTank(s,'t34_76',{x:43,y:40}).v;recordVisual(s,rifle,tank,'vehicle');
      expect(requestAirSupport(s,'german',{x:40,y:40},'auto',rifle.id)).toBe(true);const m=s.airSupport!.missions[0];
      expect(m.reporterId).toBe(hq?.id);expect(m.reports).toEqual([]);run(s,16.1);expect(m.loadId).toBe('sc50');expect(m.attackTarget).toEqual({x:40,y:40});
    }
  });
  it('a non-radio selected man can use only the HQ’s already personally received report',()=>{
    const s=fixture(),hq=caller(s),rifle=soldier(9,9,'german',{x:30,y:30},'kar98k');s.soldiers.set(9,rifle);s.teams.set(9,mkTeam(9,'rifle',[9],'german',rifle.pos));
    const reported=addTank(s,'t34_76',{x:43,y:40}).v,privateTank=addTank(s,'t34_76',{x:48,y:40}).v;recordVisual(s,rifle,reported,'vehicle');
    hq.perception={visual:[],reports:[{...structuredClone(rifle.perception!.visual[0]),receivedAt:0,hops:1}],sounds:[],nextReportAt:0,lastSounds:{},casualties:{}};
    recordVisual(s,rifle,privateTank,'vehicle');requestAirSupport(s,'german',{x:40,y:40},'auto',rifle.id);const m=s.airSupport!.missions[0];
    expect(m.reporterId).toBe(hq.id);expect(m.reports.map(c=>c.id)).toEqual([reported.id]);expect(m.loadId).toBe('sc50');run(s,2.1);
    expect(m.loadId).toBe('bk37');expect(m.pilot.perception!.reports.map(c=>c.id)).toEqual([reported.id]);
  });
  it('drops undelivered reports when their actual radio reporter dies',()=>{
    const s=fixture(),hq=caller(s),tank=addTank(s,'t34_76',{x:43,y:40}).v;recordVisual(s,hq,tank,'vehicle');requestAirSupport(s,'german',{x:40,y:40});
    const m=s.airSupport!.missions[0];expect(m.reports).toHaveLength(1);hq.health='dead';run(s,2.1);
    expect(m.reports).toEqual([]);expect(m.pilot.perception?.reports??[]).toEqual([]);expect(m.loadId).toBe('sc50');
  });
  it.each(['radio destroyed','leader leaves hull','vehicle burning'])('rechecks the actual vehicle radio endpoint at delivery: %s',failure=>{
    const s=fixture(),own=addTank(s,'pz4gh',{x:30,y:30},0,50,'german'),leader=s.soldiers.get(own.team.leaderId)!,enemy=addTank(s,'t34_76',{x:43,y:40}).v;
    recordVisual(s,leader,enemy,'vehicle');requestAirSupport(s,'german',{x:40,y:40},'auto',leader.id);const m=s.airSupport!.missions[0];
    expect(m.reporterId).toBe(leader.id);expect(m.reports).toHaveLength(1);expect(m.loadId).toBe('sc50');
    if(failure==='radio destroyed')ensureDamage(own.v).radio='destroyed';else if(failure==='leader leaves hull')leader.vehicleId=null;else own.v.state='burning';
    run(s,2.1);expect(m.pilot.perception?.reports??[]).toEqual([]);expect(m.loadId).toBe('sc50');
  });
  it('does not borrow a vehicle crewman’s private contacts, and honours an explicit armour area order without radio',()=>{
    const s=fixture(),own=addTank(s,'pz4gh',{x:30,y:30},0,50,'german'),crew=own.crew.find(c=>c.id!==own.team.leaderId)!,enemy=addTank(s,'t34_76',{x:43,y:40}).v;
    recordVisual(s,crew,enemy,'vehicle');requestAirSupport(s,'german',{x:40,y:40},'armour',crew.id);const m=s.airSupport!.missions[0];
    expect(m.reporterId).toBeUndefined();expect(m.reports).toEqual([]);expect(m.requestedRole).toBe('armour');expect(m.loadId).toBe('bk37');
  });
  it('acquires its own visible snapshots and cannot follow a subsequently occluded target',()=>{
    const s=fixture(),tank=addTank(s,'t34_76',{x:43,y:40}).v;requestAirSupport(s,'german',{x:40,y:40});
    transmission.mockReturnValue(1);s.time=12;stepAirSupport(s,4);
    const m=s.airSupport!.missions[0];expect(m.pilot.perception!.visual.find(c=>c.id===tank.id)?.pos).toEqual({x:43,y:40});
    transmission.mockReturnValue(0);tank.pos={x:65,y:65};s.time=16;stepAirSupport(s,4);
    expect(m.attackTarget).toEqual({x:43,y:40});expect(m.pilot.mind).toBeDefined();expect(m.pilot.condition).toBeDefined();
  });
  it('releases one finite load, departs, and resumes identically from a structured clone',()=>{
    const s=fixture();requestAirSupport(s,'german',{x:40,y:40});run(s,13);
    // Map authoring callbacks are not saved simulation data.
    const clone=structuredClone({...s,map:{...s.map,def:{...s.map.def,paint:undefined}}}) as unknown as BattleState;clone.map.def=s.map.def;
    run(s,24);run(clone,24);expect(s.airSupport).toEqual(clone.airSupport);expect(s.map.craters).toEqual(clone.map.craters);
    const m=s.airSupport!.missions[0];expect(m.phase).toBe('complete');expect(m.releaseIndex).toBe(4);expect(s.airSupport!.ordnance).toHaveLength(0);
    expect(m.pilot.randomStreams?.air).toBeTypeOf('number');expect(requestAirSupport(s,'german',{x:40,y:40})).toBe(false);
  });
  it.each(['air_sc50','air_fab100'])('%s hurts friendlies and leaves physical craters',weapon=>{
    const s=fixture(),friendly=soldier(1,1,'german',{x:40,y:40},'kar98k');s.soldiers.set(1,friendly);drop(s,weapon);run(s,1.2);
    expect(friendly.health==='healthy'&&friendly.suppression===0).toBe(false);expect(s.map.craterMarks!.length).toBeGreaterThan(0);expect(s.explosions.some(e=>e.weaponId===weapon)).toBe(true);
  });
  it.each(['air_bk37','air_ptab'])('%s intersects and damages actual friendly and enemy armour from above',weapon=>{
    for(const side of ['german','soviet'] as Side[]){const s=fixture(),tank=addTank(s,'t34_76',{x:40,y:40},0,50,side).v;drop(s,weapon);run(s,1.2);
      expect(tank.hits).toBeGreaterThan(0);expect(s.airSupport!.ordnance).toHaveLength(0);}
  });
  it('ordnance follows its release path rather than a target vehicle’s later position',()=>{
    const s=fixture(),tank=addTank(s,'t34_76',{x:40,y:40}).v,o=drop(s,'air_bk37');const before=airOrdnancePosition(s,o,.5);tank.pos={x:60,y:60};
    expect(airOrdnancePosition(s,o,.5)).toEqual(before);run(s,1.2);expect(tank.hits).toBe(0);expect(s.explosions[0].pos.x).toBeCloseTo(40);
  });
});
