/**
 * The device models that the 3D preview draws: which meshes of each model show
 * a display, how the display's framebuffer sits on that glass, and the hinge of
 * a foldable. The package ships each model's GLB file as
 * `@expo/hub-client/models/<file>.glb`; the consumer imports the files it
 * shows and passes their URLs. This module does not import three.js, so a
 * consumer can read it without loading the scene.
 */

import { type DuoPanelId } from "../duo/duo-fold";
import { type DeviceClient, type DevicePlatform } from "../types";

/** Exact device model that the 3D preview can draw. */
export const DEVICE_MODEL_IDS = [
  "ios:iphone-duo",
  "ios:iphone-18-pro",
  "android:pixel-9-pro",
  "android:pixel-9-pro-fold",
] as const;
export type DeviceModelId = (typeof DEVICE_MODEL_IDS)[number];

/** Fail closed when a newer or stale server sends an unknown model id. */
export function isDeviceModelId(value: unknown): value is DeviceModelId {
  return DEVICE_MODEL_IDS.some((modelId) => modelId === value);
}

/**
 * The URL of each model's GLB, as the consumer's bundler or host gives it. A
 * model without a URL keeps the flat preview.
 */
export type DeviceModelAssets = Partial<Record<DeviceModelId, string>>;

/** One display of a model. */
export interface DeviceModelDisplay {
  /**
   * The GLB nodes whose meshes show this display, as named in the GLB. A display
   * that bends over a hinge has several, and one texture spans them all.
   */
  nodes: readonly string[];
  /** The display's framebuffer in pixels, in the orientation that it is mounted. */
  size: { width: number; height: number };
  /**
   * Clockwise quarter turns from the framebuffer to the glass, as the open model
   * faces the viewer. The iPhone Duo's inner display is mounted on its side.
   */
  mount: 0 | 1;
  /** The glass faces the back of the open model, as a foldable's cover display does. */
  rear?: true;
  /** The texture that the scene paints, with the glass's aspect ratio. */
  texture: { width: number; height: number };
}

/** The hinge of a foldable. Its left leaf stays still in the GLB, and its right leaf moves. */
export interface DeviceModelHinge {
  /** The calculated bending for the flexible meshes. */
  bend: "duo" | "pixel";
  /** The leaf that holds the cover display, named as in the GLB. */
  left: string;
  /** The leaf that the GLB's hinge animation moves. */
  right: string;
}

export interface DeviceModelDescription {
  id: DeviceModelId;
  /** The name that the preview announces. */
  name: string;
  /**
   * `main` is a phone's display or a foldable's inner display; `cover` is the
   * display outside a foldable. The scene keeps serve-sim's panel IDs for them.
   */
  displays: { main: DeviceModelDisplay; cover?: DeviceModelDisplay };
  hinge?: DeviceModelHinge;
  /**
   * The materials of the black glass around the displays, named as in the GLB.
   * The scene lowers their reflection, so they stay near the stream's black.
   */
  bezelMaterials?: readonly string[];
  /**
   * The matte black materials around the displays, such as a rubber seal, named
   * as in the GLB. The rig lowers their reflectance, of the lights and of the
   * room, so they stay as near the stream's black as a glass bezel.
   */
  matteBorderMaterials?: readonly string[];
  /**
   * How the client streams the device: each display on its own (`client.displays`,
   * the iPhone Duo on serve-sim), or one flat screen that shows the active display.
   */
  streams: "displays" | "screen";
}

/** The scene's panel for each model display. */
export const MODEL_DISPLAY_PANEL = { cover: 1, main: 3 } as const satisfies Record<
  keyof DeviceModelDescription["displays"],
  DuoPanelId
>;

// @ref LLP 0004#3d-preview-in-the-hub — Expo's models replace Xcode's; each GLB's node names are recorded here
export const DEVICE_MODELS: Readonly<Record<DeviceModelId, DeviceModelDescription>> = {
  "ios:iphone-duo": {
    id: "ios:iphone-duo",
    name: "iPhone Duo",
    displays: {
      // DeviceKit's framebuffers; the textures keep the sizes the Xcode model used.
      main: {
        nodes: ["FLEX • continuous inner OLED"],
        size: { width: 2007, height: 2853 },
        mount: 1,
        texture: { width: 1600, height: 1125 },
      },
      cover: {
        nodes: ["L • outer display active surface"],
        size: { width: 1398, height: 2034 },
        mount: 0,
        rear: true,
        texture: { width: 784, height: 1140 },
      },
    },
    hinge: { bend: "duo", left: "Leaf L • outer display", right: "Leaf R • rear cameras" },
    // The inner display's seal, and the cover display's rim. The GLB also uses
    // them for recesses: gaskets, camera barrels, the speaker and microphone
    // cavities, and the inside of the USB-C port, which turn from gray to black.
    matteBorderMaterials: [
      "Elastomer • graphite perimeter seal",
      "Optical barrel • anodized black",
    ],
    streams: "displays",
  },
  "ios:iphone-18-pro": {
    id: "ios:iphone-18-pro",
    name: "iPhone 18 Pro",
    displays: {
      main: {
        nodes: ["Front • active display"],
        size: { width: 1206, height: 2622 },
        mount: 0,
        texture: { width: 736, height: 1600 },
      },
    },
    bezelMaterials: ["Front • glossy black ceramic"],
    streams: "screen",
  },
  "android:pixel-9-pro": {
    id: "android:pixel-9-pro",
    name: "Pixel 9 Pro",
    displays: {
      main: {
        nodes: ["Front • active OLED display"],
        size: { width: 1280, height: 2856 },
        mount: 0,
        texture: { width: 717, height: 1600 },
      },
    },
    bezelMaterials: ["Display • glossy black border"],
    streams: "screen",
  },
  "android:pixel-9-pro-fold": {
    id: "android:pixel-9-pro-fold",
    name: "Pixel 9 Pro Fold",
    displays: {
      // The emulator's display regions: unfolded, and the cover while folded.
      main: {
        nodes: [
          "L • continuous inner OLED left",
          "FLEX • continuous inner OLED bridge",
          "R • continuous inner OLED right",
        ],
        size: { width: 2076, height: 2152 },
        mount: 0,
        texture: { width: 1544, height: 1600 },
      },
      cover: {
        nodes: ["L • outer active display"],
        size: { width: 1080, height: 2424 },
        mount: 0,
        rear: true,
        texture: { width: 713, height: 1600 },
      },
    },
    hinge: {
      bend: "pixel",
      left: "L • stationary cover-display leaf",
      right: "R • moving rear-camera leaf",
    },
    bezelMaterials: ["Black • glossy display bezel"],
    streams: "screen",
  },
};

