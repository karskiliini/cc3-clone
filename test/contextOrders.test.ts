import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputState, Vec2 } from '@/shared/types';
import { Battle } from '@/sim/battle';
import { BattleScreen } from '@/ui/screens/battle';
import { game } from '@/game';
import { wrapAngle } from '@/shared/math';
import { stepVehicles } from '@/sim/vehicle';
import { Rng } from '@/shared/rng';
import { makeState, addTank } from './vehicleDamageHelpers';

const settings = { ...game.settings }, camera = { ...game.cam };
let now = 0;
beforeEach(() => { now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); });
afterEach(() => { game.settings = { ...settings }; game.cam = { ...camera }; vi.restoreAllMocks(); });
function input(mouse: Vec2, extra: Partial<InputState> = {}): InputState {
  return { mouse, buttons: {left:false,right:false,middle:false}, clicks:[], releases:[], keysPressed:new Set(), keysReleased:new Set(), keysDown:new Set(), pointerInside:true, wheel:0,wheelDX:0,wheelDY:0, ...extra };
}
function setup() {
  game.settings.showUnitVision = false; game.settings.showDepthMap = false;
  game.cam = {x:0,y:0,zoom:1};
  const battle = new Battle({mapId:'border_1941',playerSide:'german',year:1941,seed:1,durationS:600,difficulty:'normal',
    forces:{german:['ger_rifle_41','ger_rifle_41'],soviet:['sov_rifle_41']}});
  const screen = new BattleScreen(battle), teams = battle.selectableTeams('german'), enemy = battle.selectableTeams('soviet')[0];
  for (const [i,t] of [...teams,enemy].entries()) {
    t.pos = {x:8+i*5,y:10};
    for(const id of t.soldierIds) battle.state.soldiers.get(id)!.pos={...t.pos};
  }
  const frame = (mouse:Vec2, extra:Partial<InputState>={}) => {screen.update(0,input(mouse,extra));battle.step(0);};
  const click = (p:Vec2) => frame(p,{clicks:[{...p,button:2}],releases:[{...p,button:2}]});
  frame({x:400,y:300},{keysDown:new Set(['control']),keysPressed:new Set(['a'])});
  return {battle,screen,teams,enemy,frame,click};
}
const ground = {x:500,y:300};

