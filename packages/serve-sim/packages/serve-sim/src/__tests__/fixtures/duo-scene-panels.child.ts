import { expect, mock, test } from "bun:test";
import type { Scene } from "three";
import type { DuoSceneState } from "../../client/simulator/duo-scene";
import { HINGE_POSES } from "../../hinge-control";
import { duoPresetView, duoRotateView } from "../../client/simulator/duo-view";

// The real scene chooses and uploads its textures. Only browser/GPU plumbing
// is replaced; frame content and individual texture writes remain observable.
class TestCanvas extends EventTarget {
  width = 300;
  height = 150;
  pixel = 0;
  draws = 0;
  style = { cssText: "", width: "", height: "", cursor: "" };
  remove() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 540 }; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
  getContext() {
    const context = {
      fillStyle: "",
      fillRect: () => { this.pixel = parseInt(context.fillStyle.slice(1, 3), 16) || 0; },
      save() {}, restore() {}, translate() {}, rotate() {},
      drawImage: (source: TestCanvas) => { this.pixel = source.pixel; this.draws++; },
      getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(this.pixel) }),
    };
    return context;
  }
}
class TestHost extends EventTarget {
  dataset: Record<string, string> = {};
  panels = new Map<number, TestHost>();
  source: TestCanvas | null = null;
  appendChild() {}
  getBoundingClientRect() { return { width: 480, height: 540 }; }
  querySelector(selector: string): TestHost | TestCanvas | null {
    const panel = selector.match(/^\[data-duo-panel="(1|3)"\]$/);
    if (panel) return this.panels.get(Number(panel[1])) ?? null;
    return selector === "canvas" ? this.source ?? this.panels.get(1)?.source ?? null : null;
  }
  querySelectorAll() { return []; }
}
const canvases: TestCanvas[] = [];
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), {
    devicePixelRatio: 1, innerWidth: 1680, innerHeight: 1100,
    matchMedia: () => ({ matches: false }),
  }),
  document: Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => { const canvas = new TestCanvas(); canvases.push(canvas); return canvas; },
  }),
  ResizeObserver: class { observe() {} disconnect() {} },
  HTMLCanvasElement: TestCanvas,
  HTMLVideoElement: class {},
  HTMLImageElement: class {},
  ImageBitmap: class {},
});
const three = await import("three");
const NativeRaycaster = three.Raycaster;
let hitScreenId = 1;
const renderers: TestRenderer[] = [];
class TestRenderer {
  domElement = new TestCanvas();
  bodyRotation = new three.Quaternion();
  loop: ((now: number) => void) | null = null;
  constructor() { renderers.push(this); }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(loop: typeof this.loop) { this.loop = loop; }
  render(scene: Scene) {
    const half = scene.getObjectByName("left-half");
    half?.parent?.getWorldQuaternion(this.bodyRotation);
  }
  dispose() {}
}
mock.module("three", () => ({
  ...three,
  WebGLRenderer: TestRenderer,
  Raycaster: class {
    private actual = new NativeRaycaster();
    ray = this.actual.ray;
    setFromCamera(...args: Parameters<InstanceType<typeof three.Raycaster>["setFromCamera"]>) {
      this.actual.setFromCamera(...args);
    }
    intersectObject(object: InstanceType<typeof three.Object3D>) {
      const mesh = object.getObjectByName(hitScreenId === 1 ? "cover-display" : "inner-display-left");
      return mesh ? [{ object: mesh, uv: new three.Vector2(0.5, 0.5), face: { a: 0, b: 1, c: 2 } }] : [];
    }
  },
  PMREMGenerator: class {
    fromScene() { return { texture: new three.Texture(), dispose() {} }; }
    dispose() {}
  },
}));
mock.module("../../client/simulator/duo-model", () => ({
  async loadDuoModel() {
    const scene = new three.Group();
    for (const name of ["left-half", "right-half"]) {
      const half = new three.Group(); half.name = name; scene.add(half);
      for (const display of name === "left-half" ? ["cover-display", "inner-display-left"] : ["inner-display-right"]) {
        const mesh = new three.Mesh(new three.PlaneGeometry(4, 6), new three.MeshBasicMaterial());
        mesh.name = display;
        half.add(mesh);
      }
    }
    return scene;
  },
}));
const { createDuoScene } = await import("../../client/simulator/duo-scene");

