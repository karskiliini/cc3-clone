import { makeState } from '../test/kitHelpers';
import { addTank } from '../test/vehicleDamageHelpers';
import type { Camera, GameSettings, Vehicle } from '@/shared/types';
import { worsen } from '@/sim/vehicleDamage';
import { grenadeFragments, markVehicleStrike } from '@/sim/impactMarks';
import { WEAPONS } from '@/data/weapons';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { requestBattleAtlases } from '@/render/spriteAtlas';
import { requestFxAtlases } from '@/render/fxSprites';
const $ = (id: string) => document.getElementById(id)!;
const ctx = ($('scene') as HTMLCanvasElement).getContext('2d')!;
const camera: Camera = { x:3,y:9,zoom:1.7 };
const settings: GameSettings = {unitLabels:false,losLines:false,volume:0,speed:1};
let state = makeState(), terrain: TerrainRenderer, playing=false, burst=false, turret: Vehicle;
function reset() {
  state=makeState(); burst=false; state.map.tiles.fill('grass');
  for (const [n,x] of [9,17,25].entries()) {
    const {v}=addTank(state,'pz4gh',{x,y:13},0.45);
    if(n!==1)worsen(v,'trackL','destroyed');if(n!==0)worsen(v,'trackR','destroyed');
    for(let i=0;i<14;i++) markVehicleStrike(v,{x:x-3,y:10},i%3===0,i%5===0,i%2?0.07:0.18);
    turret = v;
  }
  const enemy=addTank(state,'t34_76',{x:18,y:24},0.3);state.spottedVehicles.german.add(enemy.v.id);
  for(let y=20;y<=27;y++){let i=y*state.map.width+11;state.map.tiles[i]='buildingWood';state.map.windows[i]=1;state.map.buildingId[i]=1;}
  for(let x=12;x<19;x++)state.map.tiles[27*state.map.width+x]='scatteredtrees';
  terrain=new TerrainRenderer(state.map);
}
function seek(t:number){
  if(t<state.time)reset();
  if(t>=0.5&&!burst){state.time=0.5;grenadeFragments(state,{x:15,y:24},WEAPONS.grenade);burst=true;}
  state.time=t;turret.turretFacing=t*0.6;
  ( $('time') as HTMLInputElement).value=t.toFixed(2);$('status').textContent=t.toFixed(2)+' s';
}
function draw(){terrain.draw(ctx,camera);terrain.drawOverlays(ctx,camera,state);drawUnits(ctx,camera,state,'german',[],settings);drawEffects(ctx,camera,state);}
$('reset').onclick=()=>{playing=false;seek(0);};$('play').onclick=()=>{if(state.time>=3)seek(0);playing=!playing;};$('time').oninput=()=>{playing=false;seek(Number(($('time') as HTMLInputElement).value));};
reset();seek(0);
await Promise.all([requestBattleAtlases(['german','soviet'],'summer',undefined,['pz4gh','t34_76']),requestFxAtlases()]);
let last=performance.now();function frame(now:number){if(playing){seek(Math.min(3,state.time+Math.min(0.1,(now-last)/1000)));if(state.time>=3)playing=false;}last=now;draw();requestAnimationFrame(frame);}requestAnimationFrame(frame);
