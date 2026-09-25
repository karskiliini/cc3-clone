import type { BattleState, Order, Side } from '@/shared/types';
import type { Battle } from '@/sim/battle';

// ============================================================================
// bootcamp.ts — the five boot-camp tutorial missions (roadmap G5).
//
// Each lesson wraps a normal battle with a list of scripted tasks. A task is a
// predicate over the battle state plus the events it watches; failing an
// active task (or taking too long) pauses the battle with a modal, exactly as
// the original's boot camp did ("Boot camp won't work if you don't obey your
// orders").
// ============================================================================

export interface BootTask {
  /** instruction shown in the modal / HUD banner */
  text: string;
  /** true when the task is complete */
  done: (state: BattleState, battle: BootTracked) => boolean;
  /** true when the task can no longer be completed (modal, replay) */
  failed?: (state: BattleState, battle: BootTracked) => boolean;
}

/** Extra per-battle tracking the task predicates read (counts of order types
 * the player issued, whether a shot was fired, etc.). Populated by the boot
 * camp battle subclass/screen. */
export interface BootTracked {
  ordersIssued: Order['type'][];
  shotsFired: boolean;
  smokeFired: boolean;
  /** map of teamId -> whether a defend order was placed with a facing set */
  defendPlaced: boolean;
  /** the player toggled the Team/Soldier monitor (F5/F7) — lesson 4's first task */
  monitorToggled?: boolean;
  /** the player selected at least one team in the battle UI — lesson 1's first task */
  selectionMade?: boolean;
}
export interface BootLesson {
  id: string;
  title: string;
  intro: string;
  /** battle setup: small forces on a quiet map */
  forces: Record<Side, string[]>;
  mapId: string;
  year: number;
  durationS: number;
  tasks: BootTask[];
}

// ------------------------------------------------------------ order tracking

export function makeTracked(): BootTracked {
  return { ordersIssued: [], shotsFired: false, smokeFired: false, defendPlaced: false };
}

export function trackOrder(t: BootTracked, order: Order): void {
  t.ordersIssued.push(order.type);
  if (order.type === 'defend') t.defendPlaced = true;
  if (order.type === 'smoke') t.smokeFired = true;
}

// ---------------------------------------------------------------- the lessons

const moveLesson: BootLesson = {
  id: 'bootMove',
  title: 'Boot Camp 1 — Moving Your Troops',
  intro:
    'Select a team (left-click a team box), then press Z for Move, X for Move Fast, C for Sneak and click the destination. ' +
    'Fine, soldier — you have learned to move. Get your squad to the objective without losing a man.',
  mapId: 'border_1941',
  year: 1941,
  durationS: 600,
  forces: { german: ['ger_command', 'ger_rifle_41'], soviet: [] },
  tasks: [
    {
      text: 'Select your rifle team (left-click its box on the team grid).',
      done: (_state, tracked) => tracked.selectionMade === true,
    },
    {
      text: 'Issue a MOVE order (press Z, then click a destination).',
      done: (_state, tracked) => tracked.ordersIssued.includes('move'),
      failed: (_state, tracked) => tracked.ordersIssued.includes('moveFast') || tracked.ordersIssued.includes('sneak'),
    },
    {
      text: 'Issue a MOVE FAST order (press X, then click a destination).',
      done: (_state, tracked) => tracked.ordersIssued.includes('moveFast'),
    },
    {
      text: 'Issue a SNEAK order (press C, then click a destination).',
      done: (_state, tracked) => tracked.ordersIssued.includes('sneak'),
    },
  ],
};

const fireLesson: BootLesson = {
  id: 'bootFire',
  title: 'Boot Camp 2 — Firing on the Enemy',
  intro:
    'Teams hide and fire only when the target comes into their field of fire. Press V for Fire and click the target, ' +
    'B orders smoke, N defends, M sets an ambush. Now issue FIRE, SMOKE, DEFEND and AMBUSH orders.',
  mapId: 'border_1941',
  year: 1941,
  durationS: 600,
  forces: { german: ['ger_command', 'ger_rifle_41', 'ger_mg34_hmg'], soviet: ['sov_rifle_41'] },
  tasks: [
    {
      text: 'Issue a FIRE order (press V, then click an enemy team).',
      done: (_state, tracked) => tracked.ordersIssued.includes('fire') || tracked.shotsFired,
    },
    {
      text: 'Order SMOKE (press B, then click a spot) to cover the approach.',
      done: (_state, tracked) => tracked.smokeFired,
    },
    {
      text: 'Place a DEFEND order (press N, then click a position).',
      done: (_state, tracked) => tracked.defendPlaced,
    },
    {
      text: 'Set an AMBUSH (press M, then click a position) and wait for the enemy.',
      done: (_state, tracked) => tracked.ordersIssued.includes('ambush'),
    },
  ],
};

