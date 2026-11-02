import type {BattleState,GameMap,HeightField,KnownHull,NavigationCell,Soldier,Vec2,Vehicle} from '@/shared/types';
import {TILE_M,SIDES} from '@/shared/types';
import {hash2} from '@/shared/rng';
import {angleTo,dist,wrapAngle} from '@/shared/math';
import * as dm from '@/shared/dmath';
import {captureNavigationBriefing} from './navigationBase';
import {conscious,knownContacts,observedVehicle,perception,vehicleObserver,directContacts} from './perception';
import {humanCapability} from './humanCondition';
import {collectSpotters,observerVisibility,type Spotter} from './spotting';

function memory(s:Soldier){return perception(s).navigation??={cells:{},hulls:{}};}
function trimCells(cells:Record<number,NavigationCell>):void{
 const keys=Object.keys(cells);if(keys.length<=256)return;
 keys.sort((a,b)=>cells[+a].observedAt-cells[+b].observedAt||+a-+b);
 for(let i=0;i<keys.length-256;i++)delete cells[+keys[i]];
}
export function rememberCell(s:Soldier,cell:NavigationCell):void{
 const m=memory(s),old=m.cells[cell.index];if(old&&old.observedAt>=cell.observedAt)return;
 m.version=(m.version??0)+1;m.cells[cell.index]=structuredClone(cell);
 trimCells(m.cells);
}
export function rememberHull(s:Soldier,hull:KnownHull):void{
 const m=memory(s),old=m.hulls[hull.id];if(old&&old.observedAt>=hull.observedAt)return;
 m.version=(m.version??0)+1;m.hulls[hull.id]=structuredClone(hull);const keys=Object.keys(m.hulls);if(keys.length>48){keys.sort((a,b)=>m.hulls[+a].observedAt-m.hulls[+b].observedAt||+a-+b);delete m.hulls[+keys[0]];}
}
function patch(state:BattleState,s:Soldier,index:number):NavigationCell{
 const map=state.map,tx=index%map.width,ty=Math.floor(index/map.width),field=map.heightField;
 const c:NavigationCell={index,tile:map.tiles[index],window:map.windows[index],buildingId:map.buildingId[index],bunkerId:map.bunkerId?.[index]??-1,wire:map.wire?.[index]??0,smoke:map.smoke[index]??0,observedAt:state.time,sourceId:s.id,hops:0};
 if(field){const samples={base:[],dig:[],height:[],canopy:[]} as NonNullable<NavigationCell['samples']>;for(let y=0;y<field.res;y++)for(let x=0;x<field.res;x++){const i=(ty*field.res+y)*field.w+tx*field.res+x;for(const key of ['base','dig','height','canopy'] as const)samples[key].push(field[key][i]);}c.samples=samples;c.edits=[];for(let y=0;y<field.res;y++)for(let x=0;x<field.res;x++){const i=(ty*field.res+y)*field.w+tx*field.res+x,e=field.earthworkEdits?.get(i);if(e)c.edits.push([i,{...e}]);}}
 if(map.foxholes)c.holes=[...map.foxholes.values()].filter(h=>Math.floor(h.pos.x)===tx&&Math.floor(h.pos.y)===ty).map(h=>structuredClone(h));
 return c;
}
interface ObservationPass {base:GameMap;changed:Set<number>;eyes:Map<number,Spotter[]>}
/** World geometry only identifies candidates. It never grants an observation;
 * each person still has their own range, eye, LOS and capability test below. */
function observationPass(state:BattleState):ObservationPass{
 const map=state.map,changed=new Set(map.navigationChanged??[]),eyes=new Map<number,Spotter[]>();
 const field=map.heightField;
 if(field?.earthworkEdits)for(const index of field.earthworkEdits.keys()){
  const x=index%field.w,y=Math.floor(index/field.w);changed.add(Math.floor(y/field.res)*map.width+Math.floor(x/field.res));
 }
 for(const mark of map.craterMarks??[])if(mark.kind!=='track'){
  const r=Math.ceil(mark.sizeM/TILE_M+2);
  for(let y=Math.floor(mark.y)-r;y<=Math.floor(mark.y)+r;y++)for(let x=Math.floor(mark.x)-r;x<=Math.floor(mark.x)+r;x++)
   if(x>=0&&y>=0&&x<map.width&&y<map.height)changed.add(y*map.width+x);
 }
 for(const h of map.foxholes?.values()??[])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
  const x=Math.floor(h.pos.x)+dx,y=Math.floor(h.pos.y)+dy;if(x>=0&&y>=0&&x<map.width&&y<map.height)changed.add(y*map.width+x);
 }
 for(const side of SIDES)for(const eye of collectSpotters(state,side))if(eye.soldier){
  const list=eyes.get(eye.soldier.id)??[];list.push(eye);eyes.set(eye.soldier.id,list);
 }
 return {base:captureNavigationBriefing(map),changed,eyes};
}
/** Acquire local geometry through eligible personal eyes. Renderer dirty lists
 * and hypothetical future routes are never observations. */
