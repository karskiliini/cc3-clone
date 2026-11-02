import {describe,it,expect} from 'vitest';
import {makeState,mkTeam,soldier} from './vehicleDamageHelpers';
import type {BattleState,Order} from '@/shared/types';
import {commandRoute} from '@/sim/commandRoute';
import {emitCommandTraffic,emitContactRadio,radioOrderSender} from '@/sim/radioTraffic';
import {connectTelephone,cutTelephone} from '@/sim/fieldTelephone';
import {Battle} from '@/sim/battle';
const order:Order={type:'move',target:{x:70,y:40},issuedAt:0};
function fixture(positions:{x:number;y:number}[]){
 const state=makeState();state.phase='deploy';
 state.map.def={...state.map.def,deployZones:{german:{x:0,y:0,w:400,h:400},soviet:state.map.def.deployZones.soviet}};
 const teams=positions.map((pos,i)=>{const id=i+1,s=soldier(id,id,'german',pos,'kar98k',{isLeader:true});state.soldiers.set(id,s);const team=mkTeam(id,'command',[id],'german',pos);state.teams.set(id,team);return team;});
 return{state,teams};
}
function phone(state:BattleState,a:number,b:number){const from=state.soldiers.get(a)!,to=state.soldiers.get(b)!;return connectTelephone(state,'german',a,b,[from.pos,to.pos])!;}
describe('command wire medium follows the actual path',()=>{
 it.each([false,true])('routes a real queued player order on its chosen medium (telephone=%s)',wired=>{
  const b=new Battle({mapId:'telephone_experiment',playerSide:'german',year:1942,seed:4,durationS:120,difficulty:'normal',controllers:{german:'human',soviet:'human'},forces:{german:['ger_command','ger_command'],soviet:['sov_command']},alwaysObeyOrders:true});
  const own=[...b.state.teams.values()].filter(t=>t.side==='german');
  b.submit('german',{type:'deployTeam',teamId:own[0].id,pos:{x:10,y:10}});b.submit('german',{type:'deployTeam',teamId:own[1].id,pos:{x:50,y:10}});b.step(0);
  if(wired){const a=b.state.soldiers.get(own[0].leaderId)!,z=b.state.soldiers.get(own[1].leaderId)!;b.submit('german',{type:'connectTelephone',fromTeamId:own[0].id,toTeamId:own[1].id,points:[a.pos,z.pos],underground:false});b.step(0);}
  b.submit('german',{type:'ready'});b.submit('soviet',{type:'ready'});b.step(0);b.submit('german',{type:'order',teamId:own[1].id,order});b.advanceTick();
  expect(b.state.teams.get(own[1].id)!.order?.type).toBe('move');
  expect(b.state.radioTraffic?.messages.length??0).toBe(wired?0:1);expect(b.state.telephoneTraffic?.messages.length??0).toBe(wired?1:0);
 });
 it('has no radio call for a local order or nearby spoken order',()=>{
  const {state}=fixture([{x:10,y:10},{x:15,y:10}]);state.phase='running';
  emitCommandTraffic(state,'german',1,order);emitCommandTraffic(state,'german',2,order);
  expect(commandRoute(state,'german',1)).toEqual([]);expect(commandRoute(state,'german',2)!.map(h=>h.channel)).toEqual(['voice']);
  expect(state.radioTraffic).toBeUndefined();expect(state.telephoneTraffic).toBeUndefined();
 });
 it('uses an intact telephone instead of an available radio',()=>{
  const {state}=fixture([{x:10,y:10},{x:60,y:10}]);phone(state,1,2);state.phase='running';
  emitCommandTraffic(state,'german',2,order);
  expect(commandRoute(state,'german',2)!.map(h=>h.channel)).toEqual(['telephone']);expect(radioOrderSender(state,'german',2)).toBeNull();
  expect(state.radioTraffic).toBeUndefined();expect(state.telephoneTraffic!.messages).toHaveLength(1);
 });
 it('uses radio only when the non-radio command path is absent',()=>{
  const {state}=fixture([{x:10,y:10},{x:60,y:10}]);state.phase='running';emitCommandTraffic(state,'german',2,order);
  expect(commandRoute(state,'german',2)!.map(h=>h.channel)).toEqual(['radio']);expect(state.radioTraffic!.messages).toHaveLength(1);expect(state.telephoneTraffic).toBeUndefined();
 });
 it('falls back to radio when the actual phone line is cut',()=>{
  const {state}=fixture([{x:10,y:10},{x:60,y:10}]);const line=phone(state,1,2);state.phase='running';cutTelephone(state,line.id,0);
  emitCommandTraffic(state,'german',2,order);expect(state.radioTraffic!.messages).toHaveLength(1);expect(state.telephoneTraffic).toBeUndefined();
 });
 it('prefers a phone-plus-voice relay over a direct radio link',()=>{
  const {state}=fixture([{x:10,y:10},{x:60,y:10},{x:65,y:10}]);phone(state,1,2);state.phase='running';
  expect(commandRoute(state,'german',3)!.map(h=>h.channel)).toEqual(['telephone','voice']);emitCommandTraffic(state,'german',3,order);
  expect(state.radioTraffic).toBeUndefined();expect(state.telephoneTraffic!.messages).toHaveLength(1);
 });
 it('does not invent radio for a voice relay through subordinate leaders',()=>{
  const {state}=fixture([{x:10,y:10},{x:20,y:10},{x:30,y:10}]);state.phase='running';
  expect(commandRoute(state,'german',3)!.map(h=>h.channel)).toEqual(['voice','voice']);emitCommandTraffic(state,'german',3,order);expect(state.radioTraffic).toBeUndefined();
 });
 it('does not invent a transmission when no recipient path exists',()=>{
  const {state}=fixture([{x:10,y:10},{x:250,y:10}]);state.phase='running';
  expect(commandRoute(state,'german',2)).toBeNull();emitCommandTraffic(state,'german',2,order);expect(state.radioTraffic).toBeUndefined();expect(state.telephoneTraffic).toBeUndefined();
 });
 it('keeps automatic observation updates out of radio speech',()=>{
  const {state}=fixture([{x:10,y:10},{x:60,y:10}]);
  emitContactRadio(state,'german',{from:1,to:2,sentAt:0,deliverAt:2,channel:'radio',contact:{entity:'vehicle',id:40,teamId:4,pos:{x:100,y:30},observedAt:0,receivedAt:0,confidence:1,uncertaintyM:0,sourceId:1,vehicleDefId:'t34_76'}},true);
  expect(state.radioTraffic).toBeUndefined();
 });
});
