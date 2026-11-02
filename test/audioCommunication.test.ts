import {describe,it,expect} from 'vitest';
import {tokensForPayload,speechSchedule,communicationDuration,SPEECH_DURATIONS} from '../src/data/communicationSpeech';
import {HeadsetAudio} from '../src/audio/communications';
describe('offline public communication speech',()=>{
 it('speaks arbitrary public words by spelling unfamiliar words',()=>{
  expect(tokensForPayload({kind:'message',text:'Move Zulu 42'})).toEqual(['move','letter_z','letter_u','letter_l','letter_u','digit_4','digit_2']);
 });
 it('reads transmitted signal identifier without expanding private meanings',()=>{
  expect(tokensForPayload({kind:'signal',signalId:'3'})).toEqual(['signal','digit_3']);
 });
 it('includes fire mission and transmitted target in measured airtime',()=>{
  const payload={kind:'fireRequest' as const,missionId:2,target:{x:10,y:20}};
  const words=speechSchedule(payload);expect(words.every(w=>SPEECH_DURATIONS[w.token]>0)).toBe(true);
  expect(tokensForPayload(payload)).toContain('target');
  const last=words.at(-1)!;expect(communicationDuration(payload)).toBeCloseTo(last.at+last.duration+0.12);
  for(let i=1;i<words.length;i++)expect(words[i].at).toBeGreaterThan(words[i-1].at+words[i-1].duration);
 });
 it('is safe before browser unlock and during lifecycle transitions',()=>{
  const audio=new HeadsetAudio();audio.setMuted(true);audio.setVolume(0.5);audio.setPaused(true);
  audio.update([{id:1,at:0,side:'soviet',channel:'telephone',payload:{kind:'message',text:'secret'}}],0,'german');
  audio.setPaused(false);audio.stopAll();audio.reset();
 });
});

describe('headset net scheduling',()=>{
 function fixture(){
  const starts:{at:number;offset:number;token:string;stopped:boolean}[]=[];
  const audio=new HeadsetAudio();
  const ctx={state:'running',currentTime:10,createBufferSource:()=>{
   const item={at:0,offset:0,token:'',stopped:false};
   return {buffer:null as unknown,connect(){},start(at:number,offset:number){item.at=at;item.offset=offset;item.token=this.buffer as string;starts.push(item);},stop(){item.stopped=true;},onended:null};
  }};
  Object.assign(audio,{ctx,master:{gain:{value:1}},buses:new Map([['german',{}],['soviet',{}],['telephone',{}]]),buffers:new Map(Object.keys(SPEECH_DURATIONS).map(t=>[t,t]))});
  return {audio,starts,ctx};
 }
 it('hears both radio nets, excludes opposing telephone, deduplicates history',()=>{
  const {audio,starts,ctx}=fixture();
  const messages=[{id:1,at:0,side:'german' as const,channel:'radio' as const,payload:{kind:'message' as const,text:'move'}},{id:2,at:0,side:'soviet' as const,channel:'radio' as const,payload:{kind:'message' as const,text:'stop'}},{id:3,at:0,side:'soviet' as const,channel:'telephone' as const,payload:{kind:'message' as const,text:'attack'}},{id:4,at:0,side:'german' as const,channel:'telephone' as const,payload:{kind:'message' as const,text:'defend'}}];
  audio.update(messages,0,'german');expect(starts.map(s=>s.token)).toEqual(['move']);
  audio.update(messages,0.1,'german');expect(starts).toHaveLength(1);
  ctx.currentTime+=7;audio.update(messages,0.1,'german');expect(starts.map(s=>s.token)).toEqual(['move','stop']);
  ctx.currentTime+=7;audio.update(messages,0.2,'german');expect(starts.map(s=>s.token)).toEqual(['move','stop','defend']);
  audio.update(messages,0.3,'german');expect(starts).toHaveLength(3);
 });
 it('stops speech on pause and resumes only the remaining live word',()=>{
  const {audio,starts}=fixture();const messages=[{id:1,at:0,side:'german' as const,channel:'radio' as const,payload:{kind:'message' as const,text:'move stop'}}];
  audio.update(messages,0,'german');audio.setPaused(true);expect(starts.every(s=>s.stopped)).toBe(true);
  const resumeAt=SPEECH_DURATIONS.move+0.05;audio.setPaused(false);audio.update(messages,resumeAt,'german');
  expect(starts.at(-1)?.token).toBe('stop');expect(starts.at(-1)?.offset).toBeGreaterThan(0);
  const count=starts.length;audio.update(messages,100,'german');expect(starts).toHaveLength(count);
 });
 it('recovers a rewind without replaying expired messages',()=>{
  const {audio,starts}=fixture();const messages=[{id:1,at:0,side:'german' as const,channel:'radio' as const,payload:{kind:'message' as const,text:'move'}}];
  audio.update(messages,100,'german');expect(starts).toHaveLength(0);audio.update(messages,0.1,'german');expect(starts).toHaveLength(1);expect(starts[0].offset).toBeCloseTo(0.1);
 });
 it('admits one utterance from a 50-message burst and silences old enemy-activity spam',()=>{
  const {audio,starts}=fixture();
  const messages=Array.from({length:50},(_,id)=>({id,at:0,side:'german' as const,channel:'radio' as const,payload:{kind:'report' as const,text:'Contact report soldier'}}));
  const oneUtterance=tokensForPayload(messages[0].payload).length;
  audio.update(messages,0,'german');expect(starts).toHaveLength(oneUtterance);
  for(let i=0;i<50;i++)audio.update(messages,.1,'german');expect(starts).toHaveLength(oneUtterance);
  const quiet=fixture();quiet.audio.update([{id:100,at:0,side:'soviet',channel:'radio',payload:{kind:'report',text:'Enemy activity report',target:{x:10,y:20}}}],0,'german');expect(quiet.starts).toHaveLength(0);
 });
 it('prioritizes fire calls over background reports',()=>{
  const {audio,starts}=fixture();
  const fire={kind:'fireRequest' as const,missionId:2,target:{x:10,y:20}};
  audio.update([{id:1,at:0,side:'german',channel:'radio',payload:{kind:'report',text:'Contact report soldier'}},{id:2,at:0,side:'soviet',channel:'radio',payload:fire}],0,'german');
  expect(starts.map(s=>s.token)).toEqual(tokensForPayload(fire));
 });
 it('caps routine announcements at eight per real minute without changing transport data',()=>{
  const {audio,starts,ctx}=fixture();
  const messages=[];
  for(let i=0;i<9;i++){
   ctx.currentTime=10+i*7;messages.push({id:i,at:i,side:'german' as const,channel:'radio' as const,payload:{kind:'message' as const,text:'move'}});audio.update(messages,i,'german');
  }
  expect(messages).toHaveLength(9);expect(starts).toHaveLength(8);
 });
});
