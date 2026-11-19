/**
 * The 3D device preview, as its own entry point so that only a consumer that
 * renders it loads three.js. It takes the client's keyboard handling, input
 * cancellation, and display geometry from `@expo/hub-client`, and each
 * preset's hinge angle from `capabilities.fold`. The entry keeps the name of
 * its first device, the foldable iPhone Duo.
 */

export { DeviceModelScreen, type DeviceModelScreenProps } from "./DeviceModelScreen";
