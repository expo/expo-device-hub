import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_CACHED_ICONS,
  clearAppIconCache,
  iconMimeType,
  parseAdaptiveForegroundId,
  selectBaseApkPath,
  selectIconEntry,
  readAppIcon,
  selectResourceFilePath,
} from "../src/apk-icon.ts";
import type { AppIcon } from "../src/shared/api-contracts.ts";

const SETTINGS_BADGING = [
  "application-icon-120:'res/drawable/ic_launcher_settings.xml'",
  "application-icon-320:'res/drawable/ic_launcher_settings.xml'",
  "application-icon-640:'res/drawable/ic_launcher_settings.xml'",
  "application-icon-65534:'res/drawable/ic_launcher_settings.xml'",
  "application-icon-65535:'res/drawable/ic_launcher_settings.xml'",
  "application: label='Settings' icon='res/drawable/ic_launcher_settings.xml'",
].join("\n");

const NAMESPACED_XMLTREE = [
  "N: android=http://schemas.android.com/apk/res/android (line=2)",
  "  E: adaptive-icon (line=2)",
  "      E: background (line=3)",
  "        A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f06010f",
  "      E: foreground (line=4)",
  "        A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f100000",
].join("\n");

const BARE_XMLTREE = [
  "E: adaptive-icon (line=8)",
  "    E: background (line=9)",
  "      A: drawable(0x01010199)=@0x0106000b",
  "    E: foreground (line=10)",
  "      A: drawable(0x01010199)=@0x7f110002",
  "    E: monochrome (line=11)",
  "      A: drawable(0x01010199)=@0x7f090852",
].join("\n");

const SETTINGS_RESOURCE_BLOCK = [
  "      (mdpi) (file) res/mipmap-mdpi-v4/ic_launcher_settings.png type=PNG",
  "      (xhdpi) (file) res/mipmap-xhdpi-v4/ic_launcher_settings.png type=PNG",
  "      (xxxhdpi) (file) res/mipmap-xxxhdpi-v4/ic_launcher_settings.png type=PNG",
].join("\n");

describe("selectBaseApkPath", () => {
  test("prefers base.apk over splits and strips the package prefix", () => {
    const output = [
      "package:/data/app/~~hash==/com.android.chrome-xPS==/split_config.en.apk\r",
      "package:/data/app/~~hash==/com.android.chrome-xPS==/base.apk\r",
    ].join("\n");
    expect(selectBaseApkPath(output)).toBe("/data/app/~~hash==/com.android.chrome-xPS==/base.apk");
  });

  test("falls back to the only listed apk", () => {
    expect(selectBaseApkPath("package:/system/priv-app/Settings/Settings.apk\n")).toBe(
      "/system/priv-app/Settings/Settings.apk",
    );
  });

  test("returns null when the package is not installed", () => {
    expect(selectBaseApkPath("")).toBeNull();
  });
});

describe("selectIconEntry", () => {
  test("takes the densest real bucket and ignores the anydpi sentinels", () => {
    expect(selectIconEntry(SETTINGS_BADGING)).toBe("res/drawable/ic_launcher_settings.xml");
  });

  test("falls back to the application icon attribute", () => {
    expect(selectIconEntry("application: label='App' icon='res/icon.png'")).toBe("res/icon.png");
  });

  test("returns null when badging reports no icon", () => {
    expect(selectIconEntry("package: name='com.example.app'")).toBeNull();
  });
});

describe("parseAdaptiveForegroundId", () => {
  test("reads the foreground drawable id through the namespaced attribute", () => {
    expect(parseAdaptiveForegroundId(NAMESPACED_XMLTREE)).toBe("0x7f100000");
  });

  test("reads it through the bare attribute and ignores monochrome", () => {
    expect(parseAdaptiveForegroundId(BARE_XMLTREE)).toBe("0x7f110002");
  });

  test("reaches through a nested bitmap element", () => {
    expect(parseAdaptiveForegroundId(BITMAP_XMLTREE)).toBe("0x7f110002");
  });

  test("skips a framework layer and takes the APK's own drawable", () => {
    expect(parseAdaptiveForegroundId(LAYER_LIST_XMLTREE)).toBe("0x7f110003");
  });

  test("returns null for a plain drawable", () => {
    expect(parseAdaptiveForegroundId("E: vector (line=1)")).toBeNull();
  });
});

