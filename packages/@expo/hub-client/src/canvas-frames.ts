/**
 * Frames that this client painted into a stream canvas. Android's H.264 paths
 * paint into the canvas that `attachVideo` received; a consumer that copies the
 * canvas elsewhere, such as a 3D model's texture, can skip a copy while the
 * count is unchanged. A canvas that this client has not painted in the current
 * stream session has no count.
 */
const painted = new WeakMap<HTMLCanvasElement, number>();

/** Options for the 2D context of a stream canvas; every painter uses the same ones. */
export const STREAM_CANVAS_CONTEXT: CanvasRenderingContext2DSettings = {
  alpha: false,
  desynchronized: true,
};

/** Count a frame that was just painted into `canvas`. */
export function markCanvasFrame(canvas: HTMLCanvasElement): void {
  painted.set(canvas, (painted.get(canvas) ?? 0) + 1);
}

/** How many frames this client painted into `canvas`, or undefined if none in this session. */
export function canvasFrameNumber(canvas: HTMLCanvasElement): number | undefined {
  return painted.get(canvas);
}

/** Forget a canvas's frames, for example when it starts to show another device. */
export function forgetCanvasFrames(canvas: HTMLCanvasElement): void {
  painted.delete(canvas);
}

/**
 * Copy the last painted frame of a replaced canvas into its replacement. A view
 * that swaps its canvas, as a switch between 2D and 3D does, then shows the
 * screen at once, even when a still Android screen sends no new frame.
 */
export function carryCanvasFrame(from: HTMLCanvasElement, to: HTMLCanvasElement): boolean {
  if (from === to || !painted.has(from) || !from.width || !from.height) return false;
  const context = to.getContext("2d", STREAM_CANVAS_CONTEXT);
  if (!context) return false;
  to.width = from.width;
  to.height = from.height;
  context.drawImage(from, 0, 0);
  markCanvasFrame(to);
  return true;
}