const monitorLesson: BootLesson = {
  id: 'bootMonitor',
  title: 'Boot Camp 4 — Monitoring Your Forces',
  intro:
    'The Team Monitor (F5) and Soldier Monitor (F7) tell you who is tired, pinned or out of ammo. ' +
    'Keep an eye on the monitors while your mortar team climbs the hill — watch their fatigue grow.',
  mapId: 'border_1941',
  year: 1941,
  durationS: 600,
  forces: { german: ['ger_command', 'ger_rifle_41', 'ger_mortar81'], soviet: [] },
  tasks: [
    {
      text: 'Open the Team Monitor (press F5 or toggle it in the Options dialog), then MOVE your mortar team up the hill.',
      done: (_state, tracked) =>
        (tracked as BootTracked & { monitorToggled?: boolean }).monitorToggled === true &&
        tracked.ordersIssued.includes('move'),
    },
    {
      text: 'Watch fatigue: their physical state on the Soldier Monitor drops toward Winded.',
      done: (state) =>
        [...state.soldiers.values()].some((s) => s.fatigue > 40 && s.side === state.config.playerSide),
    },
  ],
};

const tacticsLesson: BootLesson = {
  id: 'bootTactics',
  title: 'Boot Camp 3 — Commanders and Tactics',
  intro:
    'Assault with FIREPOWER AND MOVEMENT: one team suppresses while another closes. ' +
    'Capture the enemy-held victory location by combining fire and movement orders.',
  mapId: 'border_1941',
  year: 1941,
  durationS: 900,
  forces: { german: ['ger_command', 'ger_rifle_41', 'ger_rifle_41', 'ger_mg34_hmg'], soviet: ['sov_rifle_41', 'sov_mortar82'] },
  tasks: [
    {
      text: 'Suppress the enemy: order FIRE on a spotted enemy team.',
      done: (_state, tracked) => tracked.ordersIssued.includes('fire'),
    },
    {
      text: 'While the enemy is pinned, MOVE a second team toward the victory location.',
      done: (state, tracked) =>
        tracked.ordersIssued.includes('move') &&
        [...state.teams.values()].filter((t) => t.side === state.config.playerSide && !t.outOfAction).length >= 3,
    },
    {
      text: 'Capture the objective: hold the enemy victory location at any point.',
      done: (state) => state.map.victoryLocations.some((vl) => vl.owner === state.config.playerSide && vl.value >= 2),
    },
  ],
};


const armourLesson: BootLesson = {
  id: 'bootArmour',
  title: 'Boot Camp 5 — Fighting with Armour',
  intro:
    'Move or sneak when moving BACKWARD, keep your front armour to the enemy, and hunt flank shots. ' +
    'Move the T-34 with its hull toward the enemy, then engage with FIRE.',
  mapId: 'steppe_1943',
  year: 1943,
  durationS: 900,
  forces: { german: ['ger_command', 'ger_rifle_43', 'ger_pak38'], soviet: ['sov_command', 'sov_t34_76', 'sov_rifle_43'] },
  tasks: [
    {
      text: 'Select your tank team and MOVE it (keep the hull facing the threat).',
      done: (_state, tracked) => tracked.ordersIssued.includes('move'),
    },
    {
      text: 'Engage with FIRE: order your tank to fire on the enemy.',
      done: (_state, tracked) => tracked.ordersIssued.includes('fire') || tracked.shotsFired,
    },
    {
      text: 'Destroy or drive off the enemy gun (knock out the PaK or survive to the ceasefire).',
      done: (state) =>
        [...state.vehicles.values()].some((v) => v.state === 'knockedOut' || v.state === 'abandoned') ||
        state.sides[state.config.playerSide].score > 0,
    },
  ],
};

/** The five lessons, in boot camp order. */
export const BOOT_LESSONS: BootLesson[] = [moveLesson, fireLesson, tacticsLesson, monitorLesson, armourLesson];

export function lessonById(id: string): BootLesson | undefined {
  return BOOT_LESSONS.find((l) => l.id === id);
}
