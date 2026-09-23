import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { DuoModelViewProps } from "../components/duo-model-view";
import type { StreamConfig } from "../types";
import { duoIntendedScreen, duoFrameMatchesDisplay, duoScreenMapping, duoScreenPoint, stepDuoSpring, type DuoScreenMapping } from "./duo-pose";
import { duoInitialView, duoViewFolds, duoViewRotation, type DuoView } from "./duo-view";
import { duoFitScale, duoPanelEdgeAnchor, duoProjectAnchor, duoHingeDragAngle, type DuoScreenPoint as ProjectedPoint } from "./duo-layout";
import { HID_EDGE_BOTTOM, HID_EDGE_LEFT, HID_EDGE_RIGHT, HID_EDGE_TOP, HOME_INDICATOR_BAND_NORM, rawEdgeForDisplayEdge, streamDisplayGeometry } from "./orientation";
import { loadDuoModel } from "./duo-model";

export type DuoSceneState = Omit<DuoModelViewProps, "children">;
type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;
type HingeHandle = { element: HTMLElement; side: "left" | "right"; anchor: THREE.Vector3 | null };
type Surface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  meshes: THREE.Mesh[];
  ready: boolean;
  mapping?: DuoScreenMapping;
  mappingConfigKey?: string;
  lastFrameKey?: string;
  lastImage?: string;
  lastVideoTime?: number;
  sawOtherActiveScreen: boolean;
  nativeDeparture?: number;
  handoff?: { sawBlack: boolean };
};

