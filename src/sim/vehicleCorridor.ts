import type { Vec2 } from '@/shared/types';
import { dist } from '@/shared/math';

const gridBits = new DataView(new ArrayBuffer(8));
/** Exact dyadic coordinates for rational DDA ties; no geometric epsilon or accumulated drift. */
function gridIntegers(values:number[]):{coordinates:bigint[];unit:bigint} {
  const parts=values.map(value=>{
    gridBits.setFloat64(0,value,false);const bits=gridBits.getBigUint64(0,false),exponent=Number((bits>>52n)&2047n);
    let mantissa=bits&((1n<<52n)-1n);if(exponent)mantissa|=1n<<52n;if(bits>>63n)mantissa=-mantissa;
    return {mantissa,exponent:mantissa===0n?0:exponent?exponent-1075:-1074};
  });
  const exponent=Math.min(0,...parts.map(p=>p.exponent));
  return {coordinates:parts.map(p=>p.mantissa<<BigInt(p.exponent-exponent)),unit:1n<<BigInt(-exponent)};
}
/** Fractional supercover: floor-containing endpoints; corner neighbours precede diagonal.
 * Nonzero grid-line segments include both strips. Rational tMax/tDelta preserve every thin cell. */
export function crossedCells(a: Vec2, b: Vec2, visit: (x: number, y: number) => boolean): boolean {
  if (![a.x,a.y,b.x,b.y].every(Number.isFinite)) return false;
  let x=Math.floor(a.x),y=Math.floor(a.y);const ex=Math.floor(b.x),ey=Math.floor(b.y),dx=b.x-a.x,dy=b.y-a.y;
  if (dx===0&&dy===0) return visit(x,y);
  const sx=Math.sign(dx),sy=Math.sign(dy),lineX=dx===0&&Number.isInteger(a.x),lineY=dy===0&&Number.isInteger(a.y);
  const check=(cx:number,cy:number)=>visit(cx,cy)&&(!lineX||visit(cx-1,cy))&&(!lineY||visit(cx,cy-1));
  if(!check(x,y))return false;
  const {coordinates:[ax,ay,bx,by],unit}=gridIntegers([a.x,a.y,b.x,b.y]);
  const abs=(v:bigint)=>v<0n?-v:v,denX=abs(bx-ax),denY=abs(by-ay);
  // tMaxX=maxX/denX, tDeltaX=unit/denX (likewise Y); cross products order parameters exactly.
  let maxX=abs(BigInt(sx>0?x+1:x)*unit-ax),maxY=abs(BigInt(sy>0?y+1:y)*unit-ay);
  while(x!==ex||y!==ey){
    const left=maxX*denY,right=maxY*denX,order=x===ex?1:y===ey?-1:left<right?-1:left>right?1:0;
    if(order===0){if(!check(x+sx,y)||!check(x,y+sy))return false;x+=sx;y+=sy;maxX+=unit;maxY+=unit;}
    else if(order<0){x+=sx;maxX+=unit;}else{y+=sy;maxY+=unit;}
    if(!check(x,y))return false;
  }
  return true;
}

/** One immutable-prefix ceiling per original index; each direct result evaluated at most once.
 * Returns the one splice index; an unsafe connection retains the required original corner. */
export function prepareRoutePrefix(route: readonly Vec2[], position: Vec2, baseCost: number, lookahead: number,
  slope: (a: Vec2,b: Vec2)=>number, terrainCost: (p: Vec2)=>number,
  direct: (p: Vec2,maxCost: number)=>boolean, consumed: (p: Vec2,index: number)=>boolean,
  pinned: (p: Vec2)=>boolean): {index:number;successorDrivable:()=>boolean} {
  const points=route.slice(),ceilings:number[]=[],results:(boolean|undefined)[]=[];
  let ceiling=baseCost;
  for(let i=0;i<points.length&&dist(position,points[i])<=lookahead;i++){
    const cost=slope(i===0?position:points[i-1],points[i]);
    if(Number.isFinite(cost))ceiling=Math.max(ceiling,terrainCost(points[i])*cost);
    ceilings.push(ceiling);
  }
  const test=(i:number)=>results[i]??(results[i]=direct(points[i],ceilings[i]));
  let j=0;
  while(j+1<ceilings.length&&consumed(points[j],j)&&test(j+1))j++;
  let selected=j;
  for(let i=j;i<ceilings.length;i++){
    if(i>j&&test(i))selected=i;
    if(pinned(points[i]))break;
  }
  return {index:selected,successorDrivable:()=>selected+1<ceilings.length&&test(selected+1)};
}
export function selectRoutePrefix(...args:Parameters<typeof prepareRoutePrefix>):number { return prepareRoutePrefix(...args).index; }
