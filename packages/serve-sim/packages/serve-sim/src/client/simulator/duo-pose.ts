import { Euler, Quaternion } from "three";
import type { HingePose } from "../../hinge-control";
import type { StreamConfig } from "../types";
import { streamDisplayGeometry } from "./orientation";

export interface DuoViewAngles {
  elevation: number;
  rotation: number;
}

export const DUO_DEFAULT_VIEW_ANGLES: Record<"laptop" | "tent", DuoViewAngles> = {
  laptop: { elevation: 20, rotation: -20 },
  tent: { elevation: 10, rotation: -20 },
};

/** Camera-axis roll that makes the active panel's native UI readable. */
export function duoScreenRoll(config: StreamConfig) {
  const mount = config.screenId === 1 ? 0 : Math.PI / 2;
  return mount - streamDisplayGeometry(config).rotationDegrees * Math.PI / 180;
}

/** Turn the ordinary folding view from the cover toward the inner screens. */
export function duoFacingYaw(fold: number): number {
  return Math.PI / 2 * Math.pow(fold / (Math.PI / 2), 3);
}

/** Select the requested panel before native display metadata catches up. */
export function duoIntendedScreen(
  angle: number | undefined,
  physicalPose: HingePose | null | undefined,
  nativeScreenId?: number,
): 1 | 3 {
  if (angle === undefined) return nativeScreenId === 1 ? 1 : 3;
  if (angle <= 0) return 1;
  if (angle >= 180) return 3;
  if (physicalPose === "tent") return 1;
  // CoreSimulator keeps the cover active through 54° and activates the inner
  // display at 55°. Keep fractional angles between those boundaries on the
  // current panel, matching native display ownership during slider motion.
  if (angle <= 54) return 1;
  if (angle >= 55) return 3;
  return nativeScreenId === 3 ? 3 : 1;
}

/** Initial/preset framing. Live hinge edits articulate the saved view in duo-view.ts. */
export function duoPose(
  angle: number | undefined,
  pose: HingePose | null | undefined,
  screenId?: number,
  config?: StreamConfig | null,
  presentationRoll?: number,
  viewAngles?: DuoViewAngles,
) {
  const degrees = Math.max(0, Math.min(180, angle ?? (screenId === 1 ? 0 : 180)));
  const fold = (180 - degrees) * Math.PI / 360;
  const visibleScreen = degrees === 0 ? 1 : 3;
  const roll = presentationRoll ?? (config?.screenId === visibleScreen && config.orientation ? duoScreenRoll(config) : 0);
  // Present the cover exactly front-on at 0°, and the inner screen exactly
  // front-on at 180°. Turn toward the cover gradually as the hinge closes.
  const presentation = new Quaternion().setFromEuler(new Euler(
    0, duoFacingYaw(fold), 0, "YXZ",
  ));
  presentation.premultiply(new Quaternion(0, 0, Math.sin(roll / 2), Math.cos(roll / 2)));

  if (pose === "laptop" || pose === "tent") {
    // Place the device on a level table before applying the camera orbit.
    // Laptop's base stays flat as the hinge changes; Tent's two feet share
    // the same height. Azimuth turns around the table normal, then elevation
    // looks down at it without introducing a sideways tilt.
    const view = viewAngles ?? DUO_DEFAULT_VIEW_ANGLES[pose];
    const elevation = view.elevation * Math.PI / 180;
    const tabletopYaw = view.rotation * Math.PI / 180;
    const physical = new Quaternion().setFromEuler(pose === "laptop"
      ? new Euler(fold - Math.PI / 2, 0, Math.PI / 2, "YXZ")
      : new Euler(Math.PI / 2, 0, -Math.PI / 2, "YXZ"));
    physical.premultiply(new Quaternion().setFromEuler(new Euler(elevation, tabletopYaw, 0, "XYZ")));
    // Hinge edits retain the table orientation through both endpoints.
    // Only choosing Closed or Open explicitly returns to a front-on view.
    presentation.copy(physical);
  }
  const oriented = new Euler().setFromQuaternion(presentation, "YXZ");
  const rotation: [number, number, number] = [oriented.x, oriented.y, oriented.z];
  return { fold, rotation };
}

/** Critically damped motion preserves velocity when a preset is interrupted. */
export function stepDuoSpring(value: number, velocity: number, target: number, seconds: number) {
  const omega = 14;
  const dt = Math.max(0, Math.min(seconds, 0.05));
  const offset = value - target;
  const decay = Math.exp(-omega * dt);
  const impulse = velocity + omega * offset;
  return { value: target + (offset + impulse * dt) * decay, velocity: (velocity - omega * impulse * dt) * decay };
}

export interface DuoScreenMapping {
  rotation: number;
  width: number;
  height: number;
  drawnWidth: number;
  drawnHeight: number;
}

/** Allow scaling's pixel rounding without accepting the other Duo display. */
export function duoFrameMatchesDisplay(width: number, height: number, config: StreamConfig) {
  if (![width, height, config.width, config.height].every((dimension) => Number.isFinite(dimension) && dimension > 0)) {
    return false;
  }
  const roundingTolerance = 1 / height + 1 / config.height;
  return Math.abs(width / height - config.width / config.height) <= roundingTolerance;
}

/** Raw framebuffer pixels are fixed to the physical panel, not the camera.
 * Apple's inner panel is mounted at 270 degrees in native Y-up coordinates:
 * clockwise 90 degrees in the texture's Y-down coordinates. The cover is 0.
 * App rotation already appears in the raw pixels. Correcting it again here, or
 * adding the model's roll, rotates/shrinks content inside its own glass.
 * The painter and touch inverse share this single hardware transform.
 */
export function duoScreenMapping(config: StreamConfig, width: number, height: number): DuoScreenMapping {
  const rotation = config.screenId === 1 ? 0 : Math.PI / 2;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const rotatedWidth = config.width * cos + config.height * sin;
  const rotatedHeight = config.width * sin + config.height * cos;
  const scale = Math.min(width / rotatedWidth, height / rotatedHeight);
  return { rotation, width, height, drawnWidth: config.width * scale, drawnHeight: config.height * scale };
}

/** Coordinates outside 0..1 are padding or an extrapolated drag off the panel. */
export function duoScreenPoint(x: number, y: number, mapping: DuoScreenMapping) {
  const px = (x - 0.5) * mapping.width;
  const py = (y - 0.5) * mapping.height;
  const cos = Math.cos(mapping.rotation);
  const sin = Math.sin(mapping.rotation);
  return {
    x: 0.5 + (px * cos + py * sin) / mapping.drawnWidth,
    y: 0.5 + (-px * sin + py * cos) / mapping.drawnHeight,
  };
}
