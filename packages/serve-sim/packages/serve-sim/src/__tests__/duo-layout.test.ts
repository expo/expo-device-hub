import { describe, expect, test } from "bun:test";
import { BoxGeometry, Euler, Group, Mesh, PerspectiveCamera, Vector3 } from "three";
import { duoFitScale, duoHingeDragAngle, duoPanelEdgeAnchor, duoProjectAnchor } from "../client/simulator/duo-layout";
import { duoPose } from "../client/simulator/duo-pose";
import type { HingePose } from "../hinge-control";

const viewport = { width: 1680, height: 1100 };
const stage = { width: 640, height: 640 };
const canvas = { ...viewport, left: -420, top: -210 };

function rig() {
  const root = new Group();
  const left = new Group();
  const right = new Group();
  const leftBody = new Mesh(new BoxGeometry(8.245, 11.795, 0.56));
  leftBody.position.set(-8.245 / 2, 0, -0.244);
  const rightBody = new Mesh(new BoxGeometry(8.290, 11.840, 1.133));
  rightBody.position.set(8.290 / 2, 0.0225, -0.5305);
  left.add(leftBody);
  right.add(rightBody);
  root.add(left, right);
  const camera = new PerspectiveCamera(36, viewport.width / viewport.height, 0.1, 120);
  camera.position.set(0, 0, 31);
  camera.zoom = stage.height / viewport.height;
  camera.updateProjectionMatrix();
  const pose = (angle: number, kind: HingePose = "book", roll = 0) => {
    const target = duoPose(angle, kind, undefined, undefined, roll);
    left.rotation.y = target.fold;
    right.rotation.y = -target.fold;
    root.quaternion.setFromEuler(new Euler(...target.rotation, "YXZ"));
    root.position.set(0, 0, 4.05 * Math.sin(target.fold)).applyQuaternion(root.quaternion).multiplyScalar(-1);
    root.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
  return { root, left, right, camera, pose };
}

describe("Duo model fit", () => {
  test("every pose fits inside the stage inset and reaches a limiting edge", () => {
    const model = rig();
    for (const [angle, pose, roll] of [
      [0, "closed", 0], [90, "book", 0], [180, "open", 0],
      [180, "open", Math.PI / 2], [90, "laptop", 0], [80, "tent", 0],
    ] as const) {
      model.pose(angle, pose, roll);
      const factor = duoFitScale(model.root, model.camera, viewport, stage);
      model.camera.zoom = stage.height / viewport.height * factor;
      model.camera.updateProjectionMatrix();
      let nearestMargin = Infinity;
      model.root.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const box = child.geometry.boundingBox!;
        for (let corner = 0; corner < 8; corner++) {
          const projected = new Vector3(
            corner & 1 ? box.max.x : box.min.x,
            corner & 2 ? box.max.y : box.min.y,
            corner & 4 ? box.max.z : box.min.z,
          ).applyMatrix4(child.matrixWorld).project(model.camera);
          const marginX = stage.width / 2 - Math.abs(projected.x * viewport.width / 2);
          const marginY = stage.height / 2 - Math.abs(projected.y * viewport.height / 2);
          expect(marginX).toBeGreaterThanOrEqual(24 - 1e-8);
          expect(marginY).toBeGreaterThanOrEqual(24 - 1e-8);
          nearestMargin = Math.min(nearestMargin, marginX, marginY);
        }
      });
      expect(nearestMargin).toBeCloseTo(24, 7);
    }
  });

  test("fit does not depend on prior camera zoom or modify the requested pose", () => {
    const model = rig();
    model.pose(80, "tent");
    const before = [model.root.position.toArray(), model.root.quaternion.toArray(), model.left.rotation.toArray()];
    const expected = duoFitScale(model.root, model.camera, viewport, stage);
    for (const zoom of [0.2, 0.75, 2]) {
      model.camera.zoom = zoom;
      model.camera.updateProjectionMatrix();
      expect(duoFitScale(model.root, model.camera, viewport, stage)).toBeCloseTo(expected, 10);
      expect(model.camera.zoom).toBe(zoom);
    }
    expect([model.root.position.toArray(), model.root.quaternion.toArray(), model.left.rotation.toArray()]).toEqual(before);
  });

  test("empty, hidden, zero-size, and camera-crossing geometry keep normal framing", () => {
    const model = rig();
    expect(duoFitScale(new Group(), model.camera, viewport, stage)).toBe(1);
    expect(duoFitScale(model.root, model.camera, viewport, { width: 0, height: 640 })).toBe(1);
    model.root.visible = false;
    expect(duoFitScale(model.root, model.camera, viewport, stage)).toBe(1);
    model.root.visible = true;
    model.root.position.z = 31;
    expect(duoFitScale(model.root, model.camera, viewport, stage)).toBe(1);
  });
});

