import { ORDER_DOT_COLOR } from '@/shared/types';
import type { CommandBody } from '@/sim/commands';
import { isRecord } from './relayProtocol';

export function validCommand(v: unknown, width: number, height: number): v is CommandBody {
  if (!isRecord(v)) return false;
  const id = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  const point = (p: unknown) => isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
  switch (v.type) {
    case 'order': return id(v.teamId) && isRecord(v.order) && Object.hasOwn(ORDER_DOT_COLOR, v.order.type)
      && point(v.order.target) && Number.isFinite(v.order.issuedAt) && v.order.issuedAt >= 0
      && (v.order.waypoints == null || Array.isArray(v.order.waypoints) && v.order.waypoints.length <= 64 && v.order.waypoints.every(point));
    case 'deployTeam': return id(v.teamId) && point(v.pos);
    case 'setSpeed': return [1, 2, 4].includes(v.speed);
    case 'autoDeploy': case 'truce': case 'flee': case 'pause': case 'resume': case 'ready': return true;
    // takeoverAI is a local fork after leaving the room, never a peer command.
    default: return false;
  }
}
