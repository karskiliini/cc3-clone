import type {RadioPayload} from '@/shared/types';
import {SPEECH_DURATIONS} from './communicationSpeechDurations';
export {SPEECH_DURATIONS};
export const TOKEN_GAP = 0.045;
/** Public payload only. Unknown words are spoken letter by letter, never omitted. */
export function tokensForPayload(payload:RadioPayload):string[]{
 let text:string;
 if(payload.kind==='signal') text=`signal ${payload.signalId}`;
 else if(payload.kind==='message'||payload.kind==='report') text=payload.text;
 else text=`fire ${payload.kind==='fireRequest'?'request':payload.kind==='fireCorrection'?'correction':'cancellation'} mission ${payload.missionId}`;
 if('target' in payload&&payload.target) text+=` target ${Math.round(payload.target.x*10)/10} ${Math.round(payload.target.y*10)/10}`;
 return (text.normalize('NFKD').toLowerCase().match(/[a-z]+|[0-9]|[-.]/g)??[]).flatMap(word=>{
  if(SPEECH_DURATIONS[word]!=null)return [word];
  if(word==='-')return ['minus']; if(word==='.')return ['point'];
  return [...word].map(c=>/[0-9]/.test(c)?`digit_${c}`:`letter_${c}`);
 });
}
export function speechSchedule(payload:RadioPayload):{token:string;at:number;duration:number}[]{
 let at=0;return tokensForPayload(payload).map(token=>{const duration=SPEECH_DURATIONS[token]??SPEECH_DURATIONS.unknown!;const entry={token,at,duration};at+=duration+TOKEN_GAP;return entry;});
}
export function communicationDuration(payload:RadioPayload):number {
 const schedule=speechSchedule(payload); const last=schedule.at(-1);return last?last.at+last.duration+0.12:0.12;
}
