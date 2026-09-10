import { describe, expect, test } from "bun:test";
import {
  iconMimeType,
  parseAdaptiveForegroundId,
  selectBaseApkPath,
  selectIconEntry,
  selectResourceFilePath,
} from "../src/apk-icon.ts";

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
