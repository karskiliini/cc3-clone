import { describe, it, expect } from 'vitest';
import { reissueOrderOnMarkerDrag } from '@/ui/screens/viewKeys';
import type { Order, Vec2 } from '@/shared/types';

const P = (x: number, y: number): Vec2 => ({ x, y });

describe('marker drag keeps earlier waypoints (item 017)', () => {
  const wp: Order = {
    type: 'moveFast', target: P(30, 30), issuedAt: 5,
    waypoints: [P(10, 10), P(20, 20)],
  };

  it('dragging the endpoint preserves the Shift-click waypoints', () => {
    const out = reissueOrderOnMarkerDrag(wp, { kind: 'target', index: 0, orderType: 'moveFast' }, P(40, 35));
    expect(out).not.toBeNull();
    expect(out!.target).toEqual(P(40, 35));
    expect(out!.waypoints).toEqual([P(10, 10), P(20, 20)]);
  });

  it('dragging a waypoint dot rewrites only that point in place', () => {
    const out = reissueOrderOnMarkerDrag(wp, { kind: 'waypoint', index: 1, orderType: 'moveFast' }, P(25, 22));
    expect(out!.target).toEqual(P(30, 30));
    expect(out!.waypoints).toEqual([P(10, 10), P(25, 22)]);
  });

  it('a non-move order has no waypoints to keep (fire/smoke endpoint drag just retargets)', () => {
    const fire: Order = { type: 'fire', target: P(20, 20), issuedAt: 5 };
    const out = reissueOrderOnMarkerDrag(fire, { kind: 'target', index: 0, orderType: 'fire' }, P(22, 22));
    expect(out!.target).toEqual(P(22, 22));
    expect(out!.waypoints).toBeUndefined();
  });

  it('a stale drag (order type changed since press) is dropped', () => {
    expect(reissueOrderOnMarkerDrag(wp, { kind: 'target', index: 0, orderType: 'move' }, P(40, 35))).toBeNull();
    // waypoint dot on a non-move order is stale too
    const fire: Order = { type: 'fire', target: P(20, 20), issuedAt: 5 };
    expect(reissueOrderOnMarkerDrag(fire, { kind: 'waypoint', index: 0, orderType: 'fire' }, P(1, 1))).toBeNull();
    // waypoint index beyond the surviving chain (a leg was consumed en route) is stale
    const consumed: Order = { type: 'move', target: P(30, 30), issuedAt: 5, waypoints: [P(10, 10)] };
    expect(reissueOrderOnMarkerDrag(consumed, { kind: 'waypoint', index: 1, orderType: 'move' }, P(1, 1))).toBeNull();
  });
});
