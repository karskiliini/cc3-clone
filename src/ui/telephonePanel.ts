import type { BattleState, Camera, InputState, Side, Vec2 } from '@/shared/types';
import type { CommandBody } from '@/sim/commands';
import { VIEW_H } from '@/shared/types';
import { screenToWorld, worldToScreen } from '@/engine/camera';
import { pickFriendlyTeamScreen } from '@/ui/screens/battleInput';
/** The player's own physical network; enemy wire is never rendered. */
export class TelephonePanel {
  expanded=false; underground=false;
  private from:number|null=null;
  private points:Vec2[]=[];
  constructor(private y:number) {}
  contains(p:Vec2):boolean{return p.x>=8&&p.x<408&&p.y>=this.y&&p.y<this.y+(this.expanded?224:27);}
  update(input:InputState,state:BattleState,side:Side,selected:number|null,cam:Camera,issue:(c:CommandBody)=>void):InputState {
    const routing=this.from!==null;
    const clicks=input.clicks.filter(c=>{
      if(this.contains(c)){
        if(c.button!==0)return false;
        const y=c.y-this.y;
        if(y<27)this.expanded=!this.expanded;
        else if(y<57){if(c.x<155){if(this.from!==null){this.from=null;this.points=[];}else if(selected!==null)this.from=selected;}else this.underground=!this.underground;}
        else if(y>=91&&y<175){const l=state.fieldTelephone?.lines.filter(l=>l.side===side)[Math.floor((y-91)/28)];if(l&&c.x>=330)issue({type:'removeTelephone',lineId:l.id});else if(l&&c.x>=265&&selected!==null)issue({type:'repairTelephone',lineId:l.id,teamId:selected});}
        return false;
      }
      if(this.from===null||c.y>=VIEW_H)return true;
      if(c.button===2){this.from=null;this.points=[];return false;}
      if(c.button!==0)return false;
      const end=pickFriendlyTeamScreen(state,cam,c,side);
      if(end&&end.id!==this.from){const start=state.teams.get(this.from),a=start&&state.soldiers.get(start.leaderId),b=state.soldiers.get(end.leaderId);if(a&&b)issue({type:'connectTelephone',fromTeamId:this.from,toTeamId:end.id,points:[{...a.pos},...this.points,{...b.pos}],underground:this.underground});this.from=null;this.points=[];}
      else this.points.push(screenToWorld(cam,c));
      return false;
    });
    return {...input,clicks,releases:input.releases.filter(c=>!this.contains(c)&&!routing&&this.from===null)};
  }
  drawWires(ctx:CanvasRenderingContext2D,state:BattleState,side:Side,cam:Camera):void {
    ctx.save();ctx.lineWidth=2;
    for(const l of state.fieldTelephone?.lines??[]){if(l.side!==side)continue;for(let i=1;i<l.points.length;i++){const a=worldToScreen(cam,l.points[i-1]),b=worldToScreen(cam,l.points[i]);ctx.strokeStyle=l.cutSegments.includes(i-1)?'#ff6157':l.underground[i-1]?'#7ae2dc':'#e9cb7e';ctx.setLineDash(l.underground[i-1]?[5,4]:[]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}}
    if(this.from!==null){const t=state.teams.get(this.from),s=t&&state.soldiers.get(t.leaderId);ctx.strokeStyle='#fff';ctx.setLineDash([4,4]);ctx.beginPath();[...(s?[s.pos]:[]),...this.points].forEach((p,i)=>{const v=worldToScreen(cam,p);if(i)ctx.lineTo(v.x,v.y);else ctx.moveTo(v.x,v.y);});ctx.stroke();}
    ctx.restore();
  }
  draw(ctx:CanvasRenderingContext2D,state:BattleState,side:Side,selected:number|null):void {
    const lines=state.fieldTelephone?.lines.filter(l=>l.side===side)??[],y=this.y;
    ctx.save();ctx.font='12px Arial';ctx.textBaseline='middle';ctx.textAlign='left';ctx.fillStyle='rgba(13,19,24,.96)';ctx.fillRect(8,y,400,this.expanded?224:27);ctx.strokeStyle='#8a8970';ctx.strokeRect(8.5,y+.5,399,this.expanded?223:26);ctx.fillStyle='#f6e4b6';ctx.fillText(`${this.expanded?'▼':'▶'} FIELD TELEPHONE · ${lines.length} lines · ${Math.floor(state.fieldTelephone?.stockM[side]??0)} m stock`,16,y+14);
    if(this.expanded){ctx.fillStyle='#303b41';ctx.fillRect(16,y+31,135,25);ctx.fillRect(158,y+31,240,25);ctx.fillStyle='#fff0cc';ctx.fillText(this.from!==null?'Cancel route':'Connect selected',22,y+44);ctx.fillText(`Underground: ${this.underground?'ON':'OFF'}`,166,y+44);ctx.fillStyle='#c8d6df';ctx.fillText(this.from!==null?'Click waypoints, then friendly endpoint. Right-click cancels.':`Select command team, then Connect. Selected: ${selected??'none'}`,16,y+74,380);lines.slice(0,3).forEach((l,i)=>{const yy=y+104+i*28;ctx.fillStyle=l.cutSegments.length?'#ff8d83':'#d5dfd4';ctx.fillText(`#${l.id} ${l.fromTeamId} → ${l.toTeamId} · ${l.lengthM.toFixed(0)}m · ${l.cutSegments.length?'CUT':'linked'}`,16,yy,246);ctx.fillStyle='#d4c4a3';ctx.fillText(l.repair?'Repairing':'Repair',273,yy);ctx.fillText('Remove',341,yy);});ctx.fillStyle='#aebcc0';ctx.fillText('Gold: surface · cyan dashed: underground · red: cut',16,y+190);ctx.fillText('Endpoints must remain within 4 m. 1 tile = 2 m.',16,y+209);}
    ctx.restore();
  }
}
