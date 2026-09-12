import { Sfx, type SfxKind } from '@/audio/sfx';

const KINDS: SfxKind[] = [
  'rifle', 'smg', 'lmg', 'hmg', 'pistol',
  'mortarFire', 'mortarHit', 'tankGun', 'atGun', 'explosion', 'grenade',
  'ricochet', 'smokePop', 'click', 'message', 'flagCapture', 'scream',
];

const sfx = new Sfx();

function unlockOnce(): void {
  sfx.unlock();
}
window.addEventListener('pointerdown', unlockOnce, { once: false });
window.addEventListener('keydown', unlockOnce, { once: false });

const root = document.getElementById('buttons')!;
for (const kind of KINDS) {
  const btn = document.createElement('button');
  btn.textContent = kind;
  btn.className = 'sfx-btn';
  btn.addEventListener('click', () => {
    sfx.unlock();
    sfx.play(kind, 1);
  });
  root.appendChild(btn);
}

const volumeSlider = document.getElementById('volume') as HTMLInputElement;
volumeSlider.addEventListener('input', () => {
  sfx.setVolume(Number(volumeSlider.value) / 100);
});
sfx.setVolume(Number(volumeSlider.value) / 100);

const ambientToggle = document.getElementById('ambient') as HTMLInputElement;
ambientToggle.addEventListener('change', () => {
  sfx.unlock();
  sfx.ambient(ambientToggle.checked);
});

// Engine slider: drives a single fake vehicle id=1, speedFactor 0..1.
const engineSlider = document.getElementById('engine') as HTMLInputElement;
const engineToggle = document.getElementById('engineOn') as HTMLInputElement;
function updateEngine(): void {
  if (!engineToggle.checked) {
    sfx.engine(1, null);
    return;
  }
  sfx.engine(1, Number(engineSlider.value) / 100);
}
engineToggle.addEventListener('change', () => {
  sfx.unlock();
  updateEngine();
});
engineSlider.addEventListener('input', updateEngine);

// A few extra engines to exercise the concurrency cap.
const multiEngineBtn = document.getElementById('spawnEngines') as HTMLButtonElement;
multiEngineBtn.addEventListener('click', () => {
  sfx.unlock();
  for (let id = 2; id <= 8; id++) {
    sfx.engine(id, 0.3 + Math.random() * 0.5);
  }
});
const stopEnginesBtn = document.getElementById('stopEngines') as HTMLButtonElement;
stopEnginesBtn.addEventListener('click', () => {
  for (let id = 1; id <= 8; id++) sfx.engine(id, null);
  engineToggle.checked = false;
});
