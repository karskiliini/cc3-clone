import { expect,it } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyMultiplayerPolicy } from '@/sim/multiplayerPolicy';
import { LockstepSession } from '@/net/lockstep';
import { VirtualClock,memoryLink } from '@/net/memoryTransport';
import { hashState } from '@/sim/stateHash';
import type { BattleConfig } from '@/shared/types';
const config=():BattleConfig=>({mapId:'border_1941',playerSide:'german',year:1941,durationS:600,seed:2,difficulty:'normal',multiplayer:true,controllers:{german:'human',soviet:'human'},forces:{german:['ger_rifle_41'],soviet:['sov_rifle_41']}});
it('requires both speed votes to raise, permits either to lower, and hashes the votes',()=>{
 const b=new Battle(config()),s=b.state,h=hashState(b);applyMultiplayerPolicy(s,'german',{type:'setSpeed',speed:4});expect(s.speed).toBe(1);expect(hashState(b)).not.toBe(h);
 applyMultiplayerPolicy(s,'soviet',{type:'setSpeed',speed:2});expect(s.speed).toBe(2);applyMultiplayerPolicy(s,'german',{type:'setSpeed',speed:1});expect(s.speed).toBe(1);applyMultiplayerPolicy(s,'german',{type:'setSpeed',speed:3});expect(s.multiplayerPolicy!.speedVotes.german).toBe(1);
});
it('budgets three owner-controlled pauses per player and rejects orders during them',()=>{
 const b=new Battle(config());b.start();const s=b.state;
 for(let i=0;i<3;i++){
  applyMultiplayerPolicy(s,'german',{type:'pause'});expect(s.phase).toBe('paused');
  applyMultiplayerPolicy(s,'soviet',{type:'resume'});expect(s.phase).toBe('paused');
  expect(applyMultiplayerPolicy(s,'german',{type:'order',teamId:1,order:{type:'move',target:{x:10,y:10},issuedAt:0}})).toBe(true);
  applyMultiplayerPolicy(s,'german',{type:'resume'});expect(s.phase).toBe('running');
 }
 applyMultiplayerPolicy(s,'german',{type:'pause'});expect(s.phase).toBe('running');applyMultiplayerPolicy(s,'soviet',{type:'pause'});expect(s.phase).toBe('paused');expect(s.multiplayerPolicy!.pausesUsed).toEqual({german:3,soviet:1});
});
it('automatically emits a replayable owner resume after 60 seconds at 1x control time',()=>{
 const clock=new VirtualClock(),[ta,tb]=memoryLink(clock,{seed:2,minDelayMs:0,maxDelayMs:0,reorderChance:0});
 const a=new LockstepSession({battle:new Battle(config()),side:'german',transport:ta}),b=new LockstepSession({battle:new Battle(config()),side:'soviet',transport:tb});
 a.issue({type:'ready'});b.issue({type:'ready'});
 const update=()=>{a.update(clock.now);b.update(clock.now);clock.advanceTo(clock.now+10);};
 for(let i=0;i<100;i++)update();a.issue({type:'pause'});let first:number|null=null,last=0;
 for(let i=0;i<6500;i++){update();if(a.battle.state.phase==='paused'){first??=clock.now;last=clock.now;}else if(first!==null&&a.battle.state.phase==='running')break;}
 expect(first).not.toBeNull();expect(last-first!).toBeLessThanOrEqual(60000);expect(last-first!).toBeGreaterThan(59000);
 expect(a.battle.state.phase).toBe('running');expect(a.battle.commandLog().some(c=>c.type==='resume'&&c.side==='german')).toBe(true);
 expect(a.status).toBe('playing');expect(b.status).toBe('playing');
});
it('single-player command rules retain arbitrary positive speeds and ordinary pauses',()=>{
 const cfg=config();delete cfg.multiplayer;const b=new Battle(cfg);b.start();b.submit('german',{type:'setSpeed',speed:3});b.advanceTick();expect(b.state.speed).toBe(3);expect(b.state.multiplayerPolicy).toBeUndefined();
});
