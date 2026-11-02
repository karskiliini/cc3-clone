/** Canonical aerial light and mortar illumination. World rays use metres;
 * orders and map locations use tiles. Renderer queries are strictly read-only. */
import type {BattleState,HeightField,IlluminationFlare,Side,Soldier,Team,Vec2,Vec3} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {clamp,dist,angleTo,wrapAngle} from '@/shared/math';
import {hash2} from '@/shared/rng';
import * as dm from '@/shared/dmath';
import {WEAPONS} from '@/data/weapons';
import {VEHICLE_DEFS} from '@/data/units';
import {getHeightField,heightAt,groundAt,canopyAt} from './heightField';
import {intersectVehicle} from './hullAim';
import {humanCapability} from './humanCondition';
import {addMessage} from './messages';
import {emitShot} from './noise';
import {isAbleCrewman} from './crewWeapon';
import {isFirstFireFrozen} from './mind';

export const FLARE = {altitudeM:100,durationS:90,descentMs:1,radiusM:110,intensity:1.35,sourceRadiusM:1.8,stock:4,repeatS:65};
export const NIGHT_AMBIENT = .025;
export const FOG_CELL_TILES = 4;

/** Derived negative proof only. All interpolated solids/crowns are below this
 * bound; a small relative guard covers floating-point interpolation roundoff.
 * Identity + version invalidates on restoration, destruction and earthworks.
 * Hulls are deliberately absent: the finite hull ray is still tested separately. */
const skyBounds=new WeakMap<HeightField,{version:number;maximum:number}>();
function skyMaximum(field:HeightField):number{
  const cached=skyBounds.get(field);if(cached?.version===field.version)return cached.maximum;
  let maximum=-Infinity,magnitude=0;
  for(let i=0;i<field.height.length;i++){
    const h=field.height[i],g=field.ground[i],c=field.canopy[i];
    if(!Number.isFinite(h)||!Number.isFinite(g)||!Number.isFinite(c)){maximum=Infinity;break;}
    maximum=Math.max(maximum,h,g+c);magnitude=Math.max(magnitude,Math.abs(h),Math.abs(g),Math.abs(c));
  }
  maximum+=Math.max(1e-6,magnitude*Number.EPSILON*64);
  skyBounds.set(field,{version:field.version,maximum});return maximum;
}

/** Finite 3D physical transmission, including the receiver tile's roof. This
 * deliberately does not use tactical LOS's height-independent building rules. */
export function skyTransmission(state:BattleState,from:Vec3,to:Vec3,receiverVehicleId?:number):number {
  if(![from.x,from.y,from.z,to.x,to.y,to.z].every(Number.isFinite))return 0;
  const field=getHeightField(state.map),dx=to.x-from.x,dy=to.y-from.y,dz=to.z-from.z;
  const horizontal=dm.hypot(dx,dy),length=dm.hypot(horizontal,dz);
  const steps=Math.max(2,Math.ceil(horizontal/.5));
  const bound=skyMaximum(field);
  let first=1,last=steps;
  // Find the original sample indices which can touch terrain. Search with the
  // ORIGINAL arithmetic, rather than rounding an analytic crossing distance:
  // cancellation at large coordinates and exact-boundary samples then preserve
  // the old answers bit-for-bit. Multiplication order below is unchanged.
  const sampleZ=(i:number)=>from.z+dz*(i/steps);
  if(Number.isFinite(bound)&&Number.isFinite(steps)&&Number.isFinite(dz)){
    if(dz<0){
      if(sampleZ(steps)>bound)first=steps+1;
      else if(sampleZ(1)>bound){
        let lo=1,hi=steps;
        while(lo+1<hi){const mid=Math.floor((lo+hi)/2);if(sampleZ(mid)>bound)lo=mid;else hi=mid;}
        first=hi;
      }
    }else if(sampleZ(1)>bound)first=steps+1;
    else if(dz>0&&sampleZ(steps)>bound){
      let lo=1,hi=steps;
      while(lo+1<hi){const mid=Math.floor((lo+hi)/2);if(sampleZ(mid)>bound)hi=mid;else lo=mid;}
      last=lo;
    }
  }
  let transmission=1;
  for(let i=first;i<=last;i++){
    const t=i/steps,x=(from.x+dx*t)/TILE_M,y=(from.y+dy*t)/TILE_M,z=from.z+dz*t;
    if(x<0||y<0||x>=state.map.width||y>=state.map.height)continue;
    if(heightAt(field,x,y)>z+.12)return 0;
    const ground=groundAt(field,x,y),crown=canopyAt(field,x,y);
    if(crown>2&&z>ground+crown*.55&&z<ground+crown){transmission*=.84;if(transmission<.02)return 0;}
    if(crown>2&&z>ground+.15&&z<ground+crown*.55){
      const ox=(x-Math.floor(x)-.5)*TILE_M,oy=(y-Math.floor(y)-.5)*TILE_M;
      if(ox*ox+oy*oy<.0144)return 0;
    }
  }
  const ray={origin:from,direction:{x:dx,y:dy,z:dz}};
  for(const v of state.vehicles.values()){
    if(v.id===receiverVehicleId)continue;
    const def=VEHICLE_DEFS[v.defId];if(!def)continue;
    const x=v.pos.x*TILE_M,y=v.pos.y*TILE_M;
    if(x<Math.min(from.x,to.x)-def.lengthM||x>Math.max(from.x,to.x)+def.lengthM||y<Math.min(from.y,to.y)-def.lengthM||y>Math.max(from.y,to.y)+def.lengthM)continue;
    const hit=intersectVehicle(v,def,ray,false,heightAt(field,v.pos.x,v.pos.y));
    if(hit&&hit.distance>.05&&hit.distance<length-.12)return 0;
  }
  return transmission;
}

