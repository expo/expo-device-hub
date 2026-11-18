import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type DeviceClient } from "@expo/hub-client";
import { DeviceShape } from "@expo/hub-client/shapes";
import { renderToStaticMarkup } from "react-dom/server";

import { DeviceListItem } from "../components/DeviceListItem";
import { shouldCompactAgentDeviceStatus } from "../components/useCompactAgentDeviceStatus";
import { AgentDeviceOverlay } from "../dashboard/AgentDeviceOverlay";
import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { StreamPanel } from "../dashboard/StreamPanel";

const IPHONE: Device = {
  id: "ios",
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
};

const PIXEL: Device = {
  ...IPHONE,
  id: "android",
  name: "Pixel 10 Pro",
  version: "Android 17.0",
  platform: "android",
};

const STREAMING_CLIENT = {
  status: "streaming",
  capabilities: { clipboard: false },
} as DeviceClient;

describe("agent device status", () => {
  test("labels active device rows and renders the blue status badge", () => {
    const markup = renderToStaticMarkup(
      <DeviceListItem name="iPhone 16 Pro" version="iOS 18.6" usedByAgent />,
    );

    expect(markup).toContain('aria-label="iPhone 16 Pro, iOS 18.6, used by agent"');
    expect(markup).toContain('data-agent-device-status="active"');
    expect(markup).toContain('data-agent-device-badge="true"');
    expect(markup).toContain("Used by agent");
  });

  test("keeps inactive status space reserved without exposing the status", () => {
    const markup = renderToStaticMarkup(<DeviceListItem name="iPhone 16" version="iOS 26.5" />);

    expect(markup).toContain('data-agent-device-status="inactive"');
    expect(markup).toContain("visibility:hidden");
    expect(markup).not.toContain('aria-label="iPhone 16, iOS 26.5, used by agent"');
  });

  test("keeps long device rows contained and compacts agent status when needed", () => {
    const markup = renderToStaticMarkup(
      <DeviceListItem name="Medium_Phone_API_36.1" version="Android 16.0" usedByAgent />,
    );
    const buttonTag = markup.slice(0, markup.indexOf(">") + 1);

    expect(buttonTag).toContain("width:100%");
    expect(buttonTag).toContain("min-width:0");
    expect(buttonTag).toContain("box-sizing:border-box");
    expect(buttonTag).toContain("overflow:hidden");
    expect(
      shouldCompactAgentDeviceStatus({
        available: 176,
        name: 172,
        version: 82,
        badge: 7,
        label: 66,
      }),
    ).toBeTrue();
    expect(
      shouldCompactAgentDeviceStatus({
        available: 380,
        name: 60,
        version: 58,
        badge: 7,
        label: 66,
      }),
    ).toBeFalse();
  });

  test("only reveals the phone overlay while hover state is active", () => {
    const hidden = renderToStaticMarkup(
      <AgentDeviceOverlay visible={false} onTakeOver={() => {}} />,
    );
    const visible = renderToStaticMarkup(<AgentDeviceOverlay visible onTakeOver={() => {}} />);
    const visibleOverlayTag = visible.slice(0, visible.indexOf(">") + 1);

    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain("display:none");
    expect(visible).not.toContain('hidden=""');
    expect(visible).toContain("display:flex");
    expect(visibleOverlayTag).not.toContain("border-radius");
    expect(visible).toContain("color:rgba(218, 233, 255, 0.74)");
    expect(visibleOverlayTag).not.toContain("backdrop-filter");
    expect(visibleOverlayTag).toContain("background-color:rgba(0, 0, 0, 0.55)");
    expect(visible).toContain("Agent is using this device");
    expect(visible).toContain("color:rgba(255, 255, 255, 0.7)");
    expect(visible).toContain("Taking over might collide with what the agent is doing.");
    expect(visible).toContain("Take over anyway");
    expect(visible).toContain("background-color:var(--expo-theme-button-agent-overlay-background)");
    expect(visible).toContain("font-family:inherit");
    expect(visible).toContain(
      '<span style="font-size:12px;font-weight:500;line-height:1.6;letter-spacing:0">Take over anyway</span>',
    );
  });

  test("keeps the agent takeover button borderless in light mode", () => {
    const themeCss = readFileSync(new URL("../theme/theme.css", import.meta.url), "utf8");
    const lightTheme = themeCss.slice(themeCss.indexOf(":root {"), themeCss.indexOf(".dark-theme"));

    expect(lightTheme).toContain("--expo-theme-button-agent-overlay-border: transparent;");
    expect(lightTheme).toContain("--expo-theme-button-agent-overlay-disabled-border: transparent;");
  });

  test("clips the stream and unshaped overlay with one shared iOS screen shape", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={{ ...IPHONE, model: "iPhone 17 Pro" }}
        DeviceScreen={() => null}
        DeviceShape={DeviceShape}
        displayScreen={() => null}
      />,
    );
    const screenClipStart = markup.indexOf('data-testid="device-screen-clip"');
    const screenClipTag = markup.slice(screenClipStart, markup.indexOf(">", screenClipStart) + 1);
    const frameStart = markup.indexOf('data-testid="device-screen-frame"');
    const frameTag = markup.slice(frameStart, markup.indexOf(">", frameStart) + 1);
    const overlayStart = markup.indexOf('data-testid="agent-device-overlay-clip"');
    const overlayTag = markup.slice(overlayStart, markup.indexOf(">", overlayStart) + 1);

    expect(screenClipTag).not.toContain("overflow:hidden");
    expect(screenClipTag).not.toContain("border-radius");
    expect(screenClipTag).not.toContain("corner-shape");
    expect(screenClipTag).toContain("clip-path:polygon(");
    expect(frameTag).not.toContain("box-shadow");
    expect(overlayTag).not.toContain("overflow:hidden");
    expect(overlayTag).not.toContain("border-radius");
    expect(overlayTag).not.toContain("corner-shape");
  });

  test("gives every device state one panel-sized frame viewport", () => {
    const markup = renderToStaticMarkup(
      <StreamPanel
        device={IPHONE}
        client={{ ...STREAMING_CLIENT, status: "connecting" }}
        DeviceScreen={({ client }) => (
          <div data-testid="connection-state-surface" data-status={client.status} />
        )}
        displayScreen={() => null}
      />,
    );
    const viewportStart = markup.indexOf('data-testid="device-frame-viewport"');
    const viewportTag = markup.slice(viewportStart, markup.indexOf(">", viewportStart) + 1);

    expect(viewportTag).toContain("container-type:size");
    expect(viewportTag).toContain("flex:1");
    expect(viewportTag).toContain("min-height:0");
    expect(viewportTag).toContain("width:100%");
    // The title and toolbar hug the frame: their heights are reserved as padding.
    expect(viewportTag).toContain("padding:64px 0 86px");
    expect(markup.indexOf('aria-label="Device controls"')).toBeGreaterThan(
      markup.indexOf('data-testid="device-frame-anchor"'),
    );
    expect(markup).toMatch(
      /data-testid="device-frame-viewport"[^>]*><div data-testid="device-frame-anchor"[^>]*><div data-testid="device-screen-frame"[\s\S]*data-testid="device-screen-stream"[^>]*><div data-testid="connection-state-surface" data-status="connecting"><\/div>/,
    );
  });

  test("keeps the same frame and stream when the viewer hides the screen shape", () => {
    const StableDeviceScreen = () => <div data-testid="stable-device-screen" />;
    const markup = (showScreenShape?: boolean) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={{ ...PIXEL, model: "pixel_9" }}
          client={STREAMING_CLIENT}
          DeviceShape={DeviceShape}
          showScreenShape={showScreenShape}
          DeviceScreen={StableDeviceScreen}
          displayScreen={() => null}
        />,
      );
    const shown = markup();
    const hidden = markup(false);
    expect(shown).toContain("clip-path:polygon(");
    expect(hidden).not.toContain("clip-path");
    for (const frame of [shown, hidden]) {
      expect(frame).toContain('data-device-frame-kind="flat"');
      expect(frame).not.toContain("<img");
      expect(frame).toMatch(
        /data-testid="device-screen-stream"[^>]*><div data-testid="stable-device-screen"><\/div><\/div>/,
      );
    }
  });
});