/** The model description for an id, or null for a device without a model. */
export function deviceModelFor(
  id: DeviceModelId | null | undefined,
): DeviceModelDescription | null {
  // An id from outside the types, such as "constructor", is no model.
  return id && Object.hasOwn(DEVICE_MODELS, id) ? DEVICE_MODELS[id] : null;
}

// The hardware model names of each 3D model, as `@expo/hub-client/shapes` takes
// them: simulator device type names on iOS, AVD hardware profile ids on Android.
const IOS_MODEL_IDS: Readonly<Record<string, DeviceModelId>> = {
  "iphone duo": "ios:iphone-duo",
  "iphone 18 pro": "ios:iphone-18-pro",
};
const ANDROID_MODEL_IDS: Readonly<Record<string, DeviceModelId>> = {
  pixel_9_pro: "android:pixel-9-pro",
  pixel_9_pro_fold: "android:pixel-9-pro-fold",
};

/** Names the hardware of a device, as {@link resolveDeviceModel} takes it. */
export interface DeviceModelQuery {
  platform: DevicePlatform;
  /**
   * The exact hardware model: the simulator device type name on iOS, such as
   * `"iPhone Duo"`, or the AVD hardware profile id on Android, such as
   * `"pixel_9_pro_fold"`. An iOS name matches without case and surrounding
   * spaces; an Android id matches exactly.
   */
  model: string | null | undefined;
}

// @ref LLP 0019#model-names — the same hardware names as the screen shapes, so one name picks both
/**
 * The 3D model of a device's exact hardware model, or null when the preview
 * has none. It takes the names that `resolveScreenShape` takes.
 */
export function resolveDeviceModel({
  platform,
  model,
}: DeviceModelQuery): DeviceModelDescription | null {
  if (!model) return null;
  const ids = platform === "ios" ? IOS_MODEL_IDS : ANDROID_MODEL_IDS;
  const name = platform === "ios" ? model.trim().toLowerCase() : model;
  return Object.hasOwn(ids, name) ? deviceModelFor(ids[name]) : null;
}

/** The model display that a panel names. */
export function modelDisplay(
  model: DeviceModelDescription,
  panel: DuoPanelId,
): DeviceModelDisplay | undefined {
  return panel === MODEL_DISPLAY_PANEL.cover ? model.displays.cover : model.displays.main;
}

/** A device as a list reports it: the id of its 3D model, when it has one. */
export interface DeviceModelDevice {
  deviceModel?: DeviceModelId | null;
}

/**
 * Whether `client` streams what `model` needs. The iPhone Duo needs its fold
 * state and both displays, the cover and the inner one; a model that shows the
 * flat screen needs nothing more.
 */
export function deviceModelStreamable(
  model: Pick<DeviceModelDescription, "streams">,
  client: Pick<DeviceClient, "fold" | "displays"> | null | undefined,
): boolean {
  if (!client) return false;
  if (model.streams !== "displays") return true;
  // A panel without its display would have no frame to show.
  const displays = new Set(client.displays?.map((display) => display.id));
  return !!client.fold && displays.has("cover") && displays.has("inner");
}

/**
 * The model and its URL when the 3D preview can show `device` on `client`: the
 * device has a model, the consumer has its file, and the client streams what
 * the model needs.
 */
export function deviceModelPreview(
  device: DeviceModelDevice | null | undefined,
  client: Pick<DeviceClient, "fold" | "displays"> | null | undefined,
  assets: DeviceModelAssets | undefined,
): { model: DeviceModelDescription; url: string } | null {
  const model = deviceModelFor(device?.deviceModel);
  const url = model ? assets?.[model.id] : undefined;
  if (!model || !url || !deviceModelStreamable(model, client)) return null;
  return { model, url };
}