export function flarePose(state:BattleState,f:IlluminationFlare,time=state.time):{pos:Vec3;strength:number}|null{
  const age=time-f.burstAt;if(age<0||age>=f.durationS)return null;
  const pos={x:f.origin.x+f.wind.x*age,y:f.origin.y+f.wind.y*age,z:f.origin.z-f.descentMs*age};
  const field=getHeightField(state.map);
  if(pos.z<=heightAt(field,pos.x/TILE_M,pos.y/TILE_M)+.7)return null;
  const fadeIn=clamp(age/1.5,0,1),fadeOut=clamp((f.durationS-age)/12,0,1);
  return{pos,strength:f.intensity*fadeIn*fadeOut};
}

interface LightCache {time:number;signature:string;values:Map<string,number>}
const caches=new WeakMap<BattleState,LightCache>();
/** Inputs are checked even at the same tick: damage, terrain edits or a new
 * flare can occur between two observations. No cache key is canonical state. */
function cacheFor(state:BattleState,sourceOverride?:IlluminationSource[]):LightCache{
  const field=getHeightField(state.map);
  const signature=JSON.stringify([field.version,state.flares,sourceOverride,...Array.from(state.vehicles.values(),v=>[v.id,v.defId,v.state,v.engineOnFire,v.pos,v.body?.position,v.body?.orientation,v.hullFacing,v.turretFacing,v.turretBlown])]);
  let c=caches.get(state);
  if(!c||c.time!==state.time||c.signature!==signature){c={time:state.time,signature,values:new Map()};caches.set(state,c);}
  return c;
}

/** Five fixed source samples produce finite penumbra, without any RNG. */
export interface IlluminationSource {id:number;pos:Vec3;strength:number;radiusM:number;sourceRadiusM:number}
export type IlluminationQuery=(p:Vec3,receiverVehicleId?:number)=>number;
export function lightSources(state:BattleState):IlluminationSource[]{
  const sources:IlluminationSource[]=[];
  for(const f of state.flares??[]){const pose=flarePose(state,f);if(pose)sources.push({id:f.id,...pose,radiusM:f.radiusM,sourceRadiusM:f.sourceRadiusM});}
  for(const v of state.vehicles.values())if(v.state==='burning'||v.engineOnFire){
    const field=getHeightField(state.map);
    sources.push({id:-v.id,pos:{x:v.pos.x*TILE_M,y:v.pos.y*TILE_M,z:heightAt(field,v.pos.x,v.pos.y)+4},strength:.85,radiusM:80,sourceRadiusM:.7});
  }
  return sources;
}
function sampleLight(state:BattleState,p:Vec3,receiverVehicleId:number|undefined,cache:LightCache,sources:IlluminationSource[]):number{
  const key=`${p.x},${p.y},${p.z},${receiverVehicleId??''}`,old=cache.values.get(key);
  if(old!=null)return old;
  let darkness=1;
  for(const f of sources){
    const pose=f;if(pose.strength<=0)continue;
    const horizontal=dm.hypot(p.x-pose.pos.x,p.y-pose.pos.y);
    if(horizontal>=f.radiusM)continue;
    let visible=0;
    for(const [x,y]of [[0,0],[1,0],[-1,0],[0,1],[0,-1]])visible+=skyTransmission(state,{x:pose.pos.x+x*f.sourceRadiusM,y:pose.pos.y+y*f.sourceRadiusM,z:pose.pos.z},p,receiverVehicleId);
    const falloff=1-horizontal/f.radiusM;
    const contribution=clamp(pose.strength*falloff*falloff*visible/5,0,.96);
    darkness*=1-contribution;
  }
  const result=NIGHT_AMBIENT+(1-NIGHT_AMBIENT)*(1-darkness);cache.values.set(key,result);return result;
}
/** A render/observation pass can prepare once; it must not retain this closure
 * across a world update. This avoids per-pixel world-signature serialization. */
