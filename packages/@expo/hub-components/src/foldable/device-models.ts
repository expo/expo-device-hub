/**
 * The device models that the 3D preview draws: which meshes of each model show
 * a display, how the display's framebuffer sits on that glass, and the hinge of
 * a foldable. The GLB files belong to the consumer, which passes each model's
 * URL. This module does not import three.js, so the Hub's frame can read it
 * without loading the scene.
 */

import { type DeviceClient } from "@expo/hub-client";

import { type Device, type DeviceModelId } from "../dashboard/data";
import { type DuoPanelId } from "./duo-displays";

/**
 * Consumer-owned model files: the URL of each model's GLB. The Hub bundles
 * them with its dashboard; another consumer hosts the same files. A model
 * without a URL keeps the flat preview.
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
    streams: "screen",
  },
};

/** The model description for an id, or null for a device without a model. */
export function deviceModelFor(
  id: DeviceModelId | null | undefined,
): DeviceModelDescription | null {
  return id ? (DEVICE_MODELS[id] ?? null) : null;
}

/** The model display that a panel names. */
export function modelDisplay(
  model: DeviceModelDescription,
  panel: DuoPanelId,
): DeviceModelDisplay | undefined {
  return panel === MODEL_DISPLAY_PANEL.cover ? model.displays.cover : model.displays.main;
}

/**
 * The model and its URL when the 3D preview can show `device` on `client`: the
 * device has a model, the consumer serves it, and the client streams what the
 * model needs. The iPhone Duo needs its fold state and both displays.
 */
export function deviceModelPreview(
  device: Pick<Device, "deviceModel"> | null | undefined,
  client: Pick<DeviceClient, "fold" | "displays"> | null | undefined,
  assets: DeviceModelAssets | undefined,
): { model: DeviceModelDescription; url: string } | null {
  const model = deviceModelFor(device?.deviceModel);
  const url = model ? assets?.[model.id] : undefined;
  if (!model || !url || !client) return null;
  if (model.streams === "displays" && (!client.fold || !client.displays)) return null;
  return { model, url };
}
