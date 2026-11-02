/** 058/059 production-kernel trace. All setup/actions pass through commands;
 * rendering/camera readers can be added by the caller between advance calls. */
import { Battle } from '@/sim/battle';
import { hashState } from '@/sim/stateHash';
import { makeReplayLog, runReplay } from '@/sim/replay';
import type { BattleConfig } from '@/shared/types';

export function supportTrace(night: boolean, ticks = night ? 1300 : 400) {
  const config: BattleConfig = {
    mapId: 'village_1942', playerSide: 'german', year: 1944,
    scenarioDate: '1944-07-15', seed: 58059, durationS: 600,
    difficulty: 'normal', controllers: { german: 'human', soviet: 'human' },
    timeOfDay: night ? 'night' : 'day', weather: 'clear',
    illuminationRounds: 1,
    airSupport: { german: { missions: 1, availableAtS: 0 }, soviet: { missions: 1, availableAtS: 0 } },
    neverActOnInitiative: true, alwaysObeyOrders: true,
    forces: { german: ['ger_mortar81', 'ger_command'], soviet: ['sov_rifle_41'] },
  };
  const b = new Battle(config);
  const mortar = [...b.state.teams.values()].find(t => t.type === 'mortar')!;
  b.submit('german', { type: 'deployTeam', teamId: mortar.id, pos: { x: 112, y: 120 } });
  b.step(0);
  b.submit('german', { type: 'ready' }); b.submit('soviet', { type: 'ready' }); b.step(0);
  const chain: number[] = [];
  const activity = { shots: 0, flares: 0, ordnance: 0, released: 0, complete: 0 };
  for (let i = 0; i < ticks; i++) {
    if (i === 300 && night) b.submit('german', { type: 'illuminate', teamId: mortar.id, target: { x: 105, y: 83 } });
    if (i === 5 && !night) {
      b.submit('german', { type: 'airSupport', target: { x: 105, y: 65 }, role: 'bombing' });
      b.submit('soviet', { type: 'airSupport', target: { x: 112, y: 120 }, role: 'armour' });
    }
    b.advanceTick(); b.drainEvents(); chain.push(hashState(b));
    activity.shots = Math.max(activity.shots, b.state.illuminationShots?.length ?? 0);
    activity.flares = Math.max(activity.flares, b.state.flares?.length ?? 0);
    activity.ordnance = Math.max(activity.ordnance, b.state.airSupport?.ordnance.length ?? 0);
    activity.released = b.state.airSupport?.missions.reduce((n, m) => n + m.releaseIndex, 0) ?? 0;
    activity.complete = b.state.airSupport?.missions.filter(m => m.phase === 'complete').length ?? 0;
  }
  const replay = runReplay(makeReplayLog(b));
  const replayHash = hashState(replay.battle), finalHash = hashState(b);
  if (replayHash !== finalHash) throw new Error(`Support replay differs: ${finalHash} / ${replayHash}`);
  return { night, ticks, chain, finalHash, replayHash, activity,
    remainingFlares: b.state.flares?.length ?? 0,
    illuminationAmmo: mortar.illuminationAmmo,
    loads: b.state.airSupport?.missions.map(m => m.loadId) ?? [] };
}
