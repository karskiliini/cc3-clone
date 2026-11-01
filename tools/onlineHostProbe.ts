/** Two-machine native WebSocket/lockstep probe; bundle with the current build fingerprint.
 * Usage: probe.mjs <ws-url> <output.json> [room-code]. No room token is printed. */
import { writeFileSync } from 'node:fs';
import { RoomClient } from '@/net/roomClient';
import { OnlineMatch } from '@/net/onlineMatch';
import { SIMULATION_BUILD } from '@/shared/version';
const [url,out,code]=process.argv.slice(2);if(!url||!out)throw new Error('Expected websocket URL and output file');
const client=new RoomClient(url);let match:OnlineMatch|null=null,started=0,move=false,corrupt=false,done=false;
const begin=performance.now(),events:string[]=[];
client.onEvent(e=>{
 if(e.kind==='disconnected'){events.push(e.reason);return;}
 const f=e.frame;
 if(f.op==='error'){events.push(`${f.code}: ${f.message}`);return;}
 if(f.op==='member'){
  if(!code)console.log(`ROOM ${f.room.code}`);
  client.request({op:'roster',forces:[client.side==='german'?'ger_rifle_41':'sov_rifle_41'],ready:true});
 }
 if(f.op==='start'){match=new OnlineMatch(client,{},f);started=performance.now();match.issue({type:'ready'});}
});
await client.connect();if(code)client.join(code);else client.create('german',{mapId:'border_1941',year:1941,durationS:600,seed:71,points:200});
function finish(reason?:string){if(done)return;done=true;clearInterval(timer);const s=match?.session;
 const report={passed:!!s&&s.status==='playing'&&(s.battle.state.tick??0)>=80&&(!code?s.reports.some(r=>r.recovered):true),reason,side:client.side,build:SIMULATION_BUILD,turn:s?.turn,tick:s?.battle.state.tick,hashChain:s?.hashChain,reports:s?.reports.map(r=>({epoch:r.epoch,recovered:r.recovered,attempts:r.attempts})),events};
 writeFileSync(out,JSON.stringify(report,null,2));match?.dispose();client.close();console.log(`DONE ${report.passed}`);if(!report.passed)process.exitCode=1;
}
const timer=setInterval(()=>{
 const now=performance.now();match?.update(now);
 if(match?.phase==='failed')return finish(match.message);
 if(match?.battle&&match.phase==='playing'&&match.battle.state.phase==='running'){
  const s=match.session!;
  if(s.turn>=20&&!move){move=true;const team=[...match.battle.state.teams.values()].find(t=>t.side===client.side)!;match.issue({type:'order',teamId:team.id,order:{type:code?'defend':'move',target:{x:team.pos.x+2,y:team.pos.y+1},issuedAt:match.battle.state.time}});}
  if(!code&&s.turn>=50&&!corrupt){corrupt=true;match.battle.state.soldiers.values().next().value!.pos.x+=.001;}
 }
 if(started&&now-started>12500)finish();else if(now-begin>40000)finish('Timed out');
},25);
