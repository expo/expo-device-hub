/**
 * The 3D device model catalog: `@expo/hub-client/models/catalog`.
 *
 * The part of `@expo/hub-client/models` that does not import three.js: which
 * devices have a 3D model, what each model needs from a client, and how large
 * its stage is. A consumer reads it to decide whether to show the 3D preview,
 * and loads `@expo/hub-client/models` only when it does.
 *
 * - {@link resolveDeviceModel} — the model of a device's exact hardware model,
 *   by the names that `@expo/hub-client/shapes` takes.
 * - {@link deviceModelFor} + {@link DEVICE_MODELS} — the model of a model id.
 * - {@link deviceModelStreamable} + {@link deviceModelPreview} — whether a
 *   client can feed a model.
 * - {@link modelStageMaxSide} — the size of a model's stage.
 */

// @ref LLP 0019#two-entries — the catalog stays free of three.js, so a consumer can ask before it loads the scene
export {
  DEVICE_MODEL_IDS,
  DEVICE_MODELS,
  deviceModelFor,
  deviceModelPreview,
  deviceModelStreamable,
  isDeviceModelId,
  resolveDeviceModel,
  type DeviceModelAssets,
  type DeviceModelDescription,
  type DeviceModelDevice,
  type DeviceModelDisplay,
  type DeviceModelHinge,
  type DeviceModelId,
  type DeviceModelQuery,
} from "./device-models";
export { modelStageMaxSide } from "./duo-stage";
