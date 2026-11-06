// The real 3D scene with the real GLB models, as serve-sim tests its Duo scene.
// Only the browser and the GPU are replaced: the scene loads, rigs, bends,
// uploads frames, and hit-tests real geometry. Runs in its own process through
// `device-model-scene.test.ts`, because it replaces the `three` module.
import { expect, mock, spyOn, test } from "bun:test";
import { markCanvasFrame, type TouchSample } from "@expo/hub-client";

import {
  DEVICE_MODELS,
  type DeviceModelDescription,
  modelDisplay,
} from "../../foldable/device-models";
import { type DeviceModelRig } from "../../foldable/device-model-rig";
import { type DuoStreamConfig } from "../../foldable/duo-displays";
import { modelFrameRotation } from "../../foldable/duo-pose";
import { type DuoSceneState } from "../../foldable/duo-scene";
import { deviceModelView } from "../../foldable/duo-view";
import { FILES, MODELS, MODELS_AVAILABLE, withoutTextures } from "../glb-fixtures";

const VIEWPORT = { width: 1680, height: 1100 };

/** A canvas that records what is drawn onto it, and at which rotation. */
class TestCanvas extends EventTarget {
  width = 300;
  height = 150;
  style = { cssText: "", width: "", height: "", cursor: "" };
  draws: { source: unknown; rotation: number }[] = [];
  private rotation = 0;
  remove() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height };
  }
  setPointerCapture() {}
  hasPointerCapture() {
    return false;
  }
  releasePointerCapture() {}
  getContext() {
    return {
      fillStyle: "",
      fillRect() {},
      save() {},
      restore: () => {
        this.rotation = 0;
      },
      translate() {},
      rotate: (angle: number) => {
        this.rotation = angle;
      },
      drawImage: (source: unknown) => {
        this.draws.push({ source, rotation: this.rotation });
      },
      getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }),
    };
  }
}
class TestImage {
  complete = true;
  constructor(
    public naturalWidth: number,
    public naturalHeight: number,
  ) {}
}
/** The stage host and the hidden host of the stream's own element. */
class TestHost extends EventTarget {
  dataset: Record<string, string> = {};
  clientWidth = 480;
  clientHeight = 540;
  constructor(public source: TestCanvas | TestImage | null = null) {
    super();
  }
  appendChild() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  querySelector(selector: string) {
    return selector === "canvas" && this.source instanceof TestCanvas ? this.source : null;
  }
  querySelectorAll(selector: string) {
    return selector === "img" && this.source instanceof TestImage ? [this.source] : [];
  }
}

const created: TestCanvas[] = [];
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    matchMedia: () => ({ matches: false }),
  }),
  document: Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => {
      const canvas = new TestCanvas();
      created.push(canvas);
      return canvas;
    },
  }),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  HTMLCanvasElement: TestCanvas,
  HTMLVideoElement: class {},
  HTMLImageElement: TestImage,
  ImageBitmap: class {},
});

const three = await import("three");
let camera: InstanceType<typeof three.Camera> | undefined;
const renderers: TestRenderer[] = [];
class TestRenderer {
  domElement = new TestCanvas();
  loop: ((now: number) => void) | null = null;
  outputColorSpace = "";
  toneMapping = 0;
  toneMappingExposure = 1;
  constructor() {
    renderers.push(this);
  }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(loop: TestRenderer["loop"]) {
    this.loop = loop;
  }
  // A real renderer updates the world matrices that hit tests read.
  render(scene: InstanceType<typeof three.Scene>, view: InstanceType<typeof three.Camera>) {
    scene.updateMatrixWorld();
    view.updateMatrixWorld();
    camera = view;
  }
  dispose() {}
}
mock.module("three", () => ({
  ...three,
  WebGLRenderer: TestRenderer,
  PMREMGenerator: class {
    fromScene() {
      return { texture: new three.Texture(), dispose() {} };
    }
    dispose() {}
  },
}));

// The real rig from the shipped GLB, without its images, which need a browser.
const rigModule = await import("../../foldable/device-model-rig");
const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
let rig: DeviceModelRig | undefined;
mock.module("../../foldable/device-model-rig", () => ({
  ...rigModule,
  async loadDeviceModel(description: DeviceModelDescription) {
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(withoutTextures(MODELS + FILES[description.id]), "");
    rig = rigModule.rigDeviceModel(description, gltf);
    return rig;
  },
}));
const { createDuoScene } = await import("../../foldable/duo-scene");

type ModelId = keyof typeof DEVICE_MODELS;

/** The view that `DeviceModelScreen` gives a model with one stream. */
function streamView(model: DeviceModelDescription, angle: number, config: DuoStreamConfig) {
  const mount = modelDisplay(model, config.screenId === 1 ? 1 : 3)?.mount ?? 0;
  return deviceModelView(angle, mount, config.orientation);
}

