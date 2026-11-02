import {describe,it,expect} from 'vitest';
import type {BattleState,PendingContactReport} from '@/shared/types';
import {emitContactRadio} from '@/sim/radioTraffic';
function report():PendingContactReport{return{from:1,to:2,sentAt:0,deliverAt:2,channel:'radio',contact:{id:50,entity:'vehicle',teamId:5,pos:{x:10,y:20},observedAt:0,confidence:1,uncertaintyM:5,sourceId:1,receivedAt:0,vehicleDefId:'t34_76',vehicleState:'ok'}};}
describe('spoken report admission',()=>{
 it('announces one stationary contact instead of one utterance per observer or update',()=>{
  const state={time:0} as BattleState,r=report();
  for(let i=0;i<50;i++){state.time=i/10;r.from=i+1;r.contact!.observedAt=state.time;emitContactRadio(state,'german',r);}
  expect(state.radioTraffic!.messages).toHaveLength(1);
 });
 it('ignores jitter but admits a meaningful changed area and a later reminder',()=>{
  const state={time:0} as BattleState,r=report();emitContactRadio(state,'german',r);
  state.time=13;r.contact!.pos.x=10.1;emitContactRadio(state,'german',r);expect(state.radioTraffic!.messages).toHaveLength(1);
  r.contact!.pos.x=40;emitContactRadio(state,'german',r);expect(state.radioTraffic!.messages).toHaveLength(2);
  state.time=74;emitContactRadio(state,'german',r);expect(state.radioTraffic!.messages).toHaveLength(3);
 });
 it('does not suppress a genuinely changed tank condition as a duplicate',()=>{
  const state={time:0} as BattleState,r=report();emitContactRadio(state,'german',r);
  state.time=1;r.contact!.vehicleState='burning';emitContactRadio(state,'german',r);expect(state.radioTraffic!.messages).toHaveLength(2);
 });
 it('does not turn bulk belief synchronization into enemy-activity voice spam',()=>{
  const state={time:0} as BattleState,r=report();delete r.contact;
  r.belief={pos:{x:10,y:20},count:1,confidence:.4,kind:'heard',time:0,deadSeen:0};
  emitContactRadio(state,'german',r);expect(state.radioTraffic).toBeUndefined();
 });
});
