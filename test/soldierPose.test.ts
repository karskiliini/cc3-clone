// round5-battle.md fix #4: a soldier's sprite pose must follow his mental state (mind.state)
// and Activity, not just his calm Stance. These tests cover the pure selection logic in
// unitRender.ts (poseForSoldier) — the actual rasterised sprites are eyeballed via
// tools/spritePreview.html and captured in ref/wf16/ (no DOM/canvas is available under
// vitest's node environment, so pixel-level assertions live in that manual verification step).
import { describe, it, expect } from 'vitest';
import type { Activity, MentalState, Soldier } from '@/shared/types';
import { poseForSoldier } from '@/render/unitRender';

function soldier(activity: Activity, state: MentalState, health: Soldier['health'] = 'healthy', stance: Soldier['stance'] = 'standing'): Soldier {
  return {
    id: 1, teamId: 1, side: 'german', name: 'Test', rank: 'Gefr', weaponId: 'kar98k',
    ammo: 10, ammoReserve: 0, grenades: 0, health, morale: 50, fatigue: 0, suppression: 0,
    experience: 50, stance, activity, pos: { x: 0, y: 0 }, facing: 0,
    targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [],
    reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -99, cover: 0, kills: 0,
    mind: {
      state, motivation: 50, stress: 0, fear: 0, beliefs: [], threatDir: null, threatLevel: 0,
      lastIncomingAt: -99, hesitation: 0, surrounded: false, helpless: false, stateSince: 0,
      anchor: null, lastCoverSeekAt: -99,
    },
  };
}

describe('poseForSoldier', () => {
  it('draws a calm soldier in his ordinary stance', () => {
    expect(poseForSoldier(soldier('idle', 'calm', 'healthy', 'standing'))).toBe('standing');
    expect(poseForSoldier(soldier('idle', 'calm', 'healthy', 'crouching'))).toBe('crouching');
    expect(poseForSoldier(soldier('idle', 'calm', 'healthy', 'prone'))).toBe('prone');
  });

  it('gives every distinct mental-state activity its own pose, distinct from calm stances', () => {
    const cases: [Activity, MentalState, string][] = [
      ['cowering', 'cowering', 'cowering'],
      ['pinned', 'pinned', 'pinned'],
      ['panicked', 'panicked', 'panicked'],
      ['routed', 'broken', 'panicked'],
      ['berserk', 'berserk', 'berserk'],
      ['surrendered', 'calm', 'surrendered'],
    ];
    for (const [activity, state, expected] of cases) {
      expect(poseForSoldier(soldier(activity, state))).toBe(expected);
    }
  });

  it('shows wary/shaken soldiers presenting their weapon even though Activity has no dedicated value', () => {
    expect(poseForSoldier(soldier('idle', 'wary'))).toBe('wary');
    expect(poseForSoldier(soldier('idle', 'shaken'))).toBe('wary');
    expect(poseForSoldier(soldier('moving', 'wary'))).toBe('wary');
  });

  it('does not let a merely-alert mind override the ordinary stance (alert has its own cues elsewhere)', () => {
    expect(poseForSoldier(soldier('idle', 'alert', 'healthy', 'crouching'))).toBe('crouching');
    expect(poseForSoldier(soldier('idle', 'calm', 'healthy', 'crouching'))).toBe('crouching');
  });

  it('incapacitated soldiers always crawl, regardless of activity or mental state', () => {
    expect(poseForSoldier(soldier('idle', 'calm', 'incapacitated'))).toBe('woundedCrawl');
    expect(poseForSoldier(soldier('firing', 'panicked', 'incapacitated'))).toBe('woundedCrawl');
  });

  it('health-driven woundedCrawl takes priority over an activity-driven pose', () => {
    // An incapacitated soldier can't still be "cowering" as an activity in practice, but the
    // selection order must put health first regardless.
    expect(poseForSoldier(soldier('cowering', 'cowering', 'incapacitated'))).toBe('woundedCrawl');
  });

  it('every mental-state pose is distinct from every calm stance and from each other', () => {
    const poses = new Set([
      poseForSoldier(soldier('idle', 'calm', 'healthy', 'standing')),
      poseForSoldier(soldier('idle', 'calm', 'healthy', 'crouching')),
      poseForSoldier(soldier('idle', 'calm', 'healthy', 'prone')),
      poseForSoldier(soldier('cowering', 'cowering')),
      poseForSoldier(soldier('pinned', 'pinned')),
      poseForSoldier(soldier('panicked', 'panicked')),
      poseForSoldier(soldier('berserk', 'berserk')),
      poseForSoldier(soldier('surrendered', 'calm')),
      poseForSoldier(soldier('idle', 'wary')),
      poseForSoldier(soldier('idle', 'calm', 'incapacitated')),
    ]);
    expect(poses.size).toBe(10);
  });
});
