import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { DeviceSection, type Device } from "@expo/hub-components";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { isSupportedAndroidDevice } from "../../server/device-support";
import { androidImagesToOptions } from "../../server/sim-options";
import {
  readHideUnsupportedDevices,
  visibleDevices,
  visibleNewDeviceOptions,
} from "../deviceVisibility";

// IDs and names verified with Android SDK Command-line Tools 22.0's device list.
const phones = [
  ["pixel_fold", "Pixel Fold"],
  ["pixel_9_pro_fold", "Pixel 9 Pro Fold"],
  ["pixel_10_pro_fold", "Pixel 10 Pro Fold"],
  ["small_phone", "Small Phone"],
  ["medium_phone", "Medium Phone"],
] as const;
const profiles: AndroidDeviceProfile[] = [
  ...phones.map(([id, name]) => ({ id, name, index: null, oem: null, tag: null })),
  { id: "medium_tablet", name: "Medium Tablet", index: null, oem: "Generic", tag: null },
  { id: "pixel_tablet", name: "Pixel Tablet", index: null, oem: "Google", tag: null },
];

function recent(profile: AndroidDeviceProfile): Device {
  const avd: AndroidDevice = {
    name: "Renamed AVD",
    type: "emulator",
    booted: false,
    serial: null,
    path: null,
    lastBootedAt: 1234,
    properties: {},
    config: { "hw.device.name": profile.id },
  };
  return {
    id: profile.id,
    name: profile.name,
    version: "Android 16",
    platform: "android",
    booted: false,
    physical: false,
    lastUsedAt: avd.lastBootedAt!,
    supported: isSupportedAndroidDevice(avd),
  };
}

test("the default filter keeps foldable and generic phones in Recents and new-device choices", () => {
  const hideUnsupported = readHideUnsupportedDevices({ getItem: () => null });
  expect(hideUnsupported).toBe(true);
  const recents = visibleDevices(profiles.map(recent), hideUnsupported);
  expect(recents.map((device) => device.id)).toEqual(phones.map(([id]) => id));

  const options = androidImagesToOptions(
    [
      {
        package: "system-images;android-36;google_apis;arm64-v8a",
        apiLevel: "android-36",
        tag: "google_apis",
        abi: "arm64-v8a",
        version: "1",
        description: "Android 16",
        location: "system-images/android-36/google_apis/arm64-v8a",
      },
    ],
    profiles,
  );
  const visibleModels = visibleNewDeviceOptions(options, hideUnsupported).runtimes[0]!.models;
  expect(visibleModels.map((model) => model.value).sort()).toEqual(phones.map(([id]) => id).sort());
  expect(visibleModels.every((model) => model.supported)).toBe(true);
});

test("the sidebar drops warnings for these phones while retaining them for running tablets", () => {
  const section = (devices: Device[]) =>
    renderToStaticMarkup(
      <DeviceSection
        title="Emulators"
        addLabel="Add emulator"
        kind="emulator"
        emptyLabel="No emulators"
        devices={devices.map((device) => ({ ...device, booted: true }))}
        recent={[]}
        options={{ runtimes: [] }}
        selectedId=""
        onSelect={() => {}}
      />,
    );
  const phoneRows = section(
    phones.map(([id]) => recent(profiles.find((profile) => profile.id === id)!)),
  );
  expect(phoneRows).not.toContain("Unsupported or untested device");
  const tabletRows = section(
    profiles.filter((profile) => profile.id.endsWith("tablet")).map(recent),
  );
  expect(tabletRows).toContain("Unsupported or untested device: Medium Tablet");
  expect(tabletRows).toContain("Unsupported or untested device: Pixel Tablet");
});
