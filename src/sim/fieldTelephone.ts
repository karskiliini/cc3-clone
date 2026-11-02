import type {BattleState,FieldTelephoneLine,Side,Soldier,Vec2} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {humanCapability} from './humanCondition';
import * as dm from '@/shared/dmath';
const dist=(a:Vec2,b:Vec2)=>dm.hypot(a.x-b.x,a.y-b.y);
function capable(st:BattleState,s:Soldier|undefined):s is Soldier{return !!s&&s.health!=='dead'&&s.health!=='incapacitated'&&st.time>=(s.stunnedUntil??-Infinity)&&st.time>=(s.dazedUntil??-Infinity)&&s.activity!=='surrendered'&&s.activity!=='routed'&&s.vehicleId==null&&humanCapability(s,st.time).canOperate&&humanCapability(s,st.time).hearing>=.1;}
function endpoint(st:BattleState,id:number,p:Vec2){const t=st.teams.get(id),s=t?st.soldiers.get(t.leaderId):undefined;return !!t&&!t.outOfAction&&capable(st,s)&&dist(s.pos,p)*TILE_M<=4;}
export function initializeFieldTelephone(st:BattleState){return st.fieldTelephone??={nextId:1,lines:[],stockM:{german:Math.max(0,st.config.telephoneWireStockM??1000),soviet:Math.max(0,st.config.telephoneWireStockM??1000)}};}
function urban(st:BattleState,a:Vec2,b:Vec2){const n=Math.max(1,Math.ceil(dist(a,b)*2));for(let i=0;i<=n;i++){const x=Math.floor(a.x+(b.x-a.x)*i/n),y=Math.floor(a.y+(b.y-a.y)*i/n);if(!['buildingWood','buildingStone','floor','pavedroad','rubble'].includes(st.map.tiles[y*st.map.width+x]))return false;}return true;}
export function connectTelephone(st:BattleState,side:Side,fromTeamId:number,toTeamId:number,points:Vec2[],underground=false):FieldTelephoneLine|null{
 if(st.phase!=='deploy'||fromTeamId===toTeamId||points.length<2||points.length>256)return null;
 const z=st.map.def.deployZones[side];if(st.teams.get(fromTeamId)?.side!==side||st.teams.get(toTeamId)?.side!==side||!endpoint(st,fromTeamId,points[0])||!endpoint(st,toTeamId,points.at(-1)!))return null;
 if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>=st.map.width||p.y>=st.map.height||p.x<z.x||p.y<z.y||p.x>z.x+z.w||p.y>z.y+z.h))return null;
 const lengthM=points.slice(1).reduce((n,p,i)=>n+dist(points[i],p)*TILE_M,0),net=initializeFieldTelephone(st);if(lengthM<=0||lengthM>net.stockM[side])return null;
 const l:FieldTelephoneLine={id:net.nextId++,side,fromTeamId,toTeamId,points:points.map(p=>({...p})),lengthM,cutSegments:[],underground:points.slice(1).map((p,i)=>underground||!!st.config.telephoneUnderground||urban(st,points[i],p))};net.stockM[side]-=lengthM;net.lines.push(l);return l;
}
export function cancelTelephone(st:BattleState,side:Side,id:number){const net=st.fieldTelephone,l=net?.lines.find(l=>l.id===id&&l.side===side);if(st.phase!=='deploy'||!net||!l)return false;net.stockM[side]+=l.lengthM;net.lines=net.lines.filter(x=>x!==l);return true;}
export const removeTelephone=cancelTelephone;
export function cutTelephone(st:BattleState,id:number,i:number){const l=st.fieldTelephone?.lines.find(l=>l.id===id);if(!l||!Number.isInteger(i)||i<0||i>=l.points.length-1||l.underground[i]||l.cutSegments.includes(i))return false;l.cutSegments.push(i);l.cutSegments.sort((a,b)=>a-b);return true;}
export function telephoneLink(st:BattleState,a:Soldier,b:Soldier):{channel:'telephone';delay:number;lineIds:number[]}|null{
 if(a.id===b.id||a.side!==b.side||!capable(st,a)||!capable(st,b)||st.teams.get(a.teamId)?.leaderId!==a.id||st.teams.get(b.teamId)?.leaderId!==b.id)return null;
 const q=[{team:a.teamId,delay:0,lineIds:[] as number[]}],seen=new Set<number>();while(q.length){q.sort((a,b)=>a.delay-b.delay||a.team-b.team);const c=q.shift()!;if(seen.has(c.team))continue;seen.add(c.team);if(c.team===b.teamId)return{channel:'telephone',delay:c.delay,lineIds:c.lineIds};
 for(const l of st.fieldTelephone?.lines??[]){if(l.side!==a.side||l.cutSegments.length||!endpoint(st,l.fromTeamId,l.points[0])||!endpoint(st,l.toTeamId,l.points.at(-1)!))continue;const next=l.fromTeamId===c.team?l.toTeamId:l.toTeamId===c.team?l.fromTeamId:null;if(next!=null&&!seen.has(next))q.push({team:next,delay:c.delay+2+l.lengthM/1000,lineIds:[...c.lineIds,l.id]});}}
 return null;
}
function pointSegment(p:Vec2,a:Vec2,b:Vec2){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return dist(p,{x:a.x+t*dx,y:a.y+t*dy});}
function segmentDistance(a:Vec2,b:Vec2,c:Vec2,d:Vec2){const cross=(p:Vec2,q:Vec2,r:Vec2)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return 0;return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));}
export function damageTelephoneBlast(st:BattleState,p:Vec2,radiusM:number){if(!(radiusM>0))return;for(const l of st.fieldTelephone?.lines??[])for(let i=0;i<l.points.length-1;i++)if(pointSegment(p,l.points[i],l.points[i+1])*TILE_M<=radiusM)cutTelephone(st,l.id,i);}
export function damageTelephoneSweep(st:BattleState,a:Vec2,b:Vec2,radiusM:number){if(dist(a,b)<1e-8)return;for(const l of st.fieldTelephone?.lines??[])for(let i=0;i<l.points.length-1;i++)if(segmentDistance(a,b,l.points[i],l.points[i+1])*TILE_M<=radiusM)cutTelephone(st,l.id,i);}
function operator(st:BattleState,l:FieldTelephoneLine,teamId:number,i:number){const t=st.teams.get(teamId);if(!t||t.side!==l.side||t.outOfAction||![l.fromTeamId,l.toTeamId].includes(teamId)&&t.type!=='engineer')return;return t.soldierIds.map(id=>st.soldiers.get(id)).find(s=>capable(st,s)&&(t.type==='engineer'||s.id===t.leaderId)&&pointSegment(s.pos,l.points[i],l.points[i+1])*TILE_M<=4);}
export function requestTelephoneRepair(st:BattleState,side:Side,id:number,teamId:number){const l=st.fieldTelephone?.lines.find(l=>l.id===id&&l.side===side);if(st.phase!=='running'||!l)return false;const i=l.cutSegments.find(i=>operator(st,l,teamId,i));if(i==null)return false;l.repair={teamId,segment:i,remainingS:20};return true;}
export function stepFieldTelephone(st:BattleState,dt:number){if(st.phase!=='running'||!(dt>0))return;for(const l of st.fieldTelephone?.lines??[]){const r=l.repair;if(!r)continue;const s=operator(st,l,r.teamId,r.segment);if(!s){delete l.repair;continue;}r.remainingS-=dt*humanCapability(s,st.time).work;if(r.remainingS<=0){l.cutSegments=l.cutSegments.filter(i=>i!==r.segment);delete l.repair;}}}
