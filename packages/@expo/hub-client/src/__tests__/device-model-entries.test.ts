import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { type DeviceClient } from "../types";
import {
  DEVICE_MODEL_IDS,
  DEVICE_MODELS,
  deviceModelPreview,
  deviceModelStreamable,
  resolveDeviceModel,
} from "../models/catalog";
import { resolveScreenShape } from "../shapes";
import { FILES, MODELS } from "./glb-fixtures";

const EXTERNAL = ["react", "react-dom", "react/jsx-runtime", "use-sync-external-store"];
// Text that only three.js, the scene, and the model table have.
const THREE_MARKERS = ["WebGLRenderer", "GLTFLoader", "MeshBVH", "createDuoScene"];
const MODEL_MARKERS = ["continuous inner OLED", "ios:iphone-duo"];

async function bundle(fixture: string): Promise<string> {
  const entry = new URL(`./fixtures/${fixture}`, import.meta.url).pathname;
  // `three` stays in the bundle on purpose: an entry that reaches it would show its code.
  const result = await Bun.build({ entrypoints: [entry], external: EXTERNAL, minify: false });
  expect(result.success).toBe(true);
  return result.outputs[0]!.text();
}

// @ref LLP 0019#two-entries — the main entry never loads the models, and the catalog never loads three.js
describe("the models entries stay out of an app that does not use them", () => {
  test("the whole main entry bundles no three.js, no model table, and no shape table", async () => {
    // Every export is kept, as in a bundler without tree shaking, such as Metro.
    const output = await bundle("main-entry-whole.ts");
    // The bundle holds the main entry's code, not only its export names.
    expect(output).toContain("function DeviceScreen");
    expect(output).toContain("function useAndroidDeviceClient");
    for (const marker of [...THREE_MARKERS, ...MODEL_MARKERS]) expect(output).not.toContain(marker);
    // Bun names each bundled module in a comment.
    expect(output).not.toMatch(/^\/\/ .*\/(models|shapes)\//m);
  });

  test("an app that imports only the catalog bundles the model table without three.js", async () => {
    const output = await bundle("models-catalog-only.ts");
    for (const marker of MODEL_MARKERS) expect(output).toContain(marker);
    for (const marker of THREE_MARKERS) expect(output).not.toContain(marker);
  });

  test("the package exports both entries and every model's GLB file", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      files: string[];
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(manifest.exports["./models"]).toBeDefined();
    expect(manifest.exports["./models/catalog"]).toBeDefined();
    expect(manifest.exports["./models/*.glb"]).toBe("./models/*.glb");
    expect(manifest.files).toContain("models/*.glb");
    // A consumer that does not show 3D models must not need three.js.
    for (const peer of ["three", "three-mesh-bvh"]) {
      expect(manifest.peerDependencies[peer]).toBeDefined();
      expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true);
    }
    // One file per model id, at the path the export pattern serves.
    expect(Object.keys(FILES).sort()).toEqual([...DEVICE_MODEL_IDS].sort());
    for (const file of Object.values(FILES)) {
      expect(
        readFileSync(MODELS + file)
          .subarray(0, 4)
          .toString("latin1"),
      ).toBe("glTF");
    }
  });
});

describe("resolveDeviceModel", () => {
  test("takes the simulator device type name on iOS, without case and surrounding spaces", () => {
    expect(resolveDeviceModel({ platform: "ios", model: "iPhone Duo" })).toBe(
      DEVICE_MODELS["ios:iphone-duo"],
    );
    expect(resolveDeviceModel({ platform: "ios", model: "  iphone 18 pro " })).toBe(
      DEVICE_MODELS["ios:iphone-18-pro"],
    );
    expect(resolveDeviceModel({ platform: "ios", model: "iPhone 18 Pro Max" })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: "iPhone 17 Pro" })).toBeNull();
  });

  test("takes the AVD hardware profile id on Android, exactly", () => {
    expect(resolveDeviceModel({ platform: "android", model: "pixel_9_pro" })).toBe(
      DEVICE_MODELS["android:pixel-9-pro"],
    );
    expect(resolveDeviceModel({ platform: "android", model: "pixel_9_pro_fold" })).toBe(
      DEVICE_MODELS["android:pixel-9-pro-fold"],
    );
    expect(resolveDeviceModel({ platform: "android", model: "Pixel_9_Pro" })).toBeNull();
    expect(resolveDeviceModel({ platform: "android", model: "pixel_9_pro_xl" })).toBeNull();
    expect(resolveDeviceModel({ platform: "android", model: "pixel_9" })).toBeNull();
  });

  test("has no model for an unknown name, another platform's name, or no name", () => {
    expect(resolveDeviceModel({ platform: "android", model: "iPhone Duo" })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: "pixel_9_pro" })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: null })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: undefined })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: "" })).toBeNull();
    // Names of object members are not model names.
    expect(resolveDeviceModel({ platform: "android", model: "constructor" })).toBeNull();
    expect(resolveDeviceModel({ platform: "ios", model: "toString" })).toBeNull();
  });

  test("names every model, by a name that also has a screen shape", () => {
    const names: [DeviceClient["platform"], string][] = [
      ["ios", "iPhone Duo"],
      ["ios", "iPhone 18 Pro"],
      ["android", "pixel_9_pro"],
      ["android", "pixel_9_pro_fold"],
    ];
    const resolved = names.map(([platform, model]) => resolveDeviceModel({ platform, model })?.id);
    expect([...resolved].sort()).toEqual([...DEVICE_MODEL_IDS].sort());
    for (const [platform, model] of names) {
      expect(resolveScreenShape({ platform, model })).not.toBeNull();
    }
  });
});

describe("deviceModelStreamable", () => {
  const flat = { fold: null, displays: null };
  const duo = {
    fold: { angle: 0, pose: "closed", pending: false, error: null, setControl: () => {} },
    displays: [
      { id: "cover", active: true, attachVideo: () => {} },
      { id: "inner", active: false, attachVideo: () => {} },
    ],
  } as unknown as Pick<DeviceClient, "fold" | "displays">;

  test("a model of the flat screen needs only a client", () => {
    expect(deviceModelStreamable(DEVICE_MODELS["android:pixel-9-pro-fold"], flat)).toBe(true);
    expect(deviceModelStreamable(DEVICE_MODELS["ios:iphone-18-pro"], flat)).toBe(true);
    expect(deviceModelStreamable(DEVICE_MODELS["ios:iphone-18-pro"], null)).toBe(false);
  });

  test("the iPhone Duo needs its fold state and both displays", () => {
    const model = DEVICE_MODELS["ios:iphone-duo"];
    expect(deviceModelStreamable(model, flat)).toBe(false);
    expect(deviceModelStreamable(model, { ...duo, displays: null })).toBe(false);
    expect(deviceModelStreamable(model, { ...duo, fold: null })).toBe(false);
    expect(deviceModelStreamable(model, duo)).toBe(true);
  });

  test("deviceModelPreview applies it to a listed device", () => {
    const assets = { "ios:iphone-duo": "https://hub.test/duo.glb" };
    expect(deviceModelPreview({ deviceModel: "ios:iphone-duo" }, flat, assets)).toBeNull();
    expect(deviceModelPreview({ deviceModel: "ios:iphone-duo" }, duo, assets)).toEqual({
      model: DEVICE_MODELS["ios:iphone-duo"],
      url: "https://hub.test/duo.glb",
    });
  });
});
