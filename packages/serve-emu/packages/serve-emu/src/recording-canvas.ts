import type { DisplaySize, FoldableDisplays, HingeAngles } from "./fold.ts";
import type { ScreenOrientation } from "./shared/api-contracts.ts";

/** A rectangle in encoded pixels, from the canvas's top-left corner. */
export type RecordingRect = { x: number; y: number; width: number; height: number };

/** The display of a foldable that a recorded frame shows, named as serve-sim names the iPhone Duo's. */
export type RecordingScreen = "inner" | "outer";

/** Where a captured display sits on the recording canvas, and which display it is. */
export type RecordingGeometry = {
  /** The shown display's native size. */
  width: number;
  height: number;
  /** Which display of a foldable; absent for a device with one display. */
  screen?: RecordingScreen;
  /** The picture's bounds on the canvas, without the letterbox borders. */
  contentRect: RecordingRect;
};

/**
 * How the device stands while a frame is recorded: the hinge, and the pose that the UI shows on
 * the panel, named as serve-sim's `orientation`. Unknown fields are absent.
 */
export type RecordingPose = {
  hingeAngle?: number;
  orientation?: ScreenOrientation;
};

/** One complete device state in the recording's `deviceStates` timeline. */
export type RecordingDeviceState = Partial<RecordingGeometry> & RecordingPose;

/**
 * A recording that keeps one frame size while a foldable switches displays.
 * `canvas` is the size of every recorded frame.
 */
export type RecordingCanvas = {
  canvas: DisplaySize;
  displays: FoldableDisplays;
  /** The gRPC capture box from `captureBox`; 0 captures native size. */
  maxSize: number;
};

const even = (value: number) => value - (value % 2);

/**
 * The square box that gRPC capture fits each display into, or 0 for native size. Native-size
 * MMAP capture sizes its shared memory once, from the startup image, so its box is the startup
 * display's longest side; an unknown startup display counts as native size.
 */
export function captureBox(options: {
  maxSize: number;
  imageMode: string;
  displays: FoldableDisplays;
  startup: RecordingScreen | null;
}): number {
  if (options.maxSize > 0) return options.maxSize;
  if (options.imageMode !== "mmap" || options.startup === null) return 0;
  const startup = options.displays[options.startup];
  return Math.max(startup.width, startup.height);
}

/**
 * The size of a display's gRPC screenshot after serve-emu crops it to even
 * dimensions: the emulator fits a larger display into the square capture box,
 * and does not enlarge a smaller one.
 */
export function captureSize(display: DisplaySize, maxSize: number): DisplaySize {
  const scale = maxSize > 0 ? Math.min(1, maxSize / display.width, maxSize / display.height) : 1;
  return {
    width: Math.max(2, even(Math.floor(display.width * scale))),
    height: Math.max(2, even(Math.floor(display.height * scale))),
  };
}

// @ref LLP 0018#fold-canvas — one canvas wide and tall enough for both displays, as serve-sim's recorder
/** The fixed recording canvas for a foldable: the bounding box of both displays' captures. */
/** `maxSize` is the capture box, as `captureBox` gives it. */
export function recordingCanvas(displays: FoldableDisplays, maxSize: number): RecordingCanvas {
  const inner = captureSize(displays.inner, maxSize);
  const outer = captureSize(displays.outer, maxSize);
  return {
    canvas: {
      width: Math.max(inner.width, outer.width),
      height: Math.max(inner.height, outer.height),
    },
    displays,
    maxSize,
  };
}

/**
 * Where a captured image goes on the canvas: centered, at its own size when it
 * fits, else scaled down to fit. Every value is even, so chroma stays aligned.
 */
export function placeOnCanvas(image: DisplaySize, canvas: DisplaySize): RecordingRect {
  const width = even(image.width);
  const height = even(image.height);
  const scale = Math.min(1, canvas.width / width, canvas.height / height);
  const content = {
    width: Math.max(2, even(Math.floor(width * scale))),
    height: Math.max(2, even(Math.floor(height * scale))),
  };
  return {
    x: even(Math.floor((canvas.width - content.width) / 2)),
    y: even(Math.floor((canvas.height - content.height) / 2)),
    ...content,
  };
}

/**
 * The display that a captured image shows: the one whose proportions are
 * closest, in either orientation. The two displays of a fold differ clearly.
 */
export function screenForImage(image: DisplaySize, displays: FoldableDisplays): RecordingScreen {
  const ratio = (size: DisplaySize) =>
    Math.min(size.width, size.height) / Math.max(size.width, size.height);
  const shown = ratio(image);
  return Math.abs(ratio(displays.inner) - shown) <= Math.abs(ratio(displays.outer) - shown)
    ? "inner"
    : "outer";
}

/** The recorded geometry of one captured image on the canvas. */
export function recordingGeometry(
  image: DisplaySize,
  recording: RecordingCanvas,
): RecordingGeometry {
  const screen = screenForImage(image, recording.displays);
  const native = recording.displays[screen];
  const landscape = image.width > image.height;
  const nativeLandscape = native.width > native.height;
  return {
    // A turned display reports its turned size, as the capture shows it.
    ...(landscape === nativeLandscape
      ? { width: native.width, height: native.height }
      : { width: native.height, height: native.width }),
    screen,
    contentRect: placeOnCanvas(image, recording.canvas),
  };
}

/**
 * The pose that a frame of this geometry can show. The emulator shows the outer display at the
 * closed posture's angles. A hinge reading that contradicts the shown display comes from the
 * other side of a fold that Android has not shown yet, or has shown before the reading, so the
 * frame leaves the hinge unknown.
 */
export function poseForGeometry(
  geometry: RecordingGeometry,
  pose: RecordingPose,
  closedHinge: HingeAngles | undefined,
): RecordingPose {
  if (pose.hingeAngle === undefined || !closedHinge) return pose;
  const closed = pose.hingeAngle >= closedHinge.min && pose.hingeAngle < closedHinge.max;
  if ((geometry.screen === "outer") === closed) return pose;
  const { hingeAngle: _, ...rest } = pose;
  return rest;
}
