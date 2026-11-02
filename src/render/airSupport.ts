/** Read-only aircraft and air-delivered ordnance. Their flight, releases and
 * impacts are simulation state, not timed renderer effects. The silhouettes are
 * deliberately simple recognition art, not dimensionally verified airframe CAD. */
import type { AirMission, BattleState, Camera, Side } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { airOrdnancePosition } from '@/sim/airSupport';
import { groundAt, heightAt } from '@/sim/heightField';
import { projectNightPoint } from './nightLighting';

const aircraftPath = new Map<string, Path2D>();
function silhouette(id: string): Path2D {
  let path = aircraftPath.get(id); if (path) return path;
  path = new Path2D();
  // Nose toward negative local Y. The Stuka's narrow root and stepped trailing
  // edge distinguish it from the IL-2's broad, swept armoured wing centre.
  const ju = id.startsWith('ju87');
  const points = ju ? [
    [-.38,-5.35],[.38,-5.35],[.66,-3.3],[.64,-1.8],[2.1,-1.9],[6.85,-1.05],
    [6.65,.75],[2.2,.85],[1.6,1.35],[.49,.5],[.3,3.55],[2.18,3.9],[2.05,4.7],
    [.25,4.55],[.16,5.35],[-.16,5.35],[-.25,4.55],[-2.05,4.7],[-2.18,3.9],
    [-.3,3.55],[-.49,.5],[-1.6,1.35],[-2.2,.85],[-6.65,.75],[-6.85,-1.05],
    [-2.1,-1.9],[-.64,-1.8],[-.66,-3.3],
  ] : [
    [-.38,-5.6],[.38,-5.6],[.75,-3.35],[.85,-1.9],[2.3,-1.7],[7.15,-.45],
    [7.05,1.45],[2,1.05],[.67,.85],[.36,3.55],[2.42,4.05],[2.15,4.85],
    [.24,4.5],[.15,5.4],[-.15,5.4],[-.24,4.5],[-2.15,4.85],[-2.42,4.05],
    [-.36,3.55],[-.67,.85],[-2,1.05],[-7.05,1.45],[-7.15,-.45],[-2.3,-1.7],
    [-.85,-1.9],[-.75,-3.35],
  ];
  points.forEach(([x,y], i) => i ? path!.lineTo(x,y) : path!.moveTo(x,y)); path.closePath();
  aircraftPath.set(id, path); return path;
}

function marking(ctx: CanvasRenderingContext2D, side: Side, x: number, y: number): void {
  ctx.save(); ctx.translate(x, y);
  if (side === 'german') {
    ctx.strokeStyle = '#e5e3d2'; ctx.lineWidth = .58; ctx.beginPath(); ctx.moveTo(-.62,0); ctx.lineTo(.62,0); ctx.moveTo(0,-.62); ctx.lineTo(0,.62); ctx.stroke();
    ctx.strokeStyle = '#242c2b'; ctx.lineWidth = .28; ctx.stroke();
  } else {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? .28 : .64; i ? ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r) : ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r); }
    ctx.closePath(); ctx.fillStyle = '#9b3028'; ctx.fill(); ctx.strokeStyle = '#ceb991'; ctx.lineWidth = .065; ctx.stroke();
  }
  ctx.restore();
}

