import type {BattleConfig,BattleState,CampaignState,Side} from '@/shared/types';

/** Finite operation-wide gameplay calibration. Assignment is a ceiling, not expenditure. */
export const CAMPAIGN_ARTILLERY_SHELLS=96;
export const BATTLE_ARTILLERY_SHELLS=48;
export function campaignArtilleryPool(campaign:CampaignState){
 return campaign.artilleryPool??={remaining:{german:CAMPAIGN_ARTILLERY_SHELLS,soviet:CAMPAIGN_ARTILLERY_SHELLS},settledBattles:[]};
}
export function campaignArtilleryAssignment(campaign:CampaignState):Exclude<BattleConfig['artillerySupport'],false|undefined>{
 const pool=campaignArtilleryPool(campaign);
 return {german:{shells:Math.min(BATTLE_ARTILLERY_SHELLS,pool.remaining.german)},soviet:{shells:Math.min(BATTLE_ARTILLERY_SHELLS,pool.remaining.soviet)}};
}
/** Reservations remain unspent until launch. Airborne shells count even before impact. */
export function artillerySpent(state:BattleState):Record<Side,number>{
 const spent={german:0,soviet:0};if(!state.artillery)return spent;
 for(const side of ['german','soviet'] as const){
  const batteries=state.artillery.batteries.filter(b=>b.side===side);
  if(!batteries.length)continue;
  const allocation=state.config.artillerySupport;
  const initial=allocation===false?0:allocation?.[side]?.shells??(allocation?0:BATTLE_ARTILLERY_SHELLS);
  const ammo=batteries.reduce((sum,b)=>sum+b.ammo,0);
  const reserved=state.artillery.missions.filter(m=>m.side===side).reduce((sum,m)=>sum+m.roundsLeft,0);
  spent[side]=Math.max(0,Math.floor(initial-ammo-reserved));
 }
 return spent;
}
export function settleCampaignArtillery(campaign:CampaignState,battleKey:string,spent:Partial<Record<Side,number>>):void{
 const pool=campaignArtilleryPool(campaign);if(pool.settledBattles.includes(battleKey))return;
 for(const side of ['german','soviet'] as const){
  const rounds=spent[side]??0;
  if(Number.isFinite(rounds))pool.remaining[side]=Math.max(0,pool.remaining[side]-Math.max(0,Math.floor(rounds)));
 }
 pool.settledBattles.push(battleKey);
}
