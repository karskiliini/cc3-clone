import type {BattleConfig,CampaignState,OperationBattleDef,Side} from '@/shared/types';

/** Gameplay pool: two missions per side per calendar day, at most one assigned per battle.
 * Assignment does not spend a mission; only an actual sortie in the debrief does. */
export const DAILY_AIR_MISSIONS=2;
function daily(campaign:CampaignState,date:string){
  if(campaign.airSupportDaily?.date!==date)campaign.airSupportDaily={date,remaining:{german:DAILY_AIR_MISSIONS,soviet:DAILY_AIR_MISSIONS}};
  return campaign.airSupportDaily!;
}
export function campaignAirAssignment(campaign:CampaignState,date:string):Exclude<BattleConfig['airSupport'],false|undefined> {
  const pool=daily(campaign,date);
  return{german:{missions:Math.min(1,pool.remaining.german)},soviet:{missions:Math.min(1,pool.remaining.soviet)}};
}
/** Called once through DebriefScreen.record's existing guard before campaign persistence. */
export function settleDailySupport(campaign:CampaignState,date:string,used:Partial<Record<Side,number>>):void {
  const pool=daily(campaign,date);
  for(const side of ['german','soviet'] as Side[])pool.remaining[side]=Math.max(0,pool.remaining[side]-Math.max(0,Math.floor(used[side]??0)));
}
/** Older operation data authors only a month. The 15th is a representative gameplay
 * date for service gating and the daily pool, not a claim about a historical battle day.
 * An explicitly authored scenarioDate takes priority. */
export function operationScenarioDate(battle:Pick<OperationBattleDef,'year'|'title'|'scenarioDate'>):string {
  if(battle.scenarioDate&&/^\d{4}-\d{2}-\d{2}$/.test(battle.scenarioDate))return battle.scenarioDate;
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const found=months.findIndex(m=>battle.title.toLowerCase().includes(m));
  return`${battle.year}-${String(found<0?7:found+1).padStart(2,'0')}-15`;
}
