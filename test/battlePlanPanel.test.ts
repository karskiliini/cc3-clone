import {describe,it,expect,vi} from 'vitest';
import {BattlePlanPanel} from '@/ui/battlePlanPanel';
import {makeState} from './vehicleDamageHelpers';
import type {InputState,Order} from '@/shared/types';
function click(x:number,y:number):InputState{return{mouse:{x,y},buttons:{left:false,right:false,middle:false},clicks:[{x,y,button:0}],releases:[{x,y,button:0}],keysDown:new Set(),keysPressed:new Set(),keysReleased:new Set(),wheel:0,wheelDX:0,wheelDY:0,pointerInside:true};}
const order:Order={type:'move',target:{x:30,y:40},issuedAt:0};
describe('deployment battle-plan input',()=>{
  it('routes normal order gestures to the selected signal or H-hour and back to NOW',()=>{
    const panel=new BattlePlanPanel(),state=makeState(1944),issue=vi.fn();
    expect(panel.order(1,order)).toEqual({type:'order',teamId:1,order});
    expect(panel.update(click(210,105),state,'german',issue).clicks).toEqual([]);
    expect(panel.order(1,order)).toEqual({type:'planOrder',teamId:1,order,trigger:{kind:'signal',signal:2}});
    panel.update(click(390,105),state,'german',issue);panel.update(click(590,105),state,'german',issue);
    expect(panel.order(1,order)).toEqual({type:'planOrder',teamId:1,order,trigger:{kind:'time',at:75}});
    panel.update(click(30,105),state,'german',issue);expect(panel.order(1,order).type).toBe('order');
  });
  it('cancels only the displayed local plan and consumes releases over the panel',()=>{
    const panel=new BattlePlanPanel(),state=makeState(1944),issue=vi.fn();
    state.battlePlans={german:{orders:[{teamId:7,order,trigger:{kind:'signal',signal:1},status:'waiting'}],signals:[]},soviet:{orders:[{teamId:99,order,trigger:{kind:'signal',signal:3},status:'waiting'}],signals:[]}};
    const result=panel.update(click(590,161),state,'german',issue);
    expect(issue).toHaveBeenCalledTimes(1);expect(issue).toHaveBeenCalledWith({type:'cancelPlanOrder',teamId:7});expect(result.releases).toEqual([]);
  });
});
