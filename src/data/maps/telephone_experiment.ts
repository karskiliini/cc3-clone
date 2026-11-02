import type {MapDef} from '@/shared/types';
export const telephone_experiment:MapDef={
 id:'telephone_experiment',name:'Telephone training ground',description:'Experimental radio and field telephone report relay. A warehouse separates the receiving squad from a stationary T-34 training target.',width:80,height:56,season:'summer',attacker:'german',
 deployZones:{german:{x:1,y:1,w:58,h:54},soviet:{x:61,y:1,w:18,h:54}},
 victoryLocations:[{id:1,name:'Observation post',x:54,y:40,value:1}],
 paint(tiles,w,h){tiles.fill('grass');for(let x=0;x<w;x++)for(let y=5;y<=7;y++)tiles[y*w+x]='pavedroad';for(let x=28;x<=32;x++)for(let y=12;y<h;y++)tiles[y*w+x]='buildingStone';for(let x=66;x<=78;x++)for(let y=1;y<=12;y++)tiles[y*w+x]='buildingStone';},
};
