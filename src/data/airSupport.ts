import type {BattleConfig,Side,WeaponDef} from '@/shared/types';

/** Assigned tactical loads, not maximum airframe capacities.
 * Ju 87B mixed load reference: https://aeropedia.com.au/content/junkers-ju-87/
 * Ju 87G twin BK 3.7: RAF Museum object history:
 * https://www.rafstories.org/ciim-media/pf/D63A5943_D295_9C52_1BE8_D4238A690CC6/121/994/78_A_657_Junkers_Ju_87G_2_494083_CO.pdf
 * IL-2 contemporary load-table scan (4 x FAB-100; 4 cassettes x 48 PTAB):
 * https://www.redbanner.co.uk/History/IL2_ID/armament/IL2_bombs.html
 * PTAB summer 1943 introduction: Smithsonian, The Flying Tank:
 * https://airandspace.si.edu/air-and-space-quarterly/summer-2022/flying-tank
 * 5 July is the authored Kursk availability boundary. Unknown 1943 dates use bombs.
 * Penetration, blast radii, accuracy, dispersion, cadence and flight are gameplay values.
 */
export const AIRCRAFT = {
  ju87b:{id:'ju87b',name:'Ju 87B',side:'german' as Side},
  ju87g:{id:'ju87g',name:'Ju 87G',side:'german' as Side},
  il2:{id:'il2',name:'IL-2',side:'soviet' as Side},
};
export interface AirLoad {id:string;aircraftId:keyof typeof AIRCRAFT;name:string;weaponId:string;count:number;intervalS:number;dispersionM:number;kind:'bomb'|'cannon'|'ptab'}
export const AIR_LOADS:Record<string,AirLoad>={
  sc50:{id:'sc50',aircraftId:'ju87b',name:'4 × SC 50 (assigned 200 kg)',weaponId:'air_sc50',count:4,intervalS:.4,dispersionM:9,kind:'bomb'},
  bk37:{id:'bk37',aircraftId:'ju87g',name:'2 × BK 3.7, 24 rounds',weaponId:'air_bk37',count:24,intervalS:.12,dispersionM:2,kind:'cannon'},
  fab100:{id:'fab100',aircraftId:'il2',name:'4 × FAB-100 (assigned 400 kg)',weaponId:'air_fab100',count:4,intervalS:.4,dispersionM:11,kind:'bomb'},
  ptab:{id:'ptab',aircraftId:'il2',name:'4 × 48 PTAB-2.5-1.5 (192)',weaponId:'air_ptab',count:192,intervalS:.012,dispersionM:16,kind:'ptab'},
};
function weapon(id:string,name:string,radius:number,penetration:number):WeaponDef{return{id,name,cls:'tankgun',rangeM:800,rate:1,burst:1,accuracy:.7,lethality:.95,suppression:1,penetrationMm:penetration,heRadiusM:radius,ammo:1,reloadS:0};}
export const AIR_WEAPONS:Record<string,WeaponDef>={
  air_sc50:weapon('air_sc50','SC 50',14,45),
  air_fab100:weapon('air_fab100','FAB-100',19,60),
  air_bk37:weapon('air_bk37','BK 3.7 AP',.8,105),
  air_ptab:weapon('air_ptab','PTAB-2.5-1.5',2,70),
};
/** Historical service gate is deliberately conservative when only a year is known. */
export function airArmourAvailable(config:Pick<BattleConfig,'year'|'scenarioDate'>):boolean {
  if(config.year>1943)return true;
  if(config.year<1943)return false;
  return !!config.scenarioDate&&/^1943-\d\d-\d\d$/.test(config.scenarioDate)&&config.scenarioDate>='1943-07-05';
}
export function airLoadFor(config:Pick<BattleConfig,'year'|'scenarioDate'>,side:Side,armour:boolean):AirLoad {
  return AIR_LOADS[armour&&airArmourAvailable(config)?side==='german'?'bk37':'ptab':side==='german'?'sc50':'fab100'];
}
