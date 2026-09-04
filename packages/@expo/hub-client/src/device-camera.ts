import { type DeviceCameraFacing } from "./types";

/** Shared empty set so a client with no camera writes keeps a stable identity across renders. */
export const NO_PENDING_CAMERA_WRITES: ReadonlySet<DeviceCameraFacing> = new Set();
