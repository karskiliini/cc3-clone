import type { Screen, GameSettings, OperationState, BattleConfig, CampaignState } from '@/shared/types';
import type { Battle } from '@/sim/battle';
import type { Sfx } from '@/audio/sfx';
import { createCamera } from '@/engine/camera';
import { createInput } from '@/engine/input';

const SETTINGS_KEY = 'cc3.settings';

const DEFAULT_SETTINGS: GameSettings = {
  volume: 0.7,
  // The original shows no floating team-name labels by default (they are an
  // optional overlay); keep the Shift+L hotkey / options toggle available.
  unitLabels: false,
  losLines: true,
  speed: 1,
  // Selected units' vision overlay, toggled with 'L'.
  showUnitVision: true,
  // Tab: depth/height map view over the battlefield.
  showDepthMap: false,
  // Spotted enemy vehicles carry their name on the map; off makes you learn them by outline.
  enemyVehicleNames: true,
};

function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class NullScreen implements Screen {
  update(): void {}
  draw(): void {}
}

export class Game {
  settings: GameSettings;
  screen: Screen;
  /** assigned by main.ts once the canvas element exists */
  input!: ReturnType<typeof createInput>;
  cam = createCamera();
  audio?: Sfx;
  operation: OperationState | null = null;
  /** persistent campaign roster (G1); filled by the requisition screen, folded after battles */
  campaign: CampaignState | null = null;
  battleConfig: BattleConfig | null = null;
  battle: Battle | null = null;

  constructor() {
    this.settings = loadSettings();
    this.screen = new NullScreen();
    void this.initAudio();
  }

  private async initAudio(): Promise<void> {
    try {
      const mod = await import('@/audio/sfx');
      this.audio = new mod.Sfx();
      this.audio.setVolume(this.settings.volume);
      // Dev-only hook so a live/headless browser check can read audio state
      // (ctx.state, master volume, per-kind play counts) without shipping any
      // instrumentation into the production build.
      if ((import.meta as any).env?.DEV) {
        (window as any).__cc3Audio = this.audio;
      }
    } catch {
      // audio module not available yet
    }
  }

  setScreen(s: Screen): void {
    this.screen.onExit?.();
    this.screen = s;
    this.screen.onEnter?.();
  }

  saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore storage errors
    }
  }
}

export const game = new Game();
