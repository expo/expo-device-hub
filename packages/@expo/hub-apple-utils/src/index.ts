export { bootDevice } from "./boot-device";
export { createDevice } from "./create-device";
export { listDevices } from "./list-devices";
export { listRuntimes } from "./list-runtimes";
export { removeDevice } from "./remove-device";
export { shutdownDevice } from "./shutdown-device";
export type {
  AppleConnectionProperties,
  AppleDevice,
  AppleDeviceCapability,
  AppleDeviceProperties,
  AppleHardwareProperties,
  AppleSimulatorDeviceType,
  AppleSimulatorRuntime,
  BootDeviceOptions,
  CreateDeviceOptions,
  RemoveDeviceOptions,
  ShutdownDeviceOptions,
} from "./types";
export type { AppleUtilsError, AppleUtilsResult } from "./errors";
