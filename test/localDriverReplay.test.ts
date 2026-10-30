import { expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { makeReplayLog, runReplay } from '@/sim/replay';
import { hashState } from '@/sim/stateHash';
import { SIM_DT } from '@/shared/types';
it('reconstructs canonical local-driver history from the accepted command log',()=>{
 const b=new Battle({mapId:'steppe_1943',playerSide:'german',year:1943,seed:3,durationS:1200,difficulty:'normal',forces:{german:['ger_pz4gh'],soviet:[]}});
 b.submit('german',{type:'ready'});b.step(0);const v=[...b.state.vehicles.values()][0];const target={x:v.pos.x+8,y:v.pos.y-20};b.submit('german',{type:'order',teamId:v.teamId,order:{type:'move',target,issuedAt:b.state.time}});
 const chain:number[]=[];let observed=false,observedWindow=false;for(let i=0;i<40;i++){b.step(SIM_DT);b.drainEvents();chain.push(hashState(b));observed||=!!v.localDriver;observedWindow||=!!v.localDriver?.window;}
 expect(observed).toBe(true);expect(observedWindow).toBe(true);const replay=runReplay(JSON.parse(JSON.stringify(makeReplayLog(b))));expect(replay.chain).toEqual(chain);
 expect([...replay.battle.state.vehicles.values()][0].localDriver).toEqual(v.localDriver);
});