describe('contextual right-click orders', () => {
  it('orders the whole selection to Move while retaining formation offsets', () => {
    const {teams,click,screen}=setup();click(ground);
    expect(teams[0].order).toMatchObject({type:'move',target:{x:25,y:15}});
    expect(teams[1].order).toMatchObject({type:'move',target:{x:30,y:15}});
    expect(screen.selectionCount).toBe(2);expect(screen.cursor()).not.toBe('crosshair');
  });
  it('fires every selected team at the same spotted enemy rather than moving toward it', () => {
    const {battle,teams,enemy,click}=setup();
    for(const id of enemy.soldierIds)battle.state.spotted.german.add(id);
    click({x:enemy.pos.x*20,y:enemy.pos.y*20});
    for(const t of teams)expect(t.order).toMatchObject({type:'fire',targetTeamId:enemy.id,target:enemy.pos});
  });
  it('prioritizes a spotted enemy inside a broad friendly formation circle', () => {
    const {battle,teams,enemy,click}=setup();
    for(const [i,id] of teams[0].soldierIds.entries())battle.state.soldiers.get(id)!.pos={x:i%2?7:13,y:10};
    enemy.pos={x:10,y:10};
    for(const id of enemy.soldierIds){battle.state.soldiers.get(id)!.pos={...enemy.pos};battle.state.spotted.german.add(id);}
    click({x:200,y:200});expect(teams[0].order).toMatchObject({type:'fire',targetTeamId:enemy.id});
  });
  it('targets spotted vehicle hulls but does not attack wrecks or hidden mounted crews', () => {
    const {battle,teams,click}=setup();const {v,team}=addTank(battle.state,'t34_76',{x:20,y:15},0,60,'soviet');
    battle.state.spottedVehicles.german.add(v.id);click({x:400,y:300});
    expect(teams[0].order).toMatchObject({type:'fire',targetTeamId:team.id,targetVehicleId:v.id});
    v.state='knockedOut';click({x:400,y:300});expect(teams[0].order?.type).toBe('move');
    v.state='ok';battle.state.spottedVehicles.german.clear();
    for(const id of team.soldierIds)battle.state.spotted.german.add(id);
    click({x:400,y:300});expect(teams[0].order?.type).toBe('move');
  });
  it('does not reveal a hidden enemy or aim at its unspotted members', () => {
    const {teams,enemy,click}=setup();click({x:enemy.pos.x*20,y:enemy.pos.y*20});
    expect(teams[0].order?.type).toBe('move');expect(teams[0].order?.targetTeamId).toBeUndefined();
  });
  it('keeps the selected group when opening a friendly unit menu', () => {
    const {teams,click,screen}=setup();const orders=teams.map(t=>t.order);click({x:160,y:200});
    expect(screen.selectionCount).toBe(2);expect(teams.map(t=>t.order)).toEqual(orders);
    expect((screen as unknown as {commandMenu:{isOpen:boolean}}).commandMenu.isOpen).toBe(true);
  });
  it('right-click cancels a pending order and never turns that same gesture into Move', () => {
    const {teams,frame,click}=setup(), original=teams[0].order;
    frame(ground,{keysPressed:new Set(['v'])});click(ground);expect(teams[0].order).toBe(original);
    click(ground);expect(teams[0].order?.type).toBe('move');
  });
  it('Escape cancels a held right-click before its release can issue an order', () => {
    const {teams,frame}=setup();const original=teams[0].order;
    frame(ground,{clicks:[{...ground,button:2}],buttons:{left:false,right:true,middle:false}});
    frame(ground,{keysPressed:new Set(['escape']),releases:[{...ground,button:2}]});
    expect(teams[0].order).toBe(original);
  });
  it('retains the classic press-drag-release menu gesture for explicit orders', () => {
    const {teams,frame,screen}=setup(), original=teams[0].order;
    frame({x:160,y:200},{clicks:[{x:160,y:200,button:2}],buttons:{left:false,right:true,middle:false}});
    frame({x:180,y:228},{releases:[{x:180,y:228,button:2}]});
    expect(teams[0].order).toBe(original);expect(screen.cursor()).toBe('crosshair');
    frame({x:500,y:300},{clicks:[{x:500,y:300,button:0}],releases:[{x:500,y:300,button:0}]});
    expect(teams[0].order?.type).toBe('move');
  });
  it('a small click wobble neither pans the camera nor moves the intended point', () => {
    const {teams,frame}=setup();const before={...game.cam};
    frame(ground,{clicks:[{...ground,button:2}],buttons:{left:false,right:true,middle:false}});
    frame({x:502,y:301},{buttons:{left:false,right:true,middle:false}});
    frame({x:502,y:301},{releases:[{x:502,y:301,button:2}]});
    expect(game.cam).toEqual(before);expect(teams[0].order?.target).toEqual({x:25,y:15});
  });
  it('a complete batched right-drag pans without issuing an order', () => {
    const {teams,frame}=setup();game.cam={x:10,y:10,zoom:1};const original=teams[0].order;
    frame({x:460,y:280},{clicks:[{...ground,button:2}],releases:[{x:460,y:280,button:2}]});
    expect(game.cam).toMatchObject({x:12,y:11});expect(teams[0].order).toBe(original);
  });
  it('includes the final pan delta and does not become a click after returning to the start', () => {
    const {teams,frame}=setup();game.cam={x:10,y:10,zoom:1};const original=teams[0].order;
    frame(ground,{clicks:[{...ground,button:2}],buttons:{left:false,right:true,middle:false}});
    frame({x:480,y:300},{buttons:{left:false,right:true,middle:false}});
    frame(ground,{releases:[{...ground,button:2}]});
    expect(game.cam).toMatchObject({x:10,y:10});expect(teams[0].order).toBe(original);
  });
  it('uses real elapsed time for long holds even while battle time is paused', () => {
    const {teams,battle,frame}=setup();battle.state.phase='paused';const original=teams[0].order;
    frame(ground,{clicks:[{...ground,button:2}],buttons:{left:false,right:true,middle:false}});now=500;
    frame(ground,{releases:[{...ground,button:2}]});expect(teams[0].order).toBe(original);
  });
  it('supports contextual commands while paused, without advancing the simulation', () => {
    const {battle,teams,click}=setup();battle.state.phase='paused';click(ground);
    expect(teams[0].order?.type).toBe('move');expect(battle.state.time).toBe(0);expect(battle.state.phase).toBe('paused');
  });
  it('ignores HUD, off-map releases and clicks without a selection', () => {
    const {teams,frame,click}=setup();const original=teams[0].order;click({x:500,y:720});
    frame(ground,{clicks:[{...ground,button:2}]});frame({x:-1,y:300},{releases:[{x:-1,y:300,button:2}]});
    frame({x:500,y:500},{clicks:[{x:500,y:500,button:0}],releases:[{x:500,y:500,button:0}]});click(ground);
    expect(teams[0].order).toBe(original);
  });
  it('a contextual rear destination uses the existing physical reverse drive', () => {
    const {battle,screen,frame,click}=setup();
    // Use a clear fixture map, retaining the real BattleScreen command queue and order path.
    const state=makeState();Object.assign(battle.state,state);battle.state.config.playerSide='german';battle.state.phase='paused';
    const {v,team}=addTank(battle.state,'pz4gh',{x:20.5,y:15.5},0,60,'german');
    game.cam={x:0,y:0,zoom:1};frame({x:400,y:300},{keysDown:new Set(['control']),keysPressed:new Set(['a'])});
    click({x:410,y:550});expect(team.order?.type).toBe('move');
    let minSpeed=0,maxTurn=0;const rng=new Rng(1);
    for(let i=0;i<300;i++){battle.state.time+=0.1;stepVehicles(battle.state,rng,0.1);minSpeed=Math.min(minSpeed,v.speed);maxTurn=Math.max(maxTurn,Math.abs(wrapAngle(v.hullFacing)));}
    expect(minSpeed).toBeLessThan(0);expect(maxTurn).toBeLessThan(Math.PI/4);expect(v.pos.y).toBeGreaterThan(24);
    expect(screen.selectionCount).toBe(1);
  });
});
