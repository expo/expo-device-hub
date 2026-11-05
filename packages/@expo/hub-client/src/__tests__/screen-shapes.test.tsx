import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  DeviceShape,
  hasDisplayScreenShapes,
  interpolateScreenShapeGeometry,
  resolveScreenShape,
  rotateScreenShape,
  SCREEN_SHAPES,
  type ScreenShapeClient,
  screenShapeClipPath,
  screenShapeGeometry,
  screenShapeGeometryClipPath,
  screenShapeOrientation,
  uniformScreenShape,
} from "../shapes";
import { type ScreenSize } from "../types";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

describe("resolveScreenShape", () => {
  test("finds an iOS model by its simctl device type name, without case and surrounding spaces", () => {
    expect(resolveScreenShape({ platform: "ios", model: "iPhone 17 Pro" })).toBe(
      SCREEN_SHAPES.iPhone16Pro,
    );
    expect(resolveScreenShape({ platform: "ios", model: "  iphone 17 pro " })).toBe(
      SCREEN_SHAPES.iPhone16Pro,
    );
    // The simulator names the iPhone XR with a small capital R; "XR" names no simctl type.
    expect(resolveScreenShape({ platform: "ios", model: "iPhone Xʀ" })).toBe(
      SCREEN_SHAPES.iPhoneXR,
    );
    expect(resolveScreenShape({ platform: "ios", model: "iPhone XR" })).toBeNull();
  });

  test("finds an Android emulator only by its exact AVD hardware profile id", () => {
    expect(resolveScreenShape({ platform: "android", model: "pixel_9_pro" })).toBe(
      SCREEN_SHAPES.pixel9Pro,
    );
    expect(resolveScreenShape({ platform: "android", model: "Pixel 9 Pro" })).toBeNull();
    expect(resolveScreenShape({ platform: "android", model: "emulator-5554" })).toBeNull();
  });

  test("gives no shape to an unknown, generic, or missing model, or to the other platform", () => {
    expect(resolveScreenShape({ platform: "ios", model: "iPhone Simulator" })).toBeNull();
    expect(resolveScreenShape({ platform: "ios", model: "iPhone SE (3rd generation)" })).toBeNull();
    expect(resolveScreenShape({ platform: "ios", model: null })).toBeNull();
    expect(resolveScreenShape({ platform: "ios", model: "pixel_9" })).toBeNull();
    expect(resolveScreenShape({ platform: "android", model: "iPhone 17 Pro" })).toBeNull();
  });

  test("picks the iPhone Duo display from the stream size when no display is reported", () => {
    const duo = { platform: "ios", model: "iPhone Duo" } as const;
    // The serve-sim streams of the cover and the inner display, in either orientation.
    expect(resolveScreenShape({ ...duo, screen: { width: 1398, height: 2034 } })).toBe(
      SCREEN_SHAPES.iPhoneDuoCover,
    );
    expect(resolveScreenShape({ ...duo, screen: { width: 2007, height: 2853 } })).toBe(
      SCREEN_SHAPES.iPhoneDuoInner,
    );
    expect(resolveScreenShape({ ...duo, screen: { width: 2853, height: 2007 } })).toBe(
      SCREEN_SHAPES.iPhoneDuoInner,
    );
    // A reported display wins over the size, and an empty size does not count.
    expect(
      resolveScreenShape({ ...duo, display: "cover", screen: { width: 2007, height: 2853 } }),
    ).toBe(SCREEN_SHAPES.iPhoneDuoCover);
    expect(resolveScreenShape({ ...duo, screen: { width: 0, height: 0 } })).toBe(
      SCREEN_SHAPES.iPhoneDuoCover,
    );
  });

  test("picks the iPhone Duo display, and the cover display until one is known", () => {
    const duo = { platform: "ios", model: "iPhone Duo" } as const;
    expect(resolveScreenShape(duo)).toBe(SCREEN_SHAPES.iPhoneDuoCover);
    expect(resolveScreenShape({ ...duo, display: "cover" })).toBe(SCREEN_SHAPES.iPhoneDuoCover);
    expect(resolveScreenShape({ ...duo, display: "inner" })).toBe(SCREEN_SHAPES.iPhoneDuoInner);
    expect(hasDisplayScreenShapes(duo)).toBe(true);
    expect(hasDisplayScreenShapes({ platform: "ios", model: "iPhone 17 Pro" })).toBe(false);
    // A single-display device ignores the display.
    expect(resolveScreenShape({ platform: "ios", model: "iPhone 17 Pro", display: "inner" })).toBe(
      SCREEN_SHAPES.iPhone16Pro,
    );
  });
});

