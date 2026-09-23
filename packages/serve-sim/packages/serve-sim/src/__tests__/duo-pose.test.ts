import { describe, expect, test } from "bun:test";
import { Euler, Vector2, Vector3 } from "three";
import { duoPose, duoScreenMapping, duoScreenPoint, stepDuoSpring } from "../client/simulator/duo-pose";
import type { SimulatorOrientation } from "../client/types";

function advanceSpring(value: number, target: number, steps: number, seconds: number, velocity = 0) {
  let state = { value, velocity };
  for (let i = 0; i < steps; i++) {
    state = stepDuoSpring(state.value, state.velocity, target, seconds);
  }
  return state;
}

describe("iPhone Duo physical poses", () => {
  test("articulates both halves symmetrically through closed, half-open, and open", () => {
    for (const degrees of [0, 45, 90, 135, 180]) {
      const { fold } = duoPose(degrees, null);
      const interiorAngle = Math.PI - 2 * fold;
      expect(interiorAngle).toBeCloseTo(degrees * Math.PI / 180, 12);
    }
    expect(duoPose(-10, null).fold).toBe(duoPose(0, null).fold);
    expect(duoPose(200, null).fold).toBe(duoPose(180, null).fold);
  });

  test("uses the active display when the initial hinge angle is still unknown", () => {
    expect(duoPose(undefined, null, 1)).toEqual(duoPose(0, null));
    expect(duoPose(undefined, null, 3)).toEqual(duoPose(180, "open"));
    expect(duoPose(90, "book", 1)).toEqual(duoPose(90, "book", 3));
  });

  test("initial framing brings the cover into view when connecting to a closed device", () => {
    for (const degrees of [0, 45, 90, 180]) {
      expect(duoPose(degrees, "open")).toEqual(duoPose(degrees, null));
    }
    expect(duoPose(0, "open").rotation[1]).toBeGreaterThan(1);
  });

  test("tabletop poses ignore app orientation and generic poses ignore the previous panel", () => {
    const poses = [
      { id: "closed", angle: 0 },
      { id: "open", angle: 180 },
      { id: "book", angle: 90 },
      { id: "laptop", angle: 90 },
      { id: "tent", angle: 80 },
    ] as const;
    for (const pose of poses) {
      const expected = duoPose(pose.angle, pose.id);
      for (const screenId of [1, 3]) {
        for (const orientation of ["portrait", "landscape_left", "landscape_right", "portrait_upside_down"] as const) {
          const config = { width: 2007, height: 2853, screenId, orientation };
          const visibleScreen = pose.angle === 0 ? 1 : 3;
          if (pose.id === "laptop" || pose.id === "tent" || screenId !== visibleScreen) {
            expect(duoPose(pose.angle, pose.id, screenId, config)).toEqual(expected);
          }
        }
      }
    }
  });

  test("Closed shows the cover upright and Open retains the model's vertical hinge", () => {
    const closed = new Euler(...duoPose(0, "closed").rotation, "YXZ");
    expect(new Vector3(-1, 0, 0).applyEuler(closed).z).toBeGreaterThan(0.95);
    expect(new Vector3(0, 1, 0).applyEuler(closed).y).toBeGreaterThan(0.99);
    const open = new Euler(...duoPose(180, "open").rotation, "YXZ");
    expect(new Vector3(0, 1, 0).applyEuler(open).y).toBeGreaterThan(0.99);
    expect(new Vector3(0, 0, 1).applyEuler(open).z).toBeGreaterThan(0.95);
  });

  test("Book has a vertical hinge while Laptop and Tent have horizontal hinges", () => {
    const book = duoPose(90, "book");
    const laptop = duoPose(90, "laptop");
    const tent = duoPose(80, "tent");
    const bookAxis = new Vector3(0, 1, 0).applyEuler(new Euler(...book.rotation, "YXZ"));
    const laptopAxis = new Vector3(0, 1, 0).applyEuler(new Euler(...laptop.rotation, "YXZ"));
    const tentAxis = new Vector3(0, 1, 0).applyEuler(new Euler(...tent.rotation, "YXZ"));

    expect(book.fold).toBe(laptop.fold);
    expect(Math.abs(bookAxis.y)).toBeGreaterThan(0.9);
    expect(Math.abs(laptopAxis.x)).toBeGreaterThan(Math.abs(laptopAxis.y));
    expect(Math.abs(tentAxis.x)).toBeGreaterThan(Math.abs(tentAxis.y));
    expect(laptopAxis.x).toBeLessThan(0);
    expect(tentAxis.x).toBeGreaterThan(0);
    // Tent tips the device over; it must not be a slightly different laptop angle.
    const laptopNormal = new Vector3(0, 0, 1).applyEuler(new Euler(...laptop.rotation, "YXZ"));
    const tentNormal = new Vector3(0, 0, 1).applyEuler(new Euler(...tent.rotation, "YXZ"));
    expect(laptopNormal.y).toBeGreaterThan(0);
    expect(tentNormal.y).toBeLessThan(0);
  });

  test("initial framing accounts for native orientation on closed, half-open, and open devices", () => {
    const orientations: { orientation: SimulatorOrientation; right: [number, number]; up: [number, number] }[] = [
      { orientation: "portrait", right: [1, 0], up: [0, 1] },
      { orientation: "landscape_left", right: [0, -1], up: [1, 0] },
      { orientation: "landscape_right", right: [0, 1], up: [-1, 0] },
      { orientation: "portrait_upside_down", right: [-1, 0], up: [0, -1] },
    ];
    for (const angle of [0, 90, 180]) {
      const cover = angle === 0;
      const screenId = cover ? 1 : 3;
      for (const { orientation, right, up } of orientations) {
        const config = { width: cover ? 1398 : 2007, height: cover ? 2034 : 2853, screenId, orientation };
        const pose = duoPose(angle, null, screenId, config);
        const body = new Euler(...pose.rotation, "YXZ");
        for (const side of cover ? [1] : [1, -1]) {
          const panel = new Euler(0, side * pose.fold, 0);
          // Fixed hardware landmarks: the rear cover's right edge runs toward
          // -X; inner raw pixels are mounted clockwise, so raw +X runs down -Y.
          const rawRight = cover ? new Vector3(-1, 0, 0) : new Vector3(0, -1, 0);
          const rawUp = cover ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
          const normal = new Vector3(0, 0, cover ? -1 : 1).applyEuler(panel).applyEuler(body);
          const project = (axis: Vector3) => {
            axis.applyEuler(panel).applyEuler(body);
            return new Vector2(axis.x, axis.y).normalize();
          };
          expect(normal.z).toBeGreaterThan(0.5);
          expect(project(rawRight).dot(new Vector2(...right))).toBeGreaterThan(0.99);
          expect(project(rawUp).dot(new Vector2(...up))).toBeGreaterThan(0.99);
        }
      }
    }
  });
});

