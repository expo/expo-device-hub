// An app that asks which devices have a 3D model, without showing one. It uses
// what it imports, as `main-entry-only.ts` does.
import { deviceModelStreamable, modelStageMaxSide, resolveDeviceModel } from "../../models/catalog";

(globalThis as Record<string, unknown>).__hubClientApp = {
  deviceModelStreamable,
  modelStageMaxSide,
  resolveDeviceModel,
};
