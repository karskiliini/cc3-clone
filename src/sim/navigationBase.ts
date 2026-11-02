import type {GameMap} from '@/shared/types';
/** Immutable briefing data, captured before play. Never contains live mutable
 * structure/height arrays; physical movement continues using the original map. */
function copy<T>(value:T):T{
 if(typeof value==='function')return undefined as T;
 if(value==null||typeof value!=='object')return value;
 if(ArrayBuffer.isView(value))return (value as unknown as {slice():T}).slice();
 if(value instanceof Map)return new Map([...value].map(([k,v])=>[k,copy(v)])) as T;
 if(value instanceof Set)return new Set(value) as T;
 if(Array.isArray(value))return value.map(copy) as T;
 return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='navigationBriefing').map(([k,v])=>[k,copy(v)])) as T;
}
export function captureNavigationBriefing(map:GameMap):GameMap{
 if(map.navigationBriefing)return map.navigationBriefing;
 const base=copy(map);base.mines=undefined;base.def={...base.def,minefields:undefined};base.navigationChanged=undefined;map.navigationBriefing=base;return base;
}
