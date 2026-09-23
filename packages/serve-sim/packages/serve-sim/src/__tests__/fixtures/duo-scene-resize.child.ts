import { expect, mock, test } from "bun:test";
import type { Camera } from "three";
import type { DuoSceneState } from "../../client/simulator/duo-scene";
import { HINGE_POSES } from "../../hinge-control";
import { duoPresetView, duoRotateView } from "../../client/simulator/duo-view";

// Drive the real scene's render/resize lifecycle. The renderer models the
// WebGL guarantee that changing canvas dimensions clears its drawing buffer.
class TestCanvas extends EventTarget {
  width = 300;
  height = 150;
  style = { cssText: "", width: "", height: "" };
  remove() {}
  getBoundingClientRect() { return { left: (480 - this.width) / 2, top: (540 - this.height) / 2, width: this.width, height: this.height }; }
  getContext() { return { fillStyle: "", fillRect() {} }; }
}
class TestHandle extends EventTarget {
  style: Record<string, string> = {};
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
    this.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId: id }));
  }
  focus() {}
  point() { return { x: parseFloat(this.style.left!), y: parseFloat(this.style.top!) }; }
  pointer(type: string, x: number, y: number) {
    this.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y }));
  }
}
class TestHost extends EventTarget {
  width = 480;
  height = 540;
  dataset: Record<string, string> = {};
  appendChild() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  constructor(readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void) { observers.push(this); }
  observe() {}
  disconnect() {}
}
const testDocument = Object.assign(new EventTarget(), {
  hidden: false,
  createElement: () => new TestCanvas(),
});
const testWindow = Object.assign(new EventTarget(), {
  devicePixelRatio: 1,
  innerWidth: 1680,
  innerHeight: 1100,
  matchMedia: () => ({ matches: false }),
});
Object.assign(globalThis, {
  window: testWindow,
  document: testDocument,
  ResizeObserver: TestResizeObserver,
  ImageBitmap: class {},
});
const three = await import("three");
const renderers: TestRenderer[] = [];
class TestRenderer {
  domElement = new TestCanvas();
  framePresent = false;
  loop: ((now: number) => void) | null = null;
  renderCount = 0;
  resizeCount = 0;
  projectedHeight = 0;
  constructor() { renderers.push(this); }
  setPixelRatio() {}
  setSize(width: number, height: number) {
    this.domElement.width = width;
    this.domElement.height = height;
    this.framePresent = false;
    this.resizeCount++;
  }
  setAnimationLoop(loop: typeof this.loop) { this.loop = loop; }
  render(_scene: unknown, camera: Camera) {
    this.framePresent = true;
    this.renderCount++;
    camera.updateMatrixWorld();
    this.projectedHeight = new three.Vector3(0, 1, 0).project(camera).y * this.domElement.height;
  }
  dispose() {}
}
mock.module("three", () => ({
  ...three,
  WebGLRenderer: TestRenderer,
  PMREMGenerator: class {
    fromScene() { return { texture: new three.Texture(), dispose() {} }; }
    dispose() {}
  },
}));
mock.module("../../client/simulator/duo-model", () => ({
  async loadDuoModel() {
    const scene = new three.Group();
    for (const name of ["left-half", "right-half"]) {
      const half = new three.Group();
      half.name = name;
      const body = new three.Mesh(new three.BoxGeometry(8, 12, 0.5), new three.MeshBasicMaterial());
      body.position.x = name === "left-half" ? -4 : 4;
      half.add(body);
      scene.add(half);
    }
    return scene;
  },
}));
const { createDuoScene } = await import("../../client/simulator/duo-scene");