describe("rotation", () => {
  const cover = SCREEN_SHAPES.iPhoneDuoCover;

  test("moves each corner one step clockwise on a landscape-left device", () => {
    const rotated = rotateScreenShape(cover, "landscape_left");
    expect([rotated.width, rotated.height]).toEqual([cover.height, cover.width]);
    expect(rotated.topLeft).toBe(cover.bottomLeft);
    expect(rotated.topRight).toBe(cover.topLeft);
    expect(rotated.bottomRight).toBe(cover.topRight);
    expect(rotated.bottomLeft).toBe(cover.bottomRight);
  });

  test("moves each corner one step counterclockwise on a landscape-right device", () => {
    const rotated = rotateScreenShape(cover, "landscape_right");
    expect(rotated.topLeft).toBe(cover.topRight);
    expect(rotated.bottomLeft).toBe(cover.topLeft);
  });

  test("swaps opposite corners upside down and keeps the size", () => {
    const rotated = rotateScreenShape(cover, "portrait_upside_down");
    expect([rotated.width, rotated.height]).toEqual([cover.width, cover.height]);
    expect(rotated.topLeft).toBe(cover.bottomRight);
  });

  test("returns the same object for the same shape and orientation, so clip paths stay cached", () => {
    expect(rotateScreenShape(cover, "portrait")).toBe(cover);
    expect(rotateScreenShape(cover, "landscape_left")).toBe(
      rotateScreenShape(cover, "landscape_left"),
    );
  });

  test("counts a landscape frame as a sideways device, also when it reports upright", () => {
    expect(screenShapeOrientation(null)).toBe("portrait");
    expect(screenShapeOrientation({ width: 400, height: 800 })).toBe("portrait");
    expect(screenShapeOrientation({ width: 800, height: 400 })).toBe("landscape_left");
    expect(screenShapeOrientation({ width: 800, height: 400, orientation: "portrait" })).toBe(
      "landscape_left",
    );
    expect(
      screenShapeOrientation({ width: 800, height: 400, orientation: "landscape_right" }),
    ).toBe("landscape_right");
    expect(
      screenShapeOrientation({ width: 400, height: 800, orientation: "portrait_upside_down" }),
    ).toBe("portrait_upside_down");
  });
});

describe("clip path", () => {
  const square = uniformScreenShape(100, 100, { n: 2, size: 50 });

  function points(clipPath: string) {
    return clipPath.replace(/^polygon\(|\)$/g, "").split(", ");
  }

  test("draws each corner curve from edge to edge, clockwise from the top left", () => {
    const path = points(screenShapeClipPath(square));
    // 19 samples per corner.
    expect(path).toHaveLength(76);
    // The top-left curve starts on the left edge, halfway down, and ends on the top edge.
    expect(path[0]).toBe("0% 50%");
    expect(path[18]).toBe("50% 0%");
    expect(path[19]).toBe("50% 0%");
    expect(path[37]).toBe("100% 50%");
  });

  test("sizes corners by the element's short side, so a wider element keeps round corners", () => {
    const path = points(screenShapeClipPath(square, { aspectRatio: 2 }));
    // The corner spans half of the 1-high side, which is a quarter of the 2-wide side.
    expect(path[0]).toBe("0% 50%");
    expect(path[18]).toBe("25% 0%");
  });

  test("moves every point in by the inset", () => {
    const path = points(screenShapeClipPath(square, { insetPx: 1 }));
    expect(path[0]).toBe("calc(0% + 1px) calc(50% + 1px)");
    expect(path[37]).toBe("calc(100% + -1px) calc(50% + 1px)");
  });

  test("returns the cached string for the same shape and options", () => {
    const shape = SCREEN_SHAPES.pixel9;
    expect(screenShapeClipPath(shape, { aspectRatio: 0.45, insetPx: 1 })).toBe(
      screenShapeClipPath(shape, { aspectRatio: 0.45, insetPx: 1 }),
    );
  });

  test("blends two geometries, and a whole blend draws the target", () => {
    const from = screenShapeGeometry(SCREEN_SHAPES.iPhoneDuoCover, undefined, 0.5);
    const to = screenShapeGeometry(SCREEN_SHAPES.iPhoneDuoInner);
    const half = interpolateScreenShapeGeometry(from, to, 0.5);
    expect(half.insetPx).toBe(0.25);
    expect(half.corners[0].n).toBeCloseTo((2.45 + 2.52) / 2);
    expect(screenShapeGeometryClipPath(interpolateScreenShapeGeometry(from, to, 1), 0.7)).toBe(
      screenShapeGeometryClipPath(to, 0.7),
    );
  });
});

