import {fixture} from './fixtures/personalBattle';
import {expect,it} from 'vitest';
import {Battle} from '@/sim/battle';
import {buildMap} from '@/sim/map';
import {createMind,stepMinds} from '@/sim/mind';
import {updateSpotting} from '@/sim/spotting';
import {pickSoldierTargetForTest} from '@/sim/combat';
import {directContacts,knownContacts,perception,recordVisual,stepCommunication,hearNoise,communicationLink} from '@/sim/perception';
import {humanCapability,stepHumanCondition,explainIndividual} from '@/sim/humanCondition';
import {hashState} from '@/sim/stateHash';
import {infantrySpeedMs} from '@/sim/infantryPace';
import {Rng} from '@/shared/rng';
import type {Soldier,Team} from '@/shared/types';

it('each observer acquires independently; a remote side sighting grants neither target nor belief',()=>{
 const {b,state,a,isolated,enemy}=fixture();const rng=b.rng.state();updateSpotting(state,b.rng);
 expect(directContacts(state,a).some(c=>c.id===enemy.id)).toBe(true);expect(directContacts(state,isolated)).toEqual([]);expect(pickSoldierTargetForTest(state,isolated)).toBeNull();expect(isolated.mind.beliefs).toEqual([]);expect(b.rng.state()).toBe(rng);
 isolated.pos={x:20,y:22};updateSpotting(state,b.rng);expect(directContacts(state,a).some(c=>c.id===enemy.id)).toBe(true);expect(directContacts(state,isolated).some(c=>c.id===enemy.id)).toBe(true);
});
it('delivers a frozen report after voice delay without refreshing its observation or granting direct acquisition',()=>{
 const {state,a,isolated,enemy}=fixture();isolated.pos={x:21,y:20};recordVisual(state,a,enemy,'soldier');perception(isolated);stepCommunication(state);expect(knownContacts(state,isolated)).toEqual([]);
 enemy.pos={x:390,y:40};state.time=1;stepCommunication(state);const c=knownContacts(state,isolated).find(c=>c.id===enemy.id)!;expect(c.pos).toEqual({x:24,y:20});expect(c.observedAt).toBe(0);expect(c.receivedAt).toBe(1);expect(directContacts(state,isolated)).toEqual([]);expect(pickSoldierTargetForTest(state,isolated)).toBeNull();
 state.time=4;stepCommunication(state);expect(knownContacts(state,isolated)[0].observedAt).toBe(0);
});
it('a broken communication channel drops its queued report',()=>{
 const {state,a,isolated,enemy}=fixture();isolated.pos={x:21,y:20};recordVisual(state,a,enemy,'soldier');stepCommunication(state);a.health='incapacitated';state.time=1;stepCommunication(state);expect(knownContacts(state,isolated)).toEqual([]);expect(communicationLink(state,a,isolated)).toBeNull();
});
it('a wall-blocked sound is an uncertain cue with no identified source; deafness and masking gate it',()=>{
 const {state,a}=fixture();for(let y=0;y<60;y++)state.map.tiles[y*400+25]='stonewall';
 hearNoise(state,a,{x:30,y:20},'shot-1','shot',250);const c=a.perception!.sounds[0];expect(c).toBeDefined();expect(c.uncertaintyM).toBeGreaterThan(0);expect(c.pos).not.toEqual({x:30,y:20});expect(c).not.toHaveProperty('id');expect(directContacts(state,a)).toEqual([]);
 a.condition={breath:0,sweat:0,hearingLoss:1,at:0,lastPos:{...a.pos}};hearNoise(state,a,{x:30,y:20},'shot-2','shot',250);expect(a.perception!.sounds).toHaveLength(1);
});
it('relocating/counting/killing hidden enemies outside influence leaves an isolated person unchanged',()=>{
 const x=fixture(),y=fixture();y.enemy.pos={x:40,y:25};y.enemy.health='dead';y.person(102,'soviet',50,25);
 updateSpotting(x.state,x.b.rng);updateSpotting(y.state,y.b.rng);stepMinds(x.state,new Rng(9),.1);stepMinds(y.state,new Rng(9),.1);
 expect(explainIndividual(x.isolated,0)).toEqual(explainIndividual(y.isolated,0));expect(pickSoldierTargetForTest(x.state,x.isolated)).toEqual(pickSoldierTargetForTest(y.state,y.isolated));
});
it('exertion, pain, sweat and tremor reduce pace/settling/accuracy/work, with bounded recovery',()=>{
 const {state,a}=fixture(),fresh=humanCapability(a,0);perception(a);a.activity='movingFast';a.stance='standing';
 for(let i=0;i<100;i++){state.time+=.1;a.pos.x+=.24;stepHumanCondition(state,.1);}
 const tired=humanCapability(a,state.time);expect(tired.breath).toBeGreaterThan(.8);expect(tired.sweat).toBeGreaterThan(0);expect(tired.pace).toBeLessThan(fresh.pace);expect(tired.accuracy).toBeLessThan(fresh.accuracy);expect(tired.settle).toBeGreaterThan(fresh.settle);expect(tired.work).toBeLessThan(fresh.work);expect(infantrySpeedMs(a,2.4)).toBeLessThan(2.4);
 a.activity='defending';for(let i=0;i<1200;i++){state.time+=.1;stepHumanCondition(state,.1);}expect(humanCapability(a,state.time).breath).toBe(0);expect(a.fatigue).toBe(0);expect(humanCapability(a,state.time).pace).toBeGreaterThan(tired.pace);
 a.health='wounded';expect(humanCapability(a,state.time).pain).toBeGreaterThan(0);expect(humanCapability(a,state.time).settle).toBeGreaterThan(fresh.settle);
});
it('hashes condition, personal evidence, report schedules and private psychology timers; explanation is read-only',()=>{
 const {b,state,a,isolated,enemy}=fixture();recordVisual(state,a,enemy,'soldier');stepHumanCondition(state,.1);stepMinds(state,b.rng,.1);const base=hashState(b),rng=b.rng.state();explainIndividual(a,state.time);expect(hashState(b)).toBe(base);expect(b.rng.state()).toBe(rng);
 for(const mutate of [()=>a.condition!.breath++,()=>a.mind.beliefs[0]!.uncertaintyM=42,()=>{state.communication={queue:[{from:a.id,to:isolated.id,sentAt:0,deliverAt:3,channel:'voice',contact:structuredClone(a.perception!.visual[0])}]};},()=>state.mindRuntime!.soldiers.get(a.id)!.freezeUntil=3]){const before=hashState(b);if(!a.mind.beliefs.length)a.mind.beliefs.push({pos:{x:24,y:20},count:1,confidence:1,kind:'seen',time:0,deadSeen:0});mutate();expect(hashState(b)).not.toBe(before);}
});
it('the same failed order takes a winded, wounded individual longer to reconsider',async()=>{
 const x=fixture(),y=fixture();let seed=0;while(new Rng(seed).next()<.99)seed++;
 y.a.health='wounded';y.a.fatigue=70;y.a.condition={breath:80,sweat:60,hearingLoss:0,at:0,lastPos:{...y.a.pos}};
 const {applyOrderToSoldier}=await import('@/sim/orders');
 for(const f of [x,y]){f.a.randomStreams={orders:seed};const t=f.state.teams.get(f.a.teamId)!;t.order={type:'moveFast',target:{x:32,y:20},issuedAt:0};applyOrderToSoldier(f.state,t,f.a,f.b.rng);}
 expect(x.a.mind.hesitation).toBeGreaterThan(0);expect(y.a.mind.hesitation).toBeGreaterThan(x.a.mind.hesitation);expect(y.a.path).toEqual([]);
});