describe("iPhone Duo transition spring", () => {
  test("folds and unfolds from rest without overshooting either endpoint", () => {
    for (const [start, target] of [[0, Math.PI / 2], [Math.PI / 2, 0]] as const) {
      let state = { value: start, velocity: 0 };
      let distance = Math.abs(state.value - target);
      for (let frame = 0; frame < 120; frame++) {
        state = stepDuoSpring(state.value, state.velocity, target, 1 / 60);
        const nextDistance = Math.abs(state.value - target);
        expect(nextDistance).toBeLessThanOrEqual(distance);
        expect(state.value).toBeGreaterThanOrEqual(0);
        expect(state.value).toBeLessThanOrEqual(Math.PI / 2);
        distance = nextDistance;
      }
      expect(state.value).toBeCloseTo(target, 8);
      expect(state.velocity).toBeCloseTo(0, 8);
    }
  });

  test("preserves momentum when a moving fold is reversed, then settles on the new target", () => {
    const folding = advanceSpring(0, Math.PI / 2, 6, 1 / 60);
    expect(folding.velocity).toBeGreaterThan(0);

    const reversed = stepDuoSpring(folding.value, folding.velocity, 0, 1 / 1000);
    expect(reversed.value).toBeGreaterThan(folding.value);
    expect(reversed.velocity).toBeGreaterThan(0);
    expect(Math.abs(reversed.velocity - folding.velocity)).toBeLessThan(0.5);

    const later = advanceSpring(reversed.value, 0, 12, 1 / 60, reversed.velocity);
    expect(later.velocity).toBeLessThan(0);
    const settled = advanceSpring(later.value, 0, 120, 1 / 60, later.velocity);
    expect(settled.value).toBeCloseTo(0, 8);
    expect(settled.velocity).toBeCloseTo(0, 8);
  });

  test("rapidly interrupted presets remain continuous and converge to the last request", () => {
    let state = { value: 0, velocity: 0 };
    for (const target of [Math.PI / 2, 0, Math.PI / 4, 0, Math.PI / 2]) {
      for (let frame = 0; frame < 4; frame++) {
        const next = stepDuoSpring(state.value, state.velocity, target, 1 / 120);
        expect(Number.isFinite(next.velocity)).toBe(true);
        expect(Math.abs(next.value - state.value)).toBeLessThan(0.1);
        expect(next.value).toBeGreaterThanOrEqual(0);
        expect(next.value).toBeLessThanOrEqual(Math.PI / 2);
        state = next;
      }
    }
    state = advanceSpring(state.value, Math.PI / 2, 240, 1 / 120, state.velocity);
    expect(state.value).toBeCloseTo(Math.PI / 2, 8);
    expect(state.velocity).toBeCloseTo(0, 8);
  });

  test("reaches the same state after equal time at 30, 60, and 120 Hz", () => {
    const at30 = advanceSpring(0, Math.PI / 2, 9, 1 / 30);
    for (const hz of [60, 120]) {
      const state = advanceSpring(0, Math.PI / 2, hz * 0.3, 1 / hz);
      expect(state.value).toBeCloseTo(at30.value, 12);
      expect(state.velocity).toBeCloseTo(at30.velocity, 12);
    }
  });

  test("caps a suspended-tab interval and ignores zero or negative elapsed time", () => {
    expect(stepDuoSpring(0.4, 2, 1, 5)).toEqual(stepDuoSpring(0.4, 2, 1, 0.05));
    for (const seconds of [0, -1]) {
      const state = stepDuoSpring(0.4, 2, 1, seconds);
      expect(state.value).toBeCloseTo(0.4, 12);
      expect(state.velocity).toBe(2);
    }
  });
});