function setup(dual: boolean, cacheScreenOnFold?: boolean) {
  const host = new TestHost();
  const sourceHost = new TestHost();
  const cover = Object.assign(new TestCanvas(), { width: 1398, height: 2034, pixel: 70 });
  const inner = Object.assign(new TestCanvas(), { width: 2007, height: 2853, pixel: 0 });
  if (dual) {
    sourceHost.panels.set(1, Object.assign(new TestHost(), { source: cover }));
    sourceHost.panels.set(3, Object.assign(new TestHost(), { source: inner }));
  } else sourceHost.source = cover;
  let state: DuoSceneState = {
    angle: 0, pose: "closed",
    cacheScreenOnFold,
    streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait" },
  };
  const previous = canvases.length;
  const touches: { type: string }[] = [];
  state.onTouch = (touch) => touches.push(touch);
  let ready!: () => void;
  const loaded = new Promise<void>((resolve) => { ready = resolve; });
  const scene = createDuoScene(host as unknown as HTMLElement, sourceHost as unknown as HTMLElement,
    () => state, { ready, error: () => { throw new Error("Scene failed"); } });
  const [innerTexture, coverTexture] = canvases.slice(previous);
  const renderer = renderers.at(-1)!;
  let now = 0;
  return {
    host, sourceHost, cover, inner, innerTexture: innerTexture!, coverTexture: coverTexture!,
    loaded,
    rotation: () => renderer.bodyRotation.clone(),
    hover: (screenId: 1 | 3) => {
      hitScreenId = screenId;
      renderer.domElement.dispatchEvent(Object.assign(new Event("pointermove"), { pointerId: 1, clientX: 240, clientY: 270 }));
      return renderer.domElement.style.cursor;
    },
    cursor: () => renderer.domElement.style.cursor,
    tap: (screenId: 1 | 3) => {
      hitScreenId = screenId;
      const before = touches.filter(({ type }) => type === "begin").length;
      for (const type of ["pointerdown", "pointerup"]) renderer.domElement.dispatchEvent(Object.assign(new Event(type), {
        button: 0, pointerId: 1, pointerType: "mouse", clientX: 240, clientY: 270,
      }));
      return touches.filter(({ type }) => type === "begin").length - before;
    },
    setState: (next: Partial<DuoSceneState>) => { state = { ...state, ...next }; },
    tick: (milliseconds = 16) => renderer.loop!(now += milliseconds),
    dispose: () => scene.dispose(),
  };
}

test("hinge edits reveal ordinary displays while retaining tabletop views and ignoring delayed orientation", async () => {
  for (const { id: pose, angle: start } of HINGE_POSES) {
    const rig = setup(true);
    const configFor = (angle: number) => angle <= 54
      ? { screenId: 1, width: 1398, height: 2034, orientation: "portrait" as const, hingeAngle: angle }
      : { screenId: 3, width: 2007, height: 2853, orientation: "portrait" as const, hingeAngle: angle };
    const settle = () => { for (let frame = 0; frame < 120; frame++) rig.tick(); };
    try {
      await rig.loaded;
      rig.inner.pixel = 180;
      rig.setState({ angle: start, pose, physicalPose: pose, view: duoPresetView(pose), streamConfig: configFor(start) });
      settle();
      const initialRotation = rig.rotation();
      const hingeDirection = new three.Vector3(0, 1, 0).applyQuaternion(initialRotation);
      for (const angle of [1, 54, 55, 90, 180, 55, 54, 0, 55, 180]) {
        rig.setState({ angle, pose: null });
        rig.tick();
        if (pose === "laptop" || pose === "tent") expect(rig.rotation().angleTo(initialRotation)).toBeLessThan(1e-6);
        settle();
        const rotation = rig.rotation();
        expect(new three.Vector3(0, 1, 0).applyQuaternion(rotation).distanceTo(hingeDirection)).toBeLessThan(1e-6);
        if (pose === "laptop" || pose === "tent") expect(rotation.angleTo(initialRotation)).toBeLessThan(1e-6);
        else if (angle === 180) expect(new three.Vector3(0, 0, 1).applyQuaternion(rotation).z).toBeCloseTo(1, 6);
        else if (angle === 0) expect(new three.Vector3(-1, 0, 0).applyQuaternion(rotation).z).toBeCloseTo(1, 6);
        for (const orientation of ["portrait", "landscape_left", "landscape_right", "portrait_upside_down", "portrait"] as const) {
          rig.setState({ streamConfig: { ...configFor(angle), orientation } });
          settle();
          expect(rig.rotation().angleTo(rotation)).toBeLessThan(1e-6);
        }
      }
    } finally { rig.dispose(); }
  }
});

