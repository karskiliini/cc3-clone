import { describe, it, expect } from 'vitest';
import { BOOT_LESSONS, lessonById, makeTracked, trackOrder, type BootLesson } from '../src/ui/screens/bootcamp';

describe('boot camp lessons (G5)', () => {
  it('ships exactly five lessons in the manual\'s boot-camp order', () => {
    expect(BOOT_LESSONS.length).toBe(5);
    expect(BOOT_LESSONS.map((l: BootLesson) => l.title).some((t) => t.includes('Moving Your Troops'))).toBe(true);
    expect(BOOT_LESSONS.map((l) => l.title).some((t) => t.includes('Firing on the Enemy'))).toBe(true);
    expect(BOOT_LESSONS.map((l) => l.title).some((t) => t.includes('Commanders and Tactics'))).toBe(true);
    expect(BOOT_LESSONS.map((l) => l.title).some((t) => t.includes('Monitoring Your Forces'))).toBe(true);
    expect(BOOT_LESSONS.map((l) => l.title).some((t) => t.includes('Fighting with Armour'))).toBe(true);
  });

  it('every lesson is well-formed: intro text, forces for both sides, at least two tasks', () => {
    for (const l of BOOT_LESSONS) {
      expect(l.intro.length).toBeGreaterThan(40);
      expect(l.tasks.length).toBeGreaterThanOrEqual(2);
      expect(l.forces.german.length).toBeGreaterThan(0);
      expect(l.durationS).toBeGreaterThan(0);
      expect(lessonById(l.id)).toBe(l);
    }
  });

  it('task tracking records the order types a task predicate reads', () => {
    const t = makeTracked();
    trackOrder(t, { type: 'move', target: { x: 1, y: 1 }, issuedAt: 0 });
    trackOrder(t, { type: 'smoke', target: { x: 2, y: 2 }, issuedAt: 1 });
    trackOrder(t, { type: 'defend', target: { x: 3, y: 3 }, issuedAt: 2 });
    expect(t.ordersIssued).toEqual(['move', 'smoke', 'defend']);
    expect(t.smokeFired).toBe(true);
    expect(t.defendPlaced).toBe(true);
    // the move lesson's task 2 completes on a plain move order
    expect(BOOT_LESSONS[0].tasks[1].done({} as never, t)).toBe(true);
    // but its fail predicate trips on a moveFast issued when a move was asked
    expect(BOOT_LESSONS[0].tasks[1].failed?.({} as never, { ...makeTracked(), ordersIssued: ['moveFast'] })).toBe(true);
  });
});
