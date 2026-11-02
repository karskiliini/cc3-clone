import type {RadioPayload,Side} from '@/shared/types';
import {speechSchedule,SPEECH_DURATIONS,communicationDuration} from '@/data/communicationSpeech';
export {tokensForPayload,speechSchedule,communicationDuration} from '@/data/communicationSpeech';
export interface HeadsetMessage {id:number;at:number;side:Side;channel:'radio'|'telephone';payload:RadioPayload}
export const VOICE_REPORTS_PER_MINUTE=8;
export const VOICE_MIN_INTERVAL_S=6;
/** Only presentation priority: recipient knowledge/transport are untouched. */
export function speechPriority(payload:RadioPayload):number{
 if(payload.kind==='signal')return 100;
 if(payload.kind==='fireRequest'||payload.kind==='fireCorrection'||payload.kind==='fireCancellation')return 90;
 if(payload.kind==='report'&&/enemy activity report|terrain report|vehicle obstruction report/i.test(payload.text))return -1;
 if(payload.kind==='report'&&/t-?34|tank|panzer|kv-|casualty|leadership/i.test(payload.text))return 70;
 return payload.kind==='message'?50:20;
}
/** Non-spatial headset nets, independent of combat-SFX admission caps. */
export class HeadsetAudio {
 private ctx:AudioContext|null=null;
 private master:GainNode|null=null;
 private buses=new Map<string,AudioNode>();
 private buffers=new Map<string,AudioBuffer>();
 private sources=new Set<AudioBufferSourceNode>();
 private scheduled=new Set<number>();
 private volume=0.7; private muted=false;private paused=false;private lastTime=-Infinity;
 private loading:Promise<void>|null=null;
 private playingUntil=0;private playingPriority=-1;private nextSpeechAt=0;private lastSpeechAt=-Infinity;
 private admittedAt:number[]=[];
 unlock():void {
  if(!this.ctx){const AC=window.AudioContext||(window as any).webkitAudioContext;if(!AC)return;
   this.ctx=new AC();const ctx=this.ctx!;this.master=ctx.createGain();this.master.connect(ctx.destination);this.applyGain();
   for(const [key,pan] of [['german',-0.6],['soviet',0.6],['telephone',0]] as const){
    const filter=ctx.createBiquadFilter();filter.type='bandpass';filter.frequency.value=key==='telephone'?1500:1800;filter.Q.value=0.55;
    const panner=ctx.createStereoPanner();panner.pan.value=pan;filter.connect(panner);panner.connect(this.master);this.buses.set(key,filter);
   }
   this.loading=Promise.all(Object.keys(SPEECH_DURATIONS).map(async token=>{
    try{const response=await fetch(`${(import.meta as ImportMeta & {env?:{BASE_URL?:string}}).env?.BASE_URL??'/'}audio/communications/${token}.wav`);if(!response.ok)return;this.buffers.set(token,await ctx.decodeAudioData(await response.arrayBuffer()));}catch{/* A failed asset is silent; no external speech fallback. */}
   })).then(()=>{});
  }
  if(this.ctx?.state==='suspended')void this.ctx.resume().catch(()=>{});
 }
 /** Awaitable for loading screens / deterministic audio evidence. */
 async ready():Promise<void>{await this.loading;}
 private applyGain():void{if(this.master)this.master.gain.value=this.paused||this.muted?0:this.volume;}
 setVolume(value:number):void{this.volume=Math.max(0,Math.min(1,value));this.applyGain();}
 setMuted(value:boolean):void{this.muted=value;this.applyGain();}
 setPaused(value:boolean):void{if(this.paused===value)return;this.paused=value;this.stopSources();this.scheduled.clear();this.playingUntil=0;this.nextSpeechAt=0;this.applyGain();}
 private stopSources():void{for(const source of this.sources){try{source.stop();}catch{}}this.sources.clear();}
 stopAll():void{this.stopSources();this.scheduled.clear();this.lastTime=-Infinity;this.playingUntil=0;this.nextSpeechAt=0;this.admittedAt=[];this.lastSpeechAt=-Infinity;}
 reset():void{this.stopAll();}
 update(messages:readonly HeadsetMessage[],now:number,viewerSide:Side):void {
  if(now<this.lastTime)this.stopAll();this.lastTime=now;
  const ids=new Set(messages.map(m=>m.id));for(const id of this.scheduled)if(!ids.has(id))this.scheduled.delete(id);
  if(!this.ctx||!this.master||this.paused||this.ctx.state!=='running')return;
  const clock=this.ctx.currentTime;
  this.admittedAt=this.admittedAt.filter(at=>clock-at<60);
  const candidates=messages.filter(message=>!(message.channel==='telephone'&&message.side!==viewerSide)&&message.at<=now&&now-message.at<8&&!this.scheduled.has(message.id)&&speechPriority(message.payload)>=0)
   .sort((a,b)=>speechPriority(b.payload)-speechPriority(a.payload)||b.at-a.at||a.id-b.id);
  for(const message of candidates){
   const elapsed=now-message.at,priority=speechPriority(message.payload);
   if(elapsed>=communicationDuration(message.payload))continue;
   const urgent=priority>=90;
   if(clock<this.playingUntil){
    if(!urgent||priority<=this.playingPriority||clock-this.lastSpeechAt<.5)return;
    this.stopSources();
   }else if(!urgent&&(clock<this.nextSpeechAt||this.admittedAt.length>=VOICE_REPORTS_PER_MINUTE))return;
   const words=speechSchedule(message.payload).filter(w=>w.at+w.duration>elapsed);
   if(words.some(w=>!this.buffers.has(w.token)))continue;
   this.scheduled.add(message.id);
   this.lastSpeechAt=clock;this.admittedAt.push(clock);this.playingPriority=priority;
   this.playingUntil=clock+communicationDuration(message.payload)-elapsed;
   this.nextSpeechAt=Math.max(this.playingUntil+.75,clock+VOICE_MIN_INTERVAL_S);
   for(const word of words){const source=this.ctx.createBufferSource();source.buffer=this.buffers.get(word.token)!;
    source.connect(this.buses.get(message.channel==='telephone'?'telephone':message.side)!);
    source.onended=()=>this.sources.delete(source);this.sources.add(source);
    source.start(this.ctx.currentTime+Math.max(0,word.at-elapsed),Math.max(0,elapsed-word.at));
   }
   return; // Exactly one utterance; simultaneous nets cannot become a voice pile-up.
  }
 }
}
