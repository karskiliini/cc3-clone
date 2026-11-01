import { Battle } from '@/sim/battle';
import { makeReplayLog, runReplay, runTicks } from '@/sim/replay';
import { describe, expect, it } from 'vitest';
import { TEAM_DEFS } from '@/data/units';
import { applyOrder } from '@/sim/orders';
import { spawnTeam } from '@/sim/spawn';
import { stepMovement } from '@/sim/movement';
import { stepVehicles } from '@/sim/vehicle';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';
import { SIM_DT } from '@/shared/types';
import { makeState } from './vehicleDamageHelpers';

function setup() {
  const state = makeState(), rng = new Rng(42);
  const mortar = spawnTeam(state, TEAM_DEFS.ger_mortar81, 'german', { x: 100, y: 100 }, rng);
  const carriers = [spawnTeam(state, TEAM_DEFS.ger_kettenkrad, 'german', { x: 101, y: 104 }, rng),
    spawnTeam(state, TEAM_DEFS.ger_kubelwagen, 'german', { x: 106, y: 104 }, rng)];
  for (const c of carriers) c.supportForTeamId = mortar.id;
  mortar.assignedVehicleIds = carriers.map(c => c.vehicleId!);
  applyOrder(state, mortar, { type: 'moveFast', target: { x: 125, y: 100 }, issuedAt: 0 }, rng);
  const tick = () => { state.time = Math.round((state.time + SIM_DT) * 1000) / 1000; state.tick = (state.tick ?? 0) + 1;
    stepMovement(state, rng, SIM_DT); stepVehicles(state, rng, SIM_DT); };
  return { state, rng, mortar, carriers, tick };
}
describe('motorized crew full movement sequence', () => {
  it('packs and transports the whole mortar team, unloads, and starts normal emplacement', () => {
    const s = setup(), phases = new Set<string>(); let aboard = 0;
    for (let i = 0; i < 1500; i++) {
      phases.add(s.mortar.mobility?.phase ?? 'finished');
      s.tick();
      const riding = s.mortar.soldierIds.filter(id => s.state.soldiers.get(id)?.seat === 'passenger').length;
      aboard = Math.max(aboard, riding);
      if (!s.mortar.mobility && i > 10 && s.mortar.crewWeapon?.phase === 'ready') break;
    }
    expect(phases).toEqual(new Set(['packing', 'boarding', 'driving', 'unloading', 'finished']));
    expect(aboard).toBe(4);
    expect(s.mortar.mobility, JSON.stringify({ cw:s.mortar.crewWeapon, men:s.mortar.soldierIds.map(id=>s.state.soldiers.get(id)), vehicles:s.carriers.map(c=>s.state.vehicles.get(c.vehicleId!)) })).toBeUndefined();
    expect(s.mortar.crewWeapon?.phase, JSON.stringify({cw:s.mortar.crewWeapon,order:s.mortar.order,men:s.mortar.soldierIds.map(id=>{const m=s.state.soldiers.get(id)!;return{id:m.id,pos:m.pos,path:m.path.length,end:m.path.at(-1),activity:m.activity,task:m.crewTask}})})).toBe('ready');
    expect(Math.hypot(s.mortar.crewWeapon!.pos.x - 125, s.mortar.crewWeapon!.pos.y - 100)).toBeLessThan(5);
    for (const id of s.mortar.soldierIds) expect(s.state.soldiers.get(id)?.vehicleId).toBeNull();
  }, 20000);
  it('stops and unloads safely when a different order cancels the ride', () => {
    const s = setup();
    for (let i = 0; i < 600 && s.mortar.mobility?.phase !== 'driving'; i++) s.tick();
    expect(s.mortar.mobility?.phase).toBe('driving');
    applyOrder(s.state, s.mortar, { type:'defend', target:{x:110,y:100},issuedAt:s.state.time },s.rng);
    for (let i = 0; i < 400 && s.mortar.mobility; i++) s.tick();
    expect(s.mortar.mobility).toBeUndefined();
    expect(s.mortar.order?.type).toBe('defend');
    expect(s.mortar.soldierIds.every(id=>s.state.soldiers.get(id)?.vehicleId==null)).toBe(true);
  }, 20000);
  it('hashes seat reservations, cargo progress and pending destinations', () => {
    const s = setup(), before = hashState(s);
    s.mortar.mobility!.assignments[s.mortar.leaderId]++;
    expect(hashState(s)).not.toBe(before);
    const next=hashState(s); s.mortar.mobility!.order.target.x++;
    expect(hashState(s)).not.toBe(next);
  });
});