test("Rotate and repeated preset commands adjust the view without waiting for native orientation", async () => {
  for (const { id: pose, angle } of HINGE_POSES) {
    const rig = setup(true);
    const settle = () => { for (let frame = 0; frame < 120; frame++) rig.tick(); };
    try {
      await rig.loaded;
      let view = duoPresetView(pose);
      rig.setState({ angle, pose, physicalPose: pose, view });
      settle();
      const initial = rig.rotation();
      // Two clicks can precede a render or the native reply; both must count.
      view = duoRotateView(duoRotateView(view, -1), -1);
      rig.setState({ view, pose: null, physicalPose: null });
      settle();
      expect(rig.rotation().angleTo(initial)).toBeCloseTo(Math.PI, 6);
      rig.setState({ view: duoPresetView(pose), pose, physicalPose: pose });
      settle();
      expect(rig.rotation().angleTo(initial)).toBeLessThan(1e-6);
    } finally { rig.dispose(); }
  }
});

test("a manual hinge edit cancels an unfinished preset's pending orientation change", async () => {
  const rig = setup(true);
  const settle = () => { for (let frame = 0; frame < 120; frame++) rig.tick(); };
  try {
    await rig.loaded;
    rig.inner.pixel = 180;
    settle();
    // Request Open while native capture still reports the cover, then take
    // over with a manual angle before the new display's metadata arrives.
    rig.setState({ angle: 180, pose: "open", physicalPose: "open", view: duoPresetView("open") });
    settle();
    rig.setState({ angle: 120, pose: null });
    settle();
    const beforeFrame = rig.rotation();
    rig.setState({ streamConfig: { screenId: 3, width: 2007, height: 2853, orientation: "portrait", hingeAngle: 120 } });
    settle();
    expect(rig.rotation().angleTo(beforeFrame)).toBeLessThan(1e-6);
  } finally { rig.dispose(); }
});

test("inner frames appear before active metadata and provisional black cannot overwrite either panel", () => {
  const test = setup(true, true);
  try {
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    const coverDraws = test.coverTexture.draws;
    test.setState({ angle: 180, pose: "open" });
    test.cover.pixel = 0;
    test.tick();
    expect(test.innerTexture.draws).toBe(0);
    expect(test.coverTexture.draws).toBe(coverDraws);

    // The fixed inner feed becomes usable while main capture still reports
    // the cover. This must upload on this very animation frame.
    test.inner.pixel = 180;
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);
    expect(test.innerTexture.draws).toBe(1);
    expect(test.host.dataset.screenId).toBe("3");
    expect(test.host.dataset.screenReady).toBe("true");
    expect(test.coverTexture.pixel).toBe(70);

    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);
    expect(test.innerTexture.draws).toBe(1);

    // A genuinely black active application frame is valid once election
    // confirms this panel, including a differently scaled main stream.
    test.setState({ streamConfig: { screenId: 3, width: 900, height: 1280, orientation: "landscape_left" } });
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.innerTexture.draws).toBe(2);
    expect(test.coverTexture.pixel).toBe(70);

    test.setState({ angle: 0, pose: "closed" });
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    expect(test.coverTexture.draws).toBe(coverDraws);
  } finally { test.dispose(); }
});

