import {afterEach,describe,expect,it,vi} from 'vitest';
import {BattleScreen} from '@/ui/screens/battle';
import {BattleSetupScreen} from '@/ui/screens/battleSetup';
import {initializeAirSupport} from '@/sim/airSupport';
import {game} from '@/game';
import {screenToWorld} from '@/engine/camera';
import {makeState,mkTeam,soldier} from './vehicleDamageHelpers';
import type {InputState} from '@/shared/types';

const storageBefore=(globalThis as any).localStorage;
afterEach(()=>{if(storageBefore===undefined)delete(globalThis as any).localStorage;else(globalThis as any).localStorage=storageBefore;});
function input(keys:string[]=[],clicks:InputState['clicks']=[]):InputState{return{mouse:{x:400,y:300},buttons:{left:false,right:false,middle:false},clicks,releases:[],keysDown:new Set(),keysPressed:new Set(keys),keysReleased:new Set(),wheel:0,wheelDX:0,wheelDY:0,pointerInside:true};}
function fixture(){
  const state=makeState(1944),man=soldier(1,1,'german',{x:40,y:40},'kar98k');state.soldiers.set(1,man);
  const team=mkTeam(1,'mortar',[1],'german',man.pos);team.crewWeapon={weaponId:'mortar81',destroyed:false} as any;team.illuminationAmmo=4;state.teams.set(1,team);
  state.config.airSupport={german:{missions:1,availableAtS:0}};initializeAirSupport(state);
  const screen=Object.create(BattleScreen.prototype) as any;
  Object.assign(screen,{battle:{state,playerSide:()=> 'german'},selectedTeamId:1,selectedTeamIds:[1],pendingSupport:null,pendingOrder:'fire',pendingWaypoints:[],airRole:'auto',replay:null,leftDrag:{active:false},rightDrag:{active:false},commandMenu:{close:vi.fn()},command:vi.fn(),notice:vi.fn(),overHud:(p:{y:number})=>p.y>=670});
  return{screen,state};
}
describe('support map input',()=>{
  it('arms AIR with U and dispatches exactly one canonical area command without an HE order',()=>{
    const {screen}=fixture();const armed=screen.updateSupportInput(input(['u']));expect(armed.keysPressed.has('u')).toBe(false);expect(screen.pendingOrder).toBeNull();
    const point={x:400,y:300,button:0 as const},result=screen.updateSupportInput(input([], [point]));
    expect(result.clicks).toEqual([]);expect(screen.command).toHaveBeenCalledTimes(1);expect(screen.command).toHaveBeenCalledWith({type:'airSupport',target:screenToWorld(game.cam,point),role:'auto',requesterId:1});expect(screen.pendingSupport).toBeNull();
  });
  it('Shift+B targets artillery while plain B remains Smoke',()=>{
    const {screen,state}=fixture();screen.artillerySize='small';state.artillery={batteries:[{id:1,side:'german',name:'Battery',weaponId:'mortar81',guns:2,ammo:20,readyAt:100}],missions:[],shells:[]};
    expect(screen.updateSupportInput(input(['b'])).keysPressed.has('b')).toBe(true);
    expect(screen.pendingSupport).toBeNull();
    const event=input(['b']);event.keysDown.add('shift');expect(screen.updateSupportInput(event).keysPressed.has('b')).toBe(false);
    expect(screen.pendingSupport).toEqual({kind:'artillery'});
    screen.updateSupportInput(input([], [{x:400,y:300,button:0}]));
    expect(screen.command).toHaveBeenCalledWith({type:'artillery',target:screenToWorld(game.cam,{x:400,y:300}),size:'small'});
    expect(screen.command).toHaveBeenCalledTimes(1);
  });
  it('cancels only the viewing side active fire mission and consumes the HUD click',()=>{
    const {screen,state}=fixture();state.artillery={batteries:[],missions:[{id:99,side:'soviet',phase:'preparing'},{id:7,side:'german',phase:'preparing'}],shells:[]} as any;
    expect(screen.updateSupportInput(input([], [{x:960,y:50,button:0}])).clicks).toEqual([]);
    expect(screen.command).toHaveBeenCalledTimes(1);expect(screen.command).toHaveBeenCalledWith({type:'cancelArtillery',missionId:7});
  });
  it('locates radio targets without revealing fog and marks only fresh uncancelled enemy evidence',()=>{
    const {screen,state}=fixture(),before={...game.cam};screen.showRadio=true;state.time=100;
    state.radioTraffic={nextId:7,messages:[
      {id:0,at:1,senderSide:'soviet',payload:{kind:'fireRequest',missionId:1,target:{x:10,y:10}}},
      {id:1,at:80,senderSide:'soviet',payload:{kind:'fireRequest',missionId:2,target:{x:70,y:70}}},
      {id:2,at:81,senderSide:'soviet',payload:{kind:'fireCorrection',missionId:2,target:{x:80,y:80}}},
      {id:3,at:82,senderSide:'soviet',payload:{kind:'fireCancellation',missionId:2,target:{x:80,y:80}}},
      {id:4,at:90,senderSide:'german',payload:{kind:'fireRequest',missionId:3,target:{x:90,y:90}}},
      {id:5,at:92,senderSide:'soviet',payload:{kind:'fireRequest',missionId:4,target:{x:95,y:95}}},
      {id:6,at:95,senderSide:'soviet',payload:{kind:'fireCorrection',missionId:4,target:{x:100,y:120}}},
    ]};
    try{
      expect(screen.interceptedFireMarkers()).toEqual([{at:95,target:{x:100,y:120},correction:true}]);
      expect(screen.updateSupportInput(input([], [{x:700,y:100,button:0}])).clicks).toEqual([]);
      expect(screenToWorld(game.cam,{x:512,y:335})).toEqual({x:100,y:120});
      expect(state.spotted.german.size).toBe(0);expect(screen.command).not.toHaveBeenCalled();
    }finally{Object.assign(game.cam,before);}
  });
  it('signals consume their clicks and require an operational HQ radio',()=>{
    const {screen,state}=fixture();
    screen.updateSupportInput(input([], [{x:690,y:16,button:0}]));
    expect(screen.command).toHaveBeenCalledWith({type:'signal',signal:1});
    screen.command.mockClear();state.soldiers.get(1)!.health='dead';
    expect(screen.updateSupportInput(input([], [{x:770,y:16,button:0}])).clicks).toEqual([]);
    expect(screen.command).not.toHaveBeenCalled();
    expect(screen.notice).toHaveBeenCalledWith('Signal requires an operational HQ radio.','warn');
  });
  it('cycles the visible role and consumes Escape/right-click cancellation',()=>{
    const {screen}=fixture();screen.updateSupportInput(input([], [{x:160,y:16,button:0}]));expect(screen.airRole).toBe('bombing');
    screen.updateSupportInput(input(['u']));expect(screen.updateSupportInput(input(['escape'])).keysPressed.has('escape')).toBe(false);expect(screen.pendingSupport).toBeNull();
    screen.updateSupportInput(input(['u']));expect(screen.updateSupportInput(input([], [{x:500,y:300,button:2}])).clicks).toEqual([]);expect(screen.command).not.toHaveBeenCalled();
  });
  it('L for a selected mortar submits illumination and removes the ordinary L overlay shortcut',()=>{
    const {screen}=fixture();expect(screen.updateSupportInput(input(['l'])).keysPressed.has('l')).toBe(false);
    screen.updateSupportInput(input([], [{x:400,y:300,button:0}]));expect(screen.command).toHaveBeenCalledTimes(1);expect(screen.command).toHaveBeenCalledWith({type:'illuminate',teamId:1,target:screenToWorld(game.cam,{x:400,y:300})});
  });
  it('explains unavailable air and exhausted illumination without issuing commands',()=>{
    const {screen,state}=fixture();state.config.timeOfDay='night';screen.updateSupportInput(input(['u']));expect(screen.notice).toHaveBeenCalledWith('Unavailable at night','warn');
    expect(screen.pendingOrder).toBeNull();
    state.teams.get(1)!.illuminationAmmo=0;screen.updateSupportInput(input(['l']));expect(screen.pendingSupport).toBeNull();expect(screen.command).not.toHaveBeenCalled();
  });
});
describe('custom conditions presets',()=>{
  it('persists conditions and an explicit date that follows the selected year',()=>{
    const saved=new Map<string,string>();(globalThis as any).localStorage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v)};
    const first=new BattleSetupScreen() as any;Object.assign(first,{timeOfDay:'night',weather:'rain',year:1943,scenarioMonth:'01'});first.saveSetup();
    const restored=new BattleSetupScreen() as any;restored.loadSetup();expect([restored.timeOfDay,restored.weather,restored.scenarioMonth]).toEqual(['night','rain','01']);
    restored.year=1944;restored.saveSetup();expect(JSON.parse(saved.get('cc3.custom')!).scenarioDate).toBe('1944-01-15');
  });
  it('loads older presets with clear daylight and the July representative date',()=>{
    (globalThis as any).localStorage={getItem:()=>JSON.stringify({year:1942,durationMin:20})};const restored=new BattleSetupScreen() as any;restored.loadSetup();
    expect([restored.timeOfDay,restored.weather,restored.scenarioMonth]).toEqual(['day','clear','07']);
  });
});
