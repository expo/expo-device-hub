/**
 * The screen shapes of known device models, and the lookup from a model name.
 * Corners were measured from Apple's and Google's device frame artwork with
 * https://github.com/krystofwoldrich-agent/device-screen-shape-editor.
 */

import { type DeviceDisplayId, type DevicePlatform, type ScreenSize } from "../types";
import { type ScreenShape, uniformScreenShape as uniform } from "./screen-shape";

// The hinge is on the left, so the iPhone Duo cover display has small left corners.
const DuoCoverLeft = { n: 2.45, size: 9.57 };
const DuoCoverRight = { n: 2.51, size: 70.55 };

/**
 * One shape per screen, in points, shared by every model with that screen.
 * Each comment names the simulators that the corners were measured on.
 */
const IosScreenShapes = {
  // iPhone 16 Pro.
  iPhone16Pro: uniform(402, 874, { n: 2.59, size: 77.43 }),
  // iPhone 16 Pro Max.
  iPhone16ProMax: uniform(440, 956, { n: 2.56, size: 76.62 }),
  // iPhone Air.
  iPhoneAir: uniform(420, 912, { n: 2.61, size: 78.2 }),
  // iPhone 16.
  iPhone14Pro: uniform(393, 852, { n: 2.61, size: 68.97 }),
  // iPhone 16 Plus.
  iPhone14ProMax: uniform(430, 932, { n: 2.66, size: 69.98 }),
  // iPhone 12 Pro and iPhone 14.
  iPhone12: uniform(390, 844, { n: 2.71, size: 61.21 }),
  // iPhone 12 Pro Max and iPhone 14 Plus.
  iPhone12ProMax: uniform(428, 926, { n: 2.66, size: 67.54 }),
  // iPhone 12 mini (scaled) and iPhone 13 mini.
  iPhone12Mini: uniform(360, 780, { n: 2.73, size: 54.71 }),
  // iPhone 11 Pro.
  iPhoneX: uniform(375, 812, { n: 2.43, size: 45.67 }),
  // iPhone 11 Pro Max.
  iPhoneXsMax: uniform(414, 896, { n: 2.46, size: 46.2 }),
  // iPhone 11.
  iPhoneXR: uniform(414, 896, { n: 2.5, size: 49.98 }),
  // iPhone Duo cover display, which shows while the device is closed.
  iPhoneDuoCover: {
    width: 466,
    height: 678,
    topLeft: DuoCoverLeft,
    topRight: DuoCoverRight,
    bottomRight: DuoCoverRight,
    bottomLeft: DuoCoverLeft,
  },
  // iPhone Duo inner display, which shows while the device is open.
  iPhoneDuoInner: uniform(669, 951, { n: 2.52, size: 65.28 }),
  // iPad mini (A17 Pro).
  iPadMini6thGen: uniform(744, 1133, { n: 2.52, size: 26.28 }),
  // iPad (A16).
  iPad10thGen: uniform(820, 1180, { n: 2.22, size: 26.75 }),
  // iPad Air 11-inch (M4).
  iPadAir4thGen: uniform(820, 1180, { n: 2.28, size: 20.25 }),
  // iPad Pro 11-inch (M5).
  iPadPro11M4: uniform(834, 1210, { n: 2.22, size: 32.33 }),
  // iPad Pro 13-inch (M5).
  iPadPro13M4: uniform(1032, 1376, { n: 2.18, size: 31.68 }),
  // iPad Air 13-inch (M4).
  iPadPro129Gen3: uniform(1024, 1366, { n: 2.14, size: 19 }),
  // iPad Pro 11-inch (2018), from an Internet Archive copy.
  iPadPro11Gen1: uniform(834, 1194, { n: 2.4, size: 21.4 }),
} as const satisfies Record<string, ScreenShape>;

