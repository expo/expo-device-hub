/**
 * Loads a device model's GLB and rigs it for the scene: the meshes of each
 * display with UVs that span the display, and for a foldable the two leaves,
 * folded by the GLB's hinge animation and the calculated bending of its
 * flexible meshes. The URL is the consumer's: the Hub ships the GLBs with its
 * dashboard.
 */

import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createFlexDeformer, type FlexDeformer } from "./device-model-bend";
import { type DeviceModelDescription, type DeviceModelDisplay } from "./device-models";

/**
 * The GLBs are in meters. The scene works in centimeters, the unit of Xcode's
 * iPhone Duo model that its camera and framing were tuned for.
 */
export const SCENE_UNITS_PER_METER = 100;

/** The leaves' rotations about the hinge, as the scene's views set them. */
export type DeviceModelFolds = { left: number; right: number };

export interface DeviceModelRig {
  /** The model, centered; the scene adds it to its root. */
  model: THREE.Group;
  /** The two leaves of a foldable, for the hinge handles; null for a phone. */
  halves: { left: THREE.Object3D; right: THREE.Object3D } | null;
  /** The meshes that show each display. */
  displays: { main: THREE.Mesh[]; cover: THREE.Mesh[] };
  /** The folds that {@link fold} set last. */
  readonly folds: DeviceModelFolds;
  /**
   * Fold the leaves. Without `bend`, the flexible meshes keep their shape, for
   * a projection that the scene undoes in the same frame.
   */
  fold(folds: DeviceModelFolds, bend?: boolean): void;
  /** The center of the folded body in model coordinates. */
  center(out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

const modelBytes = new Map<string, Promise<ArrayBuffer>>();

export async function loadDeviceModel(
  description: DeviceModelDescription,
  url: string,
): Promise<DeviceModelRig> {
  let bytes = modelBytes.get(url);
  if (!bytes) {
    bytes = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`The ${description.name} model is unavailable`);
      return response.arrayBuffer();
    });
    modelBytes.set(url, bytes);
  }
  try {
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    return rigDeviceModel(description, await loader.parseAsync(await bytes, ""));
  } catch (error) {
    modelBytes.delete(url);
    throw error;
  }
}

function meshesUnder(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

/** `point`, in `object`'s coordinates, in the coordinates of its ancestor `root`. */
function pointIn(root: THREE.Object3D, object: THREE.Object3D, point: THREE.Vector3) {
  for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) {
    node.updateMatrix();
    point.applyMatrix4(node.matrix);
  }
  return point;
}

/**
 * Planar UVs over the open display, so one texture spans every mesh of the
 * display, also across the hinge. A rear display is seen from behind, so its
 * U runs the other way.
 */
function mapDisplay(asset: THREE.Object3D, meshes: THREE.Mesh[], display: DeviceModelDisplay) {
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  const positions = meshes.map((mesh) => {
    const attribute = mesh.geometry.getAttribute("position");
    const values = new Float32Array(attribute.count * 2);
    for (let i = 0; i < attribute.count; i++) {
      pointIn(asset, mesh, point.fromBufferAttribute(attribute, i));
      values[i * 2] = point.x;
      values[i * 2 + 1] = point.y;
      bounds.expandByPoint(point);
    }
    return values;
  });
  const size = bounds.getSize(new THREE.Vector3());
  meshes.forEach((mesh, index) => {
    const xy = positions[index]!;
    const uv = new Float32Array(xy.length);
    for (let i = 0; i < xy.length; i += 2) {
      const u = (xy[i]! - bounds.min.x) / size.x;
      uv[i] = display.rear ? 1 - u : u;
      uv[i + 1] = (xy[i + 1]! - bounds.min.y) / size.y;
    }
    mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  });
}

type FlexJob = {
  deformer: FlexDeformer;
  positions: THREE.BufferAttribute;
  normals: THREE.BufferAttribute;
  meshes: THREE.Mesh[];
};

/** The flexible meshes that the GLB marks for calculated bending, each with its deformer. */
function flexJobs(gltf: GLTF, bend: "duo" | "pixel"): FlexJob[] {
  const json = gltf.parser.json as {
    extras?: { proceduralFold?: { model?: string; version?: number; flexibleMeshes?: string[] } };
    meshes: { extras?: { proceduralFold?: { sourceObject?: string } } }[];
  };
  const metadata = json.extras?.proceduralFold;
  if (metadata?.model !== bend || metadata.version !== 1) {
    throw new Error("The model has no calculated bending");
  }
  const groups = new Map<number, { name: string; meshes: THREE.Mesh[] }>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const index = gltf.parser.associations.get(object)?.meshes;
    const name = index === undefined ? undefined : json.meshes[index]?.extras?.proceduralFold;
    if (index === undefined || !name?.sourceObject) return;
    let group = groups.get(index);
    if (!group) groups.set(index, (group = { name: name.sourceObject, meshes: [] }));
    group.meshes.push(object);
  });
  const jobs = [...groups.values()].map(({ name, meshes }) => {
    // A mesh's primitives share its vertices; one deformer moves them all.
    const geometry = meshes[0]!.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    if (!(position.array instanceof Float32Array) || !(normal.array instanceof Float32Array)) {
      throw new Error(`Unsupported vertex format in ${name}`);
    }
    const positions = Float32Array.from(position.array);
    const normals = Float32Array.from(normal.array);
    const indices = Uint32Array.from(
      meshes.flatMap((mesh) => Array.from(mesh.geometry.index?.array ?? [])),
    );
    const deformer = createFlexDeformer(bend, { name, positions, normals, indices });
    if (!deformer) throw new Error(`No calculated bending for ${name}`);
    const job: FlexJob = {
      deformer,
      positions: new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
      normals: new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage),
      meshes,
    };
    for (const mesh of meshes) {
      mesh.geometry.setAttribute("position", job.positions);
      mesh.geometry.setAttribute("normal", job.normals);
    }
    return job;
  });
  if (metadata.flexibleMeshes && jobs.length !== metadata.flexibleMeshes.length) {
    throw new Error("The model's flexible meshes are incomplete");
  }
  return jobs;
}