export function prepareIllumination(state:BattleState,sourceOverride?:IlluminationSource[]):IlluminationQuery{
  if(state.config.timeOfDay!=='night')return()=>1;
  const sources=sourceOverride??lightSources(state);if(!sources.length)return()=>NIGHT_AMBIENT;
  const cache=cacheFor(state,sourceOverride);return(p,id)=>sampleLight(state,p,id,cache,sources);
}
export function illuminationAt(state:BattleState,p:Vec3,receiverVehicleId?:number):number{return prepareIllumination(state)(p,receiverVehicleId);}

export function nightFogAt(state:BattleState,side:Side,x:number,y:number):'visible'|'remembered'|'unseen'{
  if(state.config.timeOfDay!=='night')return'visible';
  const width=Math.ceil(state.map.width/FOG_CELL_TILES),i=Math.floor(y/FOG_CELL_TILES)*width+Math.floor(x/FOG_CELL_TILES);
  const seen=state.nightGroundMemory?.[side]?.[i];
  return seen==null?'unseen':state.time-seen<=.55?'visible':'remembered';
}

export function mortarIlluminationAvailable(state:BattleState,team:Team):boolean{
  const cw=team.crewWeapon;
  return team.type==='mortar'&&!team.outOfAction&&!!cw&&!cw.destroyed&&WEAPONS[cw.weaponId]?.cls==='mortar';
}
export function initializeIllumination(state:BattleState):void{
  if(state.config.timeOfDay==='night')getHeightField(state.map);
  for(const t of state.teams.values())if(mortarIlluminationAvailable(state,t))t.illuminationAmmo??=Math.max(0,Math.min(24,Math.floor(state.config.illuminationRounds??FLARE.stock)));
}
export function requestIllumination(state:BattleState,side:Side,teamId:number,target:Vec2):boolean{
  const team=state.teams.get(teamId);
  if(!team||team.side!==side||!mortarIlluminationAvailable(state,team)||!Number.isFinite(target.x)||!Number.isFinite(target.y)||target.x<0||target.y<0||target.x>=state.map.width||target.y>=state.map.height)return false;
  initializeIllumination(state);
  const cw=team.crewWeapon!,weapon=WEAPONS[cw.weaponId],range=dist(cw.pos,target)*TILE_M;
  if(!team.illuminationAmmo||range>weapon.rangeM||range<(weapon.minRangeM??0)){
    addMessage(state,`${team.name}\n${!team.illuminationAmmo?'No illumination rounds.':`Illumination range: ${weapon.minRangeM??0}–${weapon.rangeM} m.`}`,'warn',side);return false;
  }
  if(team.order?.illumination&&team.illuminationMission&&dist(team.illuminationMission.target,target)<.5)return true;
  const traverse=Math.abs(wrapAngle(angleTo(cw.pos,target)-cw.facing));
  team.illuminationMission={target:{...target},orderedAt:state.time,nextRoundAt:Math.max(state.time,cw.nextMortarShotAt??0),rounds:0,layUntil:2+traverse/.4};
  team.order={type:'fire',target:{...target},issuedAt:state.time,illumination:true};
  // Individual movement/activity changes belong to normal order acceptance.
  // A hesitant man must retain his previous action until he actually obeys.
  addMessage(state,`${team.name}\nIllumination mission. ${team.illuminationAmmo} rounds.`, 'info',side);return true;
}