function aircraft(ctx: CanvasRenderingContext2D, m: AirMission, time: number): void {
  const ju = m.aircraftId.startsWith('ju87'), shape = silhouette(m.aircraftId);
  ctx.fillStyle = ju ? '#525b43' : '#65714b'; ctx.fill(shape);
  ctx.strokeStyle = '#202a29'; ctx.lineWidth = .1; ctx.stroke(shape);
  ctx.save(); ctx.clip(shape);
  ctx.fillStyle = ju ? '#35493c' : '#414936';
  for (const flip of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(flip * .6,-3.7); ctx.lineTo(flip * 2.3,-1.2); ctx.lineTo(flip * 6.9,.6); ctx.lineTo(flip * 4.4,1.15); ctx.lineTo(flip * 1.3,-.4); ctx.lineTo(flip * .4,3); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = '#a2a183'; ctx.globalAlpha = .45; ctx.lineWidth = .065;
  ctx.beginPath(); ctx.moveTo(-6.7,-.85); ctx.lineTo(-2,-1.6); ctx.lineTo(-.65,-1.5); ctx.moveTo(.65,-1.5); ctx.lineTo(2,-1.6); ctx.lineTo(6.7,-.85); ctx.moveTo(-.27,-4.8); ctx.lineTo(-.5,-2.4); ctx.stroke();
  ctx.globalAlpha = 1; ctx.strokeStyle = '#28372e'; ctx.lineWidth = .055;
  for (const side of [-1, 1]) for (const x of [2.15, 4.7, 5.9]) { ctx.beginPath(); ctx.moveTo(side*x,-1.4); ctx.lineTo(side*x,1.2); ctx.stroke(); }
  ctx.restore();
  marking(ctx,m.side,-4.8,.02); marking(ctx,m.side,4.8,.02);
  // Highlighted glass and narrow canopy frames keep the direction legible.
  ctx.fillStyle = '#202e30'; ctx.beginPath(); ctx.roundRect(-.42,-2.5,.84,ju?2.25:1.6,.2); ctx.fill();
  ctx.fillStyle = '#7c9390'; ctx.fillRect(-.28,-2.31,.23,ju?1.75:1.1);
  ctx.strokeStyle = '#babaa1'; ctx.lineWidth = .065;
  for (const y of [-2.15,-1.55,-.9]) { ctx.beginPath(); ctx.moveTo(-.37,y); ctx.lineTo(.37,y); ctx.stroke(); }
  ctx.strokeStyle = '#a6a895'; ctx.lineWidth = .085; ctx.beginPath(); ctx.moveTo(0,2.1); ctx.lineTo(0,5.2); ctx.stroke();
  if (m.aircraftId === 'ju87g') for (const x of [-2.1,2.1]) {
    ctx.fillStyle = '#29342e'; ctx.fillRect(x-.18,-1.55,.36,2.35); ctx.fillStyle = '#454c40'; ctx.fillRect(x-.08,-2.65,.16,1.3);
    if (m.phase === 'attacking' && time >= m.nextReleaseAt - .13 && m.releaseIndex > 0) {
      ctx.fillStyle = '#ffeeb1'; ctx.beginPath(); ctx.moveTo(x,-3.6); ctx.lineTo(x+.3,-2.65); ctx.lineTo(x-.3,-2.65); ctx.closePath(); ctx.fill();
    }
  }
  // Propeller blur is cosmetic and analytic; it never advances mission time.
  ctx.save(); ctx.translate(0,ju?-5.25:-5.5); ctx.rotate(time*83); ctx.strokeStyle='rgba(198,204,183,.22)'; ctx.lineWidth=.16;
  ctx.beginPath(); ctx.moveTo(-1.7,0); ctx.lineTo(1.7,0); ctx.moveTo(0,-.7); ctx.lineTo(0,.7); ctx.stroke(); ctx.restore();
  ctx.fillStyle='#c9bea1'; ctx.beginPath(); ctx.ellipse(0,ju?-5.32:-5.57,.19,.32,0,0,Math.PI*2); ctx.fill();
}

export function drawAirSupport(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, _viewer: Side): void {
  const air = state.airSupport; if (!air) return;
  const ppm = TILE_PX * cam.zoom / TILE_M;
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,VIEW_W,VIEW_H); ctx.clip(); ctx.imageSmoothingEnabled=true;
  // Aircraft are physical sky objects, visible to either side. No reported or
  // hidden live ground-target positions enter this drawing code.
  for (const m of air.missions) {
    if (m.phase === 'complete') continue;
    const p = projectNightPoint(cam,m.pos);
    if (p.x < -100*cam.zoom || p.x > VIEW_W+100*cam.zoom || p.y < -100*cam.zoom || p.y > VIEW_H+100*cam.zoom) continue;
    ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(m.heading); ctx.scale(ppm,ppm);
    aircraft(ctx,m,state.time); ctx.restore();
  }
  for (const o of air.ordnance) {
    if (state.time < o.releasedAt || state.time > o.impactAt) continue;
    // Old saves can lack impactZ. Supply it on a shallow render-local copy so
    // airOrdnancePosition cannot lazily mutate the simulation's height field.
    const ordnance = o.impactZ != null ? o : { ...o, impactZ: state.map.heightField ? heightAt(state.map.heightField,o.impact.x,o.impact.y) : 0 };
    const world=airOrdnancePosition(state,ordnance,state.time),p=projectNightPoint(cam,world);
    if(p.x < -32 || p.x > VIEW_W+32 || p.y < -32 || p.y > VIEW_H+32)continue;
    const cannon=o.weaponId==='air_bk37',ptab=o.weaponId==='air_ptab';
    const previous=projectNightPoint(cam,airOrdnancePosition(state,ordnance,Math.max(o.releasedAt,state.time-(cannon?.025:.09))));
    if(cannon){
      ctx.strokeStyle='rgba(255,239,161,.85)';ctx.lineWidth=Math.max(1,cam.zoom*1.2);ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(p.x,p.y);ctx.stroke();
    }else{
      ctx.strokeStyle=ptab?'rgba(177,176,150,.45)':'rgba(138,145,126,.5)';ctx.lineWidth=Math.max(.6,cam.zoom*.8);ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(p.x,p.y);ctx.stroke();
      const angle=Math.atan2(p.y-previous.y,p.x-previous.x)+Math.PI/2;
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(angle);ctx.scale(cam.zoom,cam.zoom);
      ctx.fillStyle=ptab?'#525844':'#383e36';ctx.beginPath();ctx.ellipse(0,0,ptab?.85:2,ptab?1.8:4.5,0,0,Math.PI*2);ctx.fill();
      if(!ptab){ctx.fillStyle='#777b62';ctx.fillRect(-1,-2,.65,3);ctx.strokeStyle='#a5a48a';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(-2.5,3.8);ctx.lineTo(2.5,3.8);ctx.moveTo(0,2.7);ctx.lineTo(0,5.2);ctx.stroke();}
      ctx.restore();
      // A close-to-ground shadow makes the impending physical impact legible;
      // it uses the projectile's present XY, never its future aim marker.
      const ground=state.map.heightField?groundAt(state.map.heightField,world.x/TILE_M,world.y/TILE_M):0;
      const above=world.z-ground;
      if(above<18){const shadow=projectNightPoint(cam,{x:world.x,y:world.y,z:ground});ctx.fillStyle=`rgba(12,16,16,${.25*(1-above/18)})`;ctx.beginPath();ctx.ellipse(shadow.x,shadow.y,(ptab?1:2.5)*cam.zoom,(ptab?.6:1.3)*cam.zoom,0,0,Math.PI*2);ctx.fill();}
    }
  }
  ctx.restore();
}
