import {pickSoldierTargetForTest as personalTarget} from '@/sim/combat';
import {recipientOrder as personalOrder,communicationLink as personalLink,stepHearing as hearWorld} from '@/sim/perception';
import {emitShot as emitTestShot} from '@/sim/noise';
import {expect,it} from 'vitest';
import {fixture} from './fixtures/personalBattle';
import {updateSpotting} from '@/sim/spotting';
import {stepMinds} from '@/sim/mind';
import {stepAttackOrders} from '@/sim/orders';
import {stepMorale} from '@/sim/morale';
import {beginIndirectMission,stepIndirectCommunication,reportIndirectImpact} from '@/sim/indirectCommunication';
import {deliveredObservation} from '@/sim/indirectCommunication';
import {observedVehicle,recordVisual,directContacts,knownContacts,perception,stepCommunication} from '@/sim/perception';
import {pickVehicleTarget,mortarWalkState} from '@/sim/combat';
import {VEHICLE_DEFS} from '@/data/units';
import {hashState} from '@/sim/stateHash';
it('seeing one man never reveals a hidden neighbour or increases perceived strength from him',()=>{
 const x=fixture(),y=fixture();for(const f of [x,y])for(let j=0;j<60;j++)f.state.map.tiles[j*400+26]='stonewall';
 y.person(102,'soviet',28,20);updateSpotting(x.state,x.b.rng);updateSpotting(y.state,y.b.rng);
 expect(directContacts(y.state,y.a).map(c=>c.id)).toEqual([101]);expect(y.a.mind.beliefs).toEqual(x.a.mind.beliefs);expect(y.a.mind.beliefs[0].count).toBe(1);
});
it('commander and gunner use separate eyes; delayed intercom gives an area report, not a precision target',()=>{
 const {state,b,a,isolated:gunner,enemy}=fixture();const def=Object.values(VEHICLE_DEFS).find(d=>d.kind==='tank'&&d.hasTurret&&d.crew>=5)!;
 const vehicle=observedVehicle({id:500,entity:'vehicle',teamId:a.teamId,pos:{x:20,y:20},observedAt:0,receivedAt:0,confidence:1,sourceId:a.id,uncertaintyM:0,vehicleDefId:def.id},'german');vehicle.seats={commander:a.id,gunner:gunner.id,driver:null,loader:null,radioOp:null};vehicle.mainAmmo=20;vehicle.coaxAmmo=0;
 state.vehicles.set(vehicle.id,vehicle);a.vehicleId=vehicle.id;gunner.vehicleId=vehicle.id;gunner.teamId=a.teamId;gunner.pos={...vehicle.pos};state.teams.delete(2);const team=state.teams.get(1)!;team.soldierIds=[a.id,gunner.id];team.vehicleId=vehicle.id;enemy.pos={x:20,y:40};
 updateSpotting(state,b.rng);expect(directContacts(state,a).some(c=>c.id===enemy.id)).toBe(true);expect(directContacts(state,gunner).some(c=>c.id===enemy.id)).toBe(false);expect(pickVehicleTarget(state,vehicle)).toBeNull();
 stepCommunication(state);state.time=.6;stepCommunication(state);expect(knownContacts(state,gunner).some(c=>c.id===enemy.id)).toBe(true);expect(directContacts(state,gunner).some(c=>c.id===enemy.id)).toBe(false);expect(pickVehicleTarget(state,vehicle)?.kind).not.toBe('soldier');
});
it('hidden destruction does not complete an attack order until a personal observation arrives',()=>{
 const {state,b,a,enemy}=fixture(),team=state.teams.get(a.teamId)!;team.order={type:'fire',target:{...enemy.pos},targetTeamId:enemy.teamId,lastKnownPos:{...enemy.pos},lastSeenAt:0,issuedAt:0};
 enemy.health='dead';state.teams.get(enemy.teamId)!.outOfAction=true;stepAttackOrders(state,b.rng);expect(team.order.type).toBe('fire');recordVisual(state,a,enemy,'soldier');stepAttackOrders(state,b.rng);expect(team.order.type).toBe('defend');
});
it('an unseen casualty affects only a witness until the delayed report is delivered',()=>{
 const {state,b,a,isolated:receiver,person}=fixture(),victim=person(3,'german',21,20),team=state.teams.get(a.teamId)!;team.soldierIds=[a.id,receiver.id,victim.id];receiver.teamId=team.id;victim.teamId=team.id;perception(a);perception(receiver);const old=receiver.morale;victim.health='dead';
 stepMorale(state,b.rng,.1);expect(a.morale).toBeLessThan(old);expect(receiver.morale).toBe(old);receiver.pos={x:22,y:20};stepCommunication(state);state.time=1;stepCommunication(state);expect(receiver.morale).toBeLessThan(old);
});
it('indirect fire needs a delivered mission request/report and only delivered impact evidence advances walk-in',()=>{
 const {state,a,isolated:observer}=fixture(),team=state.teams.get(a.teamId)!;team.type='mortar';a.weaponId='mortar81';const obsTeam=state.teams.get(observer.teamId)!;obsTeam.type='command';observer.pos={x:40,y:20};const aim={x:60,y:20};
 // A continuous wall hides the area from the mortar crew but not from the observer.
 for(let j=0;j<60;j++)state.map.tiles[j*400+30]='stonewall';
 beginIndirectMission(state,team,aim);stepIndirectCommunication(state);expect(deliveredObservation(state,team,aim)).toBeNull();
 for(let i=0;i<60;i++){state.time+=.1;stepIndirectCommunication(state);}expect(deliveredObservation(state,team,aim)?.observerId).toBe(observer.id);expect(mortarWalkState(team)?.rounds).toBe(0);
 reportIndirectImpact(state,team.id,team.indirectControl!.startedAt,aim,state.time);expect(mortarWalkState(team)?.rounds).toBe(0);
 observer.health='incapacitated';for(let i=0;i<30;i++){state.time+=.1;stepIndirectCommunication(state);}expect(mortarWalkState(team)?.rounds).toBe(0);
 observer.health='healthy';reportIndirectImpact(state,team.id,team.indirectControl!.startedAt,aim,state.time);for(let i=0;i<30;i++){state.time+=.1;stepIndirectCommunication(state);}expect(mortarWalkState(team)?.rounds).toBe(1);
});
it('read-only observation queries do not create future state or consume randomness',()=>{
 const {state,b,a}=fixture(),before=hashState(b),rng=b.rng.state();knownContacts(state,a);directContacts(state,a);deliveredObservation(state,state.teams.get(a.teamId)!,{x:40,y:20});expect(hashState(b)).toBe(before);expect(b.rng.state()).toBe(rng);
});
it('a stored visual id never follows hidden movement or destruction between observations',()=>{
 const {state,a,enemy}=fixture();recordVisual(state,a,enemy,'soldier');
 const first=personalTarget(state,a);enemy.pos={x:380,y:40};enemy.health='dead';const second=personalTarget(state,a);
 expect(first?.kind).toBe('soldier');expect(second?.kind).toBe('soldier');if(first?.kind==='soldier'&&second?.kind==='soldier'){expect(second.soldier.pos).toEqual(first.soldier.pos);expect(second.soldier.health).toBe('healthy');expect(second.soldier).not.toBe(enemy);}
});
it('leader tracking does not change an isolated recipient’s original ordered point',()=>{
 const {state,b,a,isolated:mate,enemy}=fixture(),team=state.teams.get(a.teamId)!;team.soldierIds.push(mate.id);mate.teamId=team.id;
 const point={...enemy.pos};team.order={type:'fire',target:point,targetTeamId:enemy.teamId,lastSeenAt:0,lastKnownPos:{...point},issuedAt:0};a.targetPoint={...point};mate.targetPoint={...point};enemy.pos={x:40,y:20};state.time=1;recordVisual(state,a,enemy,'soldier');stepAttackOrders(state,b.rng);
 expect(team.order.target).toEqual(point);expect(mate.targetPoint).toEqual(point);expect(personalOrder(state,mate,team.order)?.target).toEqual(point);expect(personalOrder(state,a,team.order)?.target).toEqual(enemy.pos);
});
it('a sighting reaches HQ through two delayed voice hops with its original age',()=>{
 const {state,a,isolated:leader,enemy,person}=fixture();a.isLeader=false;a.teamId=leader.teamId;state.teams.get(leader.teamId)!.soldierIds.push(a.id);state.teams.delete(1);leader.pos={x:24,y:20};const hq=person(3,'german',35,20);
 state.teams.get(leader.teamId)!.leaderId=leader.id;state.teams.get(hq.teamId)!.type='command';recordVisual(state,a,enemy,'soldier');stepCommunication(state);expect(knownContacts(state,hq)).toEqual([]);
 for(let i=0;i<40;i++){state.time+=.1;stepCommunication(state);}const report=knownContacts(state,hq).find(c=>c.id===enemy.id);expect(report).toBeDefined();expect(report?.sourceId).toBe(a.id);expect(report?.observedAt).toBe(0);expect(report?.hops).toBe(2);
});
it('a dismounted leader cannot operate a distant vehicle radio',()=>{
 const {state,a,isolated:hq}=fixture(),team=state.teams.get(a.teamId)!;hq.pos={x:80,y:20};state.teams.get(hq.teamId)!.type='command';const def=Object.values(VEHICLE_DEFS).find(d=>d.kind==='tank'&&d.layout?.radio!==false)!;
 const v=observedVehicle({id:500,entity:'vehicle',teamId:team.id,pos:{...a.pos},observedAt:0,receivedAt:0,confidence:1,sourceId:a.id,uncertaintyM:0,vehicleDefId:def.id},'german');team.vehicleId=v.id;state.vehicles.set(v.id,v);
 expect(personalLink(state,a,hq)).toBeNull();a.vehicleId=v.id;expect(personalLink(state,a,hq)?.channel).toBe('radio');v.state='knockedOut';expect(personalLink(state,a,hq)).toBeNull();
});
it('shot origins remain immutable and audible after UI events are drained',()=>{
 const x=fixture(),y=fixture();emitTestShot(x.state,{kind:'shot',pos:{...x.enemy.pos},weaponId:'kar98k',side:'soviet'},'s101');emitTestShot(y.state,{kind:'shot',pos:{...y.enemy.pos},weaponId:'kar98k',side:'soviet'},'s101');x.enemy.pos={x:390,y:40};x.state.events=[];x.state.time=y.state.time=.1;hearWorld(x.state);hearWorld(y.state);expect(x.a.perception?.sounds).toEqual(y.a.perception?.sounds);expect(x.a.perception?.sounds.length).toBe(1);const hash=hashState(x.b);x.state.noise!.events[0].pos.x++;expect(hashState(x.b)).not.toBe(hash);
});
it('a remote machine-gunner casualty does not apply instant team-wide stress',async()=>{
 const {state,a,isolated:mate,person}=fixture(),victim=person(3,'german',21,20),team=state.teams.get(a.teamId)!;team.soldierIds.push(mate.id,victim.id);mate.teamId=victim.teamId=team.id;victim.weaponId='mg34';const before=mate.mind.stress;
 const {onGunnerHit}=await import('@/sim/mind');onGunnerHit(state,team,victim);expect(a.mind.stress).toBeGreaterThan(0);expect(mate.mind.stress).toBe(before);
});
it('outside observers cannot read crew casualties through closed armor or behind a driver’s view',async()=>{
 const {state,a,enemy}=fixture(),{addTank}=await import('./vehicleDamageHelpers'),{ensureSeats,seatOccupant}=await import('@/sim/vehicleDamage'),{canObserveComrade}=await import('@/sim/perception');
 const own=addTank(state,'pz4gh',{x:20,y:20},0,50,'german');ensureSeats(state,own.v);const driver=seatOccupant(state,own.v,'driver')!,gunner=seatOccupant(state,own.v,'gunner')!;a.pos={x:21,y:20};gunner.health='dead';
 expect(canObserveComrade(state,a,gunner)).toBe(false);expect(canObserveComrade(state,driver,gunner)).toBe(true);enemy.pos={x:20,y:26};expect(canObserveComrade(state,driver,enemy)).toBe(false);
});
it('bounded report dedup evicts the oldest inserted key without moving updated keys',()=>{
 for(const existing of [false,true]){const {state,a,isolated:mate,enemy}=fixture();mate.pos={x:21,y:20};state.time=1;recordVisual(state,a,enemy,'soldier');const p=perception(a),key=`${mate.id}:soldier:${enemy.id}`;p.sentReports={};if(existing)p.sentReports[key]=0;
 for(let i=0;i<(existing?511:512);i++)p.sentReports[`old:${i}`]=0;stepCommunication(state);
 expect(Object.keys(p.sentReports)).toHaveLength(512);expect(p.sentReports[key]).toBe(1);expect(Object.keys(p.sentReports)[0]).toBe(existing?key:'old:1');
 }
});
