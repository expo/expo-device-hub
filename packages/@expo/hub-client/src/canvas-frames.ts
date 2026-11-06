/**
 * The frame that this client last painted into a stream canvas. Android's H.264
 * paths paint into the canvas that `attachVideo` received; a consumer that
 * copies the canvas elsewhere, such as a 3D model's texture, can skip a copy
 * while the number is unchanged. Numbers come from one counter and never
 * repeat, also after a canvas is forgotten, so a new session's first frame
 * cannot look like the last one of an earlier session. A canvas that this
 * client has not painted in the current stream session has no number.
 */
const painted = new WeakMap<HTMLCanvasElement, number>();
let lastFrame = 0;

/** Options for the 2D context of a stream canvas; every painter uses the same ones. */
export const STREAM_CANVAS_CONTEXT: CanvasRenderingContext2DSettings = {
  alpha: false,
  desynchronized: true,
};

/** Record a frame that was just painted into `canvas`. */
export function markCanvasFrame(canvas: HTMLCanvasElement): void {
  painted.set(canvas, ++lastFrame);
}

/** The number of the frame last painted into `canvas`, or undefined if none in this session. */
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
