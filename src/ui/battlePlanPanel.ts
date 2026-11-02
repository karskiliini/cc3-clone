import type { BattleState, InputState, Order, Rect, Side } from '@/shared/types';
import type { CommandBody } from '@/sim/commands';
import { hitRect } from '@/ui/hud/hudChrome';
export type PlanTrigger = {kind:'signal';signal:1|2|3}|{kind:'time';at:number};
const BOX:Rect={x:8,y:58,w:620,h:238};
const MODES=['NOW','Signal 1','Signal 2','Signal 3','H-hour'];
/** Read only the viewing side's sealed plan. */
export class BattlePlanPanel {
  mode=0; seconds=60; expanded=true; private page=0;
  get trigger():PlanTrigger|null {return this.mode===0?null:this.mode===4?{kind:'time',at:this.seconds}:{kind:'signal',signal:this.mode as 1|2|3};}
  contains(p:{x:number;y:number}):boolean {return hitRect(p,{...BOX,h:this.expanded?BOX.h:29});}
  order(teamId:number,order:Order):CommandBody {const trigger=this.trigger;return trigger?{type:'planOrder',teamId,order,trigger}:{type:'order',teamId,order};}
  update(input:InputState,state:BattleState,side:Side,issue:(body:CommandBody)=>void):InputState {
    const orders=state.battlePlans?.[side]?.orders??[];
    const clicks=input.clicks.filter(c=>{
      if(!this.contains(c))return true;
      if(c.button!==0)return false;
      if(c.y<87){this.expanded=!this.expanded;return false;}
      if(c.y>=92&&c.y<118){
        const index=Math.floor((c.x-16)/91);if(index>=0&&index<5)this.mode=index;
        if(c.x>=476&&c.x<508)this.seconds=Math.max(0,this.seconds-15);
        if(c.x>=576&&c.x<612)this.seconds=Math.min(state.config.durationS,this.seconds+15);
      }
      if(c.y>=151&&c.y<271&&c.x>=570){const entry=orders[this.page*6+Math.floor((c.y-151)/20)];if(entry)issue({type:'cancelPlanOrder',teamId:entry.teamId});}
      if(c.y>=273){if(c.x<100)this.page=Math.max(0,this.page-1);if(c.x>500)this.page=Math.min(Math.max(0,Math.ceil(orders.length/6)-1),this.page+1);}
      return false;
    });
    return {...input,clicks,releases:input.releases.filter(c=>!this.contains(c))};
  }
  draw(ctx:CanvasRenderingContext2D,state:BattleState,side:Side):void {
    const orders=state.battlePlans?.[side]?.orders??[];this.page=Math.min(this.page,Math.max(0,Math.ceil(orders.length/6)-1));
    ctx.save();ctx.textAlign='left';ctx.textBaseline='middle';ctx.font='12px Arial, sans-serif';
    ctx.fillStyle='rgba(13,19,24,.96)';ctx.fillRect(BOX.x,BOX.y,BOX.w,this.expanded?BOX.h:29);
    ctx.strokeStyle='#8a8970';ctx.strokeRect(BOX.x+.5,BOX.y+.5,BOX.w-1,this.expanded?BOX.h-1:28);
    ctx.fillStyle='#f6e4b6';ctx.fillText(`${this.expanded?'▼':'▶'} BATTLE PLAN · ${orders.length} scheduled order(s) · click to ${this.expanded?'hide':'review'}`,16,73);
    if(this.expanded){
      MODES.forEach((label,i)=>{ctx.fillStyle=this.mode===i?'#785822':'#303b41';ctx.fillRect(16+i*91,92,85,26);ctx.fillStyle='#fff0cc';ctx.fillText(label,23+i*91,105);});
      ctx.fillStyle='#303b41';ctx.fillRect(476,92,32,26);ctx.fillRect(576,92,36,26);ctx.fillStyle='#fff0cc';ctx.fillText('−',487,105);ctx.fillText(`${this.seconds}s`,514,105);ctx.fillText('+',588,105);
      ctx.fillStyle='#c8d6df';ctx.fillText('Choose timing, select a team, then order normally. H-hour = seconds after Begin.',16,133);
      if(!orders.length){ctx.fillStyle='#aebcc0';ctx.fillText('No scheduled orders. NOW issues the selected order immediately.',16,165);}
      orders.slice(this.page*6,this.page*6+6).forEach((p,i)=>{
        const team=state.teams.get(p.teamId),target=p.order.target,trigger=p.trigger.kind==='signal'?`Signal ${p.trigger.signal}`:`H+${p.trigger.at}s`,y=161+i*20;
        ctx.fillStyle='#e4dfcf';ctx.fillText(`${team?.name??`Team ${p.teamId}`} · ${p.order.type} → ${target?`${target.x.toFixed(0)},${target.y.toFixed(0)}`:'hold'} · ${trigger}`,16,y,550);
        ctx.fillStyle='#f1b99c';ctx.fillText('All',585,y);
      });
      ctx.fillStyle='#c8d6df';ctx.fillText('◀ Prev',16,284);ctx.fillText(`All = cancel team’s orders · page ${this.page+1}/${Math.max(1,Math.ceil(orders.length/6))}`,180,284);ctx.fillText('Next ▶',554,284);
    }ctx.restore();
  }
}
