import {describe,it,expect} from 'vitest';
import {Battle} from '@/sim/battle';
import {connectTelephone,cancelTelephone,telephoneLink,damageTelephoneBlast,damageTelephoneSweep,requestTelephoneRepair,stepFieldTelephone} from '@/sim/fieldTelephone';
function fixture(stock=1000){
 const st=new Battle({mapId:'border_1941',playerSide:'german',year:1941,seed:1,durationS:120,difficulty:'normal',telephoneWireStockM:stock,forces:{german:['ger_rifle_41','ger_rifle_41','ger_rifle_41'],soviet:['sov_rifle_41']}}).state;
 const teams=[...st.teams.values()].filter(t=>t.side==='german').slice(0,3);
 st.map.def={...st.map.def,deployZones:{...st.map.def.deployZones,german:{x:0,y:0,w:st.map.width,h:st.map.height}}};st.map.tiles.fill('grass');
 const leaders=teams.map((t,i)=>{const s=st.soldiers.get(t.leaderId)!;s.pos={x:10+i*10,y:10};s.vehicleId=null;s.health='healthy';s.activity='idle';s.mind.state='calm';return s;});
 return {st,teams,leaders};
}
describe('physical field telephone',()=>{
 it('consumes finite routed wire, refunds setup removal, and rejects foreign/outside geometry',()=>{
  const {st,teams:t,leaders:s}=fixture(30);
  expect(connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,{x:20,y:20},s[1].pos])).toBeNull();
  const l=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,s[1].pos])!;expect(l.lengthM).toBe(20);expect(st.fieldTelephone!.stockM.german).toBe(10);
  expect(cancelTelephone(st,'soviet',l.id)).toBe(false);expect(cancelTelephone(st,'german',l.id)).toBe(true);expect(st.fieldTelephone!.stockM.german).toBe(30);
  expect(connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,{x:-1,y:10},s[1].pos])).toBeNull();
 });
 it('requires capable physically present relay operators and survives serialization',()=>{
  const {st,teams:t,leaders:s}=fixture();const a=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,s[1].pos])!,b=connectTelephone(st,'german',t[1].id,t[2].id,[s[1].pos,s[2].pos])!;
  expect(telephoneLink(st,s[0],s[2])).toMatchObject({channel:'telephone',lineIds:[a.id,b.id]});expect(telephoneLink(st,s[0],s[2])!.delay).toBeCloseTo(4.04);
  st.fieldTelephone=JSON.parse(JSON.stringify(st.fieldTelephone));expect(telephoneLink(st,s[0],s[2])).not.toBeNull();
  s[1].pos={x:20,y:13};expect(telephoneLink(st,s[0],s[2])).toBeNull();s[1].pos={x:20,y:10};s[1].stunnedUntil=100;expect(telephoneLink(st,s[0],s[2])).toBeNull();
 });
 it('cuts only intersected exposed segments including a fast swept crossing',()=>{
  const {st,teams:t,leaders:s}=fixture();const l=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,{x:15,y:10},s[1].pos])!;
  damageTelephoneSweep(st,{x:12,y:5},{x:12,y:15},.5);expect(l.cutSegments).toEqual([0]);expect(telephoneLink(st,s[0],s[1])).toBeNull();
  damageTelephoneBlast(st,{x:19,y:10},1);expect(l.cutSegments).toEqual([0,1]);
  const protectedLine=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,s[1].pos],true)!;damageTelephoneBlast(st,{x:15,y:10},50);damageTelephoneSweep(st,{x:15,y:0},{x:15,y:20},4);expect(protectedLine.cutSegments).toEqual([]);
 });
 it('repairs only with a capable endpoint or engineer at the damaged segment for actual work time',()=>{
  const {st,teams:t,leaders:s}=fixture();const l=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,s[1].pos])!;damageTelephoneBlast(st,{x:15,y:10},1);st.phase='running';
  expect(requestTelephoneRepair(st,'german',l.id,t[2].id)).toBe(false);expect(requestTelephoneRepair(st,'german',l.id,t[0].id)).toBe(true);
  stepFieldTelephone(st,19);expect(l.cutSegments).toEqual([0]);stepFieldTelephone(st,100);expect(l.cutSegments).toEqual([]);expect(telephoneLink(st,s[0],s[1])).not.toBeNull();
 });
 it('classifies urban protected routes and rejects operational setup edits',()=>{
  const {st,teams:t,leaders:s}=fixture();st.map.tiles.fill('pavedroad');const l=connectTelephone(st,'german',t[0].id,t[1].id,[s[0].pos,s[1].pos])!;expect(l.underground).toEqual([true]);st.phase='running';expect(cancelTelephone(st,'german',l.id)).toBe(false);expect(connectTelephone(st,'german',t[1].id,t[2].id,[s[1].pos,s[2].pos])).toBeNull();
 });
});
