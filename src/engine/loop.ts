export function startLoop(cb: (dt: number) => void): void {
  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    cb(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
