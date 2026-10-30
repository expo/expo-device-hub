import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DeviceKitChrome,
  deviceKitChromeAssetPath,
  deviceKitChromeForScreen,
  deviceKitChromeGeometry,
  getDeviceKitChromeAssets,
  type DeviceKitChromeDescriptor,
  type DeviceKitChromeProps,
  type DeviceKitChromeSlice,
} from "../index";

const browser = new Window();

afterEach(() => {
  browser.document.body.replaceChildren();
});

function chromeFixture(): DeviceKitChromeDescriptor {
  return {
    identifier: "phone-test",
    frame: { width: 400, height: 800 },
    body: { x: 10, y: 20, width: 380, height: 760 },
    screen: { x: 40, y: 80, width: 300, height: 600 },
    insets: { top: 60, left: 30, bottom: 100, right: 50 },
    outerCornerRadius: 20,
    innerCornerRadius: 12,
    screenRadius: 10,
    compositeImage: "Composite",
    slice: null,
    corner: null,
    buttons: [
      {
        name: "volume-up",
        image: "Volume",
        imageDown: "VolumeDown",
        onTop: false,
        frame: { x: 0, y: 100, width: 20, height: 60 },
        hover: { x: -0.1, y: 0 },
        usagePage: 12,
        usage: 233,
      },
    ],
  };
}

const slice: DeviceKitChromeSlice = {
  topLeft: "TL",
  top: "T",
  topRight: "TR",
  right: "R",
  bottomRight: "BR",
  bottom: "B",
  bottomLeft: "BL",
  left: "L",
};

function renderChrome(props: Partial<DeviceKitChromeProps> = {}) {
  browser.document.body.innerHTML = renderToStaticMarkup(
    <DeviceKitChrome
      chrome={chromeFixture()}
      resolveAssetUrl={(identifier, image) => `blob:https://preview.test/${identifier}/${image}`}
      screen={<canvas data-live-screen="" />}
      {...props}
    />,
  );
  return browser.document.body;
}

