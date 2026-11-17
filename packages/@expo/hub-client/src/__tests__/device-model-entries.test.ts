import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type DeviceClient } from "../types";
import {
  DEVICE_MODEL_IDS,
  DEVICE_MODELS,
  deviceModelFor,
  deviceModelPreview,
  deviceModelStreamable,
  type DeviceModelId,
  resolveDeviceModel,
} from "../models/catalog";
import { resolveScreenShape } from "../shapes";
import { FILES, MODELS } from "./glb-fixtures";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const EXTERNAL = ["react", "react-dom", "react/jsx-runtime", "use-sync-external-store"];
// The optional peers: three.js and its add-ons, at any subpath.
const isThree = (specifier: string) => /^three(-mesh-bvh)?(\/|$)/.test(specifier);

/**
 * Every module that an entry loads at run time and every package that those
 * modules import, before a bundler removes anything. Type-only imports do not
 * count: the transpiler drops them, as the build does.
 */
function runtimeGraph(entry: string): { files: string[]; packages: string[] } {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const transpiler = transpilers[file.endsWith(".tsx") ? "tsx" : "ts"];
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) {
        packages.add(path);
        continue;
      }
      const base = resolve(dirname(file), path);
      const target = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
      if (!target) throw new Error(`${file} imports ${path}, which is not a source file`);
      visit(target);
    }
  };
  visit(join(SRC, entry));
  return { files: [...files].map((file) => relative(SRC, file)), packages: [...packages] };
}

async function bundle(fixture: string): Promise<string> {
  const entry = new URL(`./fixtures/${fixture}`, import.meta.url).pathname;
  const result = await Bun.build({ entrypoints: [entry], external: EXTERNAL, minify: false });
  expect(result.success).toBe(true);
  return result.outputs[0]!.text();
}

// @ref LLP 0019#two-entries — the main entry never loads the models, and the catalog never loads three.js
describe("the models entries stay out of an app that does not use them", () => {
  test("the main entry loads no three.js, no model code, and no shape code", () => {
    const graph = runtimeGraph("index.ts");
    expect(graph.files).toContain("DeviceScreen.tsx");
    expect(graph.packages.filter(isThree)).toEqual([]);
    expect(graph.files.filter((file) => /^(models|shapes)\//.test(file))).toEqual([]);
  });

  test("the shapes entry loads no three.js and no model code", () => {
    const graph = runtimeGraph("shapes/index.ts");
    expect(graph.packages.filter(isThree)).toEqual([]);
    expect(graph.files.filter((file) => file.startsWith("models/"))).toEqual([]);
  });

  test("the catalog loads the model table and no three.js", () => {
    const graph = runtimeGraph("models/catalog.ts");
    expect(graph.files).toContain("models/device-models.ts");
    expect(graph.packages.filter(isThree)).toEqual([]);
  });

  test("the models entry is the one that loads three.js", () => {
    // The same walk finds three.js where it is, so the checks above can fail.
    const { packages } = runtimeGraph("models/index.ts");
    expect(packages).toContain("three");
    expect(packages).toContain("three-mesh-bvh");
    expect(packages.filter(isThree).length).toBeGreaterThan(2);
  });

  test("a bundle of the whole main entry has its code and no model table", async () => {
    // Every export is kept, as in a bundler without tree shaking.
    const output = await bundle("main-entry-whole.ts");
    expect(output).toContain("function DeviceScreen");
    expect(output).toContain("function useAndroidDeviceClient");
    for (const marker of ["continuous inner OLED", "ios:iphone-duo", "createDuoScene"]) {
      expect(output).not.toContain(marker);
    }
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
    expect(manifest.files).toContain("models/*.glb");
    expect(manifest.files).toContain("models/glb.d.ts");
    // An app that does not show 3D models needs no three.js, and one that has
    // three.js for its own use installs with any version of it.
    for (const peer of ["three", "three-mesh-bvh"]) {
      expect(manifest.peerDependencies[peer]).toBe("*");
      expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true);
    }
    // One file per model id, each with its own export, so that a misspelled
    // import fails in TypeScript and in the bundler. Each is typed as its URL.
    expect(Object.keys(FILES).sort()).toEqual([...DEVICE_MODEL_IDS].sort());
    const glbExports = Object.keys(manifest.exports).filter((key) => key.endsWith(".glb"));
    expect(glbExports.sort()).toEqual(
      Object.values(FILES)
        .map((file) => `./models/${file}`)
        .sort(),
    );
    for (const file of Object.values(FILES)) {
      expect(manifest.exports[`./models/${file}`]).toEqual({
        types: "./models/glb.d.ts",
        default: `./models/${file}`,
      });
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
    // Names of object members are not model names or model ids.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveDeviceModel({ platform: "android", model: name })).toBeNull();
      expect(resolveDeviceModel({ platform: "ios", model: name })).toBeNull();
      expect(deviceModelFor(name as DeviceModelId)).toBeNull();
    }
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
    // A custom client with a part of the displays has no frame for the other panel.
    const [cover, inner] = duo.displays!;
    for (const displays of [[], [cover!], [inner!], [inner!, inner!]]) {
      expect(deviceModelStreamable(model, { ...duo, displays })).toBe(false);
    }
    expect(deviceModelStreamable(model, { ...duo, displays: [inner!, cover!] })).toBe(true);
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
