import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceClient } from "@expo/hub-client";
import { StreamPanel } from "../dashboard/StreamPanel";

function render(width: number, visualHeight = 667) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: 667,
      visualViewport: { width, height: visualHeight, offsetLeft: 0, offsetTop: 0 },
      matchMedia: () => ({ matches: true }),
    },
  });
  try {
    return renderToStaticMarkup(
      <StreamPanel
        device={{
          id: "phone",
          name: "Test phone",
          platform: "ios",
          version: "iOS 26.5",
          booted: true,
          physical: false,
          supported: true,
          deviceFrame: null,
        }}
        client={
          {
            status: "streaming",
            screen: { width: 375, height: 667 },
            deviceSettings: { appearance: "light" },
            deviceSettingsStatus: "ready",
            deviceSettingsPending: new Set(),
            capabilities: { clipboard: false },
            sendKeyEvents: () => {},
          } as unknown as DeviceClient
        }
        DeviceScreen={() => <div>Stream</div>}
        displayScreen={(screen) => screen ?? null}
      />,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("mobile hides the title and offers viewer keyboard and full screen controls", () => {
  const html = render(375);
  expect(html).not.toContain("Test phone");
  expect(html).toContain('aria-label="Full screen"');
  expect(html).toContain('aria-label="Keyboard"');
  expect(html).not.toContain('aria-label="Toggle inspector"');
  expect(html).toContain("font-size:16px");
});

test("mobile pins Full screen to the top-right corner as a plain icon button", () => {
  const html = render(375);
  const corner = html.match(/<div style="([^"]*)"><button[^>]*aria-label="Full screen"/)?.[1];
  const button = html.match(/<button[^>]*aria-label="Full screen"[^>]*>/)?.[0];

  expect(corner).toContain("position:absolute");
  expect(corner).toContain("top:calc(12px + env(safe-area-inset-top, 0px))");
  expect(corner).toContain("right:24px");
  expect(button).toContain("width:40px");
  expect(button).toContain("border:none");
  expect(button).toContain('aria-pressed="false"');
});

test("mobile keeps Full screen under the sidebar overlay", () => {
  const html = render(375);
  const corner = html.match(/<div style="([^"]*)"><button[^>]*aria-label="Full screen"/)?.[1];
  const zIndex = Number(corner?.match(/z-index:(\d+)/)?.[1]);

  // The overlay's backdrop is z-index 12 and its panel 13. A phone-width overlay covers the
  // whole screen, so a higher button would draw over the overlay's own close button.
  expect(zIndex).toBeLessThan(12);
});

test("mobile puts Keyboard in the toolbar, not in the corner controls", () => {
  const html = render(375);
  const toolbar = html.slice(html.indexOf('role="toolbar"'));

  expect(toolbar).toContain('aria-label="Keyboard"');
  expect(html.slice(0, html.indexOf('role="toolbar"'))).not.toContain('aria-label="Keyboard"');
});

test("desktop keeps its title and original controls", () => {
  const html = render(1280);
  expect(html).toContain("Test phone");
  expect(html).not.toContain('aria-label="Full screen"');
  expect(html).not.toContain('aria-label="Keyboard"');
  expect(html).toContain('aria-label="Home"');
  expect(html).not.toContain('aria-label="Toggle inspector"');
});

const toolbarWrapper = (html: string) =>
  html.match(/<div style="([^"]*)"><div role="toolbar"/)?.[1];

test("mobile shows the action bar while the keyboard is down", () => {
  expect(toolbarWrapper(render(375))).toContain("display:flex");
});

test("mobile hides every action bar button while the phone keyboard is up", () => {
  // The visual viewport shrinks by more than 120px when the soft keyboard is raised.
  const html = render(375, 300);

  expect(toolbarWrapper(html)).toContain("display:none");
});

test("mobile hides the corner Full screen button while the keyboard is up", () => {
  expect(render(375)).toContain('aria-label="Full screen"');
  expect(render(375, 300)).not.toContain('aria-label="Full screen"');
});

test("mobile gives the device the top room back while the keyboard is up", () => {
  const top = (html: string) =>
    html.match(/padding:calc\((\d+)px \+ env\(safe-area-inset-top, 0px\)\) 8px/)?.[1];

  expect(top(render(375))).toBe("56");
  expect(top(render(375, 300))).toBe("8");
});

test("mobile keeps the corner button box clear of the device's top edge", () => {
  const html = render(375);
  const corner = html.match(/<div style="([^"]*)"><button[^>]*aria-label="Full screen"/)?.[1];
  const buttonTop = Number(corner?.match(/top:calc\((\d+)px/)?.[1]);
  const deviceTop = Number(
    html.match(/padding:calc\((\d+)px \+ env\(safe-area-inset-top, 0px\)\) 8px/)?.[1],
  );

  // The button is 40px tall.
  expect(buttonTop + 40).toBeLessThanOrEqual(deviceTop);
});