it.each(['jeep', 'kettenkrad'] as const)('%s pulls a compatible packed gun through the vehicle simulation and detaches it', carrierId => {
  const state = makeState(), rng = new Rng(41);
  const side = carrierId === 'jeep' ? 'soviet' : 'german';
  const gun = spawnTeam(state, TEAM_DEFS[carrierId === 'jeep' ? 'sov_45mm_at' : 'ger_pak38'], side, { x: 100, y: 100 }, rng);
  const carrier = spawnTeam(state, TEAM_DEFS[carrierId === 'jeep' ? 'sov_jeep' : 'ger_kettenkrad'], side, { x: 106, y: 100 }, rng);
  const vehicle = state.vehicles.get(carrier.vehicleId!)!;
  applyOrder(state, gun, { type:'moveFast',target:{x:125,y:100},issuedAt:0 },rng);
  expect(gun.mobility?.tow).toBe(true);
  let attached = false, first: number | undefined, last: number | undefined;
  for (let i = 0; i < 2400; i++) {
    state.time = Math.round((state.time + SIM_DT) * 1000) / 1000;
    stepMovement(state,rng,SIM_DT); stepVehicles(state,rng,SIM_DT);
    if (vehicle.towedTeamId === gun.id) { attached = true; first ??= gun.crewWeapon!.pos.x; last = gun.crewWeapon!.pos.x; }
    if (attached && !gun.mobility) break;
  }
  expect(attached, JSON.stringify({mobility:gun.mobility,cw:gun.crewWeapon,v:vehicle.pos})).toBe(true);
  expect(last! - first!).toBeGreaterThan(8);
  expect(gun.mobility).toBeUndefined();
  expect(vehicle.towedTeamId).toBeUndefined();
  expect(gun.crewWeapon?.transport).toBeUndefined();
}, 20000);

it('retargets a ride without legacy auto-unloading and releases reservations after total crew loss', () => {
  const s = setup();
  for (let i=0;i<600 && s.mortar.mobility?.phase!=='driving';i++) s.tick();
  expect(s.mortar.mobility?.phase).toBe('driving');
  applyOrder(s.state,s.mortar,{type:'moveFast',target:{x:135,y:105},issuedAt:s.state.time},s.rng);
  expect(s.mortar.mobility?.phase).toBe('driving');
  for (const c of s.carriers) expect(s.state.vehicles.get(c.vehicleId!)?.unloading).toBeUndefined();
  for (const id of s.mortar.soldierIds) s.state.soldiers.get(id)!.health='dead';
  s.tick(); expect(s.mortar.mobility).toBeUndefined(); expect(s.mortar.order).toBeNull();
  expect(s.mortar.crewWeapon?.abandoned).toBe(true);
});


it('replays the canonical motorized movement sequence after JSON serialization', () => {
  const battle = new Battle({ mapId:'border_1941',playerSide:'german',year:1942,seed:41,durationS:600,
    difficulty:'normal',forces:{german:['ger_mortar81'],soviet:[]},controllers:{german:'human',soviet:'human'} });
  const team=[...battle.state.teams.values()].find(t=>t.type==='mortar')!;
  battle.submit('german',{type:'order',teamId:team.id,order:{type:'moveFast',target:{x:team.pos.x+25,y:team.pos.y},issuedAt:0}});
  battle.submit('german',{type:'ready'}); battle.submit('soviet',{type:'ready'});
  const chain=runTicks(battle,900), log=JSON.parse(JSON.stringify(makeReplayLog(battle)));
  expect(chain).toHaveLength(900); expect(runReplay(log).chain).toEqual(chain);
}, 20000);

it('holds a loading carrier despite a separate gun-creep request', () => {
  const s=setup(), control=setup(), v=s.state.vehicles.get(s.carriers[0].vehicleId!)!;
  const stopped=control.state.vehicles.get(control.carriers[0].vehicleId!)!;
  v.creepForGun=true; v.creepAim={x:v.pos.x+10,y:v.pos.y}; v.creepUntil=100;
  for(let i=0;i<5;i++){s.tick();control.tick();}
  expect(s.mortar.mobility?.phase).toBe('packing');
  expect(v.pos).toEqual(stopped.pos);
  expect(v.body!.velocity).toEqual(stopped.body!.velocity);
  expect(v.body!.orientation).toEqual(stopped.body!.orientation);
});


it('releases the drivers and leaves the kit when the whole unloaded crew remains panicked', () => {
  const s=setup();for(let i=0;i<600 && s.mortar.mobility?.phase!=='driving';i++)s.tick();
  expect(s.mortar.mobility?.phase).toBe('driving');
  for(const id of s.mortar.soldierIds)s.state.soldiers.get(id)!.mind.state='panicked';
  const driver=s.state.soldiers.get(s.carriers[0].soldierIds[0])!;driver.mind.state='panicked';
  for(let i=0;i<500 && s.mortar.mobility;i++)s.tick();
  expect(s.mortar.mobility).toBeUndefined();expect(s.mortar.crewWeapon?.abandoned).toBe(true);
  for(const c of s.carriers)expect(s.state.vehicles.get(c.vehicleId!)!.mobilityTeamId).toBeUndefined();
});


it('clears completed loading actions before driving and reports driver movement', () => {
  const s=setup();for(let i=0;i<600 && s.mortar.mobility?.phase!=='driving';i++)s.tick();
  expect(s.mortar.mobility?.phase).toBe('driving');
  for(const id of s.mortar.soldierIds)expect(s.state.soldiers.get(id)!.crewTask).toBeUndefined();
  for(const c of s.carriers)expect(s.state.soldiers.get(c.soldierIds[0])!.activity).toBe('moving');
});

it('does not strand passengers or teleport cargo to a surviving carrier if the cargo vehicle disappears', () => {
  const s=setup();for(let i=0;i<600 && s.mortar.mobility?.phase!=='driving';i++)s.tick();
  const primary=s.mortar.mobility!.vehicleIds[0];s.state.vehicles.delete(primary);
  for(let i=0;i<400 && s.mortar.mobility;i++)s.tick();
  expect(s.mortar.mobility).toBeUndefined();expect(s.mortar.crewWeapon?.destroyed).toBe(true);
  for(const id of s.mortar.soldierIds)expect(s.state.soldiers.get(id)!.vehicleId).toBeNull();
});