describe("DeviceShape", () => {
  function client(screen: ScreenSize | null, name = "iPhone 17 Pro"): ScreenShapeClient {
    return {
      platform: "ios",
      screen,
      devices: [{ id: "udid", name, platform: "ios", current: true }],
    };
  }

  function clipPathOf(root: ReactTestRenderer) {
    return root.root.findByType("div").props.style?.clipPath as string | undefined;
  }

  async function render(element: React.ReactElement) {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(element);
    });
    return renderer!;
  }

  test("clips its children to the client's device and keeps its own props", async () => {
    const root = await render(
      <DeviceShape
        client={client({ width: 1206, height: 2622 })}
        className="screen"
        style={{ position: "absolute" }}
      >
        <span />
      </DeviceShape>,
    );
    const div = root.root.findByType("div");
    expect(div.props.className).toBe("screen");
    expect(div.props.style.position).toBe("absolute");
    expect(div.props["data-screen-shape"]).toBe("device");
    expect(clipPathOf(root)).toBe(screenShapeClipPath(SCREEN_SHAPES.iPhone16Pro));
    expect(div.findByType("span")).toBeTruthy();
  });

  test("follows the iPhone Duo display and orientation, and keeps them while the screen is gone", async () => {
    const duo = (screen: ScreenSize | null) => client(screen, "iPhone Duo");
    const root = await render(
      <DeviceShape client={duo({ width: 466, height: 678, display: "cover" })} />,
    );
    expect(clipPathOf(root)).toBe(screenShapeClipPath(SCREEN_SHAPES.iPhoneDuoCover));

    const open = {
      width: 951,
      height: 669,
      orientation: "landscape_left",
      display: "inner",
    } as const;
    await act(async () => root.update(<DeviceShape client={duo(open)} />));
    const inner = rotateScreenShape(SCREEN_SHAPES.iPhoneDuoInner, "landscape_left");
    expect(clipPathOf(root)).toBe(screenShapeClipPath(inner));

    await act(async () => root.update(<DeviceShape client={duo(null)} />));
    expect(clipPathOf(root)).toBe(screenShapeClipPath(inner));
  });

  test("keeps the last screen only for the same device, and starts over without a client", async () => {
    const duo = (screen: ScreenSize | null, id = "duo-1"): ScreenShapeClient => ({
      platform: "ios",
      screen,
      devices: [{ id, name: "iPhone Duo", platform: "ios", current: true }],
    });
    const open = {
      width: 951,
      height: 669,
      orientation: "landscape_left",
      display: "inner",
    } as const;
    const inner = screenShapeClipPath(
      rotateScreenShape(SCREEN_SHAPES.iPhoneDuoInner, "landscape_left"),
    );
    const cover = screenShapeClipPath(SCREEN_SHAPES.iPhoneDuoCover);
    const root = await render(<DeviceShape client={duo(open)} />);
    expect(clipPathOf(root)).toBe(inner);

    // Another device starts from its own screen, or from the defaults while it has none.
    await act(async () => root.update(<DeviceShape client={duo(null, "duo-2")} />));
    expect(clipPathOf(root)).toBe(cover);

    await act(async () => root.update(<DeviceShape client={duo(open, "duo-2")} />));
    expect(clipPathOf(root)).toBe(inner);
    // Without a client, the props alone pick the shape.
    await act(async () => root.update(<DeviceShape platform="ios" model="iPhone Duo" />));
    expect(clipPathOf(root)).toBe(cover);
  });

  test("lets props override the client, and works without a client", async () => {
    const root = await render(
      <DeviceShape
        client={client({ width: 1206, height: 2622 })}
        model="pixel_9"
        platform="android"
        orientation="landscape_right"
        aspectRatio={2.2}
        insetPx={1}
      />,
    );
    expect(clipPathOf(root)).toBe(
      screenShapeClipPath(rotateScreenShape(SCREEN_SHAPES.pixel9, "landscape_right"), {
        aspectRatio: 2.2,
        insetPx: 1,
      }),
    );

    const custom = uniformScreenShape(300, 600, { n: 2, size: 30 });
    await act(async () => root.update(<DeviceShape shape={custom} />));
    expect(clipPathOf(root)).toBe(screenShapeClipPath(custom));
  });

  test("follows a screen-only client, such as useDeviceScreenClient's, with the model as a prop", async () => {
    const screenOnly: ScreenShapeClient = {
      screen: { width: 669, height: 951, display: "inner" },
    };
    const root = await render(
      <DeviceShape client={screenOnly} platform="ios" model="iPhone Duo" />,
    );
    expect(clipPathOf(root)).toBe(screenShapeClipPath(SCREEN_SHAPES.iPhoneDuoInner));
  });

  test("leaves an unknown model unclipped", async () => {
    const root = await render(
      <DeviceShape client={client(null, "iPhone Simulator")} style={{ inset: 0 }} />,
    );
    const div = root.root.findByType("div");
    expect(div.props.style).toEqual({ inset: 0 });
    expect(div.props["data-screen-shape"]).toBeUndefined();
  });
});

test("an app that imports only the main entry bundles no shape table or shape code", async () => {
  const entry = new URL("./fixtures/main-entry-only.ts", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entry],
    external: ["react", "react-dom", "react/jsx-runtime", "use-sync-external-store"],
    minify: false,
  });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  expect(output).toContain("DeviceScreen");
  for (const marker of ["iPhone 17 Pro", "pixel_9", "superellipse", "clipPath:"]) {
    expect(output).not.toContain(marker);
  }
});
