export { bootDevice } from "./boot-device";
export { createDevice } from "./create-device";
export { listDevices } from "./list-devices";
export { listRuntimes } from "./list-runtimes";
export { readCornerRadii } from "./read-corner-radii";
export { removeDevice } from "./remove-device";
export { shutdownDevice } from "./shutdown-device";
export type {
  AppleDevice,
  AppleSimulatorDeviceType,
  AppleSimulatorRuntime,
  BootDeviceOptions,
  CreateDeviceOptions,
  RemoveDeviceOptions,
  ScreenCornerRadii,
  ShutdownDeviceOptions,
} from "./types";
export type { AppleUtilsError, AppleUtilsResult } from "./errors";