describe("iPhone Duo screen hit mapping", () => {
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0.23, y: 0.67 }];
  const orientations: SimulatorOrientation[] = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"];

  test("cover pixels stay upright and inner pixels have a fixed clockwise mounting rotation", () => {
    const cover = duoScreenMapping({ width: 2, height: 3, screenId: 1 }, 2, 3);
    const inner = duoScreenMapping({ width: 2, height: 3, screenId: 3 }, 3, 2);
    expect(cover.rotation).toBe(0);
    expect(inner.rotation).toBeCloseTo(Math.PI / 2, 12);
    for (const point of points) {
      const coverRaw = duoScreenPoint(point.x, point.y, cover);
      // Raw top-left mounts at panel top-right; raw Y increases to the left.
      const innerRaw = duoScreenPoint(1 - point.y, point.x, inner);
      expect(coverRaw.x).toBeCloseTo(point.x, 12);
      expect(coverRaw.y).toBeCloseTo(point.y, 12);
      expect(innerRaw.x).toBeCloseTo(point.x, 12);
      expect(innerRaw.y).toBeCloseTo(point.y, 12);
    }
  });

  test("app orientation metadata never moves raw pixels to a different physical panel location", () => {
    for (const screenId of [1, 3]) {
      const config = { width: 2007, height: 2853, screenId };
      const panel = screenId === 1 ? { width: 800, height: 1144 } : { width: 1600, height: 1144 };
      const expected = duoScreenMapping(config, panel.width, panel.height);
      for (const orientation of orientations) {
        const mapping = duoScreenMapping({ ...config, orientation }, panel.width, panel.height);
        expect(mapping).toEqual(expected);
        for (const point of points) {
          expect(duoScreenPoint(point.x, point.y, mapping)).toEqual(duoScreenPoint(point.x, point.y, expected));
        }
      }
    }
  });

  test("round-trips rendered corners and off-center touches through both panel mounts", () => {
    for (const screenId of [1, 3]) {
      for (const orientation of orientations) {
        const config = { width: 2007, height: 2853, screenId, orientation };
        const panel = screenId === 1 ? { width: 800, height: 1144 } : { width: 1600, height: 1144 };
        const mapping = duoScreenMapping(config, panel.width, panel.height);
        for (const point of points) {
          const rendered = new Vector2(
            (point.x - 0.5) * mapping.drawnWidth,
            (point.y - 0.5) * mapping.drawnHeight,
          ).rotateAround(new Vector2(), mapping.rotation);
          const x = rendered.x / panel.width + 0.5;
          const y = rendered.y / panel.height + 0.5;
          expect(x).toBeGreaterThanOrEqual(-1e-12);
          expect(x).toBeLessThanOrEqual(1 + 1e-12);
          expect(y).toBeGreaterThanOrEqual(-1e-12);
          expect(y).toBeLessThanOrEqual(1 + 1e-12);
          const raw = duoScreenPoint(x, y, mapping);
          expect(raw.x).toBeCloseTo(point.x, 12);
          expect(raw.y).toBeCloseTo(point.y, 12);
        }
      }
    }
  });

  test("native portrait rasters fill their nominal mounted panel without distortion", () => {
    for (const screenId of [1, 3]) {
      const raw = screenId === 1 ? { width: 1398, height: 2034 } : { width: 2007, height: 2853 };
      const panel = screenId === 1 ? raw : { width: raw.height, height: raw.width };
      for (const scale of [1, 0.5, 0.25]) {
        const mapping = duoScreenMapping({ ...raw, screenId }, panel.width * scale, panel.height * scale);
        expect(mapping.drawnWidth).toBeCloseTo(raw.width * scale, 9);
        expect(mapping.drawnHeight).toBeCloseTo(raw.height * scale, 9);
        expect(mapping.drawnWidth / mapping.drawnHeight).toBeCloseTo(raw.width / raw.height, 12);
        for (const corner of points.slice(0, 4)) {
          const point = duoScreenPoint(corner.x, corner.y, mapping);
          expect(Math.min(Math.abs(point.x), Math.abs(point.x - 1))).toBeLessThan(1e-12);
          expect(Math.min(Math.abs(point.y), Math.abs(point.y - 1))).toBeLessThan(1e-12);
        }
      }
    }
  });

  test("mismatched surfaces contain the full raster without cropping or changing its aspect", () => {
    for (const screenId of [1, 3]) {
      const config = { width: 2007, height: 2853, screenId };
      const mapping = duoScreenMapping(config, 1000, 1000);
      expect(mapping.drawnWidth / mapping.drawnHeight).toBeCloseTo(config.width / config.height, 12);
      const diagonalA = new Vector2(mapping.drawnWidth, mapping.drawnHeight).rotateAround(new Vector2(), mapping.rotation);
      const diagonalB = new Vector2(mapping.drawnWidth, -mapping.drawnHeight).rotateAround(new Vector2(), mapping.rotation);
      const boundsWidth = Math.max(Math.abs(diagonalA.x), Math.abs(diagonalB.x));
      const boundsHeight = Math.max(Math.abs(diagonalA.y), Math.abs(diagonalB.y));
      expect(boundsWidth).toBeLessThanOrEqual(1000 + 1e-9);
      expect(boundsHeight).toBeLessThanOrEqual(1000 + 1e-9);
      expect(Math.min(Math.abs(boundsWidth - 1000), Math.abs(boundsHeight - 1000))).toBeLessThan(1e-9);
    }
  });

  test("padding remains outside raw display coordinates instead of clamping to an edge", () => {
    const cover = duoScreenMapping({ width: 2, height: 3, screenId: 1 }, 6, 3);
    expect(duoScreenPoint(0, 0.5, cover).x).toBeLessThan(0);
    expect(duoScreenPoint(1, 0.5, cover).x).toBeGreaterThan(1);
    expect(duoScreenPoint(0.5, 0.5, cover)).toEqual({ x: 0.5, y: 0.5 });
    expect(duoScreenPoint(1 / 3, 0.5, cover).x).toBeCloseTo(0, 12);
    expect(duoScreenPoint(2 / 3, 0.5, cover).x).toBeCloseTo(1, 12);

    const inner = duoScreenMapping({ width: 2, height: 3, screenId: 3 }, 3, 6);
    expect(duoScreenPoint(0.5, 0, inner).x).toBeLessThan(0);
    expect(duoScreenPoint(0.5, 1, inner).x).toBeGreaterThan(1);
  });
});
