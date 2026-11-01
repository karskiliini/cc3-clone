import { game } from '@/game';
import type { InputState, Rect } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { OnlineMatch } from '@/net/onlineMatch';
import type { RoomClient } from '@/net/roomClient';
import type { ServerFrame } from '@/net/relayProtocol';
import { DeployScreen } from './screens/deploy';
import { BattleScreen } from './screens/battle';
import { MainMenuScreen } from './screens/mainMenu';
import { drawDarkPanel,drawLabel,drawMetalButton,UI } from './chrome';

export function attachOnline(client:RoomClient,initial?:Extract<ServerFrame,{op:'start'}>):void {
  const show=(b:NonNullable<OnlineMatch['battle']>)=>{
    game.battle=b;game.battleConfig=b.state.config;
    game.setScreen(b.state.phase==='deploy'?new DeployScreen(b):new BattleScreen(b));
  };
  game.online=new OnlineMatch(client,{onBattle:show,onLocal:b=>{game.online=null;show(b);}},undefined);
  if(initial)game.online.start(initial);
}
const BOX:Rect={x:238,y:168,w:548,h:354};
const AI:Rect={x:264,y:346,w:236,h:36},REJOIN:Rect={x:524,y:346,w:236,h:36};
const FORFEIT:Rect={x:264,y:395,w:236,h:36},REPORT:Rect={x:524,y:395,w:236,h:36};
const SMALL_REPORT:Rect={x:872,y:40,w:132,h:26};
const BACK:Rect={x:394,y:451,w:236,h:36};
function overlay():boolean {const n=game.online;return !!n&&n.battle?.state.phase!=='ended'&&(n.blocked||n.session?.status==='resyncing');}
function downloadReport():void {
  if(!game.online)return;
  const blob=new Blob([JSON.stringify(game.online.report(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`cc3-desync-${game.online.client.room?.code??'session'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function handleOnlineInput(input:InputState):boolean {
  if(!overlay()){if(game.online?.reportCount&&input.clicks.some(c=>c.button===0&&pointInRect(c,SMALL_REPORT))){downloadReport();return true;}return false;}
  const n=game.online!;
  for(const click of input.clicks)if(click.button===0){
    if(pointInRect(click,AI)&&n.canContinueLocally)n.continueAgainstAI();
    else if(pointInRect(click,REJOIN)&&!(n.phase==='waiting'&&n.client.connected))void n.reconnect();
    else if(pointInRect(click,FORFEIT))n.forfeit();
    else if(pointInRect(click,REPORT))downloadReport();
    else if(pointInRect(click,BACK)){n.leave();game.online=null;game.setScreen(new MainMenuScreen());}
  }
  return true;
}
export function drawOnlineOverlay(ctx:CanvasRenderingContext2D):void {
  const n=game.online;if(!n)return;
  if(!overlay()){
    if(n.battle?.state.phase==='deploy'){
      const own=n.client.side!,ready=n.battle.isReady(own);
      ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(280,8,464,26);
      drawLabel(ctx,ready?'Ready — waiting for opponent.':`Room ${n.client.room?.code}: deploy your forces, then Begin.`,512,26,UI.note,'#e5d6b7','center');
    }
    else if(n.battle?.state.phase==='paused'){
      const p=n.battle.state.multiplayerPolicy,owner=p?.pauseOwner===n.client.side?'Your':'Opponent’s',remaining=Math.ceil(n.session?.pauseSecondsLeft??60);
      ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(280,8,464,26);drawLabel(ctx,`${owner} pause · ${remaining}s left · ${3-(p?.pausesUsed[n.client.side!]??0)} pauses remaining`,512,26,UI.note,'#e5d6b7','center');
    }else if(n.battle?.state.multiplayerPolicy){
      const votes=n.battle.state.multiplayerPolicy.speedVotes;
      if(votes.german!==votes.soviet){ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(280,8,464,26);drawLabel(ctx,`Speed ${n.battle.state.speed}× · German votes ${votes.german}× / Soviet votes ${votes.soviet}×`,512,26,UI.note,'#e5d6b7','center');}
    }
    if(n.reportCount)drawMetalButton(ctx,SMALL_REPORT,'Desync report',false);
    return;
  }
  ctx.save();ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(0,0,1024,670);drawDarkPanel(ctx,BOX);
  const progress=n.progress;
  drawLabel(ctx,progress!=null?`Resynchronising… ${Math.floor(progress*100)}%`:n.phase==='waiting'?'Connection interrupted':'Online battle stopped',512,211,UI.heading,'#eee0c0','center');
  const text=n.message||'Rebuilding the shared battle from its command history.';
  const words=text.split(' ');let line='',y=246;
  for(const word of words){if((line+' '+word).length>65){drawLabel(ctx,line,512,y,UI.note,'#dfd1b6','center');line='';y+=19;}line+=(line?' ':'')+word;}
  if(line)drawLabel(ctx,line,512,y,UI.note,'#dfd1b6','center');
  if(progress!=null){ctx.fillStyle='#292c25';ctx.fillRect(282,305,460,12);ctx.fillStyle='#bdae7d';ctx.fillRect(282,305,460*progress,12);}
  drawMetalButton(ctx,AI,n.canContinueLocally?'Continue vs AI':'Not ready',false);
  drawMetalButton(ctx,REJOIN,n.phase==='waiting'&&n.client.connected?'Waiting for peer':'Rejoin',false);drawMetalButton(ctx,FORFEIT,'Forfeit',false);drawMetalButton(ctx,REPORT,'Download report',false);drawMetalButton(ctx,BACK,'Main menu',false);ctx.restore();
}
