import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { DEVICE_MODELS, type DeviceModelDescription } from "../foldable/device-models";
import { type DeviceModelRig, rigDeviceModel } from "../foldable/device-model-rig";
import { duoViewFolds } from "../foldable/duo-view";

// The Hub ships the models with its dashboard.
const MODELS = fileURLToPath(
  new URL("../../../../expo-device-hub/assets/device-models/", import.meta.url),
);
const FILES: Record<keyof typeof DEVICE_MODELS, string> = {
  "ios:iphone-duo": "iphone-duo.glb",
  "ios:iphone-18-pro": "iphone-18-pro.glb",
  "android:pixel-9-pro": "pixel-9-pro.glb",
  "android:pixel-9-pro-fold": "pixel-9-pro-fold.glb",
};

/** The GLB without its images: geometry, materials, and animation are real; image decoding needs a browser. */
function withoutTextures(path: string): ArrayBuffer {
  const file = readFileSync(path);
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
  const binary = file.subarray(20 + jsonLength);
  delete json.textures;
  delete json.images;
  delete json.samplers;
  const strip = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (key.endsWith("Texture")) delete (value as Record<string, unknown>)[key];
      else strip((value as Record<string, unknown>)[key]);
    }
  };
  for (const material of json.materials ?? []) strip(material);
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const chunk = Buffer.from(text, "utf8");
  const out = Buffer.alloc(20 + chunk.length + binary.length);
  file.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(chunk.length, 12);
  out.write("JSON", 16);
  chunk.copy(out, 20);
  binary.copy(out, 20 + chunk.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

async function rig(model: DeviceModelDescription): Promise<{ rig: DeviceModelRig; gltf: GLTF }> {
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(withoutTextures(MODELS + FILES[model.id]), "");
  return { rig: rigDeviceModel(model, gltf), gltf };
}

function bounds(object: THREE.Object3D) {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object);
}

function size(box: THREE.Box3) {
  return box.getSize(new THREE.Vector3());
}

/** The folds that a Duo view sets for a hinge angle, as the scene computes them. */
function folds(
  angle: number,
  view = { rotation: [0, 0, 0, 1] as [number, number, number, number] },
) {
  return duoViewFolds(((180 - angle) * Math.PI) / 360, view);
}

const available = Object.values(FILES).every((file) => existsSync(MODELS + file));

