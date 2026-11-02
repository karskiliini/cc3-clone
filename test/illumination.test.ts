import {describe,it,expect} from 'vitest';
import {makeState,addGun,addTank,soldier,mkTeam} from './vehicleDamageHelpers';
import {buildMap} from '@/sim/map';
import {setTile} from '@/sim/map';
import {getHeightField,heightAt,groundAt,canopyAt} from '@/sim/heightField';
import {FLARE,skyTransmission,flarePose,illuminationAt,prepareIllumination,requestIllumination,stepIllumination,nightFogAt} from '@/sim/illumination';
import {updateNightGroundMemory} from '@/sim/nightVisibility';
import {updateSpotting,observerVisibility} from '@/sim/spotting';
import {applyOrder,stepAttackOrders} from '@/sim/orders';
import {recordVisual} from '@/sim/perception';
import {stepCombat} from '@/sim/combat';
import {hashState} from '@/sim/stateHash';
import {Rng} from '@/shared/rng';
import {onIncomingFire} from '@/sim/mind';
import type {BattleState,IlluminationFlare,Vec3} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import * as dm from '@/shared/dmath';
import {VEHICLE_DEFS} from '@/data/units';
import {intersectVehicle} from '@/sim/hullAim';
import {createHullBody} from '@/sim/hullPhysics';

function scene(){
 const state=makeState();state.config.timeOfDay='night';
 state.map=buildMap({id:'light',name:'Light',description:'',width:80,height:80,season:'summer',paint:tiles=>tiles.fill('open'),victoryLocations:[],deployZones:{german:{x:0,y:0,w:40,h:80},soviet:{x:40,y:0,w:40,h:80}},attacker:'german'});
 return state;
}
function flare(state:BattleState,over:Partial<IlluminationFlare>={}){
 const f:IlluminationFlare={id:700,side:'german',teamId:1,burstAt:-2,origin:{x:80,y:80,z:100},wind:{x:0,y:0},descentMs:0,durationS:90,radiusM:110,intensity:1.35,sourceRadiusM:1.8,...over};(state.flares??=[]).push(f);return f;
}
function ridge(state:BattleState){const f=getHeightField(state.map);for(let y=0;y<f.h;y++)for(let x=120;x<128;x++)f.height[y*f.w+x]=8;f.version++;}
function readyMortar(state:BattleState){const own=addGun(state,'mortar81',{x:20,y:40});own.team.type='mortar';own.team.crewWeapon!.goal='deploy';return own;}
function advance(state:BattleState,seconds:number){for(let t=0;t<Math.round(seconds*10);t++){state.time=Math.round((state.time+.1)*1000)/1000;stepIllumination(state,.1);}}

/** Frozen pre-optimization ray, intentionally retaining every original sample.
 * This is an independent exact-result oracle, not a timing-based assertion. */