test("coalesced panel previews release input after the native return is acknowledged, including same-angle returns on either panel", async () => {
  for (const [start, preview, finish, screenId] of [[40, 55, 54, 1], [0, 55, 0, 1], [180, 0, 180, 3]] as const) {
    for (const caching of [false, true]) {
      const test = setup(true, caching);
      const commands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
      try {
        await test.loaded;
        test.inner.pixel = 180;
        const config = { screenId, width: screenId === 1 ? 1398 : 2007, height: screenId === 1 ? 2034 : 2853, orientation: "portrait" as const, hingeAngle: start };
        test.setState({ angle: start, streamConfig: config, hingeCommands: commands });
        test.tick();
        expect(test.tap(screenId)).toBe(1);
        test.setState({ angle: preview, hingeCommands: { ...commands, pending: true } });
        test.tick();
        // The queued55° command is replaced by the return before native send.
        test.setState({ angle: finish });
        test.tick();
        expect(test.tap(screenId)).toBe(0);
        test.setState({
          streamConfig: { ...config, hingeAngle: finish },
          hingeCommands: commands,
        });
        test.tick();
        expect(test.tap(screenId)).toBe(1);
      } finally { test.dispose(); }
    }
  }
});

test("an actually submitted away command retains the input guard while its return is pending", async () => {
  const test = setup(true);
  const config = { screenId: 1, width: 1398, height: 2034, orientation: "portrait" as const, hingeAngle: 0 };
  const commands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  try {
    await test.loaded;
    test.setState({ streamConfig: config, hingeCommands: commands });
    test.tick();
    expect(test.tap(1)).toBe(1);
    test.setState({ angle: 55, hingeCommands: { ...commands, pending: true, coverDepartures: 1 } });
    test.tick();
    test.setState({ angle: 0, hingeCommands: { ...commands, pending: true, coverDepartures: 1, innerDepartures: 1 } });
    test.tick();
    // A matching ID alone cannot release input during an outstanding command.
    expect(test.tap(1)).toBe(0);
    test.cover.pixel = 0;
    test.tick();
    expect(test.tap(1)).toBe(0);
    test.cover.pixel = 90;
    test.tick();
    expect(test.tap(1)).toBe(1);
    // Once that real activation finishes, its old departure count must not
    // prevent a later preview-only round trip from releasing input.
    const completed = { ...commands, coverDepartures: 1, innerDepartures: 1 };
    test.setState({ angle: 55, hingeCommands: { ...completed, pending: true } });
    test.tick();
    test.setState({ angle: 0, hingeCommands: completed });
    test.tick();
    expect(test.tap(1)).toBe(1);
  } finally { test.dispose(); }
});