/** Owns GPU resources and the animation loop; React only supplies requested state. */
export function createDuoScene(
  host: HTMLElement,
  sourceHost: HTMLElement,
  state: () => DuoSceneState,
  callbacks: { ready: () => void; error: () => void },
  hingeElements: Partial<Record<"left" | "right", HTMLElement>> = {},
) {
  let disposed = false;
  let failed = false;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    callbacks.error();
    return { dispose() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.domElement.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block;touch-action:none;outline:none";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
  camera.position.set(0, 0, 31);
  const root = new THREE.Group();
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8290a2, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-6, 10, 14);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc7dcff, 2);
  fill.position.set(8, -3, 5);
  scene.add(fill);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();

  const createSurface = (width: number, height: number): Surface => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false })!;
    context.fillStyle = "#080a10";
    context.fillRect(0, 0, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.FrontSide });
    return { canvas, context, texture, material, meshes: [], ready: false, sawOtherActiveScreen: false };
  };
  const inner = createSurface(1600, 1125);
  const cover = createSurface(784, 1140);
  const originals = new Set<THREE.Material>();
  let left: THREE.Object3D | undefined;
  let right: THREE.Object3D | undefined;
  let model: THREE.Group | undefined;
  let fold = 0;
  let velocity = 0;
  let firstPose = true;
  let initialView: DuoView | undefined;
  let anchoredView: DuoView | undefined;
  let anchorWeight = 0;
  const targetQuaternion = new THREE.Quaternion();
  const center = new THREE.Vector3();
  function viewFor(current: DuoSceneState): DuoView {
    return current.view ?? (initialView ??= duoInitialView(current.angle,
      current.physicalPose === undefined ? current.pose : current.physicalPose, current.streamConfig));
  }
  function applyPanelFolds(panels: { left: number; right: number }) {
    if (!left || !right) return;
    left.rotation.y = panels.left;
    right.rotation.y = panels.right;
    // Center the articulated body, including Laptop's stationary base.
    center.set(2.025 * (Math.cos(panels.right) - Math.cos(panels.left)), 0,
      2.025 * (Math.sin(panels.left) - Math.sin(panels.right))).applyQuaternion(root.quaternion);
    root.position.copy(center).multiplyScalar(-1);
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let viewportWidth = 0;
  let viewportHeight = 0;
  let stageHeight = 0;
  let stageWidth = 0;
  let fitScale = 1;
  let fitVelocity = 0;
  const hingeHandles: HingeHandle[] = (["left", "right"] as const).flatMap((side) => {
    const element = hingeElements[side];
    return element ? [{ element, side, anchor: null }] : [];
  });
  let resizePending = false;
  let projectionPending = false;
  const resizeViewport = () => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    if (width === viewportWidth && height === viewportHeight) return;
    viewportWidth = width;
    viewportHeight = height;
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    resizePending = true;
    projectionPending = true;
  };
  resizeViewport();
  window.addEventListener("resize", resizeViewport);
  const resize = new ResizeObserver(([entry]) => {
    if (!entry) return;
    // contentRect excludes presentation transforms, as do the canvas CSS
    // dimensions. The handle changes model zoom inside that fixed canvas.
    const { width, height } = entry.contentRect;
    if (!width || !height || (height === stageHeight && width === stageWidth)) return;
    stageWidth = width;
    stageHeight = height;
    projectionPending = true;
  });
  resize.observe(host);

  let cancelInput = () => {};
  function fail() {
    if (disposed || failed) return;
    failed = true;
    cancelInput();
    renderer.setAnimationLoop(null);
    callbacks.error();
  }
  renderer.domElement.addEventListener("webglcontextlost", fail);

  function disposeModel(object: THREE.Object3D) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) originals.add(material);
    });
    for (const material of originals) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) {
        value.dispose();
        if (value.image instanceof ImageBitmap) value.image.close();
      }
      material.dispose();
    }
  }

  void loadDuoModel().then((loaded) => {
    if (disposed || failed) { disposeModel(loaded); return; }
    model = loaded;
    left = model.getObjectByName("left-half");
    right = model.getObjectByName("right-half");
    if (!left || !right) throw new Error("Missing iPhone Duo hinge groups");
    for (const handle of hingeHandles) handle.anchor = duoPanelEdgeAnchor(handle.side === "left" ? left : right, handle.side);
    const displays: THREE.Mesh[] = [];
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.name.startsWith("inner-display") || child.name === "cover-display") displays.push(child);
    });
    // UVs span both inner halves. No duplicated stream or seam down the hinge.
    for (const surface of [inner, cover]) {
      surface.meshes = displays.filter((mesh) => (mesh.name === "cover-display") === (surface === cover));
      const bounds = new THREE.Box3();
      for (const mesh of surface.meshes) {
        mesh.geometry.computeBoundingBox();
        bounds.union(mesh.geometry.boundingBox!);
      }
      const size = bounds.getSize(new THREE.Vector3());
      for (const mesh of surface.meshes) {
        const position = mesh.geometry.getAttribute("position");
        const uv = new Float32Array(position.count * 2);
        for (let i = 0; i < position.count; i++) {
          const x = (position.getX(i) - bounds.min.x) / size.x;
          uv[i * 2] = surface === cover ? 1 - x : x;
          uv[i * 2 + 1] = (position.getY(i) - bounds.min.y) / size.y;
        }
        mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) originals.add(material);
        mesh.material = surface.material;
      }
    }
    root.add(model);
    callbacks.ready();
  }).catch(fail);

  function currentSource(parent = sourceHost): FrameSource | null {
    const video = parent.querySelector("video");
    if (video && video.readyState >= 2 && video.videoWidth) return video;
    const canvas = parent.querySelector("canvas");
    if (canvas && canvas.width > 1 && canvas.height > 1) return canvas;
    const images = parent.querySelectorAll("img");
    for (let index = images.length - 1; index >= 0; index--) {
      const image = images[index]!;
      if (image.complete && image.naturalWidth > 1) return image;
    }
    return null;
  }

  function sourceSize(source: FrameSource) {
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    return { width, height };
  }

  let handoffProbe: CanvasRenderingContext2D | undefined;
  function hasVisiblePixels(source: FrameSource) {
    if (!handoffProbe) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      handoffProbe = canvas.getContext("2d", { willReadFrequently: true })!;
    }
    handoffProbe.fillStyle = "#000";
    handoffProbe.fillRect(0, 0, 8, 8);
    handoffProbe.drawImage(source, 0, 0, 8, 8);
    const { data } = handoffProbe.getImageData(0, 0, 8, 8);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! * 0.2126 + data[index + 1]! * 0.7152 + data[index + 2]! * 0.0722 > 3) return true;
    }
    return false;
  }

  function uploadScreen(source: FrameSource, config: StreamConfig, inputConfig?: StreamConfig | null, cacheScreenOnFold = false) {
    const surface = config.screenId === 1 ? cover : inner;
    const active = inputConfig?.screenId === config.screenId;
    if (surface.handoff && active && surface.sawOtherActiveScreen) surface.handoff = undefined;
    // Track activation separately from optional image retention: a matching
    // active ID can describe the previous activation on a rapid round trip.
    // Input waits for metadata to cycle or for black to change back to content.
    if ((cacheScreenOnFold && !active) || surface.handoff) {
      if (!hasVisiblePixels(source)) {
        if (surface.handoff) surface.handoff.sawBlack = true;
        if (cacheScreenOnFold) return;
      } else if (surface.handoff?.sawBlack && active) surface.handoff = undefined;
    }
    const binding = inputConfig && inputConfig.screenId === config.screenId && duoFrameMatchesDisplay(config.width, config.height, inputConfig)
      ? inputConfigKey(inputConfig) : undefined;
    // UVs remain fixed to the hardware through the entire pose animation.
    // The body carries the image, including cached frames on an inactive panel.
    const frameKey = `${config.width}:${config.height}:${binding}`;
    if (frameKey === surface.lastFrameKey) {
      if (source instanceof HTMLImageElement && source.src === surface.lastImage) return;
      if (source instanceof HTMLVideoElement && source.currentTime === surface.lastVideoTime) return;
    }
    surface.lastFrameKey = frameKey;
    if (source instanceof HTMLImageElement) surface.lastImage = source.src;
    if (source instanceof HTMLVideoElement) surface.lastVideoTime = source.currentTime;
    const { context, canvas } = surface;
    const mapping = duoScreenMapping(config, canvas.width, canvas.height);
    surface.mapping = mapping;
    context.fillStyle = "#080a10";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(mapping.rotation);
    context.drawImage(source, -mapping.drawnWidth / 2, -mapping.drawnHeight / 2, mapping.drawnWidth, mapping.drawnHeight);
    context.restore();
    surface.mappingConfigKey = binding;
    surface.texture.needsUpdate = true;
    surface.ready = true;
  }

  let previousIntendedScreen: 1 | 3 | undefined;
  let previousCacheScreenOnFold = false;
  function clearRetainedImage(surface: Surface) {
    surface.context.fillStyle = "#000";
    surface.context.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.texture.needsUpdate = true;
    surface.ready = false;
    surface.mapping = undefined;
    surface.mappingConfigKey = undefined;
    surface.lastFrameKey = undefined;
    surface.lastImage = undefined;
    surface.lastVideoTime = undefined;
  }

  function updateScreen() {
    const current = state();
    const config = current.streamConfig;
    const cacheScreenOnFold = current.cacheScreenOnFold === true;
    if (previousCacheScreenOnFold && !cacheScreenOnFold) {
      // Disabling retention also clears hidden panels whose feed is currently
      // unavailable. Ready sources repaint during this same render.
      clearRetainedImage(cover);
      clearRetainedImage(inner);
    }
    previousCacheScreenOnFold = cacheScreenOnFold;
    const physicalPose = current.physicalPose === undefined ? current.pose : current.physicalPose;
    const intended = duoIntendedScreen(current.angle, physicalPose, config?.screenId);
    const coverHost = sourceHost.querySelector<HTMLElement>('[data-duo-panel="1"]');
    const innerHost = sourceHost.querySelector<HTMLElement>('[data-duo-panel="3"]');
    if (coverHost || innerHost) {
      const commands = current.hingeCommands;
      if (commands) {
        for (const surface of [cover, inner]) {
          const departures = surface === cover ? commands.coverDepartures : commands.innerDepartures;
          if (surface.nativeDeparture === undefined) surface.nativeDeparture = departures;
          else if (surface.nativeDeparture !== departures && !surface.handoff) {
            // A native away/return can be batched into one React render, even
            // when the intermediate visual preview was never presented.
            surface.handoff = { sawBlack: false };
            surface.sawOtherActiveScreen = false;
          }
        }
      }
      if (previousIntendedScreen !== undefined && previousIntendedScreen !== intended) {
        const departing = previousIntendedScreen === 1 ? cover : inner;
        departing.sawOtherActiveScreen = false;
        const arriving = intended === 1 ? cover : inner;
        arriving.handoff ??= { sawBlack: false };
      }
      previousIntendedScreen = intended;
      if (config?.screenId === 1) inner.sawOtherActiveScreen = true;
      if (config?.screenId === 3) cover.sawOtherActiveScreen = true;
      const intendedSurface = intended === 1 ? cover : inner;
      if (intendedSurface.handoff && commands && !commands.pending &&
        config?.screenId === intended) {
        // Once commands settle on the native input panel, a coalesced or
        // failed departure needs no black frame, exact angle, or display
        // election cycle to restore input.
        intendedSurface.handoff = undefined;
      }
      // The route identifies each physical panel independently of active
      // metadata. Both textures follow their live streams by default; opting
      // into caching freezes the departing panel instead.
      for (const screenId of [1, 3] as const) {
        if (cacheScreenOnFold && screenId !== intended) continue;
        const panelHost = screenId === 1 ? coverHost : innerHost;
        const source = panelHost ? currentSource(panelHost) : null;
        if (source) {
          const size = sourceSize(source);
          if (size.width > 0 && size.height > 0) {
            uploadScreen(source, { ...size, screenId }, config, cacheScreenOnFold);
            const surface = screenId === 1 ? cover : inner;
            if (commands && !surface.handoff && config?.screenId === screenId) {
              surface.nativeDeparture = screenId === 1 ? commands.coverDepartures : commands.innerDepartures;
            }
          }
        }
      }
      const surface = intended === 1 ? cover : inner;
      host.dataset.screenReady = String(surface.ready);
      if (surface.ready) host.dataset.screenId = String(intended);
      return;
    }
    // Keep the single-stream fallback tied to its authoritative panel and
    // matching frame geometry; it cannot identify an incoming panel itself.
    if (!config || (cacheScreenOnFold && config.screenId !== intended) || (config.screenId !== 1 && config.screenId !== 3)) return;
    const source = currentSource();
    if (!source) return;
    const { width, height } = sourceSize(source);
    if (!duoFrameMatchesDisplay(width, height, config)) return;
    uploadScreen(source, config, config, cacheScreenOnFold);
    host.dataset.screenId = String(config.screenId);
    host.dataset.screenReady = "true";
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  type Point = { x: number; y: number };
  type ScreenHit = {
    point: Point;
    triangle: THREE.Triangle;
    plane: THREE.Plane;
    uv: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
    isCover: boolean;
    mapping: DuoScreenMapping;
  };
  function castRay(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }
  function screenHit(clientX: number, clientY: number): ScreenHit | "waiting" | null {
    if (!model || failed || disposed || !castRay(clientX, clientY)) return null;
    // Intersect the entire device so a rear panel cannot receive taps through
    // the front chassis, and ignore inactive display surfaces.
    const hit = raycaster.intersectObject(root, true)[0];
    if (!hit?.uv || !hit.face || !(hit.object instanceof THREE.Mesh)) return null;
    const isCover = cover.meshes.includes(hit.object);
    const isInner = inner.meshes.includes(hit.object);
    const current = state();
    const config = current.streamConfig;
    const physicalPose = current.physicalPose === undefined ? current.pose : current.physicalPose;
    const intended = duoIntendedScreen(current.angle, physicalPose, config?.screenId);
    if ((!isCover && !isInner) || intended !== (isCover ? 1 : 3)) return null;
    const surface = isCover ? cover : inner;
    const mapping = surface.mapping;
    // A new native config can precede its video frame. The retained image is
    // still useful visually, but its transform must not target the new layout.
    if (config?.screenId !== intended || surface.handoff || !mapping || surface.mappingConfigKey !== inputConfigKey(config)) return "waiting";
    const point = duoScreenPoint(hit.uv.x, 1 - hit.uv.y, mapping);
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
    const positions = hit.object.geometry.getAttribute("position");
    const uvs = hit.object.geometry.getAttribute("uv");
    const indices = [hit.face.a, hit.face.b, hit.face.c] as const;
    const vertices = indices.map((index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(hit.object.matrixWorld));
    const triangle = new THREE.Triangle(vertices[0], vertices[1], vertices[2]);
    return {
      point,
      triangle,
      plane: triangle.getPlane(new THREE.Plane()),
      uv: indices.map((index) => new THREE.Vector2().fromBufferAttribute(uvs, index)) as ScreenHit["uv"],
      isCover,
      mapping,
    };
  }

  // Extend the hit panel's plane beyond its edge. This keeps drags continuous
  // off the device and maps wheel directions through the same perspective,
  // physical rotation, and texture rotation as taps.
  function pointOnPanel(hit: ScreenHit, clientX: number, clientY: number): Point | null {
    if (!castRay(clientX, clientY)) return null;
    const intersection = raycaster.ray.intersectPlane(hit.plane, new THREE.Vector3());
    if (!intersection) return null;
    const weights = hit.triangle.getBarycoord(intersection, new THREE.Vector3());
    if (!weights) return null;
    const uv = hit.uv[0].clone().multiplyScalar(weights.x)
      .addScaledVector(hit.uv[1], weights.y).addScaledVector(hit.uv[2], weights.z);
    return duoScreenPoint(uv.x, 1 - uv.y, hit.mapping);
  }
  function boundedPoint(point: Point): Point {
    return { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  }
  function homeEdge(point: Point): number | undefined {
    const orientation = streamDisplayGeometry(state().streamConfig).inputOrientation;
    const edge = rawEdgeForDisplayEdge(orientation, HID_EDGE_BOTTOM);
    const band = HOME_INDICATOR_BAND_NORM;
    const inside = edge === HID_EDGE_BOTTOM ? point.y >= band
      : edge === HID_EDGE_TOP ? point.y <= 1 - band
        : edge === HID_EDGE_LEFT ? point.x <= 1 - band
          : edge === HID_EDGE_RIGHT && point.x >= band;
    return inside ? edge : undefined;
  }
  type Contact = { id: number; point: Point; hit: ScreenHit; pointerType: string };
  type Fingers = { x1: number; y1: number; x2: number; y2: number };
  type Gesture = {
    contacts: Map<number, Contact>;
    screenId?: number;
    configKey: string;
    touch?: DuoSceneState["onTouch"];
    multi?: DuoSceneState["onMultiTouch"];
    mirrored: boolean;
    panOffset?: Point;
    edge?: number;
    fingers: Fingers;
  };
  let gesture: Gesture | null = null;
  function inputConfigKey(config = state().streamConfig) {
    return `${config?.screenId}:${config?.width}:${config?.height}:${config?.orientation}`;
  }
  function fingersFor(current: Gesture): Fingers {
    const [first, second] = [...current.contacts.values()];
    const one = first!.point;
    const two = current.mirrored
      ? boundedPoint(current.panOffset
        ? { x: one.x + current.panOffset.x, y: one.y + current.panOffset.y }
        : { x: 1 - one.x, y: 1 - one.y })
      : second?.point ?? one;
    return { x1: one.x, y1: one.y, x2: two.x, y2: two.y };
  }
  function endGesture() {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    // Release through the callback that began this gesture, even after React
    // disables input for a resize or unmounts the model.
    if (current.multi) current.multi({ type: "end", ...current.fingers });
    else current.touch?.({ type: "end", x: current.fingers.x1, y: current.fingers.y1, edge: current.edge });
    for (const id of current.contacts.keys()) {
      if (renderer.domElement.hasPointerCapture(id)) renderer.domElement.releasePointerCapture(id);
    }
  }
  cancelInput = () => { endGesture(); endHingeDrag(); };
  function validateGesture() {
    if (gesture && (gesture.configKey !== inputConfigKey() ||
      (gesture.screenId === 1 ? cover : inner).handoff ||
      !(gesture.multi ? state().onMultiTouch : state().onTouch))) endGesture();
  }
  const down = (event: PointerEvent) => {
    validateGesture();
    if (event.button !== 0 || failed || disposed || hingeDrag) return;
    const hit = screenHit(event.clientX, event.clientY);
    if (!hit || hit === "waiting") return;
    const point = boundedPoint(hit.point);
    const contact = { id: event.pointerId, point, hit, pointerType: event.pointerType };
    if (gesture) {
      const first = gesture.contacts.values().next().value;
      const multi = state().onMultiTouch;
      if (gesture.multi || event.pointerType !== "touch" || first?.pointerType !== "touch" || !multi) return;
      event.preventDefault();
      renderer.domElement.setPointerCapture(event.pointerId);
      gesture.touch?.({ type: "end", x: first.point.x, y: first.point.y, edge: gesture.edge });
      gesture.contacts.set(event.pointerId, contact);
      gesture.multi = multi;
      gesture.fingers = fingersFor(gesture);
      multi({ type: "begin", ...gesture.fingers });
      return;
    }
    const mirrored = event.altKey && event.pointerType === "mouse" && !!state().onMultiTouch;
    if (!mirrored && !state().onTouch) return;
    event.preventDefault();
    renderer.domElement.setPointerCapture(event.pointerId);
    gesture = {
      contacts: new Map([[event.pointerId, contact]]),
      screenId: state().streamConfig?.screenId,
      configKey: inputConfigKey(),
      touch: state().onTouch,
      multi: mirrored ? state().onMultiTouch : undefined,
      mirrored,
      panOffset: mirrored && event.shiftKey ? { x: 1 - 2 * point.x, y: 1 - 2 * point.y } : undefined,
      edge: homeEdge(point),
      fingers: { x1: point.x, y1: point.y, x2: point.x, y2: point.y },
    };
    gesture.fingers = fingersFor(gesture);
    if (gesture.multi) gesture.multi({ type: "begin", ...gesture.fingers });
    else gesture.touch?.({ type: "begin", ...point, edge: gesture.edge });
  };
  let hoverPoint: Point | undefined;
  function updateCursor(hit = hoverPoint && screenHit(hoverPoint.x, hoverPoint.y)) {
    renderer.domElement.style.cursor = hit === "waiting" ? "progress" : hit ? "pointer" : "default";
  }
  const leave = () => { hoverPoint = undefined; updateCursor(); };
  const move = (event: PointerEvent) => {
    validateGesture();
    hoverPoint = { x: event.clientX, y: event.clientY };
    const result = screenHit(event.clientX, event.clientY);
    updateCursor(result);
    const hit = result === "waiting" ? null : result;
    const contact = gesture?.contacts.get(event.pointerId);
    if (!gesture || !contact) return;
    const point = hit?.point ?? pointOnPanel(contact.hit, event.clientX, event.clientY);
    if (!point) return;
    contact.point = boundedPoint(point);
    if (hit) contact.hit = hit;
    gesture.fingers = fingersFor(gesture);
    if (gesture.multi) gesture.multi({ type: "move", ...gesture.fingers });
    else gesture.touch?.({ type: "move", ...contact.point, edge: gesture.edge });
  };
  const up = (event: PointerEvent) => {
    if (!gesture?.contacts.has(event.pointerId)) return;
    if (event.type === "pointerup") move(event);
    endGesture();
  };
  const wheel = (event: WheelEvent) => {
    if (hingeDrag) return;
    if (gesture) return;
    const hit = screenHit(event.clientX, event.clientY);
    const send = state().onScroll;
    if (!hit || hit === "waiting" || !send) return;
    const rect = host.getBoundingClientRect();
    const dxPixels = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1);
    const dyPixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    const xStep = pointOnPanel(hit, event.clientX + 1, event.clientY);
    const yStep = pointOnPanel(hit, event.clientX, event.clientY + 1);
    if (!xStep || !yStep) return;
    const dx = (xStep.x - hit.point.x) * dxPixels + (yStep.x - hit.point.x) * dyPixels;
    const dy = (xStep.y - hit.point.y) * dxPixels + (yStep.y - hit.point.y) * dyPixels;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    event.preventDefault();
    event.stopPropagation();
    send({ ...hit.point, dx, dy });
  };
  function projectedHandle(handle: HingeHandle): (ProjectedPoint & { rotation: number }) | null {
    const panel = handle.side === "left" ? left : right;
    const anchor = handle.anchor;
    if (!panel || !anchor) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const edge = duoProjectAnchor(anchor, panel, camera, rect);
    const middle = duoProjectAnchor(anchor.clone().multiply(new THREE.Vector3(0.5, 1, 1)), panel, camera, rect);
    if (!edge || !middle) return null;
    const rotation = Math.atan2(edge.y - middle.y, edge.x - middle.x);
    const hostRect = host.getBoundingClientRect();
    const offset = 16 * (stageHeight > 0 ? hostRect.height / stageHeight : 1);
    return { x: edge.x + Math.cos(rotation) * offset, y: edge.y + Math.sin(rotation) * offset, rotation };
  }

  function hingeEndpoint(angle: number, handle: HingeHandle): ProjectedPoint | null {
    if (!model || !left || !right) return null;
    const current = state();
    const view = viewFor(current);
    const savedPosition = root.position.clone();
    const savedRotation = root.quaternion.clone();
    const savedLeft = left.rotation.y;
    const savedRight = right.rotation.y;
    const savedZoom = camera.zoom;
    try {
      const endpointFold = (180 - angle) * Math.PI / 360;
      if (view.facingYaw !== undefined) root.quaternion.copy(duoViewRotation(endpointFold, view));
      applyPanelFolds(duoViewFolds(endpointFold, view));
      const scale = current.sizeMode !== "physical"
        ? duoFitScale(model, camera, { width: viewportWidth, height: viewportHeight }, { width: stageWidth, height: stageHeight }, 32)
        : 1;
      camera.zoom = stageHeight / viewportHeight * scale;
      camera.updateProjectionMatrix();
      return projectedHandle(handle);
    } finally {
      root.position.copy(savedPosition);
      root.quaternion.copy(savedRotation);
      left.rotation.y = savedLeft;
      right.rotation.y = savedRight;
      camera.zoom = savedZoom;
      camera.updateProjectionMatrix();
      root.updateMatrixWorld(true);
    }
  }

  let hingeDrag: {
    handle: HingeHandle;
    pointerId: number;
    pointer: ProjectedPoint;
    start: ProjectedPoint;
    closed: ProjectedPoint;
    open: ProjectedPoint;
    angle: number;
    lastAngle: number;
  } | null = null;
  function endHingeDrag() {
    if (!hingeDrag) return;
    const { pointerId, handle } = hingeDrag;
    hingeDrag = null;
    if (handle.element.hasPointerCapture(pointerId)) handle.element.releasePointerCapture(pointerId);
  }
  const hingeDown = (event: PointerEvent) => {
    if (event.button !== 0 || hingeDrag || !state().onHingeAngleChange || !stageHeight || failed || disposed) return;
    const handle = hingeHandles.find(({ element }) => element === event.currentTarget);
    if (!handle || handle.element.style.display === "none") return;
    const start = projectedHandle(handle);
    const closed = hingeEndpoint(0, handle);
    const open = hingeEndpoint(180, handle);
    if (!start || !closed || !open) return;
    event.preventDefault();
    event.stopPropagation();
    endGesture();
    const angle = Math.max(0, Math.min(180, 180 - fold * 360 / Math.PI));
    hingeDrag = { handle, pointerId: event.pointerId, pointer: { x: event.clientX, y: event.clientY }, start, closed, open, angle, lastAngle: Math.round(angle) };
    handle.element.setPointerCapture(event.pointerId);
    handle.element.focus({ preventScroll: true });
  };
  const hingeMove = (event: PointerEvent) => {
    if (!hingeDrag || event.pointerId !== hingeDrag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const send = state().onHingeAngleChange;
    if (!send) { endHingeDrag(); return; }
    const next = Math.round(duoHingeDragAngle(hingeDrag.angle, hingeDrag.start, hingeDrag.closed, hingeDrag.open,
      { x: event.clientX - hingeDrag.pointer.x, y: event.clientY - hingeDrag.pointer.y }));
    if (next === hingeDrag.lastAngle) return;
    hingeDrag.lastAngle = next;
    send(next);
  };
  const hingeUp = (event: PointerEvent) => {
    if (!hingeDrag || event.pointerId !== hingeDrag.pointerId) return;
    if (event.type === "pointerup") hingeMove(event);
    event.preventDefault();
    event.stopPropagation();
    endHingeDrag();
  };
  const blur = () => { endGesture(); endHingeDrag(); };
  const onVisibilityChange = () => { if (document.hidden) blur(); };
  for (const { element } of hingeHandles) {
    element.addEventListener("pointerdown", hingeDown);
    element.addEventListener("pointermove", hingeMove);
    element.addEventListener("pointerup", hingeUp);
    element.addEventListener("pointercancel", hingeUp);
    element.addEventListener("lostpointercapture", hingeUp);
    element.style.display = "none";
  }
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  let previous = performance.now();
  renderer.setAnimationLoop((now) => {
    if (disposed || failed || document.hidden) return;
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    const current = state();
    if (!current.onHingeAngleChange) endHingeDrag();
    validateGesture();
    try { updateScreen(); } catch { fail(); return; }
    if (hoverPoint && !gesture && !hingeDrag) updateCursor();
    const view = viewFor(current);
    const angle = Math.max(0, Math.min(180, current.angle ?? (current.streamConfig?.screenId === 1 ? 0 : 180)));
    const targetFold = (180 - angle) * Math.PI / 360;
    if (view.fixedLeftFold !== undefined) anchoredView = view;
    const targetAnchor = view.fixedLeftFold === undefined ? 0 : 1;
    const snap = firstPose || reducedMotion.matches;
    if (snap) {
      fold = targetFold;
      velocity = 0;
      anchorWeight = targetAnchor;
      firstPose = false;
    } else {
      const step = stepDuoSpring(fold, velocity, targetFold, dt);
      fold = step.value;
      velocity = step.velocity;
      anchorWeight += (targetAnchor - anchorWeight) * (1 - Math.exp(-10 * dt));
      if (Math.abs(targetAnchor - anchorWeight) < 1e-6) anchorWeight = targetAnchor;
    }
    // Ordinary folding turns toward the inside as the rendered hinge opens.
    // Tabletop views and the user's roll stay independent of native metadata.
    targetQuaternion.copy(duoViewRotation(fold, view));
    if (snap) root.quaternion.copy(targetQuaternion);
    else root.quaternion.slerp(targetQuaternion, 1 - Math.exp(-10 * dt));
    applyPanelFolds(duoViewFolds(fold, anchoredView ?? view, anchorWeight));
    const renderedAngle = 180 - fold * 360 / Math.PI;
    try {
      // Only a window resize reallocates the buffer. Apply it with rendering
      // because changing canvas dimensions clears the previously drawn frame.
      if (resizePending) {
        renderer.setSize(viewportWidth, viewportHeight, false);
        resizePending = false;
      }
      if (projectionPending) {
        camera.aspect = viewportWidth / viewportHeight;
        camera.updateProjectionMatrix();
        projectionPending = false;
      }
      const targetScale = current.sizeMode !== "physical" && model && stageHeight > 0
        ? duoFitScale(model, camera, { width: viewportWidth, height: viewportHeight }, { width: stageWidth, height: stageHeight }, 32)
        : 1;
      const fit = stepDuoSpring(fitScale, fitVelocity, targetScale, dt);
      fitScale = reducedMotion.matches ? targetScale : fit.value;
      fitVelocity = reducedMotion.matches ? 0 : fit.velocity;
      const zoom = (stageHeight > 0 ? stageHeight / viewportHeight : 1) * fitScale;
      if (camera.zoom !== zoom) {
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
      for (const handle of hingeHandles) {
        // Near closed, the two outer edges meet. Keep the original handle.
        const visible = handle.side === "left" || Math.round(renderedAngle) > 30;
        const position = current.onHingeAngleChange && visible ? projectedHandle(handle) : null;
        const element = handle.element;
        const rect = host.getBoundingClientRect();
        element.style.display = position && rect.width && rect.height ? "" : "none";
        if (position && rect.width && rect.height) {
          element.style.left = `${(position.x - rect.left) * stageWidth / rect.width}px`;
          element.style.top = `${(position.y - rect.top) * stageHeight / rect.height}px`;
          element.style.transform = `translate(-50%, -50%) rotate(${position.rotation}rad)`;
        }
      }
    } catch { fail(); }
    host.dataset.hingeAngle = renderedAngle.toFixed(2);
    host.dataset.pose = current.pose ?? "custom";
  });

  return {
    dispose() {
      disposed = true;
      endGesture();
      endHingeDrag();
      renderer.setAnimationLoop(null);
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", fail);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel);
      for (const { element } of hingeHandles) {
        element.removeEventListener("pointerdown", hingeDown);
        element.removeEventListener("pointermove", hingeMove);
        element.removeEventListener("pointerup", hingeUp);
        element.removeEventListener("pointercancel", hingeUp);
        element.removeEventListener("lostpointercapture", hingeUp);
        element.style.display = "none";
      }
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resizeViewport);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (model) disposeModel(model);
      for (const surface of [inner, cover]) { surface.texture.dispose(); surface.material.dispose(); }
      environment.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