/** One shape per Android emulator screen, in density-independent pixels. */
const AndroidScreenShapes = {
  // Pixel 9.
  pixel9: uniform(411.43, 923.43, { n: 2.4, size: 64.06 }),
  // Pixel 9 Pro.
  pixel9Pro: uniform(426.67, 952, { n: 2.35, size: 67.11 }),
  // Pixel 9 Pro XL.
  pixel9ProXL: uniform(448, 997.33, { n: 2.32, size: 64.54 }),
  // Pixel 9a.
  pixel9a: uniform(411.43, 923.43, { n: 2, size: 55.23 }),
  // Pixel 9 Pro Fold, closed: the cover display.
  pixel9ProFoldCover: uniform(411.43, 923.43, { n: 2.3, size: 62.42 }),
  // Pixel 9 Pro Fold, open: the inner display.
  pixel9ProFoldInner: uniform(851.69, 882.87, { n: 2.22, size: 52.72 }),
  // Pixel 10, and the Pixel 10a with the same screen.
  pixel10: uniform(411.43, 923.43, { n: 2, size: 55.62 }),
  // Pixel 10 Pro.
  pixel10Pro: uniform(426.67, 952, { n: 2, size: 59.64 }),
  // Pixel 10 Pro XL.
  pixel10ProXL: uniform(448, 997.33, { n: 2.02, size: 60.64 }),
  // Pixel 10 Pro Fold, closed: the cover display.
  pixel10ProFoldCover: uniform(411.43, 900.57, { n: 2, size: 49.14 }),
  // Pixel 10 Pro Fold, open: the inner display.
  pixel10ProFoldInner: uniform(851.69, 882.87, { n: 2, size: 53.74 }),
} as const satisfies Record<string, ScreenShape>;

/**
 * Every known screen shape by name. A name is the first model with that
 * screen, such as `iPhone16Pro` for the iPhone 16 Pro, 17, 17 Pro and 18 Pro.
 * Use it to pick a shape by hand, for example in a debug menu; use
 * {@link resolveScreenShape} to look one up from a device model.
 */
export const SCREEN_SHAPES: Readonly<
  Record<keyof typeof IosScreenShapes | keyof typeof AndroidScreenShapes, ScreenShape>
> = { ...IosScreenShapes, ...AndroidScreenShapes };

/** The name of a shape in {@link SCREEN_SHAPES}. */
export type ScreenShapeName = keyof typeof SCREEN_SHAPES;

/**
 * The models that share each screen shape, by their exact simulator device type
 * names from `xcrun simctl list devicetypes`. The iPhone Duo has two displays,
 * so it has no single shape here.
 */
const IosScreenShapeModels: Record<
  Exclude<keyof typeof IosScreenShapes, "iPhoneDuoCover" | "iPhoneDuoInner">,
  readonly string[]
> = {
  iPhone16Pro: ["iPhone 16 Pro", "iPhone 17", "iPhone 17 Pro", "iPhone 18 Pro"],
  iPhone16ProMax: ["iPhone 16 Pro Max", "iPhone 17 Pro Max", "iPhone 18 Pro Max"],
  iPhoneAir: ["iPhone Air"],
  iPhone14Pro: ["iPhone 14 Pro", "iPhone 15", "iPhone 15 Pro", "iPhone 16"],
  iPhone14ProMax: ["iPhone 14 Pro Max", "iPhone 15 Plus", "iPhone 15 Pro Max", "iPhone 16 Plus"],
  iPhone12: [
    "iPhone 12",
    "iPhone 12 Pro",
    "iPhone 13",
    "iPhone 13 Pro",
    "iPhone 14",
    "iPhone 16e",
    "iPhone 17e",
  ],
  iPhone12ProMax: ["iPhone 12 Pro Max", "iPhone 13 Pro Max", "iPhone 14 Plus"],
  iPhone12Mini: ["iPhone 12 mini", "iPhone 13 mini"],
  iPhoneX: ["iPhone X", "iPhone Xs", "iPhone 11 Pro"],
  iPhoneXsMax: ["iPhone Xs Max", "iPhone 11 Pro Max"],
  // The simulator names the iPhone XR with a small capital R.
  iPhoneXR: ["iPhone Xʀ", "iPhone 11"],
  iPadMini6thGen: ["iPad mini (6th generation)", "iPad mini (A17 Pro)"],
  iPad10thGen: ["iPad (10th generation)", "iPad (A16)"],
  iPadAir4thGen: [
    "iPad Air (4th generation)",
    "iPad Air (5th generation)",
    "iPad Air 11-inch (M2)",
    "iPad Air 11-inch (M3)",
    "iPad Air 11-inch (M4)",
  ],
  iPadPro11M4: [
    "iPad Pro 11-inch (M4)",
    "iPad Pro 11-inch (M4) (16GB)",
    "iPad Pro 11-inch (M5)",
    "iPad Pro 11-inch (M5) (16GB)",
  ],
  iPadPro13M4: [
    "iPad Pro 13-inch (M4)",
    "iPad Pro 13-inch (M4) (16GB)",
    "iPad Pro 13-inch (M5)",
    "iPad Pro 13-inch (M5) (16GB)",
  ],
  iPadPro129Gen3: [
    "iPad Pro (12.9-inch) (3rd generation)",
    "iPad Pro (12.9-inch) (4th generation)",
    "iPad Pro (12.9-inch) (5th generation)",
    "iPad Pro (12.9-inch) (6th generation)",
    "iPad Pro (12.9-inch) (6th generation) (16GB)",
    "iPad Air 13-inch (M2)",
    "iPad Air 13-inch (M3)",
    "iPad Air 13-inch (M4)",
  ],
  iPadPro11Gen1: [
    "iPad Pro (11-inch) (1st generation)",
    "iPad Pro (11-inch) (2nd generation)",
    "iPad Pro (11-inch) (3rd generation)",
    "iPad Pro (11-inch) (4th generation)",
    "iPad Pro (11-inch) (4th generation) (16GB)",
  ],
};

