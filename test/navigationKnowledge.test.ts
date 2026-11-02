import {expect,it} from 'vitest';
import {fixture} from './fixtures/personalBattle';
import {planningMap,observeNavigation,rememberCell,learnHullContact,knownHulls} from '@/sim/navigationKnowledge';
import {setTile} from '@/sim/map';
import {findPath} from '@/sim/path';
import {stepCommunication,observedVehicle} from '@/sim/perception';
import {hashState} from '@/sim/stateHash';
import {VEHICLE_DEFS} from '@/data/units';
it('hidden demolition leaves a personal route unchanged until seen or reported',()=>{
 const {state,a,isolated:mate,b}=fixture(),before=planningMap(state,a),target={x:80,y:20};
 const path=findPath(before,a.pos,target,'infantry');setTile(state.map,70,20,'water');
 expect(findPath(planningMap(state,a),a.pos,target,'infantry')).toEqual(path);expect(planningMap(state,a).tiles[20*400+70]).toBe('open');
 mate.pos={x:69,y:20};state.time=1;observeNavigation(state,mate);expect(planningMap(state,mate).tiles[20*400+70]).toBe('water');
 expect(planningMap(state,a).tiles[20*400+70]).toBe('open');a.pos={x:68,y:20};stepCommunication(state);state.time=2;stepCommunication(state);
 expect(planningMap(state,a).tiles[20*400+70]).toBe('water');expect(before).toBe(planningMap(state,a));
 const h=hashState(b);planningMap(state,a);expect(hashState(b)).toBe(h);
});
it('planning arrays expose observed changes through indexing and iteration and cannot mutate the briefing',()=>{
 const {state,a}=fixture(),i=20*400+21;rememberCell(a,{index:i,tile:'water',window:0,buildingId:-1,bunkerId:-1,wire:0,smoke:1,observedAt:0,sourceId:a.id,hops:0});
 const map=planningMap(state,a);expect(map.tiles[i]).toBe('water');expect(Array.from(map.tiles)[i]).toBe('water');expect(map.tiles.slice(i,i+1)).toEqual(['water']);
 expect(()=>map.tiles.fill('water')).toThrow('read-only');expect(()=>map.smoke.fill(5)).toThrow('read-only');expect(state.map.navigationBriefing!.tiles[i]).toBe('open');
});
it('a bump teaches only a local anonymous footprint, never hidden hull identities or other vehicles',()=>{
 const {state,a}=fixture(),def=Object.values(VEHICLE_DEFS).find(d=>d.kind==='tank')!;
 const own=observedVehicle({id:500,entity:'vehicle',teamId:a.teamId,pos:{...a.pos},observedAt:0,receivedAt:0,confidence:1,sourceId:a.id,uncertaintyM:0,vehicleDefId:def.id},'german');own.seats={driver:a.id,commander:null,gunner:null,loader:null,radioOp:null};a.vehicleId=own.id;state.vehicles.set(own.id,own);
 const hidden={...structuredClone(own),id:900,side:'soviet' as const,pos:{x:24,y:20}},distant={...structuredClone(hidden),id:901,pos:{x:70,y:20}};state.vehicles.set(900,hidden);state.vehicles.set(901,distant);
 expect(knownHulls(state,a)).toEqual([]);learnHullContact(state,own,hidden);const hulls=knownHulls(state,a);expect(hulls).toHaveLength(1);expect(hulls[0].id).toBeLessThan(0);expect(hulls[0].pos).not.toEqual(hidden.pos);expect(hulls.some(h=>h.id===900||h.id===901)).toBe(false);
});
it('bounded reports eventually deliver older unsent cells and exclude the recipient’s own hull',()=>{
 const {state,a,isolated:mate}=fixture();mate.pos={x:22,y:20};
 for(let i=0;i<12;i++)rememberCell(a,{index:500+i,tile:'water',window:0,buildingId:-1,bunkerId:-1,wire:0,smoke:0,observedAt:0,sourceId:a.id,hops:0});
 for(let i=0;i<50;i++){state.time=i*.1;stepCommunication(state);}
 expect(Object.keys(mate.perception!.navigation!.cells)).toHaveLength(12);
 mate.vehicleId=500;mate.perception!.navigation!.hulls[500]={id:500,teamId:mate.teamId,side:'german',defId:'pz3',pos:{x:21,y:20},heading:0,state:'ok',observedAt:state.time,sourceId:a.id,hops:1,onFire:false};expect(knownHulls(state,mate)).toEqual([]);
});
it('actual swept movement blocks an unknown hull and teaches its driver a local footprint',async()=>{
 const {state,b}=fixture();state.soldiers.clear();state.teams.clear();state.vehicles.clear();
 const {addTank}=await import('./vehicleDamageHelpers'),{ensureSeats,seatOccupant}=await import('@/sim/vehicleDamage'),{stepVehicles}=await import('@/sim/vehicle');
 const own=addTank(state,'pz4gh',{x:20,y:25}),obstacle=addTank(state,'t34_76',{x:20,y:20},0,50,'soviet');obstacle.v.state='immobilized';ensureSeats(state,own.v);const driver=seatOccupant(state,own.v,'driver')!;own.v.path=[{x:20,y:10}];
 expect(knownHulls(state,driver)).toEqual([]);let touched=false;
 for(let i=0;i<100&&!touched;i++){state.time+=.1;stepVehicles(state,b.rng,.1);touched=knownHulls(state,driver).some(h=>h.id<0);}
 expect(touched).toBe(true);expect(own.v.pos.y).toBeGreaterThan(obstacle.v.pos.y);expect(knownHulls(state,driver).some(h=>h.id===obstacle.v.id)).toBe(false);
});
it('batched local acquisition keeps eyes personal and trims dense changed terrain once per person',async()=>{
 const {state,a,isolated:mate}=fixture(),{observeNavigationAll}=await import('@/sim/navigationKnowledge');mate.pos={x:69,y:20};setTile(state.map,70,20,'water');
 for(let y=10;y<=30;y++)for(let x=5;x<=35;x++)setTile(state.map,x,y,'rubble');
 observeNavigationAll(state);expect(planningMap(state,a).tiles[20*400+70]).toBe('open');expect(planningMap(state,mate).tiles[20*400+70]).toBe('water');
 expect(Object.keys(a.perception!.navigation!.cells)).toHaveLength(256);state.time=1;observeNavigationAll(state);expect(Object.keys(a.perception!.navigation!.cells)).toHaveLength(256);
});
it('retained geometry owns its samples and changes only on a later eligible observation',async()=>{
 const {state,a}=fixture(),{observeNavigationAll}=await import('@/sim/navigationKnowledge');setTile(state.map,21,20,'water');observeNavigationAll(state);
 const i=20*400+21,seen=a.perception!.navigation!.cells[i],field=state.map.heightField!,sample=(20*field.res)*field.w+21*field.res,old=seen.samples!.height[0];
 field.height[sample]=old+2;expect(seen.samples!.height[0]).toBe(old);state.time=1;observeNavigationAll(state);expect(a.perception!.navigation!.cells[i].samples!.height[0]).toBe(old+2);expect(seen.samples!.height[0]).toBe(old);
});

it('a bump has one revisable local hypothesis, expires without hidden knowledge and does not duplicate an identified footprint',async()=>{
 const {state}=fixture();state.soldiers.clear();state.teams.clear();state.vehicles.clear();
 const {addTank}=await import('./vehicleDamageHelpers'),{ensureSeats,seatOccupant}=await import('@/sim/vehicleDamage'),{learnHullContact}=await import('@/sim/navigationKnowledge'),{recordVisual}=await import('@/sim/perception');
 const own=addTank(state,'pz4gh',{x:20,y:25}),other=addTank(state,'t34_76',{x:20,y:22},0,50,'soviet');ensureSeats(state,own.v);const driver=seatOccupant(state,own.v,'driver')!;
 learnHullContact(state,own.v,other.v);other.v.pos.x+=1;state.time=1;learnHullContact(state,own.v,other.v);expect(knownHulls(state,driver).filter(h=>h.id<0)).toHaveLength(1);
 state.time=12;expect(knownHulls(state,driver)).toEqual([]);recordVisual(state,driver,other.v,'vehicle');learnHullContact(state,own.v,other.v);expect(knownHulls(state,driver).map(h=>h.id)).toEqual([other.v.id]);
});