function originalSkyTransmission(state:BattleState,from:Vec3,to:Vec3,receiverVehicleId?:number):number{
 if(![from.x,from.y,from.z,to.x,to.y,to.z].every(Number.isFinite))return 0;
 const field=getHeightField(state.map),dx=to.x-from.x,dy=to.y-from.y,dz=to.z-from.z;
 const horizontal=dm.hypot(dx,dy),length=dm.hypot(horizontal,dz),steps=Math.max(2,Math.ceil(horizontal/.5));
 let transmission=1;
 for(let i=1;i<=steps;i++){
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

describe('exact sky-space acceleration',()=>{
 it('preserves original sample products on slopes, ridges, crowns and ascending/descending/out-of-map rays',()=>{
  const state=scene(),field=getHeightField(state.map);
  for(let y=0;y<field.h;y++)for(let x=0;x<field.w;x++){
   const i=y*field.w+x,g=x/field.w*3+Math.max(0,y-160)*.02;
   field.ground[i]=g;field.height[i]=g+(x>=120&&x<128?8:0);
   field.canopy[i]=x>=150&&x<158&&y>=156&&y<168?10:0;
  }field.version++;
  let fractional=0;
  for(const z of [100,40,15,6])for(const sx of [-8,40,130])for(const tx of [42,61,72,80,110,172])for(const ty of [79,81]){
   const from={x:sx,y:80,z},to={x:tx,y:ty,z:groundAt(field,tx/TILE_M,ty/TILE_M)+.2};
   for(const [a,b]of [[from,to],[to,from]]){
    const expected=originalSkyTransmission(state,a,b);if(expected>0&&expected<1)fractional++;
    expect(skyTransmission(state,a,b)).toBe(expected);
   }
  }
  expect(fractional).toBeGreaterThan(0);
  for(const [a,b]of [
   [{x:90,y:90,z:100},{x:90,y:90,z:.2}],
   [{x:90,y:90,z:1e10},{x:140,y:90,z:15}],
   [{x:90,y:90,z:14.000000000001},{x:140,y:90,z:13.999999999999}],
   [{x:90,y:90,z:NaN},{x:140,y:90,z:15}],
  ])expect(skyTransmission(state,a,b)).toBe(originalSkyTransmission(state,a,b));
 });
 it('invalidates a cached bound on height-field revisions and restored identities',()=>{
  const state=scene(),field=getHeightField(state.map),from={x:20,y:80,z:60},to={x:140,y:80,z:30};
  expect(skyTransmission(state,from,to)).toBe(1);
  for(let y=156;y<164;y++)for(let x=156;x<164;x++)field.height[y*field.w+x]=80;
  field.version++;
  expect(skyTransmission(state,from,to)).toBe(0);
  expect(skyTransmission(state,from,to)).toBe(originalSkyTransmission(state,from,to));
  state.map.heightField=structuredClone(field);state.map.heightField.version=0;
  expect(skyTransmission(state,from,to)).toBe(0);
  const rng=new Rng(9),before=hashState({state,rng});skyTransmission(state,from,to);
  expect(hashState({state,rng})).toBe(before);
 });
 it('still intersects a physical hull entirely above the terrain bound, including own-receiver exclusion',()=>{
  const state=scene(),{v}=addTank(state,'pz4gh',{x:30,y:40}),def=VEHICLE_DEFS[v.defId];
  v.body=createHullBody(def,v.pos,0,()=>({heightM:0,normal:{x:0,y:0,z:1}}));v.body.position.z+=35;
  const from={x:40,y:80,z:36},to={x:80,y:80,z:36};
  expect(originalSkyTransmission(state,from,to)).toBe(0);expect(skyTransmission(state,from,to)).toBe(0);
  expect(skyTransmission(state,from,to,v.id)).toBe(originalSkyTransmission(state,from,to,v.id));
  expect(skyTransmission(state,from,to,v.id)).toBe(1);
 });
 it('a prepared observation pass gives exactly the same visibility as independent point queries',()=>{
  const state=scene();ridge(state);flare(state);const illumination=prepareIllumination(state);
  for(const x of [20,30,40,60])for(const y of [35,40,45]){
   const observer={pos:{x:20,y:40},soldier:null},p={x,y};
   expect(observerVisibility(state,observer,p,300,undefined,1.7,undefined,illumination))
    .toBe(observerVisibility(state,observer,p,300,undefined,1.7));
  }
 });
});

describe('height-aware physical illumination',()=>{
 it('shadow direction and length follow the independent point-light projection as altitude drops',()=>{
  const state=scene();ridge(state);const lengths:number[]=[];
  for(const altitude of [100,40,15]){let end=64;for(let x=64;x<120;x+=.5)if(skyTransmission(state,{x:40,y:80,z:altitude},{x,y:80,z:.2})<.1)end=x;lengths.push(end-64);
   const expected=24*8/(altitude-8);expect(Math.abs((end-64)-expected)).toBeLessThan(4);
  }
  expect(lengths[0]).toBeLessThan(lengths[1]);expect(lengths[1]).toBeLessThan(lengths[2]);
  expect(skyTransmission(state,{x:40,y:80,z:15},{x:48,y:80,z:.2})).toBe(1);
 });
 it('a roof occludes a person below it while its exterior surface receives light',()=>{
  const state=scene();ridge(state);const from={x:61,y:80,z:100};
  expect(skyTransmission(state,from,{x:61,y:80,z:1.7})).toBe(0);
  expect(skyTransmission(state,from,{x:61,y:80,z:8.3})).toBe(1);
 });
 it('tree crowns partially transmit a low ray and do not block a ray far above them',()=>{
  const state=scene(),f=getHeightField(state.map);
  for(let y=156;y<164;y++)for(let x=120;x<128;x++)f.canopy[y*f.w+x]=10;f.version++;
  const low=skyTransmission(state,{x:40,y:80,z:20},{x:80,y:80,z:.2});
  expect(low).toBeGreaterThan(0);expect(low).toBeLessThan(.9);
  expect(skyTransmission(state,{x:40,y:80,z:100},{x:80,y:80,z:.2})).toBe(1);
 });
 it('the actual physical hull casts a shadow independently of model loading or enemy knowledge',()=>{
  const state=scene(),{v}=addTank(state,'pz4gh',{x:30,y:40});
  const from={x:50,y:80,z:4},to={x:72,y:80,z:.2};
  expect(skyTransmission(state,from,to)).toBe(0);state.vehicles.delete(v.id);expect(skyTransmission(state,from,to)).toBe(1);
 });
 it('overlapping lights saturate without whiteout and burnout is gradual',()=>{
  const state=scene(),f=flare(state),p={x:90,y:85,z:.2};const single=illuminationAt(state,p);flare(state,{id:701});
  const both=illuminationAt(state,p);expect(both).toBeGreaterThan(single);expect(both).toBeLessThan(1);
  state.time=85;expect(flarePose(state,f)!.strength).toBeLessThan(f.intensity);state.time=90;expect(flarePose(state,f)).toBeNull();expect(illuminationAt(state,p)).toBe(.025);
 });
 it('wind and descent use simulation time and a low source cannot continue underground',()=>{
  const state=scene(),f=flare(state,{burstAt:0,wind:{x:.16,y:.05},descentMs:1});state.time=10;
  expect(flarePose(state,f)!.pos).toEqual({x:81.6,y:80.5,z:90});state.time=100;expect(flarePose(state,f)).toBeNull();
 });
});

describe('mortar illumination is a real finite crew mission',()=>{
 it('preserves a hesitant gunner’s previous action and waits for individual order acceptance',()=>{
  const state=scene(),own=readyMortar(state);state.config.alwaysObeyOrders=true;
  own.gunner.path=[{x:21,y:40}];own.gunner.activity='moving';own.gunner.mind.hesitation=30;
  const path=structuredClone(own.gunner.path);
  requestIllumination(state,'german',own.team.id,{x:60,y:40});
  expect(own.gunner.path).toEqual(path);expect(own.gunner.activity).toBe('moving');
  applyOrder(state,own.team,{...own.team.order!},new Rng(1));
  expect(own.gunner.mind.pendingOrderAt).toBe(own.team.order!.issuedAt);
  advance(state,20);expect(state.illuminationShots??[]).toHaveLength(0);expect(state.flares??[]).toHaveLength(0);
  own.gunner.mind.hesitation=0;applyOrder(state,own.team,{...own.team.order!},new Rng(2));
  expect(own.gunner.mind.pendingOrderAt).toBeUndefined();advance(state,15);expect(state.flares).toHaveLength(1);
 });
 it('cannot reset the weapon cycle by retargeting, and preserves the scheduled repeat for the same point',()=>{
  const state=scene(),own=readyMortar(state);requestIllumination(state,'german',own.team.id,{x:60,y:40});
  while(!state.illuminationShots?.length)advance(state,.1);
  const fired=state.time,deadline=own.team.crewWeapon!.nextMortarShotAt!,repeat=own.team.illuminationMission!.nextRoundAt;
  requestIllumination(state,'german',own.team.id,{x:60,y:40});expect(own.team.illuminationMission!.nextRoundAt).toBe(repeat);
  requestIllumination(state,'german',own.team.id,{x:61,y:40});advance(state,6);
  expect(own.team.illuminationAmmo).toBe(FLARE.stock-1);expect(state.time).toBeLessThan(deadline);
  applyOrder(state,own.team,{type:'fire',target:{x:61,y:40},issuedAt:state.time},new Rng(2));own.gunner.fireTimer=0;
  stepCombat(state,new Rng(3),.1);expect(own.gunner.lastFiredAt).toBe(fired);
 });
 it('remains an area illumination mission when an enemy at its point is already known dead',()=>{
  const state=scene(),own=readyMortar(state),enemy=soldier(9000,9900,'soviet',{x:60,y:40},'mosin',{health:'dead',activity:'dead'});
  state.soldiers.set(enemy.id,enemy);state.teams.set(9900,mkTeam(9900,'rifle',[9000],'soviet',enemy.pos));
  for(const s of own.men)recordVisual(state,s,enemy,'soldier');
  requestIllumination(state,'german',own.team.id,{x:60,y:40});
  applyOrder(state,own.team,{...own.team.order!},new Rng(1));stepAttackOrders(state,new Rng(2));
  expect(own.team.order?.illumination).toBe(true);expect(own.team.order?.targetTeamId).toBeUndefined();expect(own.team.illuminationMission).toBeDefined();
  advance(state,15);expect(state.flares).toHaveLength(1);
 });
 it('lays, fires, flies and lights an area using separate stock, without consuming or firing HE',()=>{
  const state=scene(),own=readyMortar(state);state.config.illuminationRounds=1;const he=own.gunner.ammo;
  expect(requestIllumination(state,'german',own.team.id,{x:60,y:40})).toBe(true);
  advance(state,1);expect(state.illuminationShots??[]).toHaveLength(0);
  advance(state,19);expect(own.team.illuminationAmmo).toBe(0);expect(state.flares).toHaveLength(1);
  stepCombat(state,new Rng(3),.1);expect(own.gunner.ammo).toBe(he);expect(state.pendingBursts).toHaveLength(0);
  expect(illuminationAt(state,{x:120,y:80,z:.2})).toBeGreaterThan(.5);
 });
 it('cannot work or fire while unable, shocked, dodging, fleeing or busy picking up equipment',()=>{
  for(const blocked of ['packed','stunned','cowering','dodging','fleeing','surrendered','pickup','shock','abandoned','dead']){const state=scene(),own=readyMortar(state);requestIllumination(state,'german',own.team.id,{x:60,y:40});
   if(blocked==='packed')own.team.crewWeapon!.phase='packed';if(blocked==='stunned')own.gunner.stunnedUntil=100;if(blocked==='cowering')own.gunner.mind.state='cowering';if(blocked==='abandoned')own.team.crewWeapon!.abandoned=true;if(blocked==='dead')own.gunner.health='dead';
   if(blocked==='dodging')own.gunner.dodgeUntil=100;if(blocked==='fleeing')own.gunner.activity='panicked';if(blocked==='surrendered')own.gunner.activity='surrendered';
   if(blocked==='pickup')own.gunner.pickup={itemId:1,priority:1,startedAt:0,until:100};
   if(blocked==='shock'){own.gunner.experience=20;onIncomingFire(state,new Rng(14),own.gunner,null,own.gunner.pos,'rifle');state.mindRuntime!.soldiers.get(own.gunner.id)!.freezeUntil=100;}
   advance(state,20);expect(state.flares??[]).toHaveLength(0);expect(state.illuminationShots??[]).toHaveLength(0);
  }
 });
 it('rejects hostile teams, invalid points and the normal mortar minimum range',()=>{
  const state=scene(),{team}=readyMortar(state);
  expect(requestIllumination(state,'soviet',team.id,{x:60,y:40})).toBe(false);
  expect(requestIllumination(state,'german',team.id,{x:22,y:40})).toBe(false);
  expect(requestIllumination(state,'german',team.id,{x:NaN,y:40})).toBe(false);
 });
 it('movement cancels the mission but cannot remove a flare already burning',()=>{
  const state=scene(),own=readyMortar(state);requestIllumination(state,'german',own.team.id,{x:60,y:40});advance(state,15);
  expect(state.flares).toHaveLength(1);applyOrder(state,own.team,{type:'move',target:{x:25,y:45},issuedAt:state.time},new Rng(7));
  expect(own.team.illuminationMission).toBeUndefined();expect(state.flares).toHaveLength(1);
 });
 it('pause freezes launch, descent and fuse clocks',()=>{
  const state=scene(),own=readyMortar(state);requestIllumination(state,'german',own.team.id,{x:60,y:40});state.phase='paused';const before=structuredClone(own.team.illuminationMission);stepIllumination(state,100);
  expect(own.team.illuminationMission).toEqual(before);expect(state.illuminationShots??[]).toHaveLength(0);
 });
});

describe('night light supplies evidence, not knowledge',()=>{
 function people(state:BattleState){const a=soldier(1,1,'german',{x:20,y:40},'kar98k',{stance:'standing'}),b=soldier(2,2,'soviet',{x:60,y:40},'mosin',{stance:'standing'});state.soldiers.set(1,a);state.soldiers.set(2,b);state.teams.set(1,mkTeam(1,'rifle',[1],'german',a.pos));state.teams.set(2,mkTeam(2,'rifle',[2],'soviet',b.pos));return{a,b};}
 it('both sides can acquire a lit target, while the same long-range target stays hidden in darkness',()=>{
  const state=scene();people(state);updateSpotting(state,new Rng(1));expect(state.spotted.german.has(2)).toBe(false);expect(state.spotted.soviet.has(1)).toBe(false);
  flare(state,{intensity:2});updateSpotting(state,new Rng(1));expect(state.spotted.german.has(2)).toBe(true);expect(state.spotted.soviet.has(1)).toBe(true);
 });
 it('looking into a lit area differs from looking back into darkness, without any camera input',()=>{
  const state=scene(),{a,b}=people(state);flare(state,{origin:{x:120,y:80,z:80},radiusM:70,intensity:1.5});
  expect(observerVisibility(state,{pos:a.pos,soldier:a},b.pos,300)).toBeGreaterThan(.5);
  expect(observerVisibility(state,{pos:b.pos,soldier:b},a.pos,300)).toBe(0);
 });
 it('lighting the far side of a wall never supplies observer-to-target LOS',()=>{
  const state=scene();people(state);for(let y=0;y<80;y++)setTile(state.map,40,y,'stonewall');flare(state,{intensity:2});
  updateSpotting(state,new Rng(1));expect(state.spotted.german.has(2)).toBe(false);expect(state.spotted.soviet.has(1)).toBe(false);
 });
 it('fog remembers ground in canonical side state; rendering/explanations cannot mutate future state',()=>{
  const state=scene();people(state);updateNightGroundMemory(state);expect(nightFogAt(state,'german',20,40)).toBe('visible');
  state.time=1;expect(nightFogAt(state,'german',20,40)).toBe('remembered');flare(state);const rng=new Rng(4),before=hashState({state,rng});
  illuminationAt(state,{x:110,y:80,z:.2});nightFogAt(state,'soviet',20,40);expect(hashState({state,rng})).toBe(before);
  state.flares![0].wind.x+=.01;expect(hashState({state,rng})).not.toBe(before);
 });
});
