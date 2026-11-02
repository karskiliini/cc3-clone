import {describe,it,expect} from 'vitest';
import {createTelephoneExperiment} from '@/data/telephoneExperiment';
import {directContacts} from '@/sim/perception';
import {damageTelephoneBlast} from '@/sim/fieldTelephone';
import {headsetTraffic} from '@/sim/radioTraffic';

describe('playable telephone experiment',()=>{
 it('delivers an actual T-34 report to a leader who cannot see it, then stops updates after the wire is cut',()=>{
  const b=createTelephoneExperiment(),team=[...b.state.teams.values()].find(t=>t.name==='Receiving squad')!,leader=b.state.soldiers.get(team.leaderId)!;
  expect(b.state.fieldTelephone!.lines).toHaveLength(1);b.submit('german',{type:'ready'});b.step(0);
  for(let i=0;i<300;i++)b.advanceTick();
  expect(directContacts(b.state,leader).some(c=>c.vehicleDefId==='t34_76')).toBe(false);
  expect(leader.perception!.reports.some(c=>c.vehicleDefId==='t34_76')).toBe(true);
  expect(headsetTraffic(b.state).some(m=>m.channel==='telephone'&&m.side==='german'&&m.payload.kind==='report'&&m.payload.text.includes('T-34'))).toBe(true);
  expect(headsetTraffic(b.state).some(m=>m.channel==='radio'&&m.side==='soviet'&&m.payload.kind==='signal')).toBe(true);
  const cutAt=b.state.time;damageTelephoneBlast(b.state,{x:54,y:20},2);
  expect(b.state.fieldTelephone!.lines[0].cutSegments.length).toBeGreaterThan(0);
  for(let i=0;i<100;i++)b.advanceTick();
  const reported=leader.perception!.reports.find(c=>c.vehicleDefId==='t34_76');
  expect(reported).toBeDefined();expect(reported!.observedAt).toBeLessThanOrEqual(cutAt);
 });
});