/**
 * The screen shapes of one device model: one shape, or one shape per display
 * for a device with several displays, such as the iPhone Duo. `initialDisplay`
 * is the display a new session shows first.
 */
type DeviceScreenShapes =
  | ScreenShape
  | {
      readonly displays: Readonly<Partial<Record<DeviceDisplayId, ScreenShape>>>;
      readonly initialDisplay: DeviceDisplayId;
    };

function hasDisplays(
  shapes: DeviceScreenShapes,
): shapes is Exclude<DeviceScreenShapes, ScreenShape> {
  return "displays" in shapes;
}

/** iOS models with a shape per display, by their simctl device type names. */
const IosDisplayScreenShapeModels: readonly {
  models: readonly string[];
  shapes: DeviceScreenShapes;
}[] = [
  {
    models: ["iPhone Duo"],
    shapes: {
      displays: { cover: IosScreenShapes.iPhoneDuoCover, inner: IosScreenShapes.iPhoneDuoInner },
      // A new iPhone Duo session starts closed, on the cover display.
      initialDisplay: "cover",
    },
  },
];

const IosShapesByModel = new Map<string, DeviceScreenShapes>([
  ...(Object.keys(IosScreenShapeModels) as (keyof typeof IosScreenShapeModels)[]).flatMap((name) =>
    IosScreenShapeModels[name].map(
      (model) => [model.toLowerCase(), IosScreenShapes[name]] as const,
    ),
  ),
  ...IosDisplayScreenShapeModels.flatMap(({ models, shapes }) =>
    models.map((model) => [model.toLowerCase(), shapes] as const),
  ),
]);

/**
 * The emulators of each Android screen shape, by their AVD hardware profile ids
 * from `avdmanager list device` (an AVD's `hw.device.name`). The Pro Folds have
 * two displays, so they have no single shape here.
 */
const AndroidScreenShapeModels: Record<
  Exclude<
    keyof typeof AndroidScreenShapes,
    "pixel9ProFoldCover" | "pixel9ProFoldInner" | "pixel10ProFoldCover" | "pixel10ProFoldInner"
  >,
  readonly string[]
> = {
  pixel9: ["pixel_9"],
  pixel9Pro: ["pixel_9_pro"],
  pixel9ProXL: ["pixel_9_pro_xl"],
  pixel9a: ["pixel_9a"],
  pixel10: ["pixel_10", "pixel_10a"],
  pixel10Pro: ["pixel_10_pro"],
  pixel10ProXL: ["pixel_10_pro_xl"],
};

