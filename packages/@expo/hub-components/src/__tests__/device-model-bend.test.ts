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

test("a step of the flat display keeps its length over the bend, so the stream does not stretch at the hinge", () => {
  // The stream is mapped once on the open display. The first port moved a
  // step in the middle of the Duo's hinge to 1.43 times its length at 96°.
  const xs = Array.from({ length: 241 }, (_, i) => -6 + i * 0.05);
  for (const [model, name] of [
    ["duo", "FLEX • continuous inner OLED"],
    ["pixel", "FLEX • continuous inner OLED bridge"],
  ] as const) {
    const deformer = createFlexDeformer(model, strip(name, xs));
    for (const angle of [5, 30, 60, 96, 120, 150, 175]) {
      const { positions } = bend(deformer, angle, xs.length * 2);
      for (let i = 1; i < xs.length; i++) {
        // The first vertex of each station, at y = -10 mm.
        const a = (i - 1) * 6;
        const b = i * 6;
        const bent = Math.hypot(
          positions[b]! - positions[a]!,
          positions[b + 2]! - positions[a + 2]!,
        );
        const ratio = (bent * 1000) / (xs[i]! - xs[i - 1]!);
        // The Duo stretches up to 0.413% near flat to meet its leaves; the
        // Pixel's tightest turn, near closed, shortens a straight step most.
        expect(ratio).toBeGreaterThan(0.98);
        expect(ratio).toBeLessThan(1.005);
      }
    }
  }
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
