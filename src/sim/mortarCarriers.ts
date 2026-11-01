import type { BattleState, Side, Vec2, Team } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { TEAM_DEFS, VEHICLE_DEFS } from '@/data/units';
import { findVehicleDeploySpot, spawnTeam, placeVehicleTeam } from './spawn';
import { isPassable } from './path';

/** Closest vehicle-passable tile in the owning side's deployment area. A mortar may start
 * in infantry-only cover; passing that anchor straight to spawnTeam can put a car in a house. */
function carrierAnchor(state: BattleState, side: Side, near: Vec2): Vec2 {
  const zone = state.map.def.deployZones[side];
  let best: Vec2 | undefined, distance = Infinity;
  for (let y = Math.max(0, Math.floor(zone.y)); y < Math.min(state.map.height, zone.y + zone.h); y++) {
    for (let x = Math.max(0, Math.floor(zone.x)); x < Math.min(state.map.width, zone.x + zone.w); x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (p.x < zone.x || p.x >= zone.x + zone.w || p.y < zone.y || p.y >= zone.y + zone.h
        || !isPassable(state.map, x, y, 'vehicle')) continue;
      const dx=p.x-near.x, dy=p.y-near.y, d=dx*dx+dy*dy;
      if (d < distance) { distance = d; best = p; }
    }
  }
  return best ?? near;
}

/** Organic carriers are additional one-driver transport teams, linked to their mortar team.
 * Call once after BOTH normal rosters have spawned, preserving their team-order campaign IDs.
 * Snapshotting and the existing-assignment guard also make repeated calls harmless.
 * The mixed German pair supplies five passenger places; two Jeeps supply six. */
export function spawnMortarCarriers(state: BattleState, rng: Rng): void {
  const mortars = [...state.teams.values()].filter(t => t.type === 'mortar' && t.supportForTeamId === undefined);
  // spawnTeam reads campaign UIDs by teams.size. Organic drivers must never inherit an unused
  // roster entry, including malformed/oversized campaign payloads. Keep the original config intact.
  const spawnState: BattleState = { ...state, config: { ...state.config, rosterUids: undefined } };
  try {
    for (const mortar of mortars) {
      if (mortar.assignedVehicleIds?.length) continue;
      const defs = mortar.side === 'german' ? ['ger_kettenkrad', 'ger_kubelwagen'] : ['sov_jeep', 'sov_jeep'];
      const assigned: number[] = [];
      for (const defId of defs) {
        const def = TEAM_DEFS[defId];
        const anchor = carrierAnchor(state, mortar.side, mortar.pos);
        const pos = findVehicleDeploySpot(state, mortar.side, def.vehicleDefId!, anchor, [...state.vehicles.values()]);
        const carrier = spawnTeam(spawnState, def, mortar.side, pos, rng);
        carrier.supportForTeamId = mortar.id;
        carrier.name = `${mortar.name} / ${def.name}`;
        if (carrier.vehicleId !== null && VEHICLE_DEFS[def.vehicleDefId!].lightTransport) assigned.push(carrier.vehicleId);
      }
      mortar.assignedVehicleIds = assigned;
    }
  } finally {
    // Entity maps are shared by the facade; the scalar allocation cursor must be copied back.
    state.nextId = spawnState.nextId;
  }
}


/** Pre-battle repositioning follows the mortar's deployment, never a running-battle teleport. */
export function alignMortarCarriers(state: BattleState, mortar: Team): void {
  if (state.phase !== 'deploy') return;
  for (const id of mortar.assignedVehicleIds ?? []) {
    const v=state.vehicles.get(id); if (!v) continue;
    const want=carrierAnchor(state,mortar.side,mortar.pos);
    const pos=findVehicleDeploySpot(state,mortar.side,v.defId,want,[...state.vehicles.values()].filter(other=>other!==v));
    placeVehicleTeam(state,v,pos); v.path=[];
  }
}
