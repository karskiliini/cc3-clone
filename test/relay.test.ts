import { expect,it } from 'vitest';
import { createRelayServer } from '../server/relay';
import { RoomClient, type RoomEvent } from '@/net/roomClient';
import { OnlineMatch } from '@/net/onlineMatch';
import { SIMULATION_BUILD } from '@/shared/version';
import { hashState } from '@/sim/stateHash';
import { makeReplayLog,runReplay } from '@/sim/replay';
import { crc32 } from '@/net/integrity';
const settings={mapId:'border_1941',year:1941,durationS:600,seed:7,points:200};
const wait=(n=15)=>new Promise<void>(r=>setTimeout(r,n));
async function until(fn:()=>boolean,ms=4000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Timed out waiting for relay');await wait();}}
function frames(c:RoomClient){const out:Extract<RoomEvent,{kind:'frame'}>['frame'][]=[];c.onEvent(e=>{if(e.kind==='frame')out.push(e.frame);});return out;}
function assertShared(a:OnlineMatch,b:OnlineMatch){
 const ah=new Map(a.session!.hashChain),bh=new Map(b.session!.hashChain),common=[...ah.keys()].filter(t=>bh.has(t));
 expect(common.length).toBeGreaterThan(0);for(const t of common)expect(ah.get(t)).toBe(bh.get(t));
 expect(a.session!.status).toBe('playing');expect(b.session!.status).toBe('playing');
}
it('checks version, room membership, host authority, roster eligibility and sealed-side ownership on real sockets',async()=>{
 const relay=await createRelayServer({port:0}),url=`ws://127.0.0.1:${relay.port}/relay`,a=new RoomClient(url),b=new RoomClient(url),bad=new RoomClient(url,'another-build');const af=frames(a),bf=frames(b),xf=frames(bad);
 try{
  await Promise.all([a.connect(),b.connect(),bad.connect()]);bad.create('german',settings);await until(()=>xf.some(f=>f.op==='error'));expect(xf.at(-1)).toMatchObject({op:'error',code:'BUILD_MISMATCH'});
  a.create('german',settings);await until(()=>!!a.room);expect(a.room!.code).toMatch(/^[A-Z2-9]{6}$/);b.join(a.room!.code);await until(()=>!!b.room);expect(b.side).toBe('soviet');
  b.request({op:'settings',settings:{...settings,year:1942}});await until(()=>bf.some(f=>f.op==='error'));expect(bf.at(-1)).toMatchObject({op:'error',code:'BAD_SETTINGS'});
  b.request({op:'roster',forces:['ger_rifle_41'],ready:true});await until(()=>bf.some(f=>f.op==='error'&&f.code==='BAD_ROSTER'));
  a.request({op:'roster',forces:['ger_rifle_41'],ready:true});b.request({op:'roster',forces:['sov_rifle_41'],ready:true});await until(()=>af.some(f=>f.op==='start')&&bf.some(f=>f.op==='start'));
  const body=JSON.stringify({kind:'bundle',side:'soviet',turn:3,commands:[],ack:2});a.send({k:'m',seq:0,crc:crc32(body),body});await until(()=>af.some(f=>f.op==='error'&&f.code==='WRONG_SIDE'));
  const good=JSON.stringify({kind:'bundle',side:'german',turn:3,commands:[],ack:2});a.send({k:'m',seq:1,crc:crc32(good),body:good});await until(()=>relay.rooms.values().next().value!.sealedTo.german===3);
  const changed=JSON.stringify({kind:'bundle',side:'german',turn:3,commands:[{type:'ready'}],ack:2});a.send({k:'m',seq:2,crc:crc32(changed),body:changed});await until(()=>af.some(f=>f.op==='error'&&f.code==='SEALED'));
  const corrupt=JSON.stringify({kind:'bundle',side:'german',turn:4,commands:[{type:'pause'}],ack:2});a.send({k:'m',seq:3,crc:0,body:corrupt});await wait(30);expect(relay.rooms.values().next().value!.sealedTo.german).toBe(3);
  const ahead=JSON.stringify({kind:'bundle',side:'german',turn:5,commands:[{type:'pause'}],ack:2});a.send({k:'m',seq:5,crc:crc32(ahead),body:ahead});await wait(30);expect(relay.rooms.values().next().value!.sealedTo.german).toBe(3);expect(af.some(f=>f.op==='error'&&f.code==='MISSING_TURN')).toBe(false);
  const repaired=JSON.stringify({kind:'bundle',side:'german',turn:4,commands:[{type:'ready'}],ack:2});a.send({k:'m',seq:4,crc:crc32(repaired),body:repaired});await until(()=>relay.rooms.values().next().value!.sealedTo.german===5);expect(relay.rooms.values().next().value!.history.german.get(4)).toEqual([{type:'ready'}]);
 }finally{a.close();b.close();bad.close();await relay.close();}
});
it('runs, rejoins a reloaded client from retained commands, preserves unsealed input, repairs desync and continues against AI with replay',async()=>{
 const relay=await createRelayServer({port:0}),url=`ws://127.0.0.1:${relay.port}/relay`,a=new RoomClient(url),b=new RoomClient(url);let am:OnlineMatch|null=null,bm:OnlineMatch|null=null,b2:RoomClient|null=null,restored:OnlineMatch|null=null;
 a.onEvent(e=>{if(e.kind==='frame'&&e.frame.op==='start')am=new OnlineMatch(a,{},e.frame);});b.onEvent(e=>{if(e.kind==='frame'&&e.frame.op==='start')bm=new OnlineMatch(b,{},e.frame);});
 let now=0;
 async function pump(n:number){for(let i=0;i<n;i++){am?.update(now);(restored??bm)?.update(now);now+=100;await wait();}}
 try{
  await Promise.all([a.connect(),b.connect()]);a.create('german',settings);await until(()=>!!a.room);b.join(a.room!.code);await until(()=>!!b.room);
  a.request({op:'roster',forces:['ger_rifle_41'],ready:true});b.request({op:'roster',forces:['sov_rifle_41'],ready:true});await until(()=>!!am&&!!bm);
  am!.issue({type:'ready'});bm!.issue({type:'ready'});await pump(35);assertShared(am!,bm!);expect(am!.battle!.state.phase).toBe('running');
  const own=[...am!.battle!.state.teams.values()].find(t=>t.side==='german')!;const target={x:own.pos.x+2,y:own.pos.y+2};
  am!.issue({type:'order',teamId:own.id,order:{type:'move',target,issuedAt:am!.battle!.state.time}});
  const credential=b.credential!;bm!.dispose();await until(()=>am!.phase==='waiting');
  b2=new RoomClient(url);restored=new OnlineMatch(b2);await b2.reconnect(credential);await pump(65);
  expect(am!.phase,am!.message).toBe('playing');expect(restored.phase,restored.message).toBe('playing');assertShared(am!,restored);
  expect(am!.battle!.state.teams.get(own.id)!.order?.target).toEqual(target);
  const s=am!.battle!.state.soldiers.values().next().value!;s.pos.x+=.001;await pump(70);assertShared(am!,restored);expect(am!.session!.reports.some(r=>r.recovered)).toBe(true);
  const local=am!.continueAgainstAI()!;expect(local.sideIsAI('soviet')).toBe(true);expect(local.state.multiplayerPolicy?.active).toBe(false);
  const replay=runReplay(makeReplayLog(local));expect(hashState(replay.battle)).toBe(hashState(local));
 }finally{(am as OnlineMatch|null)?.dispose();(bm as OnlineMatch|null)?.dispose();restored?.dispose();a.close();b.close();b2?.close();await relay.close();}
},20000);
it('expires disconnected rooms and reports a stale rejoin rather than inventing history',async()=>{
 const relay=await createRelayServer({port:0,ttlMs:40,maintenanceMs:20}),url=`ws://127.0.0.1:${relay.port}/relay`,a=new RoomClient(url);let b:RoomClient|null=null;
 try{await a.connect();a.create('german',settings);await until(()=>!!a.room);const credential=a.credential!;a.close();await wait(100);b=new RoomClient(url);const out=frames(b);await b.reconnect(credential);await until(()=>out.some(f=>f.op==='error'));expect(out.at(-1)).toMatchObject({op:'error',code:'NO_ROOM'});}finally{a.close();b?.close();await relay.close();}
});

it('preserves the progressed battle for AI continuation when a rejoin replay throws',async()=>{
 const relay=await createRelayServer({port:0}),url=`ws://127.0.0.1:${relay.port}/relay`,a=new RoomClient(url),b=new RoomClient(url);let am:OnlineMatch|null=null,bm:OnlineMatch|null=null,b2:RoomClient|null=null,restored:OnlineMatch|null=null;
 a.onEvent(e=>{if(e.kind==='frame'&&e.frame.op==='start')am=new OnlineMatch(a,{},e.frame);});b.onEvent(e=>{if(e.kind==='frame'&&e.frame.op==='start')bm=new OnlineMatch(b,{},e.frame);});
 let now=0;async function pump(n:number){for(let i=0;i<n;i++){am?.update(now);(restored??bm)?.update(now);now+=100;await wait();}}
 try{
  await Promise.all([a.connect(),b.connect()]);a.create('german',settings);await until(()=>!!a.room);b.join(a.room!.code);await until(()=>!!b.room);
  a.request({op:'roster',forces:['ger_rifle_41'],ready:true});b.request({op:'roster',forces:['sov_rifle_41'],ready:true});await until(()=>!!am&&!!bm);am!.issue({type:'ready'});bm!.issue({type:'ready'});await pump(20);
  const progressed=am!.battle!,tick=progressed.state.tick??0;expect(tick).toBeGreaterThan(10);
  a.onEvent(e=>{if(e.kind==='frame'&&e.frame.op==='history'){const session=am!.session as any;session.rebuild.battle.advanceTick=()=>{throw new Error('injected replay fault');};}});
  const credential=b.credential!;bm!.dispose();await until(()=>am!.phase==='waiting');b2=new RoomClient(url);restored=new OnlineMatch(b2);await b2.reconnect(credential);await pump(10);
  expect(['failed','closed']).toContain(am!.phase);expect(['failed','closed']).toContain(restored.phase);expect(am!.canContinueLocally).toBe(true);
  const local=am!.continueAgainstAI()!;expect(local).toBe(progressed);expect(local.state.tick).toBeGreaterThanOrEqual(tick);expect(local.sideIsAI('soviet')).toBe(true);expect(hashState(runReplay(makeReplayLog(local)).battle)).toBe(hashState(local));
 }finally{(am as OnlineMatch|null)?.dispose();(bm as OnlineMatch|null)?.dispose();restored?.dispose();a.close();b.close();b2?.close();await relay.close();}
},10000);
it('closes a connected recovery that makes no progress instead of waiting forever',async()=>{
 const relay=await createRelayServer({port:0,maintenanceMs:20,recoveryTimeoutMs:30}),a=new RoomClient(`ws://127.0.0.1:${relay.port}/relay`),out=frames(a);
 try{await a.connect();a.create('german',settings);await until(()=>!!a.room);const room=relay.rooms.values().next().value!;room.phase='recovering';room.recoveryAt=Date.now();await until(()=>out.some(f=>f.op==='closed'));expect(out.at(-1)).toMatchObject({op:'closed',reason:expect.stringContaining('stopped making progress')});}finally{a.close();await relay.close();}
});
