import {describe,expect,it} from 'vitest';
import {validCommand} from '@/net/commandValidation';
import {validSettings,type RoomSettings,type ServerFrame} from '@/net/relayProtocol';
import {RoomClient} from '@/net/roomClient';
import {crc32} from '@/net/integrity';
import {createRelayServer} from '../server/relay';

const settings:RoomSettings={mapId:'border_1941',year:1944,durationS:600,seed:7,points:200,timeOfDay:'night',weather:'overcast',scenarioDate:'1944-02-29'};
const point={x:20.5,y:12.5};
describe('air and illumination protocol validation',()=>{
  it('accepts all explicit air roles and area illumination as serializable command bodies',()=>{
    for(const role of ['auto','bombing','armour']){
      expect(validCommand({type:'airSupport',target:point,role},64,48)).toBe(true);
      expect(validCommand({type:'airSupport',target:point,role,requesterId:3},64,48)).toBe(true);
    }
    expect(validCommand({type:'illuminate',teamId:1,target:point},64,48)).toBe(true);
    expect(validCommand({type:'airSupport',target:{x:0,y:47.99},role:'auto'},64,48)).toBe(true);
  });
  it('rejects missing/unknown air roles and unsafe actor identities',()=>{
    for(const role of [undefined,'antiTank','AUTO',false,[],{}])expect(validCommand({type:'airSupport',target:point,role},64,48)).toBe(false);
    for(const id of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1']){
      expect(validCommand({type:'airSupport',target:point,role:'auto',requesterId:id},64,48)).toBe(false);
      expect(validCommand({type:'illuminate',target:point,teamId:id},64,48)).toBe(false);
    }
    expect(validCommand({type:'illuminate',target:point},64,48)).toBe(false);
  });
  it('rejects absent, malformed, nonfinite and off-map support coordinates',()=>{
    for(const target of [undefined,null,[],{}, {x:'1',y:1},{x:NaN,y:1},{x:Infinity,y:1},{x:1,y:-Infinity},{x:-.01,y:1},{x:64,y:1},{x:1,y:48}]){
      expect(validCommand({type:'airSupport',target,role:'bombing'},64,48)).toBe(false);
      expect(validCommand({type:'illuminate',target,teamId:1},64,48)).toBe(false);
    }
  });
  it('accepts legacy settings, valid conditions and real dates matching the selected year',()=>{
    expect(validSettings({mapId:'border_1941',year:1941,durationS:600,seed:7,points:200})).toBe(true);
    for(const timeOfDay of ['day','night'])for(const weather of ['clear','overcast','rain'])expect(validSettings({...settings,timeOfDay,weather})).toBe(true);
    expect(validSettings({...settings,year:1943,scenarioDate:'1943-07-05'})).toBe(true);
  });
  it('rejects unsupported conditions and invalid calendar dates instead of silently normalizing them',()=>{
    for(const timeOfDay of ['dusk','NIGHT',0,{}])expect(validSettings({...settings,timeOfDay})).toBe(false);
    for(const weather of ['snow','CLEAR',true,[]])expect(validSettings({...settings,weather})).toBe(false);
    for(const scenarioDate of ['1943-02-29','1944-02-30','1944-04-31','1944-00-15','1944-13-15','1944-2-29','1944-02-29T00:00:00Z','1943-07-05',4,{}])expect(validSettings({...settings,scenarioDate})).toBe(false);
  });
});

async function until(fn:()=>boolean):Promise<void>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('Timed out waiting for support protocol relay');await new Promise(resolve=>setTimeout(resolve,5));}}
it('real relay preserves authored conditions for both peers, rejects bad support bundles and retains valid commands',async()=>{
  const relay=await createRelayServer({port:0}),url=`ws://127.0.0.1:${relay.port}/relay`,a=new RoomClient(url),b=new RoomClient(url),af:ServerFrame[]=[],bf:ServerFrame[]=[];
  a.onEvent(e=>{if(e.kind==='frame')af.push(e.frame);});b.onEvent(e=>{if(e.kind==='frame')bf.push(e.frame);});
  try{
    await Promise.all([a.connect(),b.connect()]);a.create('german',settings);await until(()=>!!a.room);b.join(a.room!.code);await until(()=>!!b.room);
    a.request({op:'settings',settings:{...settings,scenarioDate:'1944-02-30'}});await until(()=>af.some(f=>f.op==='error'&&f.code==='BAD_SETTINGS'));
    expect(a.room!.settings).toEqual(settings);expect(b.room!.settings).toEqual(settings);
    const authored={...settings,weather:'rain' as const};a.request({op:'settings',settings:authored});await until(()=>a.room?.settings.weather==='rain'&&b.room?.settings.weather==='rain');
    a.request({op:'roster',forces:['ger_rifle_43'],ready:true});b.request({op:'roster',forces:['sov_rifle_43'],ready:true});
    await until(()=>af.some(f=>f.op==='start')&&bf.some(f=>f.op==='start'));
    const startA=af.find((f):f is Extract<ServerFrame,{op:'start'}>=>f.op==='start')!,startB=bf.find((f):f is Extract<ServerFrame,{op:'start'}>=>f.op==='start')!;
    expect(startA.config).toMatchObject({year:1944,timeOfDay:'night',weather:'rain',scenarioDate:'1944-02-29'});expect(startB.config).toEqual(startA.config);
    const send=(seq:number,commands:unknown[])=>{const body=JSON.stringify({kind:'bundle',side:'german',turn:3,commands,ack:2});a.send({k:'m',seq,crc:crc32(body),body});};
    send(0,[{type:'airSupport',target:point,role:'unknown'}]);await until(()=>af.some(f=>f.op==='error'&&f.code==='BAD_COMMAND'));
    const room=relay.rooms.values().next().value!;expect(room.sealedTo.german).toBe(2);expect(room.history.german.has(3)).toBe(false);
    const commands=[{type:'airSupport',target:point,role:'auto',requesterId:3},{type:'illuminate',target:point,teamId:1}];
    send(1,commands);await until(()=>room.sealedTo.german===3);expect(room.history.german.get(3)).toEqual(commands);
  }finally{a.close();b.close();await relay.close();}
});