function illuminationCrewman(state:BattleState,s:Soldier|undefined,issuedAt:number):s is Soldier{
  return isAbleCrewman(state,s)&&s.mind.pendingOrderAt!==issuedAt&&!isFirstFireFrozen(state,s.id)
    &&s.pickup?.until==null&&s.carryingMgMount==null&&!s.hatch&&humanCapability(s,state.time).canOperate;
}
export function stepIllumination(state:BattleState,dt:number):void{
  if(state.phase!=='running')return;
  initializeIllumination(state);
  for(const team of state.teams.values()){
    const m=team.illuminationMission;if(!m)continue;
    const cw=team.crewWeapon;
    if(!team.order?.illumination||!cw||cw.destroyed||!team.illuminationAmmo||team.outOfAction){delete team.illuminationMission;continue;}
    if(cw.phase!=='ready'||cw.abandoned||cw.goal==='pack')continue;
    const gunner=state.soldiers.get(cw.gunnerId),weapon=WEAPONS[cw.weaponId];
    if(!illuminationCrewman(state,gunner,team.order.issuedAt)||dist(gunner.pos,cw.pos)>3||!weapon)continue;
    const capability=humanCapability(gunner,state.time);
    if(!capability.canOperate||!capability.canFire)continue;
    const helpers=team.soldierIds.map(id=>state.soldiers.get(id)).filter(s=>illuminationCrewman(state,s,team.order!.issuedAt)&&dist(s.pos,cw.pos)<5).length;
    if(state.time<m.nextRoundAt||state.time<(cw.nextMortarShotAt??0))continue;
    gunner.activity='reloading';cw.firePhase=m.rounds===0?'aiming':'loading';
    m.layUntil-=dt*capability.work*clamp(helpers/3,.35,1);
    if(m.layUntil>0)continue;
    const range=dist(cw.pos,m.target)*TILE_M;
    if(range>weapon.rangeM||range<(weapon.minRangeM??0))continue;
    const serial=m.rounds++,scatter=.8+range*.008;
    const target={x:clamp(m.target.x+(hash2(team.id,serial,state.config.seed)-.5)*scatter/TILE_M,.1,state.map.width-.1),y:clamp(m.target.y+(hash2(team.id,serial,state.config.seed^31)-.5)*scatter/TILE_M,.1,state.map.height-.1)};
    const id=state.nextId++,flightS=3+range/60;
    (state.illuminationShots??=[]).push({id,side:team.side,teamId:team.id,from:{...cw.pos},target,firedAt:state.time,burstAt:state.time+flightS,altitudeM:FLARE.altitudeM});
    team.illuminationAmmo!--;cw.facing=angleTo(cw.pos,target);gunner.lastFiredAt=state.time;gunner.activity='firing';cw.firePhase='ready';
    cw.nextMortarShotAt=state.time+1/weapon.rate;gunner.fireTimer=Math.max(gunner.fireTimer,1/weapon.rate);
    emitShot(state,{kind:'shot',pos:{...cw.pos},weaponId:weapon.id,side:team.side},`s${gunner.id}`);
    m.nextRoundAt=state.time+Math.max(FLARE.repeatS,1/weapon.rate);m.layUntil=3;
    addMessage(state,`${team.name}\nIllumination away. ${team.illuminationAmmo} rounds left.`,'info',team.side);
  }
  const pending=[];
  for(const shot of state.illuminationShots??[]){
    if(state.time<shot.burstAt){pending.push(shot);continue;}
    const field=getHeightField(state.map),z=groundAt(field,shot.target.x,shot.target.y)+shot.altitudeM;
    (state.flares??=[]).push({id:shot.id,side:shot.side,teamId:shot.teamId,burstAt:shot.burstAt,origin:{x:shot.target.x*TILE_M,y:shot.target.y*TILE_M,z},wind:{x:.16,y:.05},descentMs:FLARE.descentMs,durationS:FLARE.durationS,radiusM:FLARE.radiusM,intensity:FLARE.intensity,sourceRadiusM:FLARE.sourceRadiusM});
  }
  if(state.illuminationShots)state.illuminationShots=pending;
  if(state.flares)state.flares=state.flares.filter(f=>state.time<f.burstAt+f.durationS&&!!flarePose(state,f));
}
