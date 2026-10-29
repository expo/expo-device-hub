import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceClient } from "@expo/hub-client";
import { StreamPanel } from "../dashboard/StreamPanel";

function render(width: number) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: 667,
      visualViewport: { width, height: 667, offsetLeft: 0, offsetTop: 0 },
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
  expect(corner).toContain("top:calc(28px + env(safe-area-inset-top, 0px))");
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
