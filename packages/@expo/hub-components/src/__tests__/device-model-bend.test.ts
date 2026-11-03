import { expect, test } from "bun:test";

import { createFlexDeformer } from "../foldable/device-model-bend";

/** A strip of two triangles per station across the hinge, in meters, flat at z = 0. */
function strip(name: string, xs: number[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const x of xs) {
    positions.push(x / 1000, -0.01, 0, x / 1000, 0.01, 0);
    normals.push(0, 0, 1, 0, 0, 1);
  }
  const indices: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return {
    name,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function bend(deformer: ReturnType<typeof createFlexDeformer>, angle: number, count: number) {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  deformer!.apply(angle, positions, normals);
  return { positions, normals };
}

test("only the GLBs' flexible meshes get a deformer", () => {
  expect(createFlexDeformer("duo", strip("L • titanium unibody", [-10, 10]))).toBeNull();
  expect(createFlexDeformer("pixel", strip("FLEX • continuous inner OLED", [-10, 10]))).toBeNull();
  expect(
    createFlexDeformer("duo", strip("FLEX • continuous inner OLED", [-10, 10])),
  ).not.toBeNull();
  expect(
    createFlexDeformer("pixel", strip("FLEX • continuous inner OLED bridge", [-10, 10])),
  ).not.toBeNull();
});

test("the Duo's display stays flat open, and folds its right side onto the left about the hinge pivot", () => {
  const mesh = strip("FLEX • continuous inner OLED", [-10, -2, 0, 2, 10]);
  const deformer = createFlexDeformer("duo", mesh);
  const open = bend(deformer, 180, 10);
  expect(Array.from(open.positions)).toEqual(Array.from(mesh.positions));
  const closed = bend(deformer, 0, 10).positions;
  // The left leaf does not move.
  expect(closed[0]).toBeCloseTo(-0.01, 6);
  expect(closed[2]).toBeCloseTo(0, 6);
  // 10 mm right of the hinge turns half a circle about the pivot 0.260577 mm above it.
  expect(closed[24]).toBeCloseTo(-0.01, 6);
  expect(closed[26]).toBeCloseTo(2 * 0.000260577, 6);
  // Height along the hinge never changes.
  for (let i = 1; i < closed.length; i += 3) expect(closed[i]).toBe(mesh.positions[i]!);
});

test("the Pixel 9 Pro Fold's bridge bends continuously, with unit normals, at every angle", () => {
  const xs = [-8, -4.3, -2, 0, 2, 4.3, 8];
  const deformer = createFlexDeformer("pixel", strip("FLEX • continuous inner OLED bridge", xs));
  for (const angle of [0, 30, 90, 150, 180]) {
    const { positions, normals } = bend(deformer, angle, xs.length * 2);
    for (let i = 0; i < positions.length; i++) expect(Number.isFinite(positions[i]!)).toBe(true);
    for (let i = 0; i < normals.length; i += 3) {
      expect(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!)).toBeCloseTo(1, 5);
    }
  }
});
