/**
 * The iPhone Duo's 3D preview, as its own entry point so that only a consumer
 * that renders it loads three.js. It takes the client's keyboard handling,
 * input cancellation, and display geometry from `@expo/hub-client`, and each
 * preset's hinge angle from `capabilities.fold`.
 */

export { FoldableDeviceScreen, type FoldableDeviceScreenProps } from "./FoldableDeviceScreen";
