import { MAX_DELTA_TIME_SEC } from '../../constants.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
}

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): () => void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const frame = (time: number) => {
    if (stopped) return;
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;

    callbacks.update(dt);

    ctx.imageSmoothingEnabled = false;
    callbacks.render(ctx);

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  // Stop the loop entirely while the page is hidden; on return restart with
  // lastTime = 0 so the first frame advances by dt = 0, not the hidden span.
  const onVisibilityChange = () => {
    if (stopped) return;
    cancelAnimationFrame(rafId);
    if (document.hidden) return;
    lastTime = 0;
    rafId = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