async function setup(id: ModelId, source: TestCanvas | TestImage, config: DuoStreamConfig) {
  const model = DEVICE_MODELS[id];
  const touches: TouchSample[] = [];
  const angle = model.hinge && config.screenId === 1 ? 0 : 180;
  let state: DuoSceneState = {
    model,
    modelUrl: `https://hub.test/${id}.glb`,
    activeScreenId: config.screenId === 1 ? 1 : 3,
    streamConfig: config,
    angle,
    view: streamView(model, angle, config),
    onTouch: (sample) => touches.push(sample),
  };
  let errors = 0;
  const first = created.length;
  let ready!: () => void;
  const loaded = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const scene = createDuoScene(
    new TestHost() as unknown as HTMLElement,
    new TestHost(source) as unknown as HTMLElement,
    () => state,
    { ready, error: () => errors++ },
  );
  const renderer = renderers.at(-1)!;
  // The scene makes the inner display's texture canvas first, then the cover's.
  const [innerTexture, coverTexture] = created.slice(first);
  await loaded;
  let now = 0;
  const tick = (frames = 1) => {
    for (let frame = 0; frame < frames; frame++) renderer.loop?.((now += 16));
  };
  const pointer = (type: string, x: number, y: number) =>
    renderer.domElement.dispatchEvent(
      Object.assign(new Event(type), {
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        clientX: x,
        clientY: y,
      }),
    );
  return {
    model,
    renderer,
    innerTexture: innerTexture!,
    coverTexture: coverTexture!,
    touches,
    errors: () => errors,
    rig: () => rig!,
    tick,
    pointer,
    tap: (x: number, y: number) => {
      pointer("pointerdown", x, y);
      pointer("pointerup", x, y);
    },
    setAngle: (next: number) => {
      state = { ...state, angle: next, view: streamView(model, next, config) };
    },
    setState: (next: Partial<DuoSceneState>) => {
      state = { ...state, ...next };
    },
    dispose: () => scene.dispose(),
  };
}

/** Where a point of a display's meshes lands on the page: `u` and `v` across its box, from the top left. */
function onDisplay(meshes: InstanceType<typeof three.Mesh>[], u: number, v: number) {
  const box = new three.Box3();
  for (const mesh of meshes) box.expandByObject(mesh);
  const point = new three.Vector3(
    box.min.x + (box.max.x - box.min.x) * u,
    box.max.y - (box.max.y - box.min.y) * v,
    box.max.z,
  ).project(camera!);
  return {
    x: ((point.x + 1) / 2) * VIEWPORT.width,
    y: ((1 - point.y) / 2) * VIEWPORT.height,
  };
}

const stream = (width: number, height: number) =>
  Object.assign(new TestCanvas(), { width, height });
const phone = DEVICE_MODELS["android:pixel-9-pro"];
const portrait = {
  ...phone.displays.main.size,
  orientation: "portrait" as const,
  framesUpright: true,
  screenId: 3,
};