describe("public DeviceKitChrome renderer", () => {
  test("renders the actual bezel and live screen cutout without a host stylesheet", () => {
    const body = renderChrome({ containerSize: { width: 200, height: 400 } });
    const root = body.querySelector("div")!;
    const screen = body.querySelector('[data-devicekit-screen=""]')!;
    const back = body.querySelector('[data-devicekit-artwork="back"]')!;
    const bezel = body.querySelector('img[src$="/Composite"]')!;

    expect(root.getAttribute("style")).toContain("position:absolute");
    expect(root.getAttribute("style")).toContain("inset:0");
    expect(back.getAttribute("style")).toContain("position:absolute");
    expect(back.getAttribute("style")).toContain("z-index:1");
    expect(bezel.getAttribute("style")).toContain("position:absolute");
    expect(bezel.getAttribute("style")).toContain("object-fit:fill");
    expect(screen.getAttribute("style")).toContain("position:absolute");
    expect(screen.getAttribute("style")).toContain("overflow:hidden");
    expect(screen.getAttribute("style")).toContain("background");
    expect(screen.getAttribute("style")).toContain("pointer-events:auto");
    expect(screen.getAttribute("style")).toContain("z-index:2");
    expect(screen.getAttribute("style")).toContain("left:20px;top:40px;width:150px;height:300px");
    expect(screen.querySelector("canvas[data-live-screen]")).not.toBeNull();
    expect(body.querySelector("[class]")).toBeNull();
    expect(body.querySelector('style,link[rel="stylesheet"]')).toBeNull();
  });

  test("rotates the original asymmetric artwork while the live screen remains axis-aligned", () => {
    const body = renderChrome({
      orientation: "landscape_left",
      containerSize: { width: 400, height: 200 },
    });
    const screen = body.querySelector('[data-devicekit-screen=""]')!;
    const back = body.querySelector('[data-devicekit-artwork="back"]')!;
    const bezel = body.querySelector('img[src$="/Composite"]')!;

    expect(deviceKitChromeGeometry(chromeFixture(), "landscape_left")).toEqual({
      frame: { width: 800, height: 400 },
      screen: { x: 120, y: 40, width: 600, height: 300 },
    });
    expect(back.getAttribute("style")).toContain("rotate(90deg)");
    expect(bezel.getAttribute("style")).toContain("left:5px;top:10px;width:190px;height:380px");
    expect(screen.getAttribute("style")).toContain("left:60px;top:20px;width:300px;height:150px");
    expect(screen.getAttribute("style")).not.toContain("transform");
    expect(screen.querySelector("canvas[data-live-screen]")).not.toBeNull();
  });

  test("uses only resolved artwork URLs and keeps the live screen when assets are unavailable", () => {
    const requested: [string, string][] = [];
    const body = renderChrome({
      resolveAssetUrl: (identifier, image) => {
        requested.push([identifier, image]);
        return undefined;
      },
    });

    expect(requested).toContainEqual(["phone-test", "Composite"]);
    expect(requested).toContainEqual(["phone-test", "Volume"]);
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("canvas[data-live-screen]")).not.toBeNull();
    expect(body.innerHTML).not.toContain('src=""');
    expect(body.innerHTML).not.toContain("grid/api");
  });

  test("retains nine-slice chrome with self-contained positioning", () => {
    const body = renderChrome({
      chrome: {
        ...chromeFixture(),
        compositeImage: null,
        slice,
        corner: { width: 20, height: 20 },
        buttons: [],
      },
    });
    const images = [...body.querySelectorAll("img")];

    expect(images).toHaveLength(8);
    expect(images.map((image) => image.getAttribute("src")?.split("/").at(-1)).sort()).toEqual(
      Object.values(slice).sort(),
    );
    for (const image of images) {
      expect(image.getAttribute("style")).toContain("position:absolute");
      expect(image.getAttribute("style")).toContain("object-fit:fill");
      expect(image.getAttribute("style")).toContain("pointer-events:none");
    }
  });
});

describe("public DeviceKitChrome asset contract", () => {
  test("enumerates required sprites once across display variants, including pressed buttons", () => {
    const chrome = chromeFixture();
    chrome.slice = slice;
    chrome.corner = { width: 20, height: 20 };
    chrome.displayVariants = {
      1: { ...chromeFixture(), screenId: 1 },
      3: {
        ...chromeFixture(),
        identifier: "inner-test",
        screenId: 3,
        compositeImage: null,
        slice,
        corner: { width: 20, height: 20 },
      },
    };

    const assets = getDeviceKitChromeAssets(chrome);
    const keys = assets.map(({ identifier, image }) => `${identifier}/${image}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [
        "phone-test/Composite",
        "phone-test/Volume",
        "phone-test/VolumeDown",
        "inner-test/Volume",
        "inner-test/VolumeDown",
        ...Object.values(slice).map((image) => `inner-test/${image}`),
      ].sort(),
    );
    expect(deviceKitChromeForScreen(chrome, 3)).toBe(chrome.displayVariants[3]);
    expect(deviceKitChromeForScreen(chrome, 99)).toBe(chrome);
  });

  test("returns an encoded relative asset path without embedding an origin or credentials", () => {
    const path = deviceKitChromeAssetPath("phone & special", "Bezel + cap/#?.png");
    const url = new URL(path, "https://preview.test/vendor/serve-sim/");

    expect(url.origin).toBe("https://preview.test");
    expect(url.pathname).toBe("/vendor/serve-sim/grid/api/devicekit-chrome");
    expect(url.searchParams.get("chrome")).toBe("phone & special");
    expect(url.searchParams.get("image")).toBe("Bezel + cap/#?.png");
    expect(url.searchParams.get("v")).toBe("2");
    expect([...url.searchParams.keys()].sort()).toEqual(["chrome", "image", "v"]);
    expect(url.hash).toBe("");
  });
});
