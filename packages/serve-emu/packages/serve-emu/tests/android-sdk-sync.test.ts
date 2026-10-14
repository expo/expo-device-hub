import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const OWN_COPY = resolve(import.meta.dir, "../src/android-sdk.ts");
const ANDROID_UTILS_COPY = resolve(
  import.meta.dir,
  "../../../../@expo/hub-android-utils/src/android-sdk.ts",
);

// The Hub vendors serve-emu, which cannot depend on the private @expo/hub-android-utils package.
test.skipIf(!existsSync(ANDROID_UTILS_COPY))(
  "android-sdk.ts matches the @expo/hub-android-utils copy byte for byte",
  async () => {
    expect(await readFile(OWN_COPY, "utf8")).toBe(await readFile(ANDROID_UTILS_COPY, "utf8"));
  },
);