/** Android models with a shape per display, by their AVD hardware profile ids. */
const AndroidDisplayScreenShapeModels: readonly {
  models: readonly string[];
  shapes: DeviceScreenShapes;
}[] = [
  {
    models: ["pixel_9_pro_fold"],
    shapes: {
      displays: {
        cover: AndroidScreenShapes.pixel9ProFoldCover,
        inner: AndroidScreenShapes.pixel9ProFoldInner,
      },
      // The AVD profile starts with the hinge at 180°, open on the inner display.
      initialDisplay: "inner",
    },
  },
  {
    models: ["pixel_10_pro_fold"],
    shapes: {
      displays: {
        cover: AndroidScreenShapes.pixel10ProFoldCover,
        inner: AndroidScreenShapes.pixel10ProFoldInner,
      },
      initialDisplay: "inner",
    },
  },
];

const AndroidShapesByModel = new Map<string, DeviceScreenShapes>([
  ...(Object.keys(AndroidScreenShapeModels) as (keyof typeof AndroidScreenShapeModels)[]).flatMap(
    (name) =>
      AndroidScreenShapeModels[name].map((model) => [model, AndroidScreenShapes[name]] as const),
  ),
  ...AndroidDisplayScreenShapeModels.flatMap(({ models, shapes }) =>
    models.map((model) => [model, shapes] as const),
  ),
]);

/** The shapes of a model: an iOS name matches without case and surrounding spaces, an Android id exactly. */
function deviceScreenShapes(
  platform: DevicePlatform,
  model: string | null | undefined,
): DeviceScreenShapes | null {
  if (!model) return null;
  return (
    (platform === "android"
      ? AndroidShapesByModel.get(model)
      : IosShapesByModel.get(model.trim().toLowerCase())) ?? null
  );
}

/** A device model to look up a screen shape for. */
export interface ScreenShapeQuery {
  platform: DevicePlatform;
  /**
   * The device model: an iOS simulator's device type name, such as
   * `"iPhone 17 Pro"`, or an Android emulator's AVD hardware profile id, such
   * as `"pixel_9_pro"`. An iOS name matches without case and surrounding
   * spaces; an Android id matches exactly.
   */
  model: string | null | undefined;
  /**
   * The display of a device with a shape per display, such as the iPhone Duo.
   * Other devices ignore it.
   */
  display?: DeviceDisplayId;
  /**
   * The streamed screen size, which picks the display when `display` is not
   * known: the display whose aspect ratio is closest, in either orientation.
   * Without both, a device shows the display that a new session starts on:
   * the cover display for the iPhone Duo, the inner display for a Pixel Pro Fold.
   */
  screen?: Pick<ScreenSize, "width" | "height"> | null;
}

/** The display whose proportions are closest to the screen's, in either orientation. */
function nearestDisplay(
  displays: Readonly<Partial<Record<DeviceDisplayId, ScreenShape>>>,
  { width, height }: Pick<ScreenSize, "width" | "height">,
): DeviceDisplayId | undefined {
  const aspect = Math.min(width, height) / Math.max(width, height);
  let nearest: DeviceDisplayId | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [display, shape] of Object.entries(displays) as [DeviceDisplayId, ScreenShape][]) {
    const distance = Math.abs(
      Math.min(shape.width, shape.height) / Math.max(shape.width, shape.height) - aspect,
    );
    if (distance < nearestDistance) {
      nearest = display;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// @ref LLP 0017#model-names — the exact simctl and AVD profile names, not the reported device name
/** The portrait screen shape of a device model, or null when the model is unknown. */
export function resolveScreenShape({
  platform,
  model,
  display,
  screen,
}: ScreenShapeQuery): ScreenShape | null {
  const shapes = deviceScreenShapes(platform, model);
  if (!shapes || !hasDisplays(shapes)) return shapes;
  const { displays, initialDisplay } = shapes;
  const shown =
    (display && displays[display] ? display : undefined) ??
    (screen && screen.width > 0 && screen.height > 0
      ? nearestDisplay(displays, screen)
      : undefined) ??
    initialDisplay;
  return displays[shown] ?? displays[initialDisplay] ?? null;
}

/**
 * Whether a model has a shape per display, such as the iPhone Duo, so that its
 * shape follows the display it shows.
 */
export function hasDisplayScreenShapes({
  platform,
  model,
}: Pick<ScreenShapeQuery, "platform" | "model">): boolean {
  const shapes = deviceScreenShapes(platform, model);
  return !!shapes && hasDisplays(shapes);
}
