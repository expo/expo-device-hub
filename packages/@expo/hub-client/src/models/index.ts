/**
 * 3D device models: `@expo/hub-client/models`.
 *
 * A separate entry point, so an app that does not show 3D models bundles
 * neither three.js nor this code. The main `@expo/hub-client` entry never
 * imports it. `three` and `three-mesh-bvh` are optional peer dependencies:
 * install them to use this entry.
 *
 * - {@link DeviceModelScreen} — a device's 3D model, textured with its live
 *   displays, in place of `DeviceScreen`. It takes the device client, the
 *   model's description, and the URL of the model's GLB file.
 * - The catalog, also at `@expo/hub-client/models/catalog` without three.js:
 *   {@link resolveDeviceModel}, {@link deviceModelStreamable}, and
 *   {@link modelStageMaxSide}.
 * - The GLB files: `@expo/hub-client/models/iphone-duo.glb`,
 *   `iphone-18-pro.glb`, `pixel-9-pro.glb`, and `pixel-9-pro-fold.glb`.
 *
 * The files keep the names of the entry's first device, the foldable iPhone Duo.
 */

// @ref LLP 0019#two-entries — only a consumer that renders the model loads three.js
export { DeviceModelScreen, type DeviceModelScreenProps } from "./DeviceModelScreen";
export * from "./catalog";