/** Rig a parsed GLB as `description` names its parts. */
export function rigDeviceModel(description: DeviceModelDescription, gltf: GLTF): DeviceModelRig {
  const asset = gltf.scene;
  const find = (name: string) => {
    const object = asset.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
    if (!object) throw new Error(`The ${description.name} model has no ${name}`);
    return object;
  };
  const hinge = description.hinge;
  let pose = (_angle: number) => {};
  let bend = (_angle: number) => {};
  let mixer: THREE.AnimationMixer | undefined;
  let halves: DeviceModelRig["halves"] = null;
  if (hinge) {
    // The GLB's animation time is the hinge angle in degrees, 0 closed to 180 open.
    const clip = gltf.animations.find((animation) => Math.abs(animation.duration - 180) < 0.001);
    if (!clip) throw new Error(`The ${description.name} model has no hinge animation`);
    mixer = new THREE.AnimationMixer(asset);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    action.paused = true;
    const jobs = flexJobs(gltf, hinge.bend);
    let posed = Number.NaN;
    let bent = Number.NaN;
    pose = (angle) => {
      if (angle === posed) return;
      posed = angle;
      action.enabled = true;
      action.paused = true;
      action.time = angle;
      mixer!.update(0);
    };
    bend = (angle) => {
      if (angle === bent) return;
      for (const job of jobs) {
        job.deformer.apply(
          angle,
          job.positions.array as Float32Array,
          job.normals.array as Float32Array,
        );
        job.positions.needsUpdate = true;
        job.normals.needsUpdate = true;
        for (const mesh of job.meshes) {
          mesh.geometry.boundingBox = null;
          mesh.geometry.boundingSphere = null;
        }
      }
      // Only a finished bend is kept, so a failed one is not mistaken for done.
      bent = angle;
    };
    halves = { left: find(hinge.left), right: find(hinge.right) };
  }
  pose(180);
  bend(180);
  asset.updateMatrixWorld(true);

  const displays = {
    main: description.displays.main.nodes.flatMap((name) => meshesUnder(find(name))),
    cover: description.displays.cover?.nodes.flatMap((name) => meshesUnder(find(name))) ?? [],
  };
  mapDisplay(asset, displays.main, description.displays.main);
  if (description.displays.cover) mapDisplay(asset, displays.cover, description.displays.cover);
  for (const mesh of meshesUnder(asset)) {
    // A bent or animated mesh leaves its stored bounds.
    mesh.frustumCulled = false;
  }

  // A phone turns around its center. A foldable keeps its hinge on the Y axis,
  // and the scene centers its folded body every frame.
  const bounds = new THREE.Box3().setFromObject(asset);
  const middle = bounds.getCenter(new THREE.Vector3());
  asset.scale.setScalar(SCENE_UNITS_PER_METER);
  asset.position.set(hinge ? 0 : -middle.x, -middle.y, hinge ? 0 : -middle.z);
  asset.position.multiplyScalar(SCENE_UNITS_PER_METER);
  const pivot = new THREE.Group();
  pivot.add(asset);
  const model = new THREE.Group();
  model.add(pivot);

  // Each leaf's middle on the hinge plane, as Xcode's model was centered.
  const anchors = halves
    ? ([halves.left, halves.right] as const).map((leaf) => {
        const box = new THREE.Box3();
        for (const mesh of meshesUnder(leaf)) {
          mesh.geometry.computeBoundingBox();
          const local = mesh.geometry.boundingBox!.clone();
          for (let node: THREE.Object3D | null = mesh; node && node !== leaf; node = node.parent) {
            node.updateMatrix();
            local.applyMatrix4(node.matrix);
          }
          box.union(local);
        }
        const anchor = box.getCenter(new THREE.Vector3());
        anchor.z = 0;
        return anchor;
      })
    : null;

  const folds: DeviceModelFolds = { left: 0, right: 0 };
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  return {
    model,
    halves,
    displays,
    folds,
    fold(next, deform = true) {
      folds.left = next.left;
      folds.right = next.right;
      if (!hinge) return;
      // The GLB keeps the left leaf still; the scene turns it with the pivot.
      pivot.rotation.y = next.left;
      const angle = Math.max(0, Math.min(180, 180 - ((next.left - next.right) * 180) / Math.PI));
      pose(angle);
      if (deform) bend(angle);
    },
    center(out) {
      if (!halves || !anchors) return out.set(0, 0, 0);
      pointIn(model, halves.left, left.copy(anchors[0]!));
      pointIn(model, halves.right, right.copy(anchors[1]!));
      return out.addVectors(left, right).multiplyScalar(0.5);
    },
    dispose() {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(asset);
    },
  };
}