const BITMAP_XMLTREE = [
  "N: android=http://schemas.android.com/apk/res/android (line=2)",
  "  E: adaptive-icon (line=2)",
  "      E: background (line=4)",
  "        A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f060675",
  "      E: foreground (line=5)",
  "          E: bitmap (line=6)",
  "            A: http://schemas.android.com/apk/res/android:src(0x01010119)=@0x7f110002",
  "      E: monochrome (line=8)",
  "        A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f080705",
].join("\n");

const LAYER_LIST_XMLTREE = [
  "N: android=http://schemas.android.com/apk/res/android (line=10)",
  "  E: adaptive-icon (line=10)",
  "      E: background (line=11)",
  "          E: layer-list (line=12)",
  "              E: item (line=13)",
  "                A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f110002",
  "      E: foreground (line=17)",
  "          E: layer-list (line=18)",
  "              E: item (line=20)",
  "                A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x0106000d",
  "              E: item (line=21)",
  "                  E: rotate (line=22)",
  "                    A: http://schemas.android.com/apk/res/android:drawable(0x01010199)=@0x7f110003",
].join("\n");

describe("selectResourceFilePath", () => {
  test("takes the densest bitmap", () => {
    expect(selectResourceFilePath(SETTINGS_RESOURCE_BLOCK)).toBe(
      "res/mipmap-xxxhdpi-v4/ic_launcher_settings.png",
    );
  });

  test("handles obfuscated paths with no extension", () => {
    const block = ["      (mdpi) (file) res/QtC", "      (xxxhdpi) (file) res/ima"].join("\n");
    expect(selectResourceFilePath(block)).toBe("res/ima");
  });

  test("skips XML entries and falls back to the default config bitmap", () => {
    const block = [
      "      (anydpi-v26) (file) res/drawable/ic.xml type=XML",
      "      () (file) res/drawable-nodpi/ic.png type=PNG",
    ].join("\n");
    expect(selectResourceFilePath(block)).toBe("res/drawable-nodpi/ic.png");
  });

  test("returns null when the block holds only vectors", () => {
    expect(selectResourceFilePath("      (anydpi-v26) (file) res/ic.xml type=XML")).toBeNull();
  });
});

