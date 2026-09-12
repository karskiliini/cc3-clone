// ============================================================================
// palette.ts — all color constants for the game. Muted, painted, CC3-style.
// ============================================================================
import type { Season, Terrain, OrderType, Side, TeamStatusWord } from '@/shared/types';

/** Chrome / UI colors (bottom panel, bevels, headings). */
export const PALETTE = {
  chromeBg: '#3a3f36',
  bevelLight: '#6b7064',
  bevelDark: '#1c1f1a',
  gold: '#d8b448',
  text: '#e8e8e0',
  dim: '#9a9c94',
  red: '#c8402c',
  green: '#5fbf4a',
  yellow: '#e0c04a',
  blue: '#5a8fd0',
  cyan: '#4ac0c0',
  orange: '#e08a2c',
  white: '#f0f0ec',
  black: '#100f0c',
} as const;

/** 2-4 shades per terrain, per season. Index 0 is the "base" shade used for solid fills. */
export const TERRAIN_COLORS: Record<Season, Record<Terrain, string[]>> = {
  summer: {
    open: ['#8a7a52', '#8f7f58', '#84754c', '#93844f'],
    grass: ['#6f7d3d', '#75843f', '#6a7838', '#7d8a45'],
    tallgrass: ['#647536', '#6d7e3c', '#5c6c30'],
    crops: ['#9a8f3f', '#a39847', '#8f8438'],
    dirtroad: ['#8a7a56', '#8f7f5c', '#7f6f4c'],
    pavedroad: ['#6e6e68', '#75756f', '#65655f'],
    woods: ['#2f4a26', '#355230', '#2a4020'],
    scatteredtrees: ['#3e5a30', '#456238', '#375228'],
    buildingWood: ['#6b4b2e', '#755436', '#5f4227'],
    buildingStone: ['#5b5b60', '#63636a', '#535358'],
    floor: ['#7a7264', '#82796c', '#726a5c'],
    rubble: ['#7a7670', '#847f78', '#8a5a52', '#6e6a64'],
    stonewall: ['#7a746a', '#847e72', '#6e6862'],
    hedge: ['#3e5a2a', '#456230', '#365024'],
    fence: ['#6b5636', '#75603c', '#5f4c2e'],
    water: ['#3f5f73', '#456a7c', '#38566a'],
    bridge: ['#7a6a4c', '#836f52', '#6f6044'],
    snow: ['#dfe3e8', '#d2d8e0', '#e6eaef'],
    mud: ['#5a4a34', '#63523a', '#50412c'],
    crater: ['#4a3f30', '#524638', '#403528'],
    trench: ['#4d4232', '#554a38', '#453a2c'],
  },
  autumn: {
    open: ['#93803f', '#9a8846', '#8a7838'],
    grass: ['#8a8339', '#93893f', '#7d7832'],
    tallgrass: ['#8a7a34', '#93843c', '#7c6e2e'],
    crops: ['#a68a34', '#b0953c', '#9a7f2c'],
    dirtroad: ['#8a7a56', '#8f7f5c', '#7f6f4c'],
    pavedroad: ['#6e6e68', '#75756f', '#65655f'],
    woods: ['#5a3f20', '#7a4e24', '#8f6a28'],
    scatteredtrees: ['#8a5a26', '#a06e2a', '#6e4a20'],
    buildingWood: ['#6b4b2e', '#755436', '#5f4227'],
    buildingStone: ['#5b5b60', '#63636a', '#535358'],
    floor: ['#7a7264', '#82796c', '#726a5c'],
    rubble: ['#7a7670', '#847f78', '#8a5a52', '#6e6a64'],
    stonewall: ['#7a746a', '#847e72', '#6e6862'],
    hedge: ['#5a4f24', '#635828', '#524820'],
    fence: ['#6b5636', '#75603c', '#5f4c2e'],
    water: ['#3f5f73', '#456a7c', '#38566a'],
    bridge: ['#7a6a4c', '#836f52', '#6f6044'],
    snow: ['#dfe3e8', '#d2d8e0', '#e6eaef'],
    mud: ['#5a4a34', '#63523a', '#50412c'],
    crater: ['#4a3f30', '#524638', '#403528'],
    trench: ['#4d4232', '#554a38', '#453a2c'],
  },
  winter: {
    open: ['#dfe3e8', '#d2d8e0', '#c7cdd6'],
    grass: ['#d6dce4', '#cad1db', '#dfe4ea'],
    tallgrass: ['#c9d0da', '#bcc4d0', '#d2d8e2'],
    crops: ['#d2d8e2', '#c5ccd8', '#dbe1e8'],
    dirtroad: ['#9a988e', '#a4a298', '#8f8d84'],
    pavedroad: ['#8c8c86', '#95958e', '#82827c'],
    woods: ['#2a3c30', '#33453a', '#243428'],
    scatteredtrees: ['#38493c', '#405246', '#303f34'],
    buildingWood: ['#6b4b2e', '#755436', '#5f4227'],
    buildingStone: ['#5b5b60', '#63636a', '#535358'],
    floor: ['#7a7264', '#82796c', '#726a5c'],
    rubble: ['#8a8a86', '#94948e', '#9a6660', '#7e7e78'],
    stonewall: ['#8a8880', '#928f86', '#7e7c74'],
    hedge: ['#5c6a5c', '#647264', '#546254'],
    fence: ['#6b5636', '#75603c', '#5f4c2e'],
    water: ['#4a6a7c', '#517486', '#41606f'],
    bridge: ['#8a8478', '#928c80', '#7e7870'],
    snow: ['#eef1f4', '#e6eaef', '#dfe3e8', '#f4f6f8'],
    mud: ['#6a6458', '#736c5f', '#5f594e'],
    crater: ['#6a6a64', '#73736c', '#5f5f58'],
    trench: ['#5a5850', '#625f56', '#514f48'],
  },
};

