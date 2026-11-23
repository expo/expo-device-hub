// An app that shows the screen without screen shapes and without 3D models.
// It uses what it imports: a bundle of re-exports alone would hold no code,
// and a test of that bundle would pass whatever the main entry imports.
import { DeviceScreen, useAndroidDeviceClient, useIosDeviceClient } from "../../index";

(globalThis as Record<string, unknown>).__hubClientApp = {
  DeviceScreen,
  useAndroidDeviceClient,
  useIosDeviceClient,
};
