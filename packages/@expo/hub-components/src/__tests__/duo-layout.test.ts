import { describe, expect, test } from "bun:test";
import { type FoldPose } from "@expo/hub-client";
import { BoxGeometry, Euler, Group, Mesh, PerspectiveCamera, Vector3 } from "three";

import {
  DUO_FILL_INSET,
  DUO_HANDLE_OFFSET,
  DUO_INITIAL_ZOOM,
  duoCameraZoom,
  duoFitExtents,
  duoFitScale,
  duoFitScaleFromExtents,
  duoHingeDragAngle,
  duoPanelEdgeAnchor,
  duoProjectAnchor,
  duoStageZoom,
  stepDuoFit,
  stepDuoZoom,
  type DuoViewportSize,
  type DuoZoomState,
} from "../foldable/duo-layout";
import { duoPose, stepDuoSpring } from "../foldable/duo-pose";

const viewport = { width: 1680, height: 1100 };
const stage = { width: 640, height: 640 };
const canvas = { ...viewport, left: -420, top: -210 };

function rig(size: { width: number; height: number } = viewport) {
  const root = new Group();
  const left = new Group();
  const right = new Group();
  const leftBody = new Mesh(new BoxGeometry(8.245, 11.795, 0.56));
  leftBody.position.set(-8.245 / 2, 0, -0.244);
  const rightBody = new Mesh(new BoxGeometry(8.29, 11.84, 1.133));
  rightBody.position.set(8.29 / 2, 0.0225, -0.5305);
  left.add(leftBody);
  right.add(rightBody);
  root.add(left, right);
  const camera = new PerspectiveCamera(36, size.width / size.height, 0.1, 120);
  camera.position.set(0, 0, 31);
  camera.zoom = stage.height / size.height;
  camera.updateProjectionMatrix();
  const pose = (angle: number, kind: FoldPose = "book", roll = 0) => {
    const target = duoPose(angle, kind, undefined, undefined, roll);
    left.rotation.y = target.fold;
    right.rotation.y = -target.fold;
    root.quaternion.setFromEuler(new Euler(...target.rotation, "YXZ"));
    root.position
      .set(0, 0, 4.05 * Math.sin(target.fold))
      .applyQuaternion(root.quaternion)
      .multiplyScalar(-1);
    root.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
  return { root, left, right, camera, pose };
}

describe("Duo model fit", () => {
  test("every pose fits inside the stage inset and reaches a limiting edge", () => {
    const model = rig();
    for (const [angle, pose, roll] of [
      [0, "closed", 0],
      [90, "book", 0],
      [180, "open", 0],
      [180, "open", Math.PI / 2],
      [90, "laptop", 0],
      [80, "tent", 0],
    ] as const) {
      model.pose(angle, pose, roll);
      const factor = duoFitScale(model.root, model.camera, viewport, stage);
      model.camera.zoom = (stage.height / viewport.height) * factor;
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
          )
            .applyMatrix4(child.matrixWorld)
            .project(model.camera);
          const marginX = stage.width / 2 - Math.abs((projected.x * viewport.width) / 2);
          const marginY = stage.height / 2 - Math.abs((projected.y * viewport.height) / 2);
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
    const before = [
      model.root.position.toArray(),
      model.root.quaternion.toArray(),
      model.left.rotation.toArray(),
    ];
    const expected = duoFitScale(model.root, model.camera, viewport, stage);
    for (const zoom of [0.2, 0.75, 2]) {
      model.camera.zoom = zoom;
      model.camera.updateProjectionMatrix();
      expect(duoFitScale(model.root, model.camera, viewport, stage)).toBeCloseTo(expected, 10);
      expect(model.camera.zoom).toBe(zoom);
    }
    expect([
      model.root.position.toArray(),
      model.root.quaternion.toArray(),
      model.left.rotation.toArray(),
    ]).toEqual(before);
  });

  test("one projection gives the same fit as duoFitScale for every inset", () => {
    const model = rig();
    model.pose(90, "laptop");
    const extents = duoFitExtents(model.root, model.camera);
    for (const inset of [0, 16, 24, 32]) {
      expect(duoFitScaleFromExtents(extents, viewport, stage, inset)).toBe(
        duoFitScale(model.root, model.camera, viewport, stage, inset),
      );
    }
    expect(duoFitScaleFromExtents(null, viewport, stage, 32)).toBe(1);
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

const POSES = [
  [0, "closed", 0],
  [90, "book", 0],
  [180, "open", 0],
  [180, "open", Math.PI / 2],
  [90, "laptop", 0],
  [80, "tent", 0],
] as const;

// The Hub's stage fills the stream area, so it can be wider or taller than
// serve-sim's fixed 1:1 stage.
const STAGES = [
  { width: 640, height: 640 },
  { width: 1600, height: 900 },
  { width: 420, height: 900 },
];

/** Smallest distance in CSS pixels from the projected model to the stage edges. */
function stageMargins(
  model: ReturnType<typeof rig>,
  stageSize: { width: number; height: number },
  size: { width: number; height: number } = viewport,
) {
  let x = Infinity;
  let y = Infinity;
  model.root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const box =
      child.geometry.boundingBox ??
      (child.geometry.computeBoundingBox(), child.geometry.boundingBox!);
    for (let corner = 0; corner < 8; corner++) {
      const projected = new Vector3(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      )
        .applyMatrix4(child.matrixWorld)
        .project(model.camera);
      x = Math.min(x, stageSize.width / 2 - Math.abs((projected.x * size.width) / 2));
      y = Math.min(y, stageSize.height / 2 - Math.abs((projected.y * size.height) / 2));
    }
  });
  return { x, y };
}

describe("Duo stage zoom", () => {
  test("is serve-sim's stage.height / viewport.height zoom on its square stage", () => {
    expect(duoStageZoom(viewport, stage)).toBe(stage.height / viewport.height);
  });

  test("frames the base view in the largest centered square of a wide or tall stage", () => {
    expect(duoStageZoom(viewport, { width: 1600, height: 900 })).toBe(900 / viewport.height);
    expect(duoStageZoom(viewport, { width: 420, height: 900 })).toBe(420 / viewport.height);
  });

  test("invalid sizes keep normal framing", () => {
    expect(duoStageZoom(viewport, { width: 0, height: 640 })).toBe(1);
    expect(duoStageZoom({ width: 1680, height: NaN }, stage)).toBe(1);
  });

  test("fill fits every pose inside any stage shape and reaches a limiting edge", () => {
    const model = rig();
    for (const stageSize of STAGES) {
      for (const [angle, pose, roll] of POSES) {
        model.pose(angle, pose, roll);
        const factor = duoFitScale(model.root, model.camera, viewport, stageSize, 32);
        model.camera.zoom = duoStageZoom(viewport, stageSize) * factor;
        model.camera.updateProjectionMatrix();
        const margins = stageMargins(model, stageSize);
        expect(margins.x).toBeGreaterThanOrEqual(32 - 1e-8);
        expect(margins.y).toBeGreaterThanOrEqual(32 - 1e-8);
        expect(Math.min(margins.x, margins.y)).toBeCloseTo(32, 7);
      }
    }
  });

  test("physical size keeps every pose inside any stage shape at the size of its inscribed square", () => {
    const model = rig();
    for (const stageSize of STAGES) {
      const side = Math.min(stageSize.width, stageSize.height);
      const square = { width: side, height: side };
      for (const [angle, pose, roll] of POSES) {
        model.pose(angle, pose, roll);
        model.camera.zoom = duoStageZoom(viewport, square);
        model.camera.updateProjectionMatrix();
        const inSquare = stageMargins(model, square);
        model.camera.zoom = duoStageZoom(viewport, stageSize);
        model.camera.updateProjectionMatrix();
        const inStage = stageMargins(model, stageSize);
        expect(inStage.x).toBeGreaterThan(0);
        expect(inStage.y).toBeGreaterThan(0);
        // Same projected size as on the square: the extra space is margin.
        expect(inStage.x - (stageSize.width - side) / 2).toBeCloseTo(inSquare.x, 7);
        expect(inStage.y - (stageSize.height - side) / 2).toBeCloseTo(inSquare.y, 7);
      }
    }
  });
});

describe("Duo camera zoom", () => {
  test("is the base zoom of the stage's short side times the fit factor", () => {
    // A narrow stage, as in a 1280x800 window with both sidebars.
    const window = { width: 1280, height: 800 };
    expect(duoCameraZoom(window, { width: 398, height: 570 }, 1)).toBe(398 / 800);
    expect(duoCameraZoom(window, { width: 398, height: 570 }, 1.25)).toBe((398 / 800) * 1.25);
    // serve-sim's square stage keeps its stage.height / viewport.height zoom.
    expect(duoCameraZoom(viewport, stage, 0.8)).toBe((stage.height / viewport.height) * 0.8);
    expect(duoCameraZoom(viewport, { width: 0, height: 640 }, 0.8)).toBe(0.8);
  });
});

/** One scene frame: measure, step the zoom, and apply it to the rig's camera. */
function frame(
  model: ReturnType<typeof rig>,
  state: DuoZoomState,
  stageSize: DuoViewportSize,
  size: DuoViewportSize,
  fill = true,
) {
  const step = stepDuoZoom(state, {
    stage: stageSize,
    viewport: size,
    seconds: 1 / 60,
    reducedMotion: false,
    extents: fill ? duoFitExtents(model.root, model.camera) : undefined,
  });
  model.camera.zoom = step.zoom;
  model.camera.updateProjectionMatrix();
  return step.state;
}

/** A settled zoom for this stage, as after the model has rested in its pose. */
function settled(model: ReturnType<typeof rig>, stageSize: DuoViewportSize, size: DuoViewportSize) {
  let state = frame(model, DUO_INITIAL_ZOOM, stageSize, size);
  for (let i = 0; i < 120; i++) state = frame(model, state, stageSize, size);
  return state;
}

describe("Duo zoom while the stage resizes", () => {
  // A 2560x1440 window: a sidebar that opens or a resize drag narrows the
  // stage while its height, the short side, stays the same.
  const window = { width: 2560, height: 1440 };

  test("a resize snaps the fit, so every frame keeps the fill inset", () => {
    for (const [from, to] of [
      [1678, 1378],
      [1678, 1258],
      [1300, 1000],
    ] as const) {
      const model = rig(window);
      model.pose(180, "open");
      const stageAt = (width: number) => ({ width, height: 1210 });
      let state = settled(model, stageAt(from), window);
      // The sidebar animates for 200 ms; then a second of rest at 60 fps.
      for (let i = 1; i <= 72; i++) {
        const stageSize = stageAt(i <= 12 ? from + ((to - from) * i) / 12 : to);
        state = frame(model, state, stageSize, window);
        const margins = stageMargins(model, stageSize, window);
        expect(Math.min(margins.x, margins.y)).toBeGreaterThanOrEqual(DUO_FILL_INSET - 1e-6);
      }
    }
  });

  test("a zero-size measurement keeps the last stage, and a window resize snaps", () => {
    const model = rig(window);
    model.pose(180, "open");
    const stageSize = { width: 1678, height: 1210 };
    const state = settled(model, stageSize, window);
    // Before layout, or while hidden, the stage measures 0 x 0.
    expect(frame(model, state, { width: 0, height: 0 }, window)).toEqual(state);
    const smaller = { width: 1920, height: 1080 };
    model.camera.aspect = smaller.width / smaller.height;
    const resized = frame(model, state, stageSize, smaller);
    expect(resized.viewport).toEqual(smaller);
    expect(resized.fit).toEqual({
      scale: duoFitScale(model.root, model.camera, smaller, stageSize, DUO_FILL_INSET),
      velocity: 0,
    });
  });

  test("Keep same size frames the stage's inscribed square at any time", () => {
    const model = rig(window);
    model.pose(180, "open");
    let state = settled(model, { width: 1678, height: 1210 }, window);
    for (let i = 0; i < 90; i++)
      state = frame(model, state, { width: 1678, height: 1210 }, window, false);
    expect(model.camera.zoom).toBeCloseTo(duoStageZoom(window, { width: 1678, height: 1210 }), 3);
  });
});

describe("Duo zoom while the device folds", () => {
  // Like the scene, the fold springs toward the new angle and the model
  // follows the folded geometry on every frame.
  const cases = [
    {
      name: "serve-sim's square",
      stage: { width: 580, height: 580 },
      size: { width: 1920, height: 1080 },
    },
    { name: "1280x800", stage: { width: 398, height: 570 }, size: { width: 1280, height: 800 } },
    { name: "1920x1080", stage: { width: 1038, height: 850 }, size: { width: 1920, height: 1080 } },
    {
      name: "2560x1440",
      stage: { width: 1678, height: 1210 },
      size: { width: 2560, height: 1440 },
    },
  ];

  test.each(cases)(
    "opening and closing never cross the handle clearance ($name)",
    ({ stage: stageSize, size }) => {
      for (const [from, to] of [
        [0, 180],
        [180, 0],
      ] as const) {
        const model = rig(size);
        model.pose(from, "book");
        let state = settled(model, stageSize, size);
        let fold = ((180 - from) * Math.PI) / 360;
        let velocity = 0;
        let smallest = Infinity;
        for (let i = 0; i < 120; i++) {
          const step = stepDuoSpring(fold, velocity, ((180 - to) * Math.PI) / 360, 1 / 60);
          fold = step.value;
          velocity = step.velocity;
          model.pose(180 - (fold * 360) / Math.PI, "book");
          state = frame(model, state, stageSize, size);
          const margins = stageMargins(model, stageSize, size);
          smallest = Math.min(smallest, margins.x, margins.y);
        }
        // The handles sit DUO_HANDLE_OFFSET outside the model, so they stay on the stage too.
        expect(smallest).toBeGreaterThanOrEqual(DUO_HANDLE_OFFSET - 1e-6);
        // At rest the spring has brought the model back to the fill inset.
        const margins = stageMargins(model, stageSize, size);
        expect(Math.min(margins.x, margins.y)).toBeCloseTo(DUO_FILL_INSET, 0);
      }
    },
  );

  test("the spring stops at the limit, and a snap lands on the target", () => {
    expect(stepDuoFit({ scale: 1, velocity: 0.5 }, 0.8, 1 / 60, false, 0.9)).toEqual({
      scale: 0.9,
      velocity: 0,
    });
    const sprung = stepDuoFit({ scale: 1, velocity: 0 }, 0.8, 1 / 60, false, 2);
    expect(sprung.scale).toBeGreaterThan(0.8);
    expect(sprung.scale).toBeLessThan(1);
    expect(stepDuoFit({ scale: 1, velocity: 0.4 }, 0.8, 1 / 60, true, 2)).toEqual({
      scale: 0.8,
      velocity: 0,
    });
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
        expect(
          duoHingeDragAngle(angle, start, closed, open, { x: remaining / 2, y: -20 }),
        ).toBeCloseTo(angle + (180 - angle) / 2, 8);
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining, y: -40 })).toBeCloseTo(
          180,
          8,
        );
      }
      if (angle > 0) {
        const remaining = closed.x - start.x;
        expect(
          duoHingeDragAngle(angle, start, closed, open, { x: remaining / 2, y: -20 }),
        ).toBeCloseTo(angle / 2, 8);
        expect(duoHingeDragAngle(angle, start, closed, open, { x: remaining, y: -40 })).toBeCloseTo(
          0,
          8,
        );
      }
    }
  });

  test("drag direction follows rotated endpoint axes and reverses around the same starting angle", () => {
    for (const rotation of [0, Math.PI / 2, Math.PI, 1.25]) {
      const rotate = (x: number, y = 0) => ({
        x: x * Math.cos(rotation) - y * Math.sin(rotation),
        y: x * Math.sin(rotation) + y * Math.cos(rotation),
      });
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
