import {emitRadio} from './radioTraffic';
import type {AirMission,AirOrdnance,AirRole,BattleState,PersonalContact,Side,Soldier,Vec2,Vec3} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {hash2} from '@/shared/rng';
import {clamp,dist,facingFromAngle} from '@/shared/math';
import * as dm from '@/shared/dmath';
import {AIRCRAFT,AIR_LOADS,AIR_WEAPONS,airLoadFor} from '@/data/airSupport';
import {VEHICLE_DEFS} from '@/data/units';
import {createMind} from './mind';
import {conscious,knownContacts,perception,recordVisual} from './perception';
import {withHumanRng} from './humanRandom';
import {humanCapability} from './humanCondition';
import {addMessage} from './messages';
import {skyTransmission} from './illumination';
import {canopyAt,getHeightField,groundAt,heightAt,syncCraterMarks} from './heightField';
import {intersectVehicle,type HullRay} from './hullAim';
import {onBlastNearVehicle,resolveVehicleHit} from './vehicleDamage';
import {applyHESplash} from './combat';
import {TERRAIN_PROPS} from './terrain';
import {tileAt} from './map';

const SIDES:Side[]=['german','soviet'];
/** Availability and mission timings are explicit gameplay assumptions. */
export const AIR_TIMING={delayMinS:45,delayMaxS:90,reportS:2,inboundS:12,observeS:4,departureS:10};
const allowed=(s:BattleState)=>s.config.airSupport!==false&&s.config.timeOfDay!=='night'&&(!s.config.weather||s.config.weather==='clear');
export function initializeAirSupport(state:BattleState):void {
  if(state.airSupport)return;
  const assignment=(side:Side)=>{
    const c=state.config.airSupport===false?undefined:state.config.airSupport?.[side];
    const remaining=allowed(state)?Math.max(0,Math.floor(c?.missions??(state.config.airSupport?0:1))):0;
    const availableAt=c?.availableAtS??AIR_TIMING.delayMinS+hash2(state.config.seed,side==='german'?1:2,5801)*(AIR_TIMING.delayMaxS-AIR_TIMING.delayMinS);
    return{remaining,availableAt,used:0};
  };
  state.airSupport={assignments:{german:assignment('german'),soviet:assignment('soviet')},missions:[],ordnance:[]};
}
export function airSupportStatus(state:BattleState,side:Side):{available:boolean;remaining:number;availableAt:number;reason:string;active:boolean} {
  const a=state.airSupport?.assignments[side],active=!!state.airSupport?.missions.some(m=>m.side===side&&m.phase!=='complete');
  const reason=state.config.airSupport===false?'Not assigned':state.config.timeOfDay==='night'?'Unavailable at night':state.config.weather&&state.config.weather!=='clear'?'Requires clear weather':active?'Aircraft on mission':!a||a.remaining<=0?'No missions remaining':state.time<a.availableAt?'Preparing aircraft':'Ready';
  return{available:allowed(state)&&!!a&&a.remaining>0&&!active&&state.time>=a.availableAt,remaining:a?.remaining??0,availableAt:a?.availableAt??0,reason,active};
}
/** Same radio endpoints as 056 communicationLink: a portable command/support
 * radio, or a leader actually occupying a functioning radio-equipped hull. */
function radioReporter(state:BattleState,side:Side,s:Soldier|undefined):s is Soldier {
  if(!s||s.side!==side||!conscious(s,state.time)||s.mind.state==='panicked'||s.mind.state==='broken')return false;
  const team=state.teams.get(s.teamId);
  if(!team||team.leaderId!==s.id)return false;
  if(team.type==='command'||team.type==='mortar'||team.type==='rocket')return true;
  const vehicle=team.vehicleId!=null?state.vehicles.get(team.vehicleId):undefined,def=vehicle?VEHICLE_DEFS[vehicle.defId]:undefined;
  return !!vehicle&&!!def&&s.vehicleId===vehicle.id&&(vehicle.state==='ok'||vehicle.state==='immobilized')&&def.layout?.radio!==false&&vehicle.damage?.radio!=='destroyed';
}
/** One operational selected endpoint, otherwise one HQ's already received
 * personal knowledge. A rifleman's private sighting never teleports to the pilot. */
