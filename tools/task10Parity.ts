import {writeFileSync} from 'node:fs';
import {Battle} from '@/sim/battle';
import {isTrenchApproachPoint} from '@/sim/vehicleTrenchApproach';
import {crushableLineSourcesAt} from '@/sim/heightField';
import {makeState,addTank} from '../test/vehicleDamageHelpers';
import {VEHICLE_DEFS} from '@/data/units';
import {findPath} from '@/sim/path';
import {createHullBody} from '@/sim/hullPhysics';
import {hashState} from '@/sim/stateHash';
import {boxProjection} from '@/sim/localDriver';
import {hullParams} from '@/data/vehiclePhysics';
import {groundProbe} from '@/sim/hullGround';
import {stepVehicles,onVehicleNearMiss} from '@/sim/vehicle';
import {WEAPONS} from '@/data/weapons';
import {hasLOS} from '@/sim/los';
import {takeHullDrive} from '@/sim/hullDrive';
import {Rng} from '@/shared/rng';
import * as dm from '@/shared/dmath';
const state=makeState(),{v,team}=addTank(state,'t34_76',{x:20,y:20},0,60);
const target={x:20,y:10};team.order={type:'move',target,issuedAt:0};v.path=[target];
v.body=createHullBody(VEHICLE_DEFS.t34_76,v.pos,0,groundProbe(state.map));
v.body.orientation={x:0,y:-dm.sin(.1),z:0,w:dm.cos(.1)};
const rng=new Rng(3),steps=[];
for(let i=0;i<10;i++){state.time+=.1;stepVehicles(state,rng,.1);steps.push({body:structuredClone(v.body),drive:takeHullDrive(v),pos:{...v.pos}});}
const map=makeState().map;map.ground=new Float32Array(map.width*map.height);
for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++)map.ground[y*map.width+x]=(x+.5)*2*.24;
const def={...VEHICLE_DEFS.sdkfz251,slopeComfortDeg:5,slopeTipDeg:30};
const path=findPath(map,{x:10.5,y:10.5},{x:14.5,y:16.5},'vehicle',20000,undefined,{def});
const contactState=makeState(),contactMap=contactState.map;
contactMap.def={...contactMap.def,vectors:[{kind:'line',terrain:'fence',width:1,points:[{x:4,y:10},{x:18,y:10}]}]};
for(let x=4;x<=18;x++)contactMap.tiles[10*contactMap.width+x]='fence';
const sources=crushableLineSourcesAt(contactMap,[{x:10.5,y:9.8}]);
const {v:contactVehicle,team:contactTeam}=addTank(contactState,'pz4gh',{x:10.5,y:8.2},Math.PI);
const contactGoal={x:10.5,y:15};contactVehicle.path=[contactGoal];contactTeam.order={type:'move',target:contactGoal,issuedAt:0};
const contactSteps=[];
for(let i=0;i<10;i++){contactState.time+=.1;stepVehicles(contactState,rng,.1);contactSteps.push({body:structuredClone(contactVehicle.body),sourceTiles:sources.map(i=>contactMap.tiles[i])});}
const recoveryState=makeState(),{v:recoveryVehicle,team:recoveryTeam}=addTank(recoveryState,'pz4gh',{x:20.5,y:20.5});
const recoveryDef=VEHICLE_DEFS.pz4gh;
recoveryVehicle.body=createHullBody(recoveryDef,recoveryVehicle.pos,0,groundProbe(recoveryState.map));
const goal={x:30.5,y:10.5},anchorM={x:recoveryVehicle.body.position.x,y:recoveryVehicle.body.position.y},axis={x:0,y:1};
recoveryTeam.order={type:'move',target:goal,issuedAt:0};recoveryVehicle.path=[goal];
recoveryVehicle.localDriver={owner:1,episode:{anchorM,attempts:1,limit:3,exhausted:false},window:null,
 recovery:{gear:-1,capMs:2.5,anchorM,axis,turning:true,entryMaxProjection:boxProjection(recoveryVehicle.body,hullParams(recoveryDef).solidBox,axis,anchorM).max,phase:'pending',budgetTicks:0,elapsedTicks:0}};
const recoverySteps=[];
for(let i=0;i<10;i++){recoveryState.time+=.1;stepVehicles(recoveryState,rng,.1);recoverySteps.push({body:structuredClone(recoveryVehicle.body),local:structuredClone(recoveryVehicle.localDriver),drive:takeHullDrive(recoveryVehicle),hash:hashState({state:recoveryState,rng})});}
const giveWaySteps=[];
for(const blocked of [false,true]){const s=makeState(),{v,team}=addTank(s,'t34_76',{x:20.5,y:20.5});const goal={x:20.5,y:10.5};team.order={type:'move',target:goal,issuedAt:0};v.path=[goal];v.giveWayUntil=1;if(blocked)s.map.tiles[21*s.map.width+20]='water';
 for(let i=0;i<3;i++){s.time+=.1;stepVehicles(s,rng,.1);giveWaySteps.push({blocked,body:structuredClone(v.body),drive:takeHullDrive(v),hash:hashState({state:s,rng})});}}
