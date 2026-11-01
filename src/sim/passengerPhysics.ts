import type { BattleState, PassengerCompartment, RiderState, Soldier, Vec3, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { add, cross, dot, inverseRotate, rotate, yawQuat } from './hullMath';
import { groundProbe } from './hullGround';
import { groundAtTile } from './map';

export const RIDER_RADIUS_M = 0.09;
export const RIDER_BONES = [[0,1],[1,2],[1,3],[1,4],[2,5],[2,6]] as const;
const RELATIVE_BODY: Vec3[] = [
  {x:0,y:0,z:.55},{x:0,y:0,z:.28},{x:0,y:0,z:0},
  {x:-.28,y:-.12,z:.1},{x:.28,y:-.12,z:.1},{x:-.13,y:-.3,z:-.25},{x:.13,y:-.3,z:-.25},
];
const length = (p: Vec3) => Math.sqrt(p.x*p.x+p.y*p.y+p.z*p.z);
const REST = RIDER_BONES.map(([a,b]) => length({x:RELATIVE_BODY[b].x-RELATIVE_BODY[a].x,y:RELATIVE_BODY[b].y-RELATIVE_BODY[a].y,z:RELATIVE_BODY[b].z-RELATIVE_BODY[a].z}));
function frame(v: Vehicle, state: BattleState) {
  const p = hullParams(VEHICLE_DEFS[v.defId]);
  const q = v.body?.orientation ?? yawQuat(v.hullFacing);
  const centre = v.body?.position ?? {x:v.pos.x*TILE_M,y:v.pos.y*TILE_M,z:groundAtTile(state.map,Math.floor(v.pos.x),Math.floor(v.pos.y))+p.cgHeightM};
  return {q,origin:add(centre,rotate(q,p.modelOriginLocal))};
}
type RiderFrame = ReturnType<typeof frame>;
function worldPoint(f:RiderFrame,p:Vec3):Vec3{return add(f.origin,rotate(f.q,p));}
function localPoint(f:RiderFrame,p:Vec3):Vec3{return inverseRotate(f.q,{x:p.x-f.origin.x,y:p.y-f.origin.y,z:p.z-f.origin.z});}
export function riderWorld(state: BattleState, v: Vehicle, local: Vec3): Vec3 {
  return worldPoint(frame(v,state),local);
}
export function riderLocal(state: BattleState, v: Vehicle, world: Vec3): Vec3 {
  return localPoint(frame(v,state),world);
}
/** Seat assignment belongs to the simulation, including dead riders occupying their seat. */
export function ensureRiderSeat(state: BattleState,v:Vehicle,s:Soldier): RiderState | null {
  const c=VEHICLE_DEFS[v.defId]?.passengerCompartment;
  if(!c||s.seat!=='passenger'||s.vehicleId!==v.id)return null;
  if(s.rider?.vehicleId===v.id && !s.rider.body) { s.rider.attached=true; return s.rider; }
  if(s.rider?.attached&&s.rider.vehicleId===v.id)return s.rider;
  const used=new Set<number>();
  for(const p of state.soldiers.values())if(p!==s&&p.vehicleId===v.id&&p.rider?.attached)used.add(p.rider.seatIndex);
  const i=c.seats.findIndex((_,index)=>!used.has(index));
  if(i<0)return null;
  return s.rider={vehicleId:v.id,seatIndex:i,attached:true,posture:'crouched',local:{...c.seats[i]}};
}
/** Reserve the physical boarding endpoint before the hatch animation starts. */
export function reserveRiderSeat(state:BattleState,v:Vehicle,s:Soldier):void {
  const c=VEHICLE_DEFS[v.defId]?.passengerCompartment;if(!c)return;
  const used=new Set<number>();
  for(const p of state.soldiers.values())if(p!==s&&p.rider?.vehicleId===v.id&&(p.rider.attached||p.hatch?.vehicleId===v.id))used.add(p.rider.seatIndex);
  const index=c.seats.findIndex((_,i)=>!used.has(i));if(index<0)return;
  s.rider={vehicleId:v.id,seatIndex:index,attached:false,posture:'crouched',local:{...c.seats[index]}};
}
export function riderCanExpose(state:BattleState,s:Soldier):boolean {
  if(!s.rider?.attached)return true;
  const v=state.vehicles.get(s.rider.vehicleId);
  return !!v&&Math.abs(v.speed)<=.05&&s.suppression<45&&s.health!=='dead'&&s.health!=='incapacitated'
    &&!['panicked','broken','cowering'].includes(s.mind.state);
}
/** Clamp only solid surfaces: the open top has no invisible ceiling. */
export function constrainCompartment(point:Vec3,c:PassengerCompartment):Vec3 {
  const p={...point},r=RIDER_RADIUS_M;
  p.z=Math.max(p.z,c.floorZ+r);
  if(p.z<c.wallTopZ+r){
    const t=Math.max(0,Math.min(1,(p.z-c.floorZ)/(c.wallTopZ-c.floorZ)));
    const half=c.lowerHalfWidth+(c.upperHalfWidth-c.lowerHalfWidth)*t-r;
    p.x=Math.max(-half,Math.min(half,p.x));
    p.y=Math.max(c.frontY+r,Math.min(c.rearY-r,p.y));
  }
  for(const b of c.benches){
    if(p.x<=b.min.x-r||p.x>=b.max.x+r||p.y<=b.min.y-r||p.y>=b.max.y+r||p.z<=b.min.z-r||p.z>=b.max.z+r)continue;
    const faces=[{axis:'x' as const,value:b.min.x-r,d:p.x-b.min.x+r},{axis:'x' as const,value:b.max.x+r,d:b.max.x+r-p.x},
      {axis:'y' as const,value:b.min.y-r,d:p.y-b.min.y+r},{axis:'y' as const,value:b.max.y+r,d:b.max.y+r-p.y},
      {axis:'z' as const,value:b.min.z-r,d:p.z-b.min.z+r},{axis:'z' as const,value:b.max.z+r,d:b.max.z+r-p.z}];
    let best=faces[0];for(const f of faces)if(f.d<best.d)best=f;p[best.axis]=best.value;
  }
  return p;
}
function makeBody(state:BattleState,v:Vehicle,s:Soldier,r:RiderState):void {
  const c=VEHICLE_DEFS[v.defId].passengerCompartment!,facing=c.facing[r.seatIndex]??0;
  const f=frame(v,state),turn=yawQuat(facing),velocity=v.body?.velocity??{x:0,y:0,z:0};
  r.body=RELATIVE_BODY.map(offset=>{
    const position=worldPoint(f,add(r.local,rotate(turn,offset))),b=v.body;
    return {position,velocity:b?add(velocity,cross(b.angularVelocity,{x:position.x-b.position.x,y:position.y-b.position.y,z:position.z-b.position.z})):{...velocity}};
  });
  r.posture='casualty';
}
/** Damage initializes the body at the hit pose, before the next hull tick moves. */
export function onPassengerCasualty(state:BattleState,v:Vehicle,s:Soldier):void {
  const r=ensureRiderSeat(state,v,s);if(r&&!r.body)makeBody(state,v,s,r);
}
export function onPassengerFired(state:BattleState,s:Soldier):void {
  if(s.rider?.attached&&riderCanExpose(state,s)){s.rider.posture='firing';s.stance='standing';}
}
function bodyStep(state:BattleState,v:Vehicle|undefined,r:RiderState,dt:number):void {
  const points=r.body!;
  const c=v&&r.attached?VEHICLE_DEFS[v.defId].passengerCompartment:undefined;
  const f=c&&v?frame(v,state):null;
  const probe=c?null:groundProbe(state.map,'tick');
  const h=dt/4;
  for(let step=0;step<4;step++){
    const old=points.map(p=>({...p.position}));
    for(const p of points){p.velocity.z-=9.81*h;p.position=add(p.position,{x:p.velocity.x*h,y:p.velocity.y*h,z:p.velocity.z*h});}
    for(let pass=0;pass<5;pass++){
      for(let i=0;i<RIDER_BONES.length;i++){
        const[a,b]=RIDER_BONES[i],p=points[a].position,q=points[b].position;
        const dx=q.x-p.x,dy=q.y-p.y,dz=q.z-p.z,d=Math.sqrt(dx*dx+dy*dy+dz*dz);
        if(d===0)continue;const k=(d-REST[i])/(2*d);
        p.x+=dx*k;p.y+=dy*k;p.z+=dz*k;q.x-=dx*k;q.y-=dy*k;q.z-=dz*k;
      }
      for(const p of points){
        if(c&&f)p.position=worldPoint(f,constrainCompartment(localPoint(f,p.position),c));
        else if(probe)p.position.z=Math.max(p.position.z,probe(p.position.x,p.position.y).heightM+RIDER_RADIUS_M);
      }
    }
    for(let i=0;i<points.length;i++){
      const p=points[i];p.velocity={x:(p.position.x-old[i].x)/h*.94,y:(p.position.y-old[i].y)/h*.94,z:(p.position.z-old[i].z)/h*.94};
      if(c&&f&&v?.body){
        const local=localPoint(f,p.position),radius=RIDER_RADIUS_M;
        const supported=local.z<=c.floorZ+radius+.005||c.benches.some(b=>local.x>b.min.x-radius&&local.x<b.max.x+radius&&local.y>b.min.y-radius&&local.y<b.max.y+radius&&Math.abs(local.z-b.max.z-radius)<.005);
        if(supported){
          const normal=rotate(f.q,{x:0,y:0,z:1}),b=v.body;
          const surface=add(b.velocity,cross(b.angularVelocity,{x:p.position.x-b.position.x,y:p.position.y-b.position.y,z:p.position.z-b.position.z}));
          const relative={x:p.velocity.x-surface.x,y:p.velocity.y-surface.y,z:p.velocity.z-surface.z},n=dot(relative,normal);
          p.velocity={x:p.velocity.x-(relative.x-normal.x*n)*.35,y:p.velocity.y-(relative.y-normal.y*n)*.35,z:p.velocity.z-(relative.z-normal.z*n)*.35};
        }
      }
      const speed=length(p.velocity);if(speed>20){const k=20/speed;p.velocity={x:p.velocity.x*k,y:p.velocity.y*k,z:p.velocity.z*k};}
    }
  }
}
/** Called after all accepted hull movement, once per fixed simulation tick. */
export function stepPassengerPhysics(state:BattleState,dt:number):void {
  if(dt!==SIM_DT)throw new Error('Passenger physics requires fixed SIM_DT');
  for(const s of state.soldiers.values()){
    const v=s.vehicleId!=null?state.vehicles.get(s.vehicleId):undefined;
    const c=v&&VEHICLE_DEFS[v.defId]?.passengerCompartment;
    if(s.rider?.attached&&(s.vehicleId!==s.rider.vehicleId||s.seat!=='passenger'||!c))delete s.rider;
    const r=c&&v?ensureRiderSeat(state,v,s):s.rider;
    if(!r)continue;
    if(!r.attached&&!r.body&&s.vehicleId==null&&!s.hatch){delete s.rider;continue;}
    if(r.attached&&(!v||s.seat!=='passenger')){delete s.rider;continue;}
    if(s.health==='dead'||s.health==='incapacitated'){
      if(!r.body&&v)makeBody(state,v,s,r);
      if(!r.body)continue;
      bodyStep(state,v,r,dt);
      const hip=r.body[2].position;
      if(v&&c&&r.attached){
        const local=riderLocal(state,v,hip);r.local=local;
        if(local.z>c.wallTopZ+.6||Math.abs(local.x)>c.lowerHalfWidth+.6||local.y<c.frontY-.6||local.y>c.rearY+.6){
          r.attached=false;s.vehicleId=null;s.seat=undefined;v.passengerIds=v.passengerIds?.filter(id=>id!==s.id);
        }
      }
      s.pos={x:hip.x/TILE_M,y:hip.y/TILE_M};
    }else if(v&&c){
      r.local={...c.seats[r.seatIndex]};
      r.posture=riderCanExpose(state,s)&&state.time-s.lastFiredAt<.65?'firing':'crouched';
      s.stance=r.posture==='firing'?'standing':'crouching';
      const world=riderWorld(state,v,r.local);s.pos={x:world.x/TILE_M,y:world.y/TILE_M};
    }
  }
}
