import {Battle} from '@/sim/battle';
import {buildMap} from '@/sim/map';
import {createMind} from '@/sim/mind';
import type {Soldier,Team} from '@/shared/types';
export function fixture(){
 const b=new Battle({mapId:'border_1941',year:1941,playerSide:'german',seed:17,durationS:600,difficulty:'normal',controllers:{german:'human',soviet:'human'},forces:{german:['ger_rifle_41'],soviet:['sov_rifle_41']}}),state=b.state;
 state.map=buildMap({id:'personal',name:'Personal',description:'',width:400,height:60,season:'summer',paint:(tiles)=>tiles.fill('open'),victoryLocations:[],deployZones:{german:{x:0,y:0,w:200,h:60},soviet:{x:200,y:0,w:200,h:60}},attacker:'german'});
 const template=[...state.soldiers.values()][0],teamTemplate=[...state.teams.values()][0];state.soldiers.clear();state.teams.clear();state.vehicles.clear();state.phase='running';state.time=0;state.tick=0;
 function person(id:number,side:Soldier['side'],x:number,y:number):Soldier{const s:Soldier={...structuredClone(template),id,teamId:id,side,pos:{x,y},weaponId:'kar98k',health:'healthy',activity:'defending',stance:'standing',mind:createMind(60),fatigue:0,suppression:0,ammo:10,ammoReserve:20,grenades:0,vehicleId:null,path:[],targetPoint:null,targetSoldierId:null,targetVehicleId:null,lastFiredAt:-999,fireTimer:0,reloadTimer:0,perception:undefined,condition:undefined};state.soldiers.set(id,s);const t:Team={...structuredClone(teamTemplate),id,side,leaderId:id,soldierIds:[id],pos:{...s.pos},order:null,vehicleId:null,outOfAction:false};state.teams.set(id,t);return s;}
 const a=person(1,'german',20,20),isolated=person(2,'german',300,20),enemy=person(101,'soviet',24,20);return{b,state,a,isolated,enemy,person};
}