export function observeNavigation(state:BattleState,s:Soldier,pass?:ObservationPass):void{
 if(!conscious(s,state.time))return;
 const cap=humanCapability(s,state.time);if(cap.sensing<.1)return;
 const context=pass??observationPass(state),map=state.map,base=context.base,eyes=context.eyes.get(s.id)??[];
 if(!eyes.length)return;
 const cx=Math.floor(s.pos.x),cy=Math.floor(s.pos.y),radius=20,observed:number[]=[];
 // Scan only the local square, already in deterministic tile-index order.
 // Expanding global crater history and collecting eyes happens once per pass.
 for(let y=Math.max(0,cy-radius);y<=Math.min(map.height-1,cy+radius);y++)for(let x=Math.max(0,cx-radius);x<=Math.min(map.width-1,cx+radius);x++){
  const i=y*map.width+x;
  if(!context.changed.has(i)&&map.tiles[i]===base.tiles[i]&&map.windows[i]===base.windows[i]&&map.wire?.[i]===base.wire?.[i]&&!(map.smoke[i]>0)&&!s.perception?.navigation?.cells[i])continue;
  const p={x:x+.5,y:y+.5};if(dist(s.pos,p)*TILE_M>40||!eyes.some(eye=>observerVisibility(state,eye,p,40)>.05/cap.sensing))continue;
  const old=s.perception?.navigation?.cells[i];if(!old||old.observedAt<state.time)observed.push(i);
 }
 // Decide the bounded retained set before copying height/earthwork payloads.
 // This is the same latest-time/index selection as inserting every observation
 // and trimming afterward. Discarded observations still advance the version.
 if(observed.length){
  const m=memory(s),fresh=new Set(observed),times=new Map(Object.values(m.cells).map(c=>[c.index,c.observedAt]));
  for(const i of observed)times.set(i,state.time);
  const retained=[...times].sort((a,b)=>b[1]-a[1]||b[0]-a[0]).slice(0,256).map(([i])=>i),keep=new Set(retained);
  for(const key of Object.keys(m.cells))if(!keep.has(Number(key)))delete m.cells[Number(key)];
  for(const i of retained)if(fresh.has(i))m.cells[i]=patch(state,s,i); // patch owns fresh copies of every world value
  m.version=(m.version??0)+observed.length;
 }
 for(const v of state.vehicles.values()){
  if(v.id===s.vehicleId)continue;
  if(v.side!==s.side&&!directContacts(state,s).some(c=>c.entity==='vehicle'&&c.id===v.id))continue;
  if(!eyes.some(eye=>observerVisibility(state,eye,v.pos,100)>.05/cap.sensing))continue;
  rememberHull(s,{id:v.id,teamId:v.teamId,side:v.side,defId:v.defId,pos:{...v.pos},heading:v.hullFacing,state:v.state,observedAt:state.time,sourceId:s.id,hops:0,onFire:v.state==='burning'||!!v.engineOnFire});
 }
}
export function observeNavigationAll(state:BattleState):void{
 const pass=observationPass(state);for(const s of state.soldiers.values())observeNavigation(state,s,pass);
}
const mutators=new Set(['set','fill','copyWithin','reverse','sort','push','pop','shift','unshift','splice']);
function overlay<T extends ArrayLike<number|string>>(source:T,read:(index:number,fallback:T[number])=>T[number]):T{
 let proxy:T;
 proxy=new Proxy(source as object,{get(target,key){
  if(typeof key==='string'&&/^\d+$/.test(key))return read(Number(key),(target as T)[Number(key)]);
  if(typeof key==='string'&&mutators.has(key))return()=>{throw new Error('Planning geometry is read-only');};
  if(key===Symbol.iterator)return function*(){for(let i=0;i<source.length;i++)yield read(i,source[i]);};
  if(key==='at')return(i:number)=>{i=i<0?source.length+i:i;return i<0||i>=source.length?undefined:read(i,source[i]);};
  const value=Reflect.get(target,key,target);
  if(typeof value!=='function')return value;
  // TypedArray methods require a native receiver; use an observed copy for those
  // uncommon bulk readers. Indexed path/height reads stay allocation-free.
  return ArrayBuffer.isView(source)?(...args:unknown[])=>{const copy=Array.from(proxy);return (Array.prototype as unknown as Record<PropertyKey,Function>)[key].apply(copy,args);}:value.bind(proxy);
 },set(){throw new Error('Planning geometry is read-only');}}) as T;return proxy;
}
const views=new WeakMap<BattleState,Map<Soldier|null,{root:GameMap;map:GameMap;version:number}>>();
/** Derived view only: no Proxy is stored in canonical state or transmitted. */
export function planningMap(state:BattleState,s:Soldier|null|undefined):GameMap{
 const base=captureNavigationBriefing(state.map),cells=()=>s?.perception?.navigation?.cells??{};
 let byPerson=views.get(state);if(!byPerson){byPerson=new Map();views.set(state,byPerson);}
 let entry=byPerson.get(s??null);
 if(!entry||entry.root!==state.map){
  const map:GameMap={...base,tiles:overlay(base.tiles,(i,v)=>cells()[i]?.tile??v),windows:overlay(base.windows,(i,v)=>cells()[i]?.window??v),buildingId:overlay(base.buildingId,(i,v)=>cells()[i]?.buildingId??v),smoke:overlay(base.smoke,(i,v)=>{const c=cells()[i];return c?Math.max(0,c.smoke-(state.time-c.observedAt)/60):v;}),dirtyTiles:[],foxholes:new Map(base.foxholes??[])};
  if(base.wire)map.wire=overlay(base.wire,(i,v)=>cells()[i]?.wire??v);if(base.bunkerId)map.bunkerId=overlay(base.bunkerId,(i,v)=>cells()[i]?.bunkerId??v);
  const f=base.heightField;if(f){map.heightField={...f};for(const key of ['base','dig','height','canopy'] as const)map.heightField[key]=overlay(f[key],(i,v)=>{const x=i%f.w,y=Math.floor(i/f.w),cell=cells()[Math.floor(y/f.res)*base.width+Math.floor(x/f.res)];return cell?.samples?.[key][(y%f.res)*f.res+x%f.res]??v;});}
  entry={root:state.map,map,version:-1};byPerson.set(s??null,entry);
 }
 const version=s?.perception?.navigation?.version??0;
 if(entry.version!==version){
  entry.version=version;entry.map.foxholes=new Map(base.foxholes??[]);
  const field=entry.map.heightField;if(field){field.version=(base.heightField?.version??0)+version;field.earthworkEdits=new Map(base.heightField?.earthworkEdits??[]);}
  for(const c of Object.values(cells())){for(const h of c.holes??[])entry.map.foxholes.set(h.id,h);for(const [i,e] of c.edits??[])field?.earthworkEdits?.set(i,e);}
 }
 return entry.map;
}
export function learnTerrainContact(state:BattleState,v:Vehicle,pos:Vec2):void{
 const s=vehicleObserver(state,v,'driver'),x=Math.floor(pos.x),y=Math.floor(pos.y);
 if(s&&x>=0&&y>=0&&x<state.map.width&&y<state.map.height)rememberCell(s,patch(state,s,y*state.map.width+x));
}
export function knownHulls(state:BattleState,s:Soldier|null|undefined):Vehicle[]{
 if(!s)return[];const hulls=new Map<number,Vehicle>();
 for(const h of Object.values(s.perception?.navigation?.hulls??{}))if(state.time-h.observedAt<(h.contact?10:120))hulls.set(h.id,{...observedVehicle({id:h.id,entity:'vehicle',teamId:h.teamId,pos:h.pos,observedAt:h.observedAt,receivedAt:h.observedAt,confidence:.7,uncertaintyM:2,sourceId:h.sourceId,vehicleDefId:h.defId,hullFacing:h.heading,vehicleState:h.state},h.side),engineOnFire:h.onFire});
 for(const c of knownContacts(state,s))if(c.entity==='vehicle')hulls.set(c.id,observedVehicle(c,s.side==='german'?'soviet':'german'));
 return [...hulls.values()].filter(h=>h.id!==s.vehicleId);
}
export function knownHazards(state:BattleState,s:Soldier|null|undefined):Vec2[]{return knownHulls(state,s).filter(v=>v.state==='burning'||v.engineOnFire).map(v=>v.pos);}
/** A physical bump reveals one local estimated footprint, not the other hull's
 * identity, distant position, crew or every obstacle elsewhere on the map. */
export function learnHullContact(state:BattleState,v:Vehicle,blocker:Vehicle):void{
 const s=vehicleObserver(state,v,'driver');if(!s)return;const a=angleTo(v.pos,blocker.pos),p={x:v.pos.x+dm.sin(a)*2,y:v.pos.y-dm.cos(a)*2};
 // A local identified footprint already explains this contact; do not duplicate it.
 if(knownHulls(state,s).some(h=>h.id>=0&&dist(h.pos,p)<3))return;
 // One revisable hypothesis per driver, with a short uncertain-contact lifetime.
 const id=-1-v.id;rememberHull(s,{id,teamId:v.teamId,side:v.side,defId:v.defId,pos:p,heading:v.hullFacing,state:'immobilized',observedAt:state.time,sourceId:s.id,hops:0,onFire:false,contact:true});
}