function requester(state:BattleState,side:Side,id?:number):Soldier|undefined {
  if(id!=null){const s=state.soldiers.get(id);if(radioReporter(state,side,s))return s;}
  const hq=[...state.teams.values()].filter(t=>t.side===side&&t.type==='command').sort((a,b)=>a.id-b.id);
  for(const t of hq){const s=state.soldiers.get(t.leaderId);if(radioReporter(state,side,s))return s;}
}
const reportsArmour=(reports:readonly PersonalContact[])=>reports.some(c=>c.entity==='vehicle'&&c.vehicleState!=='knockedOut'&&c.vehicleState!=='burning'&&!!c.vehicleDefId&&(VEHICLE_DEFS[c.vehicleDefId]?.armor.front??0)>10);
function pilot(state:BattleState,side:Side,id:number,target:Vec2):Soldier {
  return{id,teamId:-1,side,name:'Pilot',rank:'Lt',weaponId:'pistol_p38',ammo:0,ammoReserve:0,grenades:0,health:'healthy',morale:80,fatigue:0,suppression:0,experience:60+Math.floor(hash2(id,state.config.seed,58)*20),stance:'standing',activity:'idle',pos:{...target},facing:0,targetSoldierId:null,targetVehicleId:null,targetPoint:null,path:[],reloadTimer:0,fireTimer:0,animFrame:0,isLeader:true,vehicleId:null,formationOffset:{x:0,y:0},lastFiredAt:-999,cover:0,kills:0,mind:createMind(80,state.time),condition:{breath:0,sweat:0,hearingLoss:0,at:state.time,lastPos:{...target}},randomStreams:{}};
}
export function requestAirSupport(state:BattleState,side:Side,target:Vec2,role:AirRole='auto',requesterId?:number):boolean {
  initializeAirSupport(state);
  if(!airSupportStatus(state,side).available||!Number.isFinite(target.x)||!Number.isFinite(target.y)||target.x<0||target.y<0||target.x>=state.map.width||target.y>=state.map.height)return false;
  const reporter=requester(state,side,requesterId);
  if(reporter)emitRadio(state,side,{kind:'message',text:'Air support requested',target});
  const reports=knownContacts(state,reporter).filter(c=>dist(c.pos,target)*TILE_M<=75).map(c=>structuredClone(c));
  // AUTO remains a bombing assignment until the operational radio actually
  // delivers the frozen target report during the two-second preparation window.
  const load=airLoadFor(state.config,side,role==='armour'),id=state.nextId++,p=pilot(state,side,-id,target);
  const heading=withHumanRng(state,p,'air',rng=>rng.range(0,2*Math.PI));
  const m:AirMission={id,side,aircraftId:load.aircraftId,loadId:load.id,target:{...target},heading,phase:'inbound',calledAt:state.time,arriveAt:state.time+AIR_TIMING.inboundS,pos:{x:0,y:0,z:160},releaseIndex:0,nextReleaseAt:Infinity,pilot:p,reports,reportsAt:state.time+AIR_TIMING.reportS,reporterId:reporter?.id,requestedRole:role};
  setAircraftPosition(state,m,state.time);state.airSupport!.missions.push(m);
  const a=state.airSupport!.assignments[side];a.remaining--;a.used++;
  addMessage(state,`${AIRCRAFT[load.aircraftId].name}: ${load.name}. Aircraft inbound.`, 'info',side);
  return true;
}
function ground(state:BattleState,p:Vec2):number {const f=getHeightField(state.map);syncCraterMarks(state.map,f);return heightAt(f,p.x,p.y);}
function setAircraftPosition(state:BattleState,m:AirMission,time:number):void {
  const attack=m.attackAt??m.arriveAt+AIR_TIMING.observeS;
  const distance=(time-attack)*65;
  const altitude=m.phase==='departing'?110+Math.max(0,time-m.nextReleaseAt+AIR_TIMING.departureS)*4:110+50*clamp((attack-time)/AIR_TIMING.observeS,0,1);
  m.pos={x:m.target.x*TILE_M+dm.sin(m.heading)*distance,y:m.target.y*TILE_M-dm.cos(m.heading)*distance,z:ground(state,m.target)+altitude};
  m.pilot.pos={x:m.pos.x/TILE_M,y:m.pos.y/TILE_M};
  m.pilot.facing=facingFromAngle(m.heading);
  if(m.pilot.condition){m.pilot.condition.at=time;m.pilot.condition.lastPos={...m.pilot.pos};}
}
/** Physical sight alone authorizes making a fresh personal snapshot. */
function acquire(state:BattleState,m:AirMission,dt:number):void {
  const p=m.pilot,cap=humanCapability(p,state.time);perception(p).visual=[];
  if(!cap.canOperate)return;
  const see=(entity:Soldier|import('@/shared/types').Vehicle,kind:PersonalContact['entity'])=>{
    if(entity.side===m.side||dist(p.pos,entity.pos)*TILE_M>650*cap.sensing||dist(entity.pos,m.target)*TILE_M>100)return;
    const f=getHeightField(state.map);
    const endpoint={x:entity.pos.x*TILE_M,y:entity.pos.y*TILE_M,z:groundAt(f,entity.pos.x,entity.pos.y)+(kind==='vehicle'?1.6:1)};
    const trans=skyTransmission(state,m.pos,endpoint,kind==='vehicle'?entity.id:undefined);
    if(trans<=.03)return;
    const dM=dist(p.pos,entity.pos)*TILE_M;
    const ahead=(entity.pos.x-p.pos.x)*dm.sin(m.heading)-(entity.pos.y-p.pos.y)*dm.cos(m.heading);
    const posture=kind==='soldier'?(entity as Soldier).stance==='prone'?.45:(entity as Soldier).stance==='crouching'?.75:1:1;
    const concealment=TERRAIN_PROPS[tileAt(state.map,Math.floor(entity.pos.x),Math.floor(entity.pos.y))].concealment;
    const probability=Math.min(1,dt*(.7+p.experience/100)*trans*cap.sensing*posture*(ahead<0?.6:1)*clamp(1-concealment,.15,1)*clamp((650-dM)/450,.1,1));
    if(withHumanRng(state,p,'air',rng=>rng.chance(probability)))recordVisual(state,p,entity,kind);
  };
  for(const v of [...state.vehicles.values()].sort((a,b)=>a.id-b.id))see(v,'vehicle');
  for(const s of [...state.soldiers.values()].sort((a,b)=>a.id-b.id)){if(s.vehicleId==null)see(s,'soldier');}
}
function chooseAttackTarget(state:BattleState,m:AirMission):Vec2 {
  const known=knownContacts(state,m.pilot).filter(c=>dist(c.pos,m.target)*TILE_M<60&&state.time-c.observedAt<=45&&c.health!=='dead'&&c.health!=='incapacitated'&&c.vehicleState!=='knockedOut'&&c.vehicleState!=='burning');
  const armour=AIR_LOADS[m.loadId].kind!=='bomb';
  known.sort((a,b)=>(armour?Number(b.entity==='vehicle')-Number(a.entity==='vehicle'):0)||dist(a.pos,m.target)-dist(b.pos,m.target)||b.observedAt-a.observedAt||a.id-b.id);
  return{...(known[0]?.pos??m.target)};
}
function release(state:BattleState,m:AirMission,at:number):void {
  const load=AIR_LOADS[m.loadId],cap=humanCapability(m.pilot,state.time);
  const impact=withHumanRng(state,m.pilot,'air',rng=>{
    const angle=rng.range(0,2*Math.PI),r=Math.sqrt(rng.next())*load.dispersionM/Math.max(.2,cap.accuracy);
    return{x:clamp(m.attackTarget!.x+dm.cos(angle)*r/TILE_M,.01,state.map.width-.01),y:clamp(m.attackTarget!.y+dm.sin(angle)*r/TILE_M,.01,state.map.height-.01)};
  });
  const from={...m.pos},flight=load.kind==='cannon'?.35:Math.sqrt(2*Math.max(1,from.z-ground(state,impact))/9.81);
  state.airSupport!.ordnance.push({id:state.nextId++,missionId:m.id,side:m.side,weaponId:load.weaponId,from,impact,impactZ:ground(state,impact),releasedAt:at,impactAt:at+flight});
  if(load.kind==='cannon')state.tracers.push({from:{...m.pilot.pos},to:{...impact},fromHeightM:from.z,t:0,hit:false,kind:'shell'});
  m.pilot.lastFiredAt=at;m.releaseIndex++;
}
/** Launch state determines a ballistic path; neither aim nor flight chases a live target. */
export function airOrdnancePosition(state:BattleState,o:AirOrdnance,time:number):Vec3 {
  const f=clamp((time-o.releasedAt)/(o.impactAt-o.releasedAt),0,1),z=o.impactZ??ground(state,o.impact);
  const linear=AIR_WEAPONS[o.weaponId]?.id==='air_bk37';
  return{x:o.from.x+(o.impact.x*TILE_M-o.from.x)*f,y:o.from.y+(o.impact.y*TILE_M-o.from.y)*f,z:o.from.z+(z-o.from.z)*(linear?f:f*f)};
}
function impactOrdnance(state:BattleState,m:AirMission,o:AirOrdnance,from:Vec3,to:Vec3,terminal:boolean):boolean {
  const dx=to.x-from.x,dy=to.y-from.y,dz=to.z-from.z,length=Math.sqrt(dx*dx+dy*dy+dz*dz);
  if(length<=0)return false;
  const ray:HullRay={origin:from,direction:{x:dx/length,y:dy/length,z:dz/length}};
  const field=getHeightField(state.map);syncCraterMarks(state.map,field);
  let solidDistance=length,point=to,hitWorld=terminal;
  const n=Math.max(1,Math.ceil(length/.5));
  for(let i=1;i<=n;i++){
    const f=i/n,p={x:from.x+dx*f,y:from.y+dy*f,z:from.z+dz*f},x=p.x/TILE_M,y=p.y/TILE_M;
    if(x<0||y<0||x>=state.map.width||y>=state.map.height)continue;
    const canopy=canopyAt(field,x,y);
    if(p.z<=Math.max(heightAt(field,x,y),canopy>0?groundAt(field,x,y)+canopy:-Infinity)+.03){solidDistance=length*f;point=p;hitWorld=true;break;}
  }
  let contact: {v:import('@/shared/types').Vehicle;hit:NonNullable<ReturnType<typeof intersectVehicle>>}|undefined;
  for(const v of state.vehicles.values()){
    const def=VEHICLE_DEFS[v.defId];if(!def||v.state==='knockedOut'||v.state==='burning')continue;
    const h=intersectVehicle(v,def,ray,false,ground(state,v.pos));
    if(h&&h.distance<=solidDistance&&(!contact||h.distance<contact.hit.distance||h.distance===contact.hit.distance&&v.id<contact.v.id))contact={v,hit:h};
  }
  if(!contact&&!hitWorld)return false;
  if(contact)point=contact.hit.point;
  const pos={x:point.x/TILE_M,y:point.y/TILE_M},weapon=AIR_WEAPONS[o.weaponId];
  withHumanRng(state,m.pilot,'air',rng=>{
    if(contact)resolveVehicleHit(state,rng,contact.v,{weapon,round:'ap',shooterPos:{x:o.from.x/TILE_M,y:o.from.y/TILE_M},shooterSide:o.side,distM:0,fromAbove:true,ray});
    // Existing HE pipeline owns infantry injury, terrain, trees, structures and craters.
    applyHESplash(state,rng,pos,weapon,o.side,undefined,contact?.v.id);
    // Ground weapons intentionally omit own vehicles; aircraft area ordnance does not.
    for(const v of state.vehicles.values())if(v.side===o.side&&v.id!==contact?.v.id)onBlastNearVehicle(state,rng,v,pos,weapon,o.side);
  });
  return true;
}
export function stepAirSupport(state:BattleState,dt:number):void {
  const air=state.airSupport;if(!air||dt<=0||state.phase!=='running')return;
  for(const side of SIDES){const a=air.assignments[side];if(allowed(state)&&a.remaining>0&&!a.announced&&state.time>=a.availableAt){a.announced=true;addMessage(state,'Air support is available.','good',side);}}
  for(const m of air.missions){
    if(m.phase==='complete')continue;
    setAircraftPosition(state,m,state.time);
    if(state.time>=m.reportsAt&&m.reports.length){
      const reporter=m.reporterId!=null?state.soldiers.get(m.reporterId):undefined;
      if(radioReporter(state,m.side,reporter)){
        perception(m.pilot).reports.push(...m.reports.map(c=>({...c,pos:{...c.pos},receivedAt:state.time})));
        if(m.requestedRole==='auto'&&m.releaseIndex===0&&m.phase==='inbound'){
          const load=airLoadFor(state.config,m.side,reportsArmour(m.reports));
          if(load.id!==m.loadId){m.loadId=load.id;m.aircraftId=load.aircraftId;addMessage(state,`${AIRCRAFT[load.aircraftId].name}: ${load.name}. Load confirmed from delivered target report.`,'info',m.side);}
        }
      }
      m.reports=[];
    }
    if(m.phase==='inbound'&&state.time>=m.arriveAt){m.phase='attacking';m.attackAt=m.arriveAt+AIR_TIMING.observeS;m.nextReleaseAt=m.attackAt;addMessage(state,`${AIRCRAFT[AIR_LOADS[m.loadId].aircraftId].name}: beginning attack pass.`,'info',m.side);}
    if(m.phase==='attacking'){
      acquire(state,m,dt);
      if(state.time>=m.nextReleaseAt){m.attackTarget??=chooseAttackTarget(state,m);const load=AIR_LOADS[m.loadId];
        if(!humanCapability(m.pilot,state.time).canFire){m.releaseIndex=load.count;}
        while(m.releaseIndex<load.count&&state.time>=m.nextReleaseAt){release(state,m,m.nextReleaseAt);m.nextReleaseAt+=load.intervalS;}
        if(m.releaseIndex>=load.count){m.phase='departing';m.nextReleaseAt=state.time+AIR_TIMING.departureS;addMessage(state,'Air support: attack complete, returning to base.','info',m.side);}
      }
    }
    if(m.phase==='departing'&&state.time>=m.nextReleaseAt)m.phase='complete';
  }
  const pending:AirOrdnance[]=[];
  for(const o of air.ordnance){const m=air.missions.find(m=>m.id===o.missionId);if(!m)continue;if(state.time<o.releasedAt){pending.push(o);continue;}
    const from=airOrdnancePosition(state,o,Math.max(o.releasedAt,state.time-dt)),to=airOrdnancePosition(state,o,state.time);
    if(!impactOrdnance(state,m,o,from,to,state.time>=o.impactAt))pending.push(o);
  }
  air.ordnance=pending;
}
