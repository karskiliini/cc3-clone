/** Both sides' ground observation memory is advanced by the sim, never the camera. */
import type {BattleState,Side,Vec2} from '@/shared/types';
import {SIDES,TILE_M} from '@/shared/types';
import {collectSpotters,observerVisibility} from './spotting';
import {FOG_CELL_TILES,prepareIllumination} from './illumination';
import {humanCapability} from './humanCondition';
import {getHeightField,heightAt,groundAt} from './heightField';
import * as dm from '@/shared/dmath';

export function updateNightGroundMemory(state:BattleState):void{
  if(state.config.timeOfDay!=='night')return;
  const width=Math.ceil(state.map.width/FOG_CELL_TILES),height=Math.ceil(state.map.height/FOG_CELL_TILES);
  const memory=state.nightGroundMemory??={};
  const field=getHeightField(state.map);
  const illumination=prepareIllumination(state);
  for(const side of SIDES){
    const seen=memory[side]??={},current=new Set<number>();
    const remember=(p:Vec2)=>{const x=Math.floor(p.x/FOG_CELL_TILES),y=Math.floor(p.y/FOG_CELL_TILES);if(x>=0&&y>=0&&x<width&&y<height){const i=y*width+x;seen[i]=state.time;current.add(i);}};
    for(const eye of collectSpotters(state,side)){
      if(eye.soldier&&humanCapability(eye.soldier,state.time).sensing<=.05)continue;
      // A person's dark surroundings and nearby illuminated areas are candidates;
      // every candidate still requires that person's own normal LOS and night range.
      const areas=[{pos:eye.pos,radius:32/TILE_M},...(state.flares??[]).map(f=>({pos:{x:f.origin.x/TILE_M,y:f.origin.y/TILE_M},radius:f.radiusM/TILE_M}))];
      for(const area of areas){
        if(dm.hypot(area.pos.x-eye.pos.x,area.pos.y-eye.pos.y)-area.radius>150)continue;
        for(let y=Math.max(0,Math.floor((area.pos.y-area.radius)/FOG_CELL_TILES));y<=Math.min(height-1,Math.floor((area.pos.y+area.radius)/FOG_CELL_TILES));y++){
          for(let x=Math.max(0,Math.floor((area.pos.x-area.radius)/FOG_CELL_TILES));x<=Math.min(width-1,Math.floor((area.pos.x+area.radius)/FOG_CELL_TILES));x++){
            const i=y*width+x;if(current.has(i))continue;
            const p={x:Math.min(state.map.width-.1,(x+.5)*FOG_CELL_TILES),y:Math.min(state.map.height-.1,(y+.5)*FOG_CELL_TILES)};
            const surface=heightAt(field,p.x,p.y)-groundAt(field,p.x,p.y)+.3;
            if(observerVisibility(state,eye,p,300,undefined,surface,undefined,illumination)>.02)remember(p);
          }
        }
      }
    }
    for(const s of state.soldiers.values())if(s.side===side||state.spotted[side].has(s.id))remember(s.pos);
    for(const v of state.vehicles.values())if(v.side===side||state.spottedVehicles[side].has(v.id))remember(v.pos);
  }
}