test("the resize handle changes projected model size inside a fixed, continuously drawn canvas", () => {
  const host = new TestHost();
  const scene = createDuoScene(
    host as unknown as HTMLElement,
    new TestHost() as unknown as HTMLElement,
    () => ({ angle: 180, pose: "open", sizeMode: "physical" }),
    { ready() {}, error: () => { throw new Error("Scene failed"); } },
  );
  const renderer = renderers.at(-1)!;
  const resize = observers.at(-1)!;
  const notifyStageResize = () => resize.callback([{ contentRect: host.getBoundingClientRect() }]);
  try {
    notifyStageResize();
    renderer.loop!(16);
    expect(renderer.framePresent).toBe(true);
    const projectedHeightPerStagePixel = renderer.projectedHeight / host.height;
    for (let frame = 1; frame <= 30; frame++) {
      // Browser ordering: rAF callbacks, layout, ResizeObserver, then paint.
      // The handle writes the new CSS width during the animation frame.
      renderer.loop!((frame + 1) * 16);
      expect(renderer.domElement.width).toBe(1680);
      expect(renderer.domElement.height).toBe(1100);
      expect(renderer.domElement.style.width).toBe("1680px");
      expect(renderer.domElement.style.height).toBe("1100px");
      expect(renderer.resizeCount).toBe(1);
      expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
      host.width += 4;
      host.height += 4.5;
      notifyStageResize();
      expect(renderer.framePresent).toBe(true);
    }
    renderer.loop!(32 * 16);
    expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
    expect(renderer.domElement.width).toBe(1680);
    expect(renderer.domElement.height).toBe(1100);
    const settledResizeCount = renderer.resizeCount;
    // Duplicate layout notifications must not allocate/clear another buffer.
    notifyStageResize();
    renderer.loop!(33 * 16);
    expect(renderer.resizeCount).toBe(settledResizeCount);
    expect(renderer.framePresent).toBe(true);

    // A window resize may reallocate, but only together with drawing. Model
    // size remains tied to the logical stage instead of the larger canvas.
    testWindow.innerWidth = 1440;
    testWindow.innerHeight = 900;
    testWindow.dispatchEvent(new Event("resize"));
    expect(renderer.resizeCount).toBe(1);
    expect(renderer.framePresent).toBe(true);
    renderer.loop!(34 * 16);
    expect(renderer.resizeCount).toBe(2);
    expect(renderer.domElement.width).toBe(1440);
    expect(renderer.domElement.height).toBe(900);
    expect(renderer.projectedHeight / host.height).toBeCloseTo(projectedHeightPerStagePixel, 8);
    expect(renderer.framePresent).toBe(true);
  } finally {
    scene.dispose();
    testWindow.innerWidth = 1680;
    testWindow.innerHeight = 1100;
    testWindow.dispatchEvent(new Event("resize"));
    expect(renderer.domElement.style.width).toBe("1440px");
  }
});

async function hingeRig() {
  const host = new TestHost();
  const left = new TestHandle();
  const right = new TestHandle();
  const changes: number[] = [];
  const state: DuoSceneState = {
    angle: 180, pose: "open", sizeMode: "fill",
    onHingeAngleChange: (angle) => { changes.push(angle); state.angle = angle; },
  };
  let ready!: () => void;
  const loaded = new Promise<void>((resolve) => { ready = resolve; });
  const scene = createDuoScene(host as unknown as HTMLElement, new TestHost() as unknown as HTMLElement,
    () => state, { ready, error: () => { throw new Error("Scene failed"); } },
    { left: left as unknown as HTMLElement, right: right as unknown as HTMLElement });
  await loaded;
  const renderer = renderers.at(-1)!;
  observers.at(-1)!.callback([{ contentRect: host.getBoundingClientRect() }]);
  let now = 0;
  const settle = () => { for (let frame = 0; frame < 180; frame++) renderer.loop!(now += 16); };
  settle();
  return { left, right, state, changes, settle, dispose: () => scene.dispose() };
}

