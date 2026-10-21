/**
 * The iPhone Duo's 3D preview, as its own entry point so that only a consumer
 * that renders it loads three.js. It takes the client's keyboard handling,
 * input cancellation, display geometry, and hinge presets from
 * `@expo/hub-client`.
 */

export { FoldableDeviceScreen, type FoldableDeviceScreenProps } from "./FoldableDeviceScreen";