const bankState=makeState(),{v:bankVehicle}=addTank(bankState,'pz4gh',{x:200.5,y:200.5},0,60);
for(let y=200;y<=202;y++)for(let x=201;x<=203;x++)if(x!==202||y!==201)bankState.map.tiles[y*bankState.map.width+x]='water';
bankState.map.tiles[200*bankState.map.width+202]='buildingStone';
const bankThreat={x:200.5,y:192.5},bankRng=new Rng(3),bankSteps=[];
for(let i=0;i<550;i++){
 if(i%100===0)onVehicleNearMiss(bankState,bankVehicle,WEAPONS.pak40,bankThreat);
 bankState.time+=.1;stepVehicles(bankState,bankRng,.1);
 const exposed=hasLOS(bankState.map,bankVehicle.pos,bankThreat);
 bankSteps.push({body:structuredClone(bankVehicle.body),local:structuredClone(bankVehicle.localDriver),drive:takeHullDrive(bankVehicle),hash:hashState({state:bankState,rng:bankRng}),exposed});
 if(!exposed)break;
}
if(bankSteps.at(-1)?.exposed)throw new Error('Bank parity scenario did not reach cover');
const trenchState=new Battle({mapId:'steppe_1943',playerSide:'german',year:1943,seed:3,durationS:1200,
 difficulty:'normal',forces:{german:[],soviet:[]}}).state;
const trenchGoal={x:160.77486641705036,y:58.36966942995787};
const trenchRoute=findPath(trenchState.map,{x:115.5,y:25.5},trenchGoal,'vehicle',6000,undefined,{def:VEHICLE_DEFS.pz4gh});
const crossingIndex=trenchRoute.findIndex(p=>isTrenchApproachPoint(trenchState.map,VEHICLE_DEFS.pz4gh,p));
if(crossingIndex<0||!trenchRoute[crossingIndex+1])throw new Error('Steppe parity scenario has no prepared crossing');
const trenchEntry=trenchRoute[crossingIndex],trenchExit=trenchRoute[crossingIndex+1];
const {v:trenchVehicle,team:trenchTeam}=addTank(trenchState,'pz4gh',trenchEntry,
 dm.atan2(trenchExit.x-trenchEntry.x,trenchEntry.y-trenchExit.y));
trenchVehicle.path=trenchRoute.slice(crossingIndex);trenchTeam.order={type:'move',target:trenchGoal,issuedAt:0};
const trenchRng=new Rng(3),trenchSteps=[];
for(let i=0;i<60;i++){trenchState.time+=.1;stepVehicles(trenchState,trenchRng,.1);trenchSteps.push({body:structuredClone(trenchVehicle.body),
 path:structuredClone(trenchVehicle.path),local:structuredClone(trenchVehicle.localDriver),drive:takeHullDrive(trenchVehicle),hash:hashState({state:trenchState,rng:trenchRng})});}
const roadState=makeState(),roadStart={x:20.5,y:20.5},roadGoal={x:21.5,y:21.5};
const {v:roadVehicle,team:roadTeam}=addTank(roadState,'stug3g',roadStart,3*Math.PI/4);
roadState.map.tiles[20*roadState.map.width+20]='dirtroad';roadState.map.tiles[21*roadState.map.width+21]='dirtroad';
roadState.map.tiles[20*roadState.map.width+21]='mud';roadState.map.tiles[21*roadState.map.width+20]='mud';
roadVehicle.path=[roadStart,roadGoal];roadTeam.order={type:'move',target:roadGoal,issuedAt:0};
const roadRng=new Rng(3),roadSteps=[];
for(let i=0;i<10;i++){roadState.time+=.1;stepVehicles(roadState,roadRng,.1);roadSteps.push({body:structuredClone(roadVehicle.body),
 path:structuredClone(roadVehicle.path),local:structuredClone(roadVehicle.localDriver),drive:takeHullDrive(roadVehicle),hash:hashState({state:roadState,rng:roadRng})});}
writeFileSync(process.argv[2]??'/private/tmp/task10-parity.json',JSON.stringify({steps,path,sources,contactSteps,recoverySteps,giveWaySteps,bankSteps,trenchSteps,roadSteps}));
