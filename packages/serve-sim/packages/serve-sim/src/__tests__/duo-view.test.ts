import { expect, test } from "bun:test";
import { Quaternion, Vector3 } from "three";
import { HINGE_POSES } from "../hinge-control";
import { duoInitialView, duoPresetView, duoRotateView, duoViewFolds, duoViewRotation } from "../client/simulator/duo-view";

test("hinge motion preserves the hinge angle and saved orientation controls for every preset", () => {
  for (const { id } of HINGE_POSES) {
    const view = duoPresetView(id);
    const rotation: typeof view.rotation = [...view.rotation];
    for (const angle of [0, 1, 30, 54, 55, 90, 150, 179, 180, 0]) {
      const fold = (180 - angle) * Math.PI / 360;
      const panels = duoViewFolds(fold, view);
      expect(panels.left - panels.right).toBeCloseTo(2 * fold, 10);
      expect(view.rotation).toEqual(rotation);
    }
  }
});

test("ordinary folding reveals the cover when closed and the inside when opened, preserving Rotate", () => {
  const hinge = new Vector3(0, 1, 0);
  for (const pose of ["closed", "book", "open"] as const) {
    for (const turns of [0, 1, 2, 3]) {
      const view = duoRotateView(duoPresetView(pose), turns);
      const hingeDirection = hinge.clone().applyQuaternion(new Quaternion(...view.rotation));
      for (const angle of [0, 1, 30, 54, 55, 60, 90, 120, 179, 180]) {
        const fold = (180 - angle) * Math.PI / 360;
        const rotation = duoViewRotation(fold, view);
        expect(hinge.clone().applyQuaternion(rotation).distanceTo(hingeDirection)).toBeLessThan(1e-8);
        const normal = (side: number, z = 1) => new Vector3(0, 0, z)
          .applyAxisAngle(hinge, side * fold).applyQuaternion(rotation).z;
        if (angle === 0) expect(normal(1, -1)).toBeCloseTo(1, 8);
        if (angle >= 55) expect(Math.max(normal(1), normal(-1))).toBeGreaterThan(0.5);
        if (angle >= 90) expect(Math.min(normal(1), normal(-1))).toBeGreaterThan(0.5);
        if (angle === 180) {
          expect(normal(1)).toBeCloseTo(1, 8);
          expect(normal(-1)).toBeCloseTo(1, 8);
        }
      }
    }
  }
});

test("facing movement is continuous when a hinge gesture reverses", () => {
  const view = duoPresetView("closed");
  let previous = duoViewRotation(Math.PI / 2, view);
  for (const angles of [Array.from({ length: 181 }, (_, angle) => angle), Array.from({ length: 181 }, (_, angle) => 180 - angle)]) {
    for (const angle of angles) {
      const rotation = duoViewRotation((180 - angle) * Math.PI / 360, view);
      expect(rotation.angleTo(previous)).toBeLessThan(0.03);
      previous = rotation;
    }
  }
});

test("Laptop's base stays fixed and Tent's two edges stay level with a fixed view", () => {
  const laptop = duoPresetView("laptop");
  const tent = duoPresetView("tent");
  const direction = (point: Vector3, fold: number, rotation: number[]) => point
    .applyAxisAngle(new Vector3(0, 1, 0), fold).applyQuaternion(new Quaternion(...rotation));
  const baseNormal = new Vector3(0, Math.cos(Math.PI / 9), Math.sin(Math.PI / 9));
  const tableNormal = new Vector3(0, Math.cos(Math.PI / 18), Math.sin(Math.PI / 18));
  for (const angle of [0, 1, 30, 54, 55, 90, 150, 179, 180]) {
    const fold = (180 - angle) * Math.PI / 360;
    for (const view of [laptop, tent, duoRotateView(laptop, 1), duoRotateView(tent, 1)]) {
      expect(duoViewRotation(fold, view).angleTo(new Quaternion(...view.rotation))).toBeLessThan(1e-7);
    }
    const base = duoViewFolds(fold, laptop);
    expect(direction(new Vector3(0, 0, 1), base.left, laptop.rotation).distanceTo(baseNormal)).toBeLessThan(1e-8);
    const feet = duoViewFolds(fold, tent);
    const left = direction(new Vector3(-1, 0, 0), feet.left, tent.rotation);
    const right = direction(new Vector3(1, 0, 0), feet.right, tent.rotation);
    expect(left.dot(tableNormal)).toBeCloseTo(right.dot(tableNormal), 8);
  }
});

test("Rotate turns the saved view even in tabletop modes and four clicks restore it", () => {
  for (const { id } of HINGE_POSES) {
    const initial = duoPresetView(id);
    for (const turns of [-1, 1]) {
      let view = duoRotateView(initial, turns);
      const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), turns * Math.PI / 2)
        .multiply(new Quaternion(...initial.rotation));
      expect(new Quaternion(...view.rotation).angleTo(expected)).toBeLessThan(1e-7);
      expect(view.fixedLeftFold).toBe(initial.fixedLeftFold);
      for (let click = 1; click < 4; click++) view = duoRotateView(view, turns);
      expect(new Quaternion(...view.rotation).angleTo(new Quaternion(...initial.rotation))).toBeLessThan(1e-7);
    }
  }
});

test("native orientation is used only to initialize a view; preset selection restores its own view", () => {
  const config = { screenId: 3, width: 2007, height: 2853, orientation: "portrait" as const };
  const portrait = duoInitialView(180, "open", config);
  const landscape = duoInitialView(180, "open", { ...config, orientation: "landscape_left" });
  expect(new Quaternion(...portrait.rotation).angleTo(new Quaternion(...landscape.rotation))).toBeCloseTo(Math.PI / 2, 8);
  expect(duoPresetView("open")).toEqual(landscape);
  expect(duoPresetView("closed")).not.toEqual(portrait);
});
