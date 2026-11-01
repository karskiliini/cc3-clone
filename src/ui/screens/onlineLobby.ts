import type { InputState,Screen,Side } from '@/shared/types';
import { MENU_X,MENU_Y } from '@/shared/types';
import { game } from '@/game';
import { RoomClient,type RoomEvent } from '@/net/roomClient';
import type { RoomSettings } from '@/net/relayProtocol';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { TEAM_DEFS } from '@/data/units';
import { ForcePicker } from './forcePicker';
import { MainMenuScreen } from './mainMenu';
import { drawMenuFrame,toMenuInput,BottomStrip } from './common';
import { drawLabel,UI } from '@/ui/chrome';
import { attachOnline } from '@/ui/online';

function defaultSettings():RoomSettings {
  const year=Number(/(194[1-5])/.exec(MAPS[0].id)?.[1]??1941),forces=DEFAULT_FORCES[year]??DEFAULT_FORCES[1941];
  const costs=Object.values(forces).map(ids=>ids.reduce((n,id)=>n+(TEAM_DEFS[id]?.cost??0),0));
  return {mapId:MAPS[0].id,year,durationS:1200,seed:crypto.getRandomValues(new Uint32Array(1))[0],points:Math.min(1000,Math.max(50,...costs)+20)};
}
export class OnlineLobbyScreen implements Screen {
  private client:RoomClient|null=null;
  private unsubscribe:(()=>void)|null=null;
  private panel:HTMLDivElement|null=null;
  private view:'lobby'|'forces'='lobby';
  private handedOff=false;
  private busy=false;
  private message='Create a private room or enter a friend’s six-character code.';
  private picker:ForcePicker|null=null;
  private pickerKey='';
  private strip=new BottomStrip({next:'Ready'});
  private settings=defaultSettings();
  private rectKey='';
  onEnter():void {this.makePanel();this.sync();}
  onExit():void {this.panel?.remove();this.panel=null;this.unsubscribe?.();this.unsubscribe=null;if(!this.handedOff)this.client?.close();}
  private el<T extends HTMLElement>(id:string):T{return this.panel!.querySelector('#'+id) as T;}
  private makePanel():void {
    if(this.panel)return;
    const p=document.createElement('div');p.id='cc3-online-lobby';
    p.style.cssText='position:fixed;z-index:5;width:700px;padding:22px;box-sizing:border-box;background:#211e18ee;border:2px solid #817356;color:#e6d9bd;font:14px Arial;transform-origin:top left;';
    p.innerHTML=`<section id="connect"><label>Relay server <input id="relay-address" aria-label="Relay server" style="width:98%"></label><p style="margin:6px 0 18px;color:#b9aa8e">Use the game’s server, or enter the address supplied by your host.</p><div style="display:flex;gap:12px;align-items:center"><label>My side <select id="host-side" aria-label="My side"><option value="german">German</option><option value="soviet">Soviet</option></select></label><button id="create-room">Create room</button></div><hr style="border-color:#655943;margin:22px 0"><label>Room code <input id="room-code" aria-label="Room code" maxlength="6" size="9" autocomplete="off" style="text-transform:uppercase"></label> <button id="join-room">Join room</button> <button id="rejoin-room">Rejoin saved game</button></section>
<section id="room" hidden><p>Share room code: <input id="share-code" aria-label="Share room code" readonly size="9" style="font-weight:bold;letter-spacing:4px"></p><p id="members"></p><div style="display:grid;grid-template-columns:2fr 1fr;gap:12px"><label>Map <select id="battle-map" aria-label="Battle map" style="width:100%"></select></label><label>Year <select id="battle-year" aria-label="Battle year"></select></label><label>Duration <select id="battle-duration" aria-label="Battle duration"><option value="600">10 minutes</option><option value="900">15 minutes</option><option value="1200">20 minutes</option><option value="1800">30 minutes</option><option value="3600">60 minutes</option></select></label><label>Force points <input id="battle-points" aria-label="Force points" type="number" min="50" max="1000" style="width:80px"></label></div><p><button id="apply-setup">Apply battle settings</button> <button id="choose-forces">Choose my forces</button></p><p style="color:#b9aa8e">Both players choose their own forces, then deploy and press Begin.</p></section>
<p id="online-status" role="status" aria-live="polite" style="min-height:36px;line-height:18px"></p><button id="online-back">Back to main menu</button>`;
    for(const e of p.querySelectorAll<HTMLElement>('input,select,button'))e.style.cssText+=';font:14px Arial;background:#3c382d;color:#f1e5ca;border:1px solid #9a8967;padding:7px;';
    for(const map of MAPS){const o=document.createElement('option');o.value=map.id;o.textContent=map.name;p.querySelector('#battle-map')!.append(o);}
    for(let year=1941;year<=1945;year++){const o=document.createElement('option');o.value=String(year);o.textContent=String(year);p.querySelector('#battle-year')!.append(o);}
    for(const e of p.querySelectorAll<HTMLElement>('input')){e.style.userSelect='text';e.style.setProperty('-webkit-user-select','text');}
    document.body.append(p);this.panel=p;this.rectKey='';
    const saved=RoomClient.saved();this.el<HTMLInputElement>('relay-address').value=saved?.url??((import.meta as any).env?.VITE_RELAY_URL||`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/relay`);
    this.el('create-room').onclick=()=>void this.connect('create');this.el('join-room').onclick=()=>void this.connect('join');this.el('rejoin-room').onclick=()=>void this.connect('rejoin');
    this.el('online-back').onclick=()=>{this.client?.request({op:'leave',mode:'quit'});game.setScreen(new MainMenuScreen());};
    this.el('share-code').onclick=()=>this.el<HTMLInputElement>('share-code').select();
    this.el('apply-setup').onclick=()=>this.applySettings();
    this.el('choose-forces').onclick=()=>this.chooseForces();
    this.position();
  }
  private position():void {
    if(!this.panel)return;const r=document.getElementById('game')!.getBoundingClientRect(),scale=Math.min(r.width/1024,r.height/768),left=r.left+(r.width-1024*scale)/2,top=r.top+(r.height-768*scale)/2,key=[left,top,scale].join();
    if(key===this.rectKey)return;this.rectKey=key;
    this.panel.style.left=`${left+(MENU_X+50)*scale}px`;this.panel.style.top=`${top+(MENU_Y+104)*scale}px`;this.panel.style.transform=`scale(${scale})`;
  }
  private async connect(mode:'create'|'join'|'rejoin'):Promise<void> {
    if(this.busy)return;
    try{
      let url=this.el<HTMLInputElement>('relay-address').value.trim();const saved=RoomClient.saved();
      if(mode==='rejoin'){if(!saved)throw new Error('No saved room in this browser.');url=saved.url;}
      const parsed=new URL(url);if(!['ws:','wss:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Use a ws:// or wss:// relay address.');
      this.busy=true;this.message='Connecting…';this.sync();this.unsubscribe?.();this.client?.close();
      const client=new RoomClient(url);this.client=client;this.unsubscribe=client.onEvent(e=>this.event(e));
      if(mode==='rejoin')await client.reconnect(saved!);
      else{await client.connect();if(mode==='create')client.create(this.el<HTMLSelectElement>('host-side').value as Side,this.settings);else client.join(this.el<HTMLInputElement>('room-code').value);}
    }catch(e){this.message=e instanceof Error?e.message:String(e);}finally{this.busy=false;this.sync();}
  }
  private event(e:RoomEvent):void {
    if(e.kind==='disconnected'){this.message=e.reason;this.sync();return;}
    const f=e.frame;
    if(f.op==='error'){this.message=f.message;this.sync();return;}
    if(f.op==='start'){
      this.handedOff=true;this.panel!.style.display='none';this.unsubscribe?.();this.unsubscribe=null;game.operation=null;game.campaign=null;attachOnline(this.client!,f);return;
    }
    if(f.op==='member'&&f.room.phase!=='lobby'){
      this.handedOff=true;this.panel!.style.display='none';this.unsubscribe?.();this.unsubscribe=null;game.operation=null;game.campaign=null;attachOnline(this.client!);return;
    }
    if(f.op==='member'||f.op==='room'){
      const room=f.room;this.settings={...room.settings};
      const own=room.members[this.client!.side!],peer=room.members[this.client!.side==='german'?'soviet':'german'];
      this.message=own?.ready?(peer?.ready?'Starting deployment…':'Ready. Waiting for the other player’s forces.'):'Choose your forces when the battle settings are agreed.';this.sync();
    }
  }
  private sync():void {
    if(!this.panel||this.handedOff)return;
    const room=this.client?.room,host=room?.host===this.client?.side;
    this.el('connect').hidden=!!room;this.el('room').hidden=!room;this.el('online-status').textContent=this.message;
    for(const id of ['create-room','join-room','rejoin-room'])(this.el(id) as HTMLButtonElement).disabled=this.busy;
    (this.el('rejoin-room') as HTMLButtonElement).disabled=this.busy||!RoomClient.saved();
    if(room){
      this.el<HTMLInputElement>('share-code').value=room.code;
      const peer=room.members[this.client!.side==='german'?'soviet':'german'];
      this.el('members').textContent=`You: ${this.client!.side==='german'?'German':'Soviet'} · Opponent: ${peer?.connected?(peer.ready?'ready':'choosing forces'):'not connected'}`;
      for(const [id,value]of [['battle-map',room.settings.mapId],['battle-year',room.settings.year],['battle-duration',room.settings.durationS],['battle-points',room.settings.points]] as const){const e=this.el<HTMLInputElement>(id);e.value=String(value);e.disabled=!host;}
      (this.el('apply-setup') as HTMLButtonElement).disabled=!host;
    }
    this.panel.style.display=this.view==='forces'?'none':'block';
  }
  private applySettings():void {
    if(!this.client)return;
    const settings={...this.settings,mapId:this.el<HTMLSelectElement>('battle-map').value,year:Number(this.el<HTMLSelectElement>('battle-year').value),durationS:Number(this.el<HTMLSelectElement>('battle-duration').value),points:Number(this.el<HTMLInputElement>('battle-points').value)};
    this.client.request({op:'settings',settings});
  }
  private chooseForces():void {
    const c=this.client,r=c?.room;if(!c?.side||!r)return;
    const own=r.members[c.side]!;if(own.ready)c.request({op:'roster',forces:own.forces,ready:false});
    const key=[c.side,r.settings.year,r.settings.points].join();
    if(!this.picker||key!==this.pickerKey){
      const defaults=DEFAULT_FORCES[r.settings.year]?.[c.side]??[],ids:string[]=[];let spent=0;
      for(const id of own.forces.length?own.forces:defaults){const d=TEAM_DEFS[id];if(d&&d.years[0]<=r.settings.year&&d.years[1]>=r.settings.year&&spent+d.cost<=r.settings.points&&ids.length<15){ids.push(id);spent+=d.cost;}}
      this.picker=new ForcePicker(c.side,r.settings.year,r.settings.points,ids);this.pickerKey=key;
    }
    this.view='forces';this.sync();
  }
  update(_dt:number,input:InputState):void {
    this.position();if(this.handedOff)return;
    if(this.view==='forces'&&this.picker){
      const m=toMenuInput(input);this.picker.update(m);this.strip.nextEnabled=this.picker.rosterIds.length>0&&this.picker.remaining()>=0;
      const action=this.strip.update(m);
      if(action.back){this.view='lobby';this.sync();}
      else if(action.next){this.client!.request({op:'roster',forces:[...this.picker.rosterIds],ready:true});this.view='lobby';this.message='Confirming forces…';this.sync();}
    }
  }
  draw(ctx:CanvasRenderingContext2D):void {
    drawMenuFrame(ctx,'MULTIPLAYER',()=>{
      if(this.view==='forces'&&this.picker){this.picker.draw(ctx);this.strip.draw(ctx);}
      else drawLabel(ctx,'Private battle · One player per side',400,82,UI.label,'#dfd1b6','center');
    });
  }
  cursor(){return 'arrow' as const;}
}
