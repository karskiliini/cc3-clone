import {describe,it,expect} from 'vitest';
import type {BattleState,RadioPayload,PendingContactReport} from '../src/shared/types';
import {emitRadio,interceptedRadio,emitContactRadio,RADIO_TRAFFIC_LIMIT} from '../src/sim/radioTraffic';
const state=()=>({time:12} as BattleState);
describe('immediate public radio interception',()=>{
 it('discloses a signal identity at emission without private fields or plans',()=>{
  const s=state();emitRadio(s,'german',{kind:'signal',signalId:'1',meaning:'attack',orders:[1],pos:{x:2,y:3}} as RadioPayload);
  expect(interceptedRadio(s,'soviet')).toEqual([{id:0,at:12,senderSide:'german',payload:{kind:'signal',signalId:'1'}}]);
  expect(interceptedRadio(s,'german')).toEqual([]);
 });
 it('freezes transmitted fire coordinates and retains neither trajectory nor caller position',()=>{
  const s=state(),target={x:5,y:6};emitRadio(s,'soviet',{kind:'fireRequest',missionId:3,target,impactAt:50,callerPos:{x:1,y:1}} as RadioPayload);target.x=99;
  expect(interceptedRadio(s,'german')[0].payload).toEqual({kind:'fireRequest',missionId:3,target:{x:5,y:6}});
 });
 it('ignores local voice/intercom and does not disclose report source identity',()=>{
  const s=state(),report={channel:'voice',contact:{entity:'soldier',pos:{x:7,y:8},sourceId:42}} as PendingContactReport;
  emitContactRadio(s,'german',report);report.channel='intercom';emitContactRadio(s,'german',report);expect(s.radioTraffic).toBeUndefined();
  report.channel='radio';emitContactRadio(s,'german',report);expect(interceptedRadio(s,'soviet')[0].payload).toEqual({kind:'report',text:'Contact report: soldier',target:{x:7,y:8}});
 });
 it('bounds canonical traffic and resumes emission IDs after save recovery',()=>{
  const s=state();for(let i=0;i<RADIO_TRAFFIC_LIMIT+5;i++)emitRadio(s,'german',{kind:'message',text:String(i)});
  const recovered=structuredClone(s);emitRadio(recovered,'soviet',{kind:'signal',signalId:'2'});
  expect(recovered.radioTraffic!.messages).toHaveLength(RADIO_TRAFFIC_LIMIT);expect(recovered.radioTraffic!.messages.at(-1)!.id).toBe(RADIO_TRAFFIC_LIMIT+5);
 });
});
