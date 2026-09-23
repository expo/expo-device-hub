import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as THREE from "three";
import { resolveDeviceKitModel } from "../devicekit-model";
import { clipHingeGeometry, prepareDuoModel } from "../client/simulator/duo-model";
import { applySelectedLayer, parseDeviceKitUsdz } from "../client/simulator/devicekit-usdz";
import type { USDLayer } from "three/addons/loaders/usd/USDCParser.js";

test("hinge clipping preserves the display outline and continuous UVs on both halves", () => {
  const plane = new THREE.PlaneGeometry(4, 2);
  for (const sign of [-1, 1] as const) {
    const geometry = clipHingeGeometry(plane, sign)!;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBe(sign < 0 ? -2 : 0);
    expect(geometry.boundingBox!.max.x).toBe(sign < 0 ? 0 : 2);
    const positions = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    let area = 0;
    for (let i = 0; i < positions.count; i++) {
      expect(uv.getX(i)).toBeCloseTo((positions.getX(i) + 2) / 4);
      expect(uv.getY(i)).toBeCloseTo((positions.getY(i) + 1) / 2);
      if (i % 3 === 0) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, i);
        const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1);
        const c = new THREE.Vector3().fromBufferAttribute(positions, i + 2);
        area += b.sub(a).cross(c.sub(a)).length() / 2;
      }
    }
    expect(area).toBeCloseTo(4);
  }
});

test("wrapper color overrides preserve payload geometry and ignore unselected variants", () => {
  const target: USDLayer = { specsByPath: {
    "/root": { specType: 6, fields: { typeName: "Xform", primChildren: ["body"] } },
    "/root/material.color": { specType: 1, fields: { typeName: "color3f", default: [0, 0, 0] } },
  } };
  applySelectedLayer(target, { specsByPath: {
    "/root": { specType: 6, fields: { payload: null, variantSelection: { color: "Light" } } },
    "/root/{color=Light}/material.color": { specType: 1, fields: { default: [1, 1, 1] } },
    "/root/{color=Dark}/material.color": { specType: 1, fields: { default: [0.1, 0.1, 0.1] } },
  } });
  expect(target.specsByPath["/root"]!.fields.primChildren).toEqual(["body"]);
  expect(target.specsByPath["/root/material.color"]!.fields).toEqual({ typeName: "color3f", default: [1, 1, 1] });
});

const installedModel = resolveDeviceKitModel();
test.skipIf(!installedModel)("loads the installed Xcode archive into foldable halves and live screen meshes", async () => {
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  // Geometry/material composition is real; image decoding requires a browser.
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  } });
  try {
    const bytes = readFileSync(installedModel!);
    const source = await parseDeviceKitUsdz(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const model = prepareDuoModel(source);
    const left = model.getObjectByName("left-half")!;
    const right = model.getObjectByName("right-half")!;
    expect(left.children.length).toBeGreaterThan(10);
    expect(right.children.length).toBeGreaterThan(10);
    expect(left.getObjectByName("cover-display")).toBeInstanceOf(THREE.Mesh);
    for (const half of ["left", "right"]) {
      const display = model.getObjectByName(`inner-display-${half}`)!;
      const box = new THREE.Box3().setFromObject(display);
      expect(box.getSize(new THREE.Vector3()).x).toBeGreaterThan(7);
      expect(box.getSize(new THREE.Vector3()).y).toBeGreaterThan(11);
      expect(Math.abs(box.getCenter(new THREE.Vector3()).z)).toBeLessThan(0.001);
    }
    const openBounds = new THREE.Box3().setFromObject(model);
    expect(openBounds.getSize(new THREE.Vector3()).x).toBeGreaterThan(16);
    left.rotation.y = Math.PI / 2;
    right.rotation.y = -Math.PI / 2;
    const closedBounds = new THREE.Box3().setFromObject(model);
    expect(closedBounds.getSize(new THREE.Vector3()).x).toBeLessThan(2);
    expect(closedBounds.getSize(new THREE.Vector3()).z).toBeGreaterThan(8);
  } finally {
    if (previousImage) Object.defineProperty(globalThis, "Image", previousImage);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});
