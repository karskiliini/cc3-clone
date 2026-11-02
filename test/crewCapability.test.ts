import {expect,it} from 'vitest';
import {makeState,addTank} from './vehicleDamageHelpers';
import {stepCombat,pickVehicleTarget} from '@/sim/combat';
import {recordVisual} from '@/sim/perception';
import {seatOccupant,ensureSeats} from '@/sim/vehicleDamage';
import {Rng} from '@/shared/rng';
import {SIM_DT} from '@/shared/types';
function scene(){const state=makeState(),own=addTank(state,'pz4gh',{x:100,y:100}),enemy=addTank(state,'t34_76',{x:100,y:80});ensureSeats(state,own.v);const gunner=seatOccupant(state,own.v,'gunner')!;recordVisual(state,gunner,enemy.v,'vehicle');own.v.loadedRound='ap';own.v.coaxAmmo=0;own.v.mainFireTimer=0;return{state,own,enemy,gunner};}
it('a loaded gun cannot fire while its gunner is stunned, cowering or panicked',()=>{
 for(const status of ['healthy','stunned','cowering','panicked'] as const){const {state,own,gunner,enemy}=scene();if(status==='stunned')gunner.stunnedUntil=10;else if(status!=='healthy')gunner.mind.state=status;enemy.v.mainAmmo=0;enemy.v.coaxAmmo=0;let fired=false;const rng=new Rng(7);for(let i=0;i<80;i++){state.time+=SIM_DT;recordVisual(state,gunner,enemy.v,'vehicle');stepCombat(state,rng,SIM_DT);fired ||= own.v.lastMainShotAt!=null;}expect(fired).toBe(status==='healthy');if(status!=='healthy')expect(own.v.loadedRound).toBe('ap');}
});
it('hidden enemy reload, ammunition and crew condition do not change the observed targeting descriptor',()=>{
 const {state,own,enemy}=scene(),before=pickVehicleTarget(state,own.v);expect(before).not.toBeNull();enemy.v.mainFireTimer=99;enemy.v.loadedRound='he';enemy.v.mainAmmo=0;for(const s of enemy.crew){s.health='dead';s.experience=0;s.mind.stress=100;}
 expect(pickVehicleTarget(state,own.v)).toEqual(before);
});
it('the shared inability gate also blocks grenade throwing, with a working healthy control',async()=>{
 const {soldier,mkTeam}=await import('./vehicleDamageHelpers');
 for(const stunned of [false,true]){const state=makeState(),s=soldier(1,1,'german',{x:20,y:20},'kar98k',{ammo:0,grenades:1}),e=soldier(2,2,'soviet',{x:20,y:10},'mosin',{ammo:0});state.soldiers.set(1,s);state.soldiers.set(2,e);state.teams.set(1,mkTeam(1,'rifle',[1],'german',s.pos));state.teams.set(2,mkTeam(2,'rifle',[2],'soviet',e.pos));if(stunned)s.mind.state='cowering';recordVisual(state,s,e,'soldier');stepCombat(state,new Rng(4),.1);expect(s.grenades).toBe(stunned?1:0);}
});
it('a gunner’s own sight permits MG area fire at an open compartment without a commander report',()=>{
 for(const enemyDef of ['marder3','t34_76']){const state=makeState(),own=addTank(state,'pz4gh',{x:100,y:100}),enemy=addTank(state,enemyDef,{x:100,y:80},0,50,'soviet');ensureSeats(state,own.v);const gunner=seatOccupant(state,own.v,'gunner')!;own.v.mainAmmo=0;own.v.bowAmmo=0;recordVisual(state,gunner,enemy.v,'vehicle');stepCombat(state,new Rng(4),.1);expect(own.v.coaxAmmo<250).toBe(enemyDef==='marder3');expect(seatOccupant(state,own.v,'commander')!.perception).toBeUndefined();}
});
