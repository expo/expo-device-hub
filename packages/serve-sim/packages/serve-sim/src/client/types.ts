// Protocol types used by the simulator UI.
import type { HingeControlState, HingePhysicalOrientation } from "../hinge-control";

export type SimulatorOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface StreamConfig extends HingeControlState {
  width: number;
  height: number;
  /** Current simulator orientation, when known. */
  orientation?: SimulatorOrientation;
  /** Active simulator display, used to select its frame and corner geometry. */
  screenId?: number;
  /** Whether this simulator exposes hinge angle control. */
  supportsHingeAngle?: boolean;
  /** Whether the active Duo surface can be selected without changing its hinge angle. */
  supportsPhysicalOrientation?: boolean;
  /** Last confirmed physical orientation, separate from the app's screen orientation. */
  physicalOrientation?: HingePhysicalOrientation;
}

export type ConnectionQuality = "good" | "degraded" | "poor";
export type AdaptiveState = "normal" | "degraded";

export interface StreamAPI {
  start: (options?: { maxFps?: number }) => void;
  stop: () => void;
  sendTouch: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  sendMultiTouch: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  sendButton: (button: string) => void;
  sendDigitalCrown?: (delta: number) => void;
  /** Subscribe to frame updates (bypasses React state for performance). Returns unsubscribe fn.
   * Callback receives a blob URL (object URL) pointing to the JPEG frame. */
  subscribeFrame: (cb: (blobUrl: string) => void) => () => void;
  frame: string | null;
  config: StreamConfig | null;
  /** Current adaptive FPS (may change dynamically based on network conditions). */
  adaptiveFps: number;
  /** Adaptive state: "normal" when at full FPS, "degraded" when reduced. */
  adaptiveState: AdaptiveState;
  connectionQuality: ConnectionQuality | null;
}
