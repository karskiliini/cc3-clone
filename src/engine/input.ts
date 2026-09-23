import type { InputState } from '@/shared/types';
import { SCREEN_W, SCREEN_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { game } from '@/game';

const MODIFIER_KEYS = new Set(['control', 'meta', 'shift', 'alt', 'altgraph', 'capslock', 'fn', 'os']);

/** Zoom (Ctrl/Cmd+wheel, trackpad pinch) quantisation: small pinch deltas
 * accumulate until they reach ZOOM_STEP_PX; a single event of at least
 * ZOOM_NOTCH_PX (a mouse-wheel notch) steps immediately. After a step, zoom
 * input is ignored for ZOOM_COOLDOWN_MS so one gesture moves one level at a
 * time; leftovers are discarded after ZOOM_IDLE_RESET_MS without events. */
const ZOOM_STEP_PX = 100;
const ZOOM_NOTCH_PX = 50;
const ZOOM_COOLDOWN_MS = 200;
const ZOOM_IDLE_RESET_MS = 250;

const PREVENT_KEYS = new Set([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab']);

function unlockAudio(): void {
  game.audio?.unlock?.();
}

export function createInput(canvas: HTMLCanvasElement): { state: InputState; endFrame(): void } {
  const state: InputState = {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    wheel: 0,
    wheelDX: 0,
    wheelDY: 0,
    pointerInside: true,
  };

  // Reused scratch object for clientToLogical results, to avoid allocating a
  // new {x,y} on every mousemove/mousedown/mouseup — those fire very often.
  const scratchPt = { x: 0, y: 0 };

  // DevicePixelRatio-independent: getBoundingClientRect() and clientX/clientY
  // are both in CSS pixels, so this mapping is exact regardless of DPR. The
  // canvas is laid out with object-fit:contain (letterboxed, 4:3), so we
  // recompute the same contain-fit math the browser uses for painting.
  function clientToLogical(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / SCREEN_W, rect.height / SCREEN_H);
    const dispW = SCREEN_W * scale;
    const dispH = SCREEN_H * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    // Snap to whole logical pixels. At any non-integer letterbox scale the raw
    // mapping is fractional (369 / 1.171875 = 314.88), and consumers that
    // Math.round a press point into a rect origin (e.g. the command menu)
    // would then see that same press fall just outside the rect and cancel.
    scratchPt.x = clamp(Math.floor((clientX - offX) / (scale || 1)), 0, SCREEN_W - 1);
    scratchPt.y = clamp(Math.floor((clientY - offY) / (scale || 1)), 0, SCREEN_H - 1);
    return scratchPt;
  }

  function buttonOf(b: number): 0 | 1 | 2 {
    return (b === 2 ? 2 : b === 1 ? 1 : 0) as 0 | 1 | 2;
  }

  window.addEventListener('mousemove', (e: MouseEvent) => {
    const p = clientToLogical(e.clientX, e.clientY);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
    state.pointerInside = true;
  });

  // Edge-scroll and drag gestures must stop dead the instant the pointer
  // leaves the page or the window loses focus — otherwise the camera (or a
  // stuck button) keeps "moving" after the user has alt-tabbed away.
  canvas.addEventListener('mouseleave', () => {
    state.pointerInside = false;
  });
  window.addEventListener('blur', () => {
    state.pointerInside = false;
    state.buttons.left = false;
    state.buttons.right = false;
    state.buttons.middle = false;
    state.keysDown.clear();
    spaceHeld = false;
    spaceUsedForPan = false;
    ctrlPhysical = false;
  });

  window.addEventListener('mousedown', (e: MouseEvent) => {
    unlockAudio();
    const p = clientToLogical(e.clientX, e.clientY);
    const button = buttonOf(e.button);
    if (button === 0) state.buttons.left = true;
    else if (button === 1) state.buttons.middle = true;
    else if (button === 2) state.buttons.right = true;
    state.clicks.push({ x: p.x, y: p.y, button });
  });

  window.addEventListener('mouseup', (e: MouseEvent) => {
    const p = clientToLogical(e.clientX, e.clientY);
    const button = buttonOf(e.button);
    if (button === 0) state.buttons.left = false;
    else if (button === 1) state.buttons.middle = false;
    else if (button === 2) state.buttons.right = false;
    state.releases.push({ x: p.x, y: p.y, button });
  });

  window.addEventListener('contextmenu', (e: Event) => {
    e.preventDefault();
  });

  // Right-drag-to-pan and left-drag-to-select must never trigger the
  // browser's native text/image selection or drag-ghost affordances.
  window.addEventListener('selectstart', (e: Event) => e.preventDefault());
  canvas.addEventListener('dragstart', (e: Event) => e.preventDefault());

  // Space is both "pause" (tap) and the hold-modifier for Space+left-drag
  // panning. Its keysPressed event is therefore emitted on RELEASE, and only
  // when no left/middle press happened while it was held — so a pan gesture
  // never toggles pause.
  let spaceHeld = false;
  let spaceUsedForPan = false;
  // Physical Control state, and whether 'control' was put into keysDown only
  // as a transient alias for a Cmd/Ctrl chord this frame (removed at endFrame).
  let ctrlPhysical = false;
  let ctrlAliasThisFrame = false;

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (spaceHeld && (e.button === 0 || e.button === 1)) spaceUsedForPan = true;
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    unlockAudio();
    const key = e.key.toLowerCase();
    if (PREVENT_KEYS.has(key)) e.preventDefault();
    const isSpace = key === ' ' || key === 'spacebar';
    if (key === 'control') ctrlPhysical = true;
    if (isSpace) {
      if (!spaceHeld) { spaceHeld = true; spaceUsedForPan = state.buttons.left || state.buttons.middle; }
    } else if (!e.repeat) {
      state.keysPressed.add(key);
      if ((e.ctrlKey || e.metaKey) && !MODIFIER_KEYS.has(key)) {
        // Chord recorded from the event's own modifier flags, so a fast
        // Ctrl+A whose down/up land in one frame is not lost, and Cmd+A (macOS)
        // counts the same as Ctrl+A.
        state.keysPressed.add('mod+' + key);
        // Keep 'control' visible in keysDown until endFrame, even if the
        // modifier is released before the frame runs.
        state.keysDown.add('control');
        ctrlAliasThisFrame = true;
      }
    }
    state.keysDown.add(key);
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key === ' ' || key === 'spacebar') {
      if (spaceHeld && !spaceUsedForPan) state.keysPressed.add(' ');
      spaceHeld = false;
      spaceUsedForPan = false;
    }
    if (key === 'control') {
      ctrlPhysical = false;
      // Keep it visible until the end of the frame if a chord used it.
      if (ctrlAliasThisFrame) return;
    }
    state.keysDown.delete(key);
    if (key === 'meta') {
      // macOS Chrome swallows keyup for keys released while Cmd is held; drop
      // every non-modifier key so none stays stuck (e.g. an arrow key drifting the pan).
      for (const k of [...state.keysDown]) if (!MODIFIER_KEYS.has(k)) state.keysDown.delete(k);
    }
  });

  // Two-finger trackpad scroll pans the map (like any modern scrollable
  // surface); Ctrl/Cmd+wheel — how browsers report a trackpad pinch, and
  // how a mouse wheel + modifier reads too — zooms around the pointer
  // instead. Always preventDefault so the wheel never scrolls/back-navigates
  // the page (paired with `overscroll-behavior:none` in index.html).
  let zoomAccum = 0;
  let zoomLastEventAt = -Infinity;
  let zoomCooldownUntil = -Infinity;

  window.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    // DOM_DELTA_LINE (1): browser reports "lines"; DOM_DELTA_PAGE (2): "pages".
    // Normalize both to approximate screen pixels so pan speed feels the same
    // regardless of input device/browser.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? SCREEN_H : 1;
    if (e.ctrlKey || e.metaKey) {
      const d = e.deltaY * scale;
      const now = performance.now();
      if (now - zoomLastEventAt > ZOOM_IDLE_RESET_MS) zoomAccum = 0;
      zoomLastEventAt = now;
      if (now < zoomCooldownUntil) return;
      zoomAccum += d;
      if (Math.abs(d) >= ZOOM_NOTCH_PX || Math.abs(zoomAccum) >= ZOOM_STEP_PX) {
        // Emit one whole step; consumers zoom one level per non-zero frame.
        state.wheel = Math.sign(zoomAccum || d) * ZOOM_STEP_PX;
        zoomAccum = 0;
        zoomCooldownUntil = now + ZOOM_COOLDOWN_MS;
      }
    } else {
      state.wheelDX += e.deltaX * scale;
      state.wheelDY += e.deltaY * scale;
    }
  }, { passive: false });

  function endFrame(): void {
    state.clicks.length = 0;
    state.releases.length = 0;
    state.keysPressed.clear();
    if (ctrlAliasThisFrame) {
      if (!ctrlPhysical) state.keysDown.delete('control');
      ctrlAliasThisFrame = false;
    }
    state.wheel = 0;
    state.wheelDX = 0;
    state.wheelDY = 0;
  }

  return { state, endFrame };
}