describe("iconMimeType", () => {
  test("recognizes PNG", () => {
    expect(iconMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("image/png");
  });

  test("recognizes WebP only with the WEBP tag at offset 8", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(iconMimeType(webp)).toBe("image/webp");
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(iconMimeType(wav)).toBeNull();
  });

  test("recognizes JPEG and GIF", () => {
    expect(iconMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(iconMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe("image/gif");
  });

  test("returns null for a compiled binary XML drawable", () => {
    expect(iconMimeType(new Uint8Array([0x03, 0x00, 0x08, 0x00]))).toBeNull();
  });
});

describe("readAppIcon", () => {
  const ICON: AppIcon = { mimeType: "image/png", data: "aWNvbg==" };

  function fakes(pathFor: (packageName: string) => string | null) {
    const extracted: string[] = [];
    return {
      extracted,
      deps: {
        readBaseApkPath: (_serial: string, packageName: string) =>
          Promise.resolve(pathFor(packageName)),
        extractIcon: (_serial: string, baseApkPath: string) => {
          extracted.push(baseApkPath);
          return Promise.resolve(ICON);
        },
      },
    };
  }

  beforeEach(() => {
    clearAppIconCache();
  });

  test("extracts once for repeat reads of the same install", async () => {
    const { extracted, deps } = fakes(() => "/data/app/~~aaa==/com.example-1/base.apk");

    expect(await readAppIcon("emulator-5554", "com.example", deps)).toEqual(ICON);
    expect(await readAppIcon("emulator-5554", "com.example", deps)).toEqual(ICON);

    expect(extracted).toHaveLength(1);
  });

  test("keeps one entry per device, so the same package on two serials does not collide", async () => {
    const { extracted, deps } = fakes(() => "/data/app/~~aaa==/com.example-1/base.apk");

    await readAppIcon("emulator-5554", "com.example", deps);
    await readAppIcon("emulator-5556", "com.example", deps);

    expect(extracted).toHaveLength(2);
  });

  test("re-extracts after a reinstall moves the apk, and does not keep the old entry", async () => {
    let path = "/data/app/~~aaa==/com.example-1/base.apk";
    const { extracted, deps } = fakes(() => path);

    await readAppIcon("emulator-5554", "com.example", deps);
    path = "/data/app/~~bbb==/com.example-2/base.apk";
    await readAppIcon("emulator-5554", "com.example", deps);
    await readAppIcon("emulator-5554", "com.example", deps);

    expect(extracted).toEqual([
      "/data/app/~~aaa==/com.example-1/base.apk",
      "/data/app/~~bbb==/com.example-2/base.apk",
    ]);
  });

  test("drops a failed extraction so the next read retries", async () => {
    let attempts = 0;
    const deps = {
      readBaseApkPath: () => Promise.resolve("/data/app/~~aaa==/com.example-1/base.apk"),
      extractIcon: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("pull failed")) : Promise.resolve(ICON);
      },
    };

    await expect(readAppIcon("emulator-5554", "com.example", deps)).rejects.toThrow("pull failed");
    expect(await readAppIcon("emulator-5554", "com.example", deps)).toEqual(ICON);
    expect(attempts).toBe(2);
  });

  test("a failure does not evict the newer entry that replaced it", async () => {
    let release: (() => void) | null = null;
    const slowFailure = new Promise<AppIcon | null>((_resolve, reject) => {
      release = () => {
        reject(new Error("pull failed"));
      };
    });
    let path = "/data/app/~~aaa==/com.example-1/base.apk";
    let call = 0;
    const deps = {
      readBaseApkPath: () => Promise.resolve(path),
      extractIcon: () => {
        call += 1;
        return call === 1 ? slowFailure : Promise.resolve(ICON);
      },
    };

    const failing = readAppIcon("emulator-5554", "com.example", deps);
    path = "/data/app/~~bbb==/com.example-2/base.apk";
    expect(await readAppIcon("emulator-5554", "com.example", deps)).toEqual(ICON);

    release!();
    await expect(failing).rejects.toThrow("pull failed");

    expect(await readAppIcon("emulator-5554", "com.example", deps)).toEqual(ICON);
    expect(call).toBe(2);
  });

  test("bounds the cache, evicting the oldest package first", async () => {
    const { extracted, deps } = fakes((packageName) => `/data/app/${packageName}/base.apk`);

    for (let i = 0; i <= MAX_CACHED_ICONS; i += 1) {
      await readAppIcon("emulator-5554", `com.example.app${i}`, deps);
    }
    expect(extracted).toHaveLength(MAX_CACHED_ICONS + 1);

    // The newest is still cached; the first one was evicted and must be read again.
    await readAppIcon("emulator-5554", `com.example.app${MAX_CACHED_ICONS}`, deps);
    expect(extracted).toHaveLength(MAX_CACHED_ICONS + 1);

    await readAppIcon("emulator-5554", "com.example.app0", deps);
    expect(extracted).toHaveLength(MAX_CACHED_ICONS + 2);
  });

  test("repeated reinstalls of one package do not evict the others", async () => {
    const paths = new Map<string, string>();
    const extracted: string[] = [];
    const deps = {
      readBaseApkPath: (_serial: string, packageName: string) =>
        Promise.resolve(paths.get(packageName) ?? `/data/app/${packageName}/base.apk`),
      extractIcon: (_serial: string, baseApkPath: string) => {
        extracted.push(baseApkPath);
        return Promise.resolve(ICON);
      },
    };

    await readAppIcon("emulator-5554", "com.example.first", deps);

    // One package, reinstalled far more times than the cache can hold.
    for (let i = 0; i < MAX_CACHED_ICONS * 2; i += 1) {
      paths.set("com.example.churn", `/data/app/~~build${i}==/com.example.churn/base.apk`);
      await readAppIcon("emulator-5554", "com.example.churn", deps);
    }

    const before = extracted.length;
    await readAppIcon("emulator-5554", "com.example.first", deps);
    expect(extracted).toHaveLength(before);
  });

  test("throws when the package is not installed", async () => {
    const { deps } = fakes(() => null);

    await expect(readAppIcon("emulator-5554", "com.missing", deps)).rejects.toThrow(
      "com.missing is not installed",
    );
  });
});
