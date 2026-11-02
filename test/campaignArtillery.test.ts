import {describe,expect,it} from 'vitest';
import {newCampaign} from '@/campaign/roster';
import {artillerySpent,campaignArtilleryAssignment,campaignArtilleryPool,settleCampaignArtillery} from '@/campaign/artillery';
import {makeState} from './vehicleDamageHelpers';

describe('finite campaign artillery',()=>{
 it('initializes once, allocates without spending and never refreshes a depleted saved pool',()=>{
  const c=newCampaign(1,'german',200);
  expect(campaignArtilleryAssignment(c).german?.shells).toBe(48);
  expect(campaignArtilleryPool(c).remaining.german).toBe(96);
  campaignArtilleryAssignment(c);expect(c.artilleryPool!.remaining.german).toBe(96);
  settleCampaignArtillery(c,'battle1',{german:90});
  const saved=JSON.parse(JSON.stringify(c));
  expect(campaignArtilleryAssignment(saved).german?.shells).toBe(6);
  settleCampaignArtillery(saved,'battle2',{german:6});
  expect(campaignArtilleryAssignment(saved).german?.shells).toBe(0);
 });
 it('counts launched rounds, excluding unfired reservations, then debits only once after reload',()=>{
  const c=newCampaign(1,'german',200),state=makeState();
  state.config.artillerySupport=campaignArtilleryAssignment(c);
  state.artillery={batteries:[{id:1,side:'german',name:'test',weaponId:'field_105',guns:4,ammo:24,readyAt:0}],
   missions:[{id:2,batteryId:1,side:'german',target:{x:1,y:1},size:'large',phase:'firing',calledAt:0,acceptedAt:2,readyAt:60,nextShotAt:66,roundsLeft:20,repeat:false,requesterId:1}],shells:[]};
  expect(artillerySpent(state)).toEqual({german:4,soviet:0});
  settleCampaignArtillery(c,'unique-battle',artillerySpent(state));
  const restored=JSON.parse(JSON.stringify(c));
  settleCampaignArtillery(restored,'unique-battle',{german:4});
  expect(restored.artilleryPool.remaining.german).toBe(92);
  state.artillery.batteries[0].ammo+=20;state.artillery.missions[0].roundsLeft=0;state.artillery.missions[0].phase='cancelled';
  expect(artillerySpent(state).german).toBe(4);
 });
});
