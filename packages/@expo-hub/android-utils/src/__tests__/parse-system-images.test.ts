import { describe, expect, test } from "bun:test";
import { parseSystemImages } from "../parse-system-images";

const LIST_INSTALLED_OUTPUT = `Installed packages:
  Path                                                       | Version       | Description                                | Location
  -------                                                    | -------       | -------                                    | -------
  build-tools;36.0.0                                         | 36.0.0        | Android SDK Build-Tools 36                 | build-tools/36.0.0
  emulator                                                   | 36.6.11       | Android Emulator                           | emulator
  system-images;android-26;google_apis;x86_64                | 16            | Google APIs Intel x86_64 Atom System Image | system-images/android-26/google_apis/x86_64
  system-images;android-36.1;google_apis_playstore;arm64-v8a | 4             | Google Play ARM 64 v8a System Image        | system-images/android-36.1/google_apis_playstore/arm64-v8a
  system-images;android-36;android-tv;arm64-v8a              | 3             | Android TV ARM 64 v8a System Image         | system-images/android-36/android-tv/arm64-v8a
`;

describe("parseSystemImages", () => {
  test("keeps only system-images packages, in order", () => {
    const images = parseSystemImages(LIST_INSTALLED_OUTPUT);
    expect(images.map((image) => image.package)).toEqual([
      "system-images;android-26;google_apis;x86_64",
      "system-images;android-36.1;google_apis_playstore;arm64-v8a",
      "system-images;android-36;android-tv;arm64-v8a",
    ]);
  });

  test("parses every table column for a row", () => {
    const [first] = parseSystemImages(LIST_INSTALLED_OUTPUT);
    expect(first).toEqual({
      package: "system-images;android-26;google_apis;x86_64",
      apiLevel: "android-26",
      tag: "google_apis",
      abi: "x86_64",
      version: "16",
      description: "Google APIs Intel x86_64 Atom System Image",
      location: "system-images/android-26/google_apis/x86_64",
    });
  });

  test("derives apiLevel, tag and abi from the package path", () => {
    const playstore = parseSystemImages(LIST_INSTALLED_OUTPUT)[1];
    expect(playstore?.apiLevel).toBe("android-36.1");
    expect(playstore?.tag).toBe("google_apis_playstore");
    expect(playstore?.abi).toBe("arm64-v8a");
  });

  test("ignores the header, separator and non-system-image rows", () => {
    expect(parseSystemImages(LIST_INSTALLED_OUTPUT)).toHaveLength(3);
  });

  test("ignores sdkmanager loading and progress noise", () => {
    const noisy =
      "Loading package information...\r[=====     ] 25% Loading...\rInstalled packages:\n" +
      "  system-images;android-34;google_apis;arm64-v8a | 1 | Google APIs ARM 64 v8a System Image | system-images/android-34/google_apis/arm64-v8a\n";
    expect(parseSystemImages(noisy).map((image) => image.package)).toEqual([
      "system-images;android-34;google_apis;arm64-v8a",
    ]);
  });

  test("returns an empty array when nothing is installed", () => {
    expect(parseSystemImages("")).toEqual([]);
    expect(parseSystemImages("Installed packages:\n")).toEqual([]);
  });
});
