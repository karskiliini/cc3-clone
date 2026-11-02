import {Battle} from '@/sim/battle';
import {hashState} from '@/sim/stateHash';
import {makeReplayLog,runReplay} from '@/sim/replay';
/** Same real command path in Node, Chromium and WebKit, including actual impacts. */
export function commandSupportTrace(){
 const b=new Battle({mapId:'border_1941',playerSide:'german',controllers:{german:'human',soviet:'human'},year:1942,seed:6870,durationS:600,difficulty:'normal',alwaysObeyOrders:true,neverActOnInitiative:true,airSupport:false,forces:{german:['ger_command'],soviet:['sov_command']}});
 const hq=[...b.state.teams.values()].find(t=>t.side==='german')!;
 b.submit('german',{type:'planOrder',teamId:hq.id,order:{type:'defend',target:{x:50,y:50},issuedAt:0},trigger:{kind:'signal',signal:1}});
 b.submit('german',{type:'planOrder',teamId:hq.id,order:{type:'ambush',target:{x:60,y:50},issuedAt:0},trigger:{kind:'time',at:10}});b.step(0);
 b.submit('german',{type:'ready'});b.submit('soviet',{type:'ready'});b.step(0);
 const chain:number[]=[];let impacts=0;
 for(let i=0;i<1600;i++){
  if(i===1)b.submit('german',{type:'signal',signal:1});
  if(i===2)b.submit('soviet',{type:'signal',signal:3});
  if(i===3)b.submit('german',{type:'artillery',target:{x:100,y:80},size:'small'});
  if(i===950)b.submit('german',{type:'artillery',target:{x:100,y:80},size:'small'});
  if(i===1000)b.submit('soviet',{type:'artillery',target:{x:100,y:80},size:'large'});
  if(i===1020){const m=b.state.artillery!.missions.find(m=>m.side==='soviet');if(m)b.submit('soviet',{type:'cancelArtillery',missionId:m.id});}
  b.advanceTick();for(const e of b.drainEvents())if(e.kind==='explosion'&&e.weaponId?.startsWith('field_'))impacts++;
  chain.push(hashState(b));
 }
 const replay=runReplay(makeReplayLog(b));
 if(hashState(replay.battle)!==hashState(b))throw new Error('Command-support replay mismatch');
 if(impacts<8||b.state.battlePlans!.german.orders.some(o=>o.status!=='executed')||!b.state.artillery!.missions.some(m=>m.repeat))throw new Error('Command-support trace did not exercise required behavior');
 return{chain,hash:hashState(b),replayHash:hashState(replay.battle),impacts,traffic:b.state.radioTraffic,missions:b.state.artillery!.missions,plans:b.state.battlePlans};
}
