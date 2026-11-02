import {describe,it,expect} from 'vitest';
import {makeState,mkTeam,soldier} from './vehicleDamageHelpers';
import {setPlannedOrder,sendPlanSignal,stepBattlePlan,cancelPlannedOrder} from '@/sim/battlePlan';
import {requestArtillery,stepArtillery,cancelArtillery,ARTILLERY_TIMING as T} from '@/sim/artillery';
import {interceptedRadio} from '@/sim/radioTraffic';
import {Rng} from '@/shared/rng';
import {Battle} from '@/sim/battle';
import {hashState} from '@/sim/stateHash';
import {makeReplayLog,runReplay} from '@/sim/replay';
import {validCommand} from '@/net/commandValidation';
import {applyOrder} from '@/sim/orders';
import type {BattleConfig,Order,Side} from '@/shared/types';

function fixture(){
 const s=makeState(1942);s.phase='deploy';s.config.durationS=1200;s.config.artillerySupport={german:{shells:48,guns:4},soviet:{shells:24,guns:4}};
 for(const [id,side] of [[1,'german'],[2,'german'],[3,'soviet']] as [number,Side][]){
  const man=soldier(id,id,side,{x:10+id*20,y:10},'kar98k',{isLeader:true});
  s.soldiers.set(id,man);s.teams.set(id,mkTeam(id,'command',[id],side,man.pos));
 }return s;
}
const order:Order={type:'move',target:{x:40,y:20},issuedAt:0};
describe('pre-battle plans with immediate public signals',()=>{
 it('executes a genuinely briefed H-hour order beyond HQ contact without bypassing ordinary orders',()=>{
  const s=fixture(),team=s.teams.get(2)!,man=s.soldiers.get(2)!;team.type='rifle';team.pos={x:200,y:100};man.pos={...team.pos};
  s.config.alwaysObeyOrders=true;const move:Order={type:'move',target:{x:205,y:100},issuedAt:0};
  setPlannedOrder(s,'german',2,move,{kind:'time',at:5});s.phase='running';s.time=5;
  applyOrder(s,team,{...move},new Rng(1));expect(man.path).toEqual([]);
  stepBattlePlan(s,(id,received)=>applyOrder(s,s.teams.get(id)!,received,new Rng(1)));
  expect(team.order?.prebriefed).toBe(true);expect(man.path.length).toBeGreaterThan(0);
 });
 it('briefs only own troops; executes a delivered signal once and exposes no meaning',()=>{
  const s=fixture();expect(setPlannedOrder(s,'soviet',2,order,{kind:'signal',signal:1})).toBe(false);
  expect(setPlannedOrder(s,'german',2,order,{kind:'signal',signal:1})).toBe(true);
  expect(s.teams.get(2)!.order).toBeFalsy();s.phase='running';expect(sendPlanSignal(s,'german',1)).toBe(true);
  expect(interceptedRadio(s,'soviet')[0]).toMatchObject({at:0,payload:{kind:'signal',signalId:'1'}});
  const issued:number[]=[];stepBattlePlan(s,id=>issued.push(id));expect(issued).toEqual([]);
  s.time=2;stepBattlePlan(s,id=>issued.push(id));stepBattlePlan(s,id=>issued.push(id));expect(issued).toEqual([2]);
  expect(sendPlanSignal(s,'german',1)).toBe(false);
 });
 it('does not deliver a missed signal after reconnecting; H-hour works without radio',()=>{
  const s=fixture();s.soldiers.get(2)!.pos={x:1000,y:10};setPlannedOrder(s,'german',2,order,{kind:'signal',signal:2});
  setPlannedOrder(s,'german',1,order,{kind:'time',at:5});s.phase='running';sendPlanSignal(s,'german',2);
  s.soldiers.get(2)!.pos={x:50,y:10};s.soldiers.get(1)!.stunnedUntil=10;s.time=5;
  const issued:number[]=[];stepBattlePlan(s,id=>issued.push(id));expect(issued).toEqual([]);
  s.time=10;stepBattlePlan(s,id=>issued.push(id));expect(issued).toEqual([1]);
 });
 it('edits/cancels only during setup and stores a frozen order',()=>{
  const s=fixture(),copy=structuredClone(order);setPlannedOrder(s,'german',2,copy,{kind:'time',at:4});copy.target.x=99;
  expect(s.battlePlans!.german.orders[0].order.target.x).toBe(40);cancelPlannedOrder(s,'german',2);expect(s.battlePlans!.german.orders).toEqual([]);
  s.phase='running';expect(setPlannedOrder(s,'german',2,order,{kind:'time',at:4})).toBe(false);
 });
});
describe('finite battery fire missions',()=>{
 it('reveals requested coordinates immediately, then prepares, loads and flies before impact',()=>{
  const s=fixture();s.phase='running';const rng=new Rng(5),target={x:40,y:20};
  expect(requestArtillery(s,'german',target,'small')).toBe(true);const a=s.artillery!,m=a.missions[0];
  expect(a.batteries[0].ammo).toBe(44);expect(interceptedRadio(s,'soviet')[0]).toMatchObject({at:0,payload:{kind:'fireRequest',target}});
  s.time=T.messageS;stepArtillery(s,rng);expect(m.readyAt).toBe(T.messageS+T.firstPreparationS);
  s.time=m.readyAt+T.loadS-.01;stepArtillery(s,rng);expect(a.shells).toHaveLength(0);
  s.time=m.readyAt+T.loadS;stepArtillery(s,rng);expect(a.shells).toHaveLength(4);
  expect(a.shells.every(sh=>sh.impactAt-sh.firedAt===T.flightS)).toBe(true);
  const impactAt=a.shells[0].impactAt;s.time=impactAt-.01;stepArtillery(s,rng);expect(a.shells).toHaveLength(4);
  s.time=impactAt;stepArtillery(s,rng);expect(a.shells).toHaveLength(0);expect(s.explosions.length).toBeGreaterThan(0);
 });
 it('uses battery-specific retained data for repeat preparation and preserves queued work',()=>{
  const s=fixture();s.phase='running';const rng=new Rng(8);requestArtillery(s,'german',order.target,'small');
  s.time=2;stepArtillery(s,rng);s.time=68;stepArtillery(s,rng);
  expect(s.artillery!.batteries[0].registration).toBeDefined();requestArtillery(s,'german',order.target,'small');
  s.time=100;stepArtillery(s,rng);const repeat=s.artillery!.missions[1];expect(repeat.repeat).toBe(true);expect(repeat.readyAt-s.time).toBe(T.repeatPreparationS);
  requestArtillery(s,'soviet',order.target,'small');s.time=102;stepArtillery(s,rng);expect(s.artillery!.missions[2].repeat).toBe(false);
 });
 it('does not conjure stock and refuses calls without an operational radio',()=>{
  const s=fixture();s.phase='running';s.config.artillerySupport=false;expect(requestArtillery(s,'german',order.target,'small')).toBe(false);
  expect(s.radioTraffic).toBeUndefined();const b=fixture();b.phase='running';b.soldiers.get(1)!.health='dead';b.soldiers.get(2)!.health='dead';expect(requestArtillery(b,'german',order.target,'small')).toBe(false);
 });
 it('cancel preserves airborne shells and returns only unfired reservations',()=>{
  const s=fixture();s.phase='running';const rng=new Rng(9);requestArtillery(s,'german',order.target,'large');s.time=2;stepArtillery(s,rng);s.time=68;stepArtillery(s,rng);
  const a=s.artillery!,m=a.missions[0];expect(a.shells).toHaveLength(4);cancelArtillery(s,'german',m.id);
  s.time+=T.messageS;stepArtillery(s,rng);expect(m.phase).toBe('cancelled');expect(a.shells).toHaveLength(4);expect(a.batteries[0].ammo).toBe(44);
 });
});
describe('command contracts and recovery',()=>{
 it('keeps actual plans, signals and artillery independent of the viewing side',()=>{
  const config:BattleConfig={mapId:'border_1941',playerSide:'german',controllers:{german:'human',soviet:'human'},year:1942,seed:810,durationS:600,difficulty:'normal',forces:{german:['ger_command'],soviet:['sov_command']},alwaysObeyOrders:true};
  const a=new Battle(structuredClone(config)),b=new Battle({...structuredClone(config),playerSide:'soviet'});
  for(const battle of [a,b]){
   const team=[...battle.state.teams.values()].find(t=>t.side==='german')!;
   battle.submit('german',{type:'planOrder',teamId:team.id,order,trigger:{kind:'signal',signal:1}});battle.step(0);
   battle.submit('german',{type:'ready'});battle.submit('soviet',{type:'ready'});battle.step(0);
   battle.submit('german',{type:'signal',signal:1});battle.submit('german',{type:'artillery',target:order.target,size:'small'});
  }
  for(let i=0;i<80;i++){a.advanceTick();b.advanceTick();a.drainEvents();b.drainEvents();expect(hashState(a)).toBe(hashState(b));}
 });
 it('accepts bounded commands and rejects malformed public inputs',()=>{
  expect(validCommand({type:'planOrder',teamId:1,order,trigger:{kind:'signal',signal:1}},100,100)).toBe(true);
  expect(validCommand({type:'planOrder',teamId:1,order,trigger:{kind:'signal',signal:4}},100,100)).toBe(false);
  expect(validCommand({type:'artillery',target:order.target,size:'large'},100,100)).toBe(true);
  expect(validCommand({type:'artillery',target:{x:NaN,y:1},size:'large'},100,100)).toBe(false);
 });
 it('replays prepared orders, public signals and fire calls with the same exact state',()=>{
  const config:BattleConfig={mapId:'border_1941',playerSide:'german',controllers:{german:'human',soviet:'human'},year:1942,seed:321,durationS:1200,difficulty:'normal',forces:{german:['ger_command'],soviet:['sov_command']},alwaysObeyOrders:true};
  const b=new Battle(config),hq=[...b.state.teams.values()].find(t=>t.side==='german')!;
  b.submit('german',{type:'planOrder',teamId:hq.id,order,trigger:{kind:'signal',signal:1}});b.step(0);
  b.submit('german',{type:'ready'});b.submit('soviet',{type:'ready'});b.step(0);
  b.submit('german',{type:'signal',signal:1});b.submit('german',{type:'artillery',target:order.target,size:'small'});
  for(let i=0;i<60;i++)b.step(.05);
  const replay=runReplay(makeReplayLog(b));expect(hashState(replay.battle)).toBe(hashState(b));
 });
});

it('retains battery firing data for A then B then A',()=>{
 const s=fixture();s.phase='running';const rng=new Rng(91),a={x:40,y:20},b={x:65,y:20};
 requestArtillery(s,'german',a,'small');s.time=2;stepArtillery(s,rng);s.time=68;stepArtillery(s,rng);
 s.time=100;requestArtillery(s,'german',b,'small');s.time=102;stepArtillery(s,rng);s.time=168;stepArtillery(s,rng);
 s.time=200;requestArtillery(s,'german',a,'small');s.time=202;stepArtillery(s,rng);
 const m=s.artillery!.missions[2];expect(m.repeat).toBe(true);expect(m.readyAt-s.time).toBe(T.repeatPreparationS);
 expect(s.artillery!.batteries[0].registrations).toHaveLength(2);
});
