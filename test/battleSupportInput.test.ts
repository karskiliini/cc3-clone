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
