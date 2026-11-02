import {describe,expect,it} from 'vitest';
import {campaignAirAssignment,operationScenarioDate,settleDailySupport} from '@/campaign/airSupport';
import {newCampaign} from '@/campaign/roster';
import {game} from '@/game';
import {DebriefScreen} from '@/ui/screens/debrief';
import {makeState} from './vehicleDamageHelpers';

describe('campaign daily air pool',()=>{
  it('returns unused assignments and spends only actual sorties on the same day',()=>{
    const c=newCampaign(1,'german',200),date='1943-07-15';
    expect(campaignAirAssignment(c,date)).toEqual({german:{missions:1},soviet:{missions:1}});
    settleDailySupport(c,date,{german:0,soviet:1});expect(c.airSupportDaily!.remaining).toEqual({german:2,soviet:1});
    campaignAirAssignment(c,date);expect(c.airSupportDaily!.remaining.german).toBe(2);
    settleDailySupport(c,date,{german:1,soviet:1});expect(campaignAirAssignment(c,date)).toEqual({german:{missions:1},soviet:{missions:0}});
    settleDailySupport(c,date,{german:1});expect(campaignAirAssignment(c,date).german?.missions).toBe(0);
  });
  it('persists the pool as plain saved data and refreshes it only on a new date',()=>{
    const c=newCampaign(1,'german',200);settleDailySupport(c,'1944-01-15',{german:2});
    const restored=JSON.parse(JSON.stringify(c));expect(campaignAirAssignment(restored,'1944-01-15').german?.missions).toBe(0);
    expect(campaignAirAssignment(restored,'1944-01-16').german?.missions).toBe(1);expect(restored.airSupportDaily.remaining.german).toBe(2);
  });
  it('respects exact authored dates and labels old month-only battles with a representative 15th',()=>{
    expect(operationScenarioDate({year:1943,title:'Kursk — July 1943'})).toBe('1943-07-15');
    expect(operationScenarioDate({year:1941,title:'Moscow — December 1941'})).toBe('1941-12-15');
    expect(operationScenarioDate({year:1943,title:'Kursk',scenarioDate:'1943-07-04'})).toBe('1943-07-04');
  });
  it('settles actual sorties only once through the existing debrief record guard',()=>{
    const previous={operation:game.operation,campaign:game.campaign,battle:game.battle};
    try{
      const c=newCampaign(1,'german',220),date='1943-07-15',state=makeState();state.config.scenarioDate=date;
      campaignAirAssignment(c,date);game.campaign=c;
      game.operation={index:0,playerSide:'german',results:[],forcePool:[],requisition:220};
      game.battle={state,playerSide:()=> 'german',battleReport:()=>({result:'draw',fledSide:null,teams:[],airMissionsUsed:{german:1,soviet:0}})} as any;
      const debrief=new DebriefScreen(game.battle!) as any;debrief.record();debrief.record();
      expect(c.airSupportDaily!.remaining).toEqual({german:1,soviet:2});expect(game.operation!.index).toBe(1);
    }finally{game.operation=previous.operation;game.campaign=previous.campaign;game.battle=previous.battle;}
  });
});