test("hinge handles follow both outer edges and only the original remains near closed", async () => {
  const rig = await hingeRig();
  try {
    expect(rig.left.style.display).toBe("");
    expect(rig.right.style.display).toBe("");
    expect(rig.left.point().x).toBeLessThan(240);
    expect(rig.right.point().x).toBeGreaterThan(240);
    expect(rig.left.point().y).toBeCloseTo(rig.right.point().y, 6);
    for (const angle of [90, 31, 30, 29, 10, 0, 90, 180]) {
      rig.state.angle = angle;
      rig.settle();
      expect(rig.left.style.display).toBe("");
      expect(rig.right.style.display).toBe(angle > 30 ? "" : "none");
    }
    rig.state.onHingeAngleChange = undefined;
    rig.settle();
    expect(rig.left.style.display).toBe("none");
    expect(rig.right.style.display).toBe("none");
  } finally { rig.dispose(); }
});

test("either hinge handle folds and unfolds, and a hidden handle retains its active drag", async () => {
  for (const side of ["left", "right"] as const) {
    const rig = await hingeRig();
    const handle = rig[side];
    try {
      const open = handle.point();
      const direction = side === "left" ? 1 : -1;
      handle.pointer("pointerdown", open.x, open.y);
      expect(handle.hasPointerCapture(1)).toBe(true);
      handle.pointer("pointermove", open.x + direction * 10, open.y);
      expect(rig.state.angle).toBeLessThan(180);
      expect(rig.state.angle).toBeGreaterThan(0);
      handle.pointer("pointermove", open.x + direction * 1500, open.y);
      rig.settle();
      expect(rig.state.angle).toBe(0);
      expect(rig.right.style.display).toBe("none");
      expect(handle.hasPointerCapture(1)).toBe(true);
      // Reversing the same drag still works after the added handle disappears.
      handle.pointer("pointermove", open.x, open.y);
      rig.settle();
      expect(rig.state.angle).toBe(180);
      expect(rig.right.style.display).toBe("");
      handle.pointer("pointerup", open.x, open.y);
      expect(handle.hasPointerCapture(1)).toBe(false);
      handle.pointer("pointerdown", open.x, open.y);
      expect(handle.hasPointerCapture(1)).toBe(true);
    } finally { rig.dispose(); }
    expect(handle.hasPointerCapture(1)).toBe(false);
    const count = rig.changes.length;
    handle.pointer("pointermove", 1000, 500);
    expect(rig.changes.length).toBe(count);
  }
});

test("fold handles reach both endpoints using the saved view, including rotated tabletop poses", async () => {
  for (const { id } of HINGE_POSES) {
    for (const turns of [0, 1]) {
      const rig = await hingeRig();
      try {
        rig.state.view = duoRotateView(duoPresetView(id), turns);
        rig.state.angle = 0;
        rig.settle();
        const closed = rig.left.point();
        rig.state.angle = 180;
        rig.settle();
        const open = rig.left.point();
        rig.left.pointer("pointerdown", open.x, open.y);
        expect(rig.left.hasPointerCapture(1)).toBe(true);
        rig.left.pointer("pointermove", open.x + (closed.x - open.x) * 10, open.y + (closed.y - open.y) * 10);
        rig.settle();
        expect(rig.state.angle).toBe(0);
        rig.left.pointer("pointermove", open.x, open.y);
        rig.settle();
        expect(rig.state.angle).toBe(180);
        rig.left.pointer("pointerup", open.x, open.y);
        expect(rig.left.hasPointerCapture(1)).toBe(false);
        // Starting a new opening gesture from fully closed must use the
        // same facing path as the rendered model, including after Rotate.
        rig.state.angle = 0;
        rig.settle();
        const start = rig.left.point();
        rig.left.pointer("pointerdown", start.x, start.y);
        rig.left.pointer("pointermove", start.x + (open.x - start.x) * 10, start.y + (open.y - start.y) * 10);
        rig.settle();
        expect(rig.state.angle).toBe(180);
        rig.left.pointer("pointermove", start.x, start.y);
        rig.settle();
        expect(rig.state.angle).toBe(0);
        rig.left.pointer("pointerup", start.x, start.y);
        expect(rig.left.hasPointerCapture(1)).toBe(false);
      } finally { rig.dispose(); }
    }
  }
});