describe("Duo physical hinge handle", () => {
  test("the local outer-edge anchor survives folding and projects with the actual canvas offset", () => {
    const model = rig();
    model.pose(180, "open");
    const anchor = duoPanelEdgeAnchor(model.left, "left")!;
    expect(anchor.x).toBeCloseTo(-8.245, 5);
    expect(anchor.y).toBeCloseTo(0, 8);
    expect(anchor.z).toBeCloseTo(0.036, 5);
    const centerX = canvas.left + canvas.width / 2;
    const open = duoProjectAnchor(anchor, model.left, model.camera, canvas)!;
    expect(open.x).toBeLessThan(centerX);
    model.pose(0, "closed");
    expect(duoPanelEdgeAnchor(model.left, "left")!.distanceTo(anchor)).toBeLessThan(1e-10);
    const closed = duoProjectAnchor(anchor, model.left, model.camera, canvas)!;
    expect(closed.x).toBeGreaterThan(centerX);
    expect(closed.y).toBeCloseTo(canvas.top + canvas.height / 2, 8);
    model.left.position.z = 100;
    model.root.rotation.set(0, 0, 0);
    expect(duoProjectAnchor(anchor, model.left, model.camera, canvas)).toBeNull();
  });

  test("piecewise drag travel starts without a jump and reaches either endpoint at any angle", () => {
    const closed = { x: 200, y: 400 };
    const open = { x: 600, y: 400 };
    for (let angle = 0; angle <= 180; angle++) {
      // Nonlinear spacing along the path and a perpendicular presentation
      // offset must not prevent a drag from reaching either endpoint.
      const start = { x: closed.x + 400 * (angle / 180) ** 1.5, y: 440 };
      expect(duoHingeDragAngle(angle, start, closed, open, { x: 0, y: 0 })).toBe(angle);
      if (angle < 180) {
        const remaining = open.x - start.x;
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining / 2, y: -20 })).toBeCloseTo(angle + (180 - angle) / 2, 8);
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining, y: -40 })).toBeCloseTo(180, 8);
      }
      if (angle > 0) {
        const remaining = closed.x - start.x;
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining / 2, y: -20 })).toBeCloseTo(angle / 2, 8);
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining, y: -40 })).toBeCloseTo(0, 8);
      }
    }
  });

  test("drag direction follows rotated endpoint axes and reverses around the same starting angle", () => {
    for (const rotation of [0, Math.PI / 2, Math.PI, 1.25]) {
      const rotate = (x: number, y = 0) => ({ x: x * Math.cos(rotation) - y * Math.sin(rotation), y: x * Math.sin(rotation) + y * Math.cos(rotation) });
      const closed = rotate(0);
      const open = rotate(400);
      const start = rotate(140, 25);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(130))).toBeCloseTo(120, 8);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(-70))).toBeCloseTo(30, 8);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(0))).toBe(60);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(900))).toBe(180);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(-900))).toBe(0);
      expect(duoHingeDragAngle(60, start, closed, open, rotate(0, 70))).toBe(60);
    }
  });

  test("collapsed or invalid geometry preserves a stable bounded drag", () => {
    const point = { x: 50, y: 50 };
    expect(duoHingeDragAngle(75, point, point, point, { x: 500, y: 500 })).toBe(75);
    expect(duoHingeDragAngle(75, point, point, { x: NaN, y: 0 }, { x: 1, y: 0 })).toBe(75);
    const closed = { x: 0, y: 0 };
    const open = { x: 400, y: 0 };
    // Geometric overlap with an endpoint does not itself change the angle.
    expect(duoHingeDragAngle(90, closed, closed, open, { x: 0, y: 0 })).toBe(90);
    expect(duoHingeDragAngle(90, closed, closed, open, { x: -100, y: 0 })).toBe(45);
    expect(duoHingeDragAngle(0, closed, closed, open, { x: -500, y: 0 })).toBe(0);
    expect(duoHingeDragAngle(180, open, closed, open, { x: 500, y: 0 })).toBe(180);
  });
});