describe.skipIf(!available)("the iPhone Duo rig, in Xcode's model's place", () => {
  test("has two halves and the displays where Xcode's model had them, in its centimeters", async () => {
    const { rig: duo } = await rig(DEVICE_MODELS["ios:iphone-duo"]);
    expect(duo.halves).not.toBeNull();
    expect(duo.displays.main).toHaveLength(1);
    expect(duo.displays.cover).toHaveLength(1);
    // Xcode's open Duo was more than 16 cm wide, each inner half more than 7 x 11 cm.
    const open = size(bounds(duo.model));
    expect(open.x).toBeGreaterThan(16);
    const inner = size(bounds(duo.displays.main[0]!));
    expect(inner.x / 2).toBeGreaterThan(7);
    expect(inner.y).toBeGreaterThan(11);
    // The open inner display faces the camera at the hinge plane; the cover is on the left half, behind.
    expect(Math.abs(bounds(duo.displays.main[0]!).getCenter(new THREE.Vector3()).z)).toBeLessThan(
      0.1,
    );
    const cover = bounds(duo.displays.cover[0]!);
    expect(cover.max.x).toBeLessThan(0);
    expect(cover.max.z).toBeLessThan(0);
    // The body's center stays on the hinge axis when open.
    expect(duo.center(new THREE.Vector3()).length()).toBeLessThan(0.1);
  });

  test("folds shut like Xcode's model: thin, standing out of the hinge plane, centered by its leaves", async () => {
    const { rig: duo } = await rig(DEVICE_MODELS["ios:iphone-duo"]);
    duo.fold(folds(0));
    const closed = size(bounds(duo.model));
    expect(closed.x).toBeLessThan(2.5);
    expect(closed.z).toBeGreaterThan(8);
    // Xcode's model centered the closed body at half a leaf (4.05 cm) in front of the hinge.
    const center = duo.center(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 1);
    expect(center.z).toBeGreaterThan(4);
    expect(center.z).toBeLessThan(4.3);
    // The cover faces away from the inner display, which folds inside.
    const cover = new THREE.Vector3(0, 0, -1).transformDirection(
      duo.displays.cover[0]!.matrixWorld,
    );
    expect(cover.x).toBeLessThan(-0.99);
  });

  test("bends one inner display over the hinge, with UVs that span it", async () => {
    const { rig: duo } = await rig(DEVICE_MODELS["ios:iphone-duo"]);
    const mesh = duo.displays.main[0]!;
    const uv = mesh.geometry.getAttribute("uv");
    let minU = Infinity;
    let maxU = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      minU = Math.min(minU, uv.getX(i));
      maxU = Math.max(maxU, uv.getX(i));
    }
    expect(minU).toBeCloseTo(0, 5);
    expect(maxU).toBeCloseTo(1, 5);
    duo.fold(folds(90));
    const bent = bounds(mesh);
    // At 90° the display reaches from the left leaf around the hinge onto the right leaf.
    expect(size(bent).z).toBeGreaterThan(7);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 97) {
      expect(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i))).toBe(true);
    }
    // A projection without bending leaves the flexible display's own shape as it was.
    const shape = () => {
      mesh.geometry.computeBoundingBox();
      return size(mesh.geometry.boundingBox!);
    };
    const bentShape = shape();
    duo.fold(folds(0), false);
    expect(shape().equals(bentShape)).toBe(true);
  });

  test("keeps the cover's U mirrored, as seen from behind", async () => {
    const { rig: duo } = await rig(DEVICE_MODELS["ios:iphone-duo"]);
    const mesh = duo.displays.cover[0]!;
    const position = mesh.geometry.getAttribute("position");
    const uv = mesh.geometry.getAttribute("uv");
    let left = 0;
    for (let i = 1; i < position.count; i++) if (position.getX(i) < position.getX(left)) left = i;
    expect(uv.getX(left)).toBeCloseTo(1, 5);
  });
});

describe.skipIf(!available)("the other models", () => {
  test("the Pixel 9 Pro Fold folds its three inner meshes and keeps its cover on the left leaf", async () => {
    const { rig: fold } = await rig(DEVICE_MODELS["android:pixel-9-pro-fold"]);
    expect(fold.displays.main).toHaveLength(3);
    expect(fold.displays.cover).toHaveLength(1);
    const open = size(bounds(fold.model));
    expect(open.x).toBeGreaterThan(14);
    fold.fold(folds(0));
    const closed = size(bounds(fold.model));
    expect(closed.x).toBeLessThan(2.5);
    expect(closed.z).toBeGreaterThan(7);
  });

  test("a phone has one display, no hinge, and turns around its own center", async () => {
    for (const id of ["ios:iphone-18-pro", "android:pixel-9-pro"] as const) {
      const { rig: phone } = await rig(DEVICE_MODELS[id]);
      expect(phone.halves).toBeNull();
      expect(phone.displays.main).toHaveLength(1);
      expect(phone.displays.cover).toHaveLength(0);
      const body = bounds(phone.model);
      expect(body.getCenter(new THREE.Vector3()).length()).toBeLessThan(0.01);
      // The display is at the front of the body.
      expect(bounds(phone.displays.main[0]!).max.z).toBeCloseTo(body.max.z, 1);
      phone.fold(folds(0));
      expect(bounds(phone.model).equals(body)).toBe(true);
    }
  });

  test("each display mesh has the shape of its framebuffer", async () => {
    for (const model of Object.values(DEVICE_MODELS)) {
      const { rig: loaded } = await rig(model);
      for (const [key, display] of Object.entries(model.displays)) {
        if (!display) continue;
        const box = new THREE.Box3();
        for (const mesh of loaded.displays[key as "main" | "cover"]) box.union(bounds(mesh));
        const glass = size(box);
        const frame = display.mount
          ? display.size.height / display.size.width
          : display.size.width / display.size.height;
        expect(Math.abs(glass.x / glass.y - frame) / frame).toBeLessThan(0.02);
      }
    }
  });
});
