import { expect,it } from 'vitest';
import { crossedCells,prepareRoutePrefix,selectRoutePrefix } from '@/sim/vehicleCorridor';
const cells=(a:{x:number;y:number},b:{x:number;y:number})=>{const rows:string[]=[];crossedCells(a,b,(x,y)=>{rows.push(x+','+y);return true;});return rows;};
it('covers a generic fractional sliver on both directions without an epsilon',()=>{
 const a={x:.7,y:.4},b={x:1.4,y:1.3};for(const [p,q] of [[a,b],[b,a]]){expect(cells(p,q)).toContain('1,0');expect(crossedCells(p,q,(x,y)=>!(x===1&&y===0))).toBe(false);}
 const a2={x:.999999999999,y:.2},b2={x:1.000000000001,y:.8};expect(cells(a2,b2)).toEqual(['0,0','1,0']);
});
it('checks corner orthogonals, both grid-line strips and explicit floor endpoints',()=>{
 expect(cells({x:.5,y:.5},{x:1,y:1})).toEqual(['0,0','1,0','0,1','1,1']);
 expect(new Set(cells({x:1,y:.2},{x:1,y:2}))).toEqual(new Set(['1,0','0,0','1,1','0,1','1,2','0,2']));
 expect(cells({x:1,y:1},{x:1,y:1})).toEqual(['1,1']);expect(cells({x:2.5,y:.5},{x:1,y:.5})).toEqual(['2,0','1,0']);
});
it('uses original immutable candidate ceilings once per index, retains unsafe consumed corners and pins',()=>{
 const points=[{x:0,y:.1},{x:1,y:1},{x:2,y:1}],calls:any[]=[];
 const run=(safe:boolean,pin=-1)=>selectRoutePrefix(points,{x:0,y:0},1,6,()=>1,(p)=>p===points[0]?5:2,(p,m)=>{calls.push([points.indexOf(p),m]);return safe;},()=>true,(p)=>points.indexOf(p)===pin);
 expect(run(false)).toBe(0);expect(calls).toEqual([[1,5],[2,5]]);calls.length=0;expect(run(true,1)).toBe(2);expect(calls.filter(x=>x[0]===1)).toHaveLength(1);
 // A pin which is not legitimately reached cannot be crossed by shortcut selection.
 calls.length=0;expect(selectRoutePrefix(points,{x:0,y:0},1,6,()=>1,()=>1,()=>true,()=>false,p=>p===points[1])).toBe(1);
 expect(selectRoutePrefix(points,{x:0,y:0},1,.2,()=>1,()=>1,()=>true,()=>true,()=>false)).toBe(0);
});

it('retains one original successor/ceiling result for the legacy wheeled post-steering pop',()=>{
 const points=[{x:0,y:.1},{x:1,y:1},{x:2,y:1}],calls:any[]=[];
 const p=prepareRoutePrefix(points,{x:0,y:0},1,6,()=>1,p=>p===points[0]?7:2,(p,m)=>{calls.push([points.indexOf(p),m]);return true;},()=>false,p=>p===points[1]);
 expect(p.index).toBe(1);expect(calls).toEqual([[1,7]]);expect(p.successorDrivable()).toBe(true);expect(p.successorDrivable()).toBe(true);expect(calls).toEqual([[1,7],[2,7]]);
});

it('preserves non45-degree corner ties over repeated crossings in both directions',()=>{
 const a={x:.25,y:.5},b={x:4.75,y:9.5};
 for(const [start,end] of [[a,b],[b,a]]){
  const got=new Set(cells(start,end));for(const [x,y] of [[1,2],[2,4],[3,6],[4,8]]){
   for(const [cx,cy] of [[x-1,y-1],[x,y-1],[x-1,y],[x,y]])expect(got.has(cx+','+cy),cx+','+cy).toBe(true);
  }
 }
});
it('does not conflate a representable near-corner thin interval with an exact tie',()=>{
 const a={x:.25,y:.5},b={x:4.75,y:9.5+Number.EPSILON*8};
 const forward=new Set(cells(a,b)),reverse=new Set(cells(b,a));expect(forward).toEqual(reverse);
 expect(forward.has('0,2')).toBe(true);expect(forward.has('1,1')).toBe(false);
});