/** Team status word -> HUD color. */
export function STATUS_COLOR(word: TeamStatusWord): string {
  switch (word) {
    case 'Idle':
    case 'Defending':
    case 'Ambushing':
      return PALETTE.green;
    case 'Moving':
    case 'Moving Fast':
    case 'Sneaking':
      return PALETTE.white;
    case 'Firing':
      return PALETTE.yellow;
    case 'Pinned':
    case 'Cowering':
      return PALETTE.orange;
    case 'Panicked':
    case 'Routed':
    case 'Broken':
      return PALETTE.red;
    case 'Destroyed':
    case 'Knocked Out':
      return PALETTE.dim;
    case 'Surrendered':
      return PALETTE.white;
    default:
      return PALETTE.text;
  }
}

/** Soldier health / activity word colors used by soldier cards & tiny figures. */
export const HEALTH_COLOR = {
  healthy: PALETTE.green,
  wounded: PALETTE.yellow,
  incapacitated: PALETTE.red,
  dead: '#4a4a46',
} as const;

export const ORDER_COLOR: Record<OrderType, string> = {
  move: '#5fbf4a',
  moveFast: '#e0c04a',
  sneak: '#5a8fd0',
  fire: '#c8402c',
  smoke: '#e8e8e0',
  defend: '#4ac0c0',
  ambush: '#e08a2c',
};

export const SIDE_COLOR: Record<Side, string> = {
  german: '#7b8aa0',
  soviet: '#c04030',
};

// ============================================================================
// HUD palette — the dark-maroon in-battle chrome (bottom panel, team grid,
// combat messages, soldier monitor, minimap frame, command menu). Owned by
// the HUD agent; kept separate from the olive PALETTE above which the menu
// screens still use.
// ============================================================================
export const HUD = {
  base: '#3b1410',
  face: '#4a1a14',
  bevelLight: '#7a3a2e',
  bevelDark: '#1e0806',
  frame: '#1e0806',
  text: '#f0f0ec',
  gold: '#e8d83c',
  green: '#3fbf3f',
  yellow: '#e8d83c',
  red: '#d02020',
  darkRed: '#6e1616',
  cyan: '#3ccfc8',
  dim: '#a89088',
  titleRed: '#d64b3c',
  black: '#0c0402',
} as const;