test("a discarded preview restores input after the queue fails without submitting an away command", async () => {
  const test = setup(true);
  const commands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  try {
    await test.loaded;
    test.setState({ hingeCommands: commands, streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait", hingeAngle: 0 } });
    test.tick();
    test.setState({ angle: 55, hingeCommands: { ...commands, pending: true } });
    test.tick();
    test.setState({ angle: 0, hingeCommands: commands });
    test.tick();
    expect(test.tap(1)).toBe(1);
  } finally { test.dispose(); }
});

test.each([undefined, 80])("a failed pose restores matching-panel input with native angle %s", async (hingeAngle) => {
  const rig = setup(true);
  const commands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  const config = { screenId: 3, width: 2007, height: 2853, orientation: "portrait" as const };
  try {
    await rig.loaded;
    rig.inner.pixel = 180;
    rig.setState({ angle: 180, pose: "open", streamConfig: { ...config, hingeAngle: 180 }, hingeCommands: commands });
    rig.tick();
    expect(rig.tap(3)).toBe(1);
    // Tent previews the cover, but native fails after moving to 80 degrees
    // while the inner display keeps streaming. No black frame or ID cycle.
    const submitted = { ...commands, innerDepartures: 1 };
    rig.setState({ angle: 80, pose: "tent", hingeCommands: { ...submitted, pending: true } });
    rig.tick();
    rig.setState({ angle: 90, pose: null, streamConfig: { ...config, hingeAngle }, hingeCommands: submitted });
    rig.tick();
    expect(rig.tap(3)).toBe(1);
  } finally { rig.dispose(); }
});

test("a visible arriving panel shows a wait cursor only until native input follows it", async () => {
  const rig = setup(true);
  const commands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  try {
    await rig.loaded;
    rig.inner.pixel = 180;
    rig.setState({ hingeCommands: commands });
    rig.tick();
    rig.setState({ angle: 90, pose: "book", hingeCommands: { ...commands, pending: true, coverDepartures: 1 } });
    rig.tick();
    expect(rig.host.dataset.screenId).toBe("3");
    expect(rig.hover(3)).toBe("progress");
    expect(rig.tap(3)).toBe(0);
    // Native routing is ready, even if the command ack/angle is still delayed.
    rig.setState({ streamConfig: { screenId: 3, width: 2007, height: 2853, orientation: "portrait" } });
    rig.tick();
    expect(rig.cursor()).toBe("pointer");
    expect(rig.tap(3)).toBe(1);
    expect(rig.tap(1)).toBe(0);
  } finally { rig.dispose(); }
});

test("batched away and return submissions release input once the queue is idle on the matching panel", async () => {
  const test = setup(true);
  try {
    await test.loaded;
    test.setState({ hingeCommands: { pending: false, coverDepartures: 0, innerDepartures: 0 },
      streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait", hingeAngle: 0 } });
    test.tick();
    expect(test.tap(1)).toBe(1);
    test.setState({ hingeCommands: { pending: true, coverDepartures: 1, innerDepartures: 1 } });
    test.tick();
    expect(test.tap(1)).toBe(0);
    test.setState({ hingeCommands: { pending: false, coverDepartures: 1, innerDepartures: 1 } });
    test.tick();
    expect(test.tap(1)).toBe(1);
  } finally { test.dispose(); }
});

test("the single-stream fallback still requires matching active display metadata", () => {
  const test = setup(false, true);
  try {
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    test.setState({ angle: 180, pose: "open" });
    test.tick();
    expect(test.innerTexture.draws).toBe(0);
    expect(test.host.dataset.screenId).toBe("1");
  } finally { test.dispose(); }
});

test("panel caching follows the native 54/55 boundary before display metadata catches up", () => {
  const test = setup(true, true);
  try {
    test.tick();
    test.setState({ angle: 54, pose: "open" });
    test.cover.pixel = 100;
    test.inner.pixel = 180;
    test.tick();
    expect(test.host.dataset.screenId).toBe("1");
    expect(test.coverTexture.pixel).toBe(100);
    expect(test.innerTexture.draws).toBe(0);

    test.setState({ angle: 55 });
    test.cover.pixel = 0;
    test.tick();
    expect(test.host.dataset.screenId).toBe("3");
    expect(test.host.dataset.screenReady).toBe("true");
    expect(test.innerTexture.pixel).toBe(180);
    expect(test.coverTexture.pixel).toBe(100);

    // Folding back below the boundary returns to the cover even if the main
    // stream has only just acknowledged the earlier switch to the inner panel.
    test.setState({ angle: 54, streamConfig: { screenId: 3, width: 2007, height: 2853, orientation: "portrait" } });
    test.cover.pixel = 120;
    test.inner.pixel = 0;
    test.tick();
    expect(test.host.dataset.screenId).toBe("1");
    expect(test.coverTexture.pixel).toBe(120);
    expect(test.innerTexture.pixel).toBe(180);
  } finally { test.dispose(); }
});

test("rapid reopening retains its cached screen while matching metadata belongs to the previous activation", () => {
  const test = setup(true, true);
  const innerConfig = { screenId: 3, width: 2007, height: 2853, orientation: "landscape_left" as const };
  try {
    test.tick();
    test.inner.pixel = 180;
    test.setState({ angle: 180, pose: "open", streamConfig: innerConfig });
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);

    // Close and reopen before the main metadata ever leaves screen 3.
    test.setState({ angle: 0, pose: "closed" });
    test.inner.pixel = 0;
    test.tick();
    test.setState({ angle: 180, pose: "open" });
    const beforeReopen = test.innerTexture.draws;
    for (let second = 0; second < 12; second++) {
      test.tick(1000);
      expect(test.innerTexture.pixel).toBe(180);
      expect(test.innerTexture.draws).toBe(beforeReopen);
    }
    expect(test.host.dataset.screenId).toBe("3");

    // A real black-to-valid frame transition proves this activation finished.
    // A subsequent genuinely black application frame must then be accepted.
    test.inner.pixel = 210;
    test.tick();
    expect(test.innerTexture.pixel).toBe(210);
    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.innerTexture.draws).toBe(beforeReopen + 2);

    test.inner.pixel = 230;
    test.tick();
    test.setState({ angle: 0, pose: "closed" });
    test.tick();
    test.setState({ angle: 180, pose: "open" });
    test.inner.pixel = 0;
    test.tick();
    expect(test.innerTexture.pixel).toBe(230);
    // A delayed metadata cycle is independent confirmation, even if the
    // newly active application has only black pixels.
    test.setState({ streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait" } });
    test.tick();
    expect(test.innerTexture.pixel).toBe(230);
    test.setState({ streamConfig: innerConfig });
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
  } finally { test.dispose(); }
});

test("panel caching defaults off and both panels show their live frames including black during a fold", () => {
  const test = setup(true);
  try {
    test.inner.pixel = 180;
    test.tick();
    expect(test.coverTexture.pixel).toBe(70);
    expect(test.innerTexture.pixel).toBe(180);

    test.setState({ angle: 180, pose: "open" });
    test.cover.pixel = 0;
    test.inner.pixel = 0;
    test.tick();
    expect(test.coverTexture.pixel).toBe(0);
    expect(test.innerTexture.pixel).toBe(0);

    test.inner.pixel = 210;
    test.tick();
    expect(test.innerTexture.pixel).toBe(210);
    expect(test.host.dataset.screenId).toBe("3");

    test.setState({ angle: 0, pose: "closed" });
    test.inner.pixel = 0;
    test.cover.pixel = 100;
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.coverTexture.pixel).toBe(100);
  } finally { test.dispose(); }
});

test("turning caching off clears a retained hidden panel even before its source resumes", () => {
  const test = setup(true, true);
  try {
    test.tick();
    test.inner.pixel = 180;
    test.setState({ angle: 180, pose: "open", streamConfig: { screenId: 3, width: 2007, height: 2853, orientation: "landscape_left" } });
    test.tick();
    test.inner.pixel = 0;
    test.setState({ angle: 0, pose: "closed", streamConfig: { screenId: 1, width: 1398, height: 2034, orientation: "portrait" } });
    test.tick();
    expect(test.innerTexture.pixel).toBe(180);

    test.sourceHost.panels.get(3)!.source = null;
    test.setState({ cacheScreenOnFold: false });
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    expect(test.coverTexture.pixel).toBe(70);

    test.sourceHost.panels.get(3)!.source = test.inner;
    test.tick();
    expect(test.innerTexture.pixel).toBe(0);
    test.setState({ cacheScreenOnFold: true });
    test.cover.pixel = 100;
    test.tick();
    test.setState({ angle: 180, pose: "open" });
    test.cover.pixel = 0;
    test.tick();
    expect(test.coverTexture.pixel).toBe(100);
  } finally { test.dispose(); }
});