test.skipIf(!MODELS_AVAILABLE)(
  "a phone's stream lands on its display, and a tap reaches the point under the pointer",
  async () => {
    const source = stream(portrait.width, portrait.height);
    markCanvasFrame(source as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro", source, portrait);
    try {
      scene.tick(200);
      expect(scene.errors()).toBe(0);
      expect(scene.innerTexture.draws.at(-1)?.source).toBe(source);
      expect(scene.innerTexture.draws.at(-1)?.rotation).toBe(0);

      const display = scene.rig().displays.main;
      const center = onDisplay(display, 0.5, 0.5);
      scene.tap(center.x, center.y);
      expect(scene.touches[0]?.phase).toBe("begin");
      expect(scene.touches[0]?.x).toBeCloseTo(0.5, 1);
      expect(scene.touches[0]?.y).toBeCloseTo(0.5, 1);
      // Near the top of the glass is near the top of the stream.
      const top = onDisplay(display, 0.5, 0.15);
      scene.tap(top.x, top.y);
      const begins = scene.touches.filter((touch) => touch.phase === "begin");
      expect(begins[1]?.x).toBeCloseTo(0.5, 1);
      expect(begins[1]!.y).toBeLessThan(0.25);
    } finally {
      scene.dispose();
    }
  },
);

test.skipIf(!MODELS_AVAILABLE)(
  "an upright frame of a turned phone is drawn turned back onto the glass",
  async () => {
    const config = {
      width: portrait.height,
      height: portrait.width,
      orientation: "landscape_left" as const,
      framesUpright: true,
      screenId: 3,
    };
    const source = stream(config.width, config.height);
    markCanvasFrame(source as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro", source, config);
    try {
      scene.tick(5);
      const rotation = modelFrameRotation(phone, config);
      expect(rotation).not.toBe(0);
      expect(scene.innerTexture.draws.at(-1)?.rotation).toBe(rotation);
    } finally {
      scene.dispose();
    }
  },
);

test.skipIf(!MODELS_AVAILABLE)(
  "an Android canvas is drawn again only after hub-client paints it, an MJPEG image on every frame",
  async () => {
    const counted = stream(portrait.width, portrait.height);
    markCanvasFrame(counted as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro", counted, portrait);
    try {
      scene.tick(3);
      const drawn = scene.innerTexture.draws.length;
      expect(drawn).toBeGreaterThan(0);
      scene.tick(5);
      expect(scene.innerTexture.draws.length).toBe(drawn);
      markCanvasFrame(counted as unknown as HTMLCanvasElement);
      scene.tick(5);
      expect(scene.innerTexture.draws.length).toBe(drawn + 1);
    } finally {
      scene.dispose();
    }

    // A canvas that hub-client did not paint, as from an older client, is drawn on every frame.
    const uncounted = await setup(
      "android:pixel-9-pro",
      stream(portrait.width, portrait.height),
      portrait,
    );
    try {
      uncounted.tick(3);
      const before = uncounted.innerTexture.draws.length;
      uncounted.tick(5);
      expect(uncounted.innerTexture.draws.length).toBe(before + 5);
    } finally {
      uncounted.dispose();
    }

    const iphone = DEVICE_MODELS["ios:iphone-18-pro"];
    const image = new TestImage(iphone.displays.main.size.width, iphone.displays.main.size.height);
    const mjpeg = await setup("ios:iphone-18-pro", image, {
      ...iphone.displays.main.size,
      orientation: "portrait",
      screenId: 3,
    });
    try {
      mjpeg.tick(3);
      const before = mjpeg.innerTexture.draws.length;
      mjpeg.tick(5);
      expect(mjpeg.innerTexture.draws.length).toBe(before + 5);
    } finally {
      mjpeg.dispose();
    }
  },
);

const fold = DEVICE_MODELS["android:pixel-9-pro-fold"];
const inner = {
  ...fold.displays.main.size,
  orientation: "portrait" as const,
  framesUpright: true,
  screenId: 3,
};

test.skipIf(!MODELS_AVAILABLE)(
  "the Pixel 9 Pro Fold follows the client's hinge angle, and its bend stops soon after a move",
  async () => {
    const source = stream(inner.width, inner.height);
    markCanvasFrame(source as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro-fold", source, inner);
    try {
      scene.tick(10);
      const rig = scene.rig();
      const fold = rig.fold.bind(rig);
      const bends = new Set<string>();
      rig.fold = (folds, bend = true) => {
        if (bend) bends.add(`${folds.left},${folds.right}`);
        fold(folds, bend);
      };
      scene.setAngle(90);
      scene.tick(300);
      const host = scene.renderer.domElement;
      expect(host).toBeDefined();
      // The model reaches 90° exactly, and bends on fewer than 90 frames to get there.
      const angle = 180 - ((rig.folds.left - rig.folds.right) * 180) / Math.PI;
      expect(angle).toBeCloseTo(90, 6);
      expect(bends.size).toBeGreaterThan(10);
      expect(bends.size).toBeLessThan(90);
      expect(scene.errors()).toBe(0);
    } finally {
      scene.dispose();
    }
  },
);

test.skipIf(!MODELS_AVAILABLE)(
  "a non-finite angle is ignored, and a bend that throws falls back to the flat view",
  async () => {
    const source = stream(inner.width, inner.height);
    markCanvasFrame(source as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro-fold", source, inner);
    try {
      scene.tick(10);
      scene.setState({ angle: Number.NaN });
      scene.tick(10);
      expect(scene.errors()).toBe(0);
      expect(Number.isFinite(scene.rig().folds.left)).toBe(true);
      // A caller builds its view from the same angle, so the view is non-finite too.
      scene.setState({ angle: Number.NaN, view: streamView(fold, Number.NaN, inner) });
      scene.tick(10);
      scene.setAngle(150);
      scene.tick(300);
      expect(scene.errors()).toBe(0);
      expect(scene.rig().model.matrixWorld.elements.every(Number.isFinite)).toBe(true);

      scene.setAngle(60);
      scene.rig().fold = () => {
        throw new Error("Non-positive bend Jacobian");
      };
      scene.tick(3);
      expect(scene.errors()).toBe(1);
      expect(scene.renderer.loop).toBeNull();
    } finally {
      scene.dispose();
    }
  },
);

test.skipIf(!MODELS_AVAILABLE)(
  "a resting pointer does not hit-test the whole model on every frame",
  async () => {
    const source = stream(portrait.width, portrait.height);
    markCanvasFrame(source as unknown as HTMLCanvasElement);
    const scene = await setup("android:pixel-9-pro", source, portrait);
    const intersect = spyOn(three.Raycaster.prototype, "intersectObject");
    try {
      // Let the first pose and the zoom settle.
      scene.tick(300);
      const center = onDisplay(scene.rig().displays.main, 0.5, 0.5);
      scene.pointer("pointermove", center.x, center.y);
      const afterMove = intersect.mock.calls.length;
      expect(afterMove).toBeGreaterThan(0);
      scene.tick(30);
      expect(intersect.mock.calls.length).toBe(afterMove);
      expect(scene.renderer.domElement.style.cursor).toBe("pointer");
      // A moved pointer is tested again.
      scene.pointer("pointermove", center.x + 10, center.y);
      expect(intersect.mock.calls.length).toBe(afterMove + 1);
    } finally {
      intersect.mockRestore();
      scene.dispose();
    }
  },
);
