import { describe, expect, test } from "bun:test";
import { parseAvdList } from "../parse-avd-list";

const AVD_LIST_OUTPUT = `Available Android Virtual Devices:
    Name: expo-emu-android-unknown-0
  Device: pixel_6 (Google)
    Path: /Users/krystofwoldrich/.android/avd/expo-emu-android-unknown-0.avd
  Target: Google Play (Google Inc.)
          Based on: Android 16.0 ("Baklava") Tag/ABI: google_apis_playstore/arm64-v8a
  Sdcard: 512 MB
---------
    Name: Medium_Phone_API_36.1
  Device: medium_phone (Generic)
    Path: /Users/krystofwoldrich/.android/avd/Medium_Phone.avd
  Target: Google Play (Google Inc.)
          Based on: Android 16.0 ("Baklava") Tag/ABI: google_apis_playstore/arm64-v8a
  Sdcard: 512M
---------
    Name: Television_720p
  Device: tv_720p (Google)
    Path: /Users/krystofwoldrich/.android/avd/Television_720p.avd
  Target: Android TV
          Based on: Android 16.0 ("Baklava") Tag/ABI: android-tv/arm64-v8a
    Skin: tv_720p
  Sdcard: 512M
`;

describe("parseAvdList", () => {
  test("parses every available AVD block in order", () => {
    const avds = parseAvdList(AVD_LIST_OUTPUT);
    expect(avds.map((avd) => avd.Name)).toEqual([
      "expo-emu-android-unknown-0",
      "Medium_Phone_API_36.1",
      "Television_720p",
    ]);
  });

  test("captures the Path field used to locate config.ini", () => {
    const avds = parseAvdList(AVD_LIST_OUTPUT);
    expect(avds[1]?.Path).toBe("/Users/krystofwoldrich/.android/avd/Medium_Phone.avd");
  });

  test("captures block fields like Device and Target", () => {
    const [first] = parseAvdList(AVD_LIST_OUTPUT);
    expect(first?.Device).toBe("pixel_6 (Google)");
    expect(first?.Target).toBe("Google Play (Google Inc.)");
  });

  test("excludes the 'could not be loaded' section", () => {
    const output = `Available Android Virtual Devices:
    Name: Good
    Path: /avd/good.avd
---------
The following Android Virtual Devices could not be loaded:
    Name: Broken
    Path: /avd/broken.ini
    Error: Failed to parse properties`;

    expect(parseAvdList(output).map((avd) => avd.Name)).toEqual(["Good"]);
  });

  test("returns an empty array when there are no devices", () => {
    expect(parseAvdList("")).toEqual([]);
    expect(parseAvdList("Available Android Virtual Devices:\n")).toEqual([]);
  });
});
