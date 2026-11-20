import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsPanel } from "../client/components/tools-panel";
import { AxSelectionContext } from "../client/hooks/use-ax-snapshot";

const noop = () => {};

const defaultProps: ComponentProps<typeof ToolsPanel> = {
  open: false,
  peer: { peerConnection: null, subscribeStats: () => () => {} },
  onClose: noop,
  udid: "one",
  deviceRuntime: "iOS-27-0",
  currentApp: null,
  axOverlayEnabled: false,
  onToggleAxOverlay: noop,
  streamSettings: {
    transport: "http",
    httpCodec: "auto",
    webRtcCodec: "h264",
    mjpegFps: 60,
    mjpegQuality: 0.7,
    maxDimension: 0,
    h264Bitrate: 6_000_000,
    h264Fps: 60,
  },
  onStreamPlaybackSettingsChange: noop,
  onStreamEncoderSettingsChange: noop,
  activeCodec: "h264",
  avccSupported: true,
  streamSettingsPending: false,
  width: 320,
};
function renderPanel(props: Partial<ComponentProps<typeof ToolsPanel>> = {}) {
  return renderToStaticMarkup(
    <AxSelectionContext
      value={{
        highlightedKey: null,
        selectedKey: null,
        setHighlightedKey: noop,
        setSelectedKey: noop,
      }}
    >
      <ToolsPanel {...defaultProps} {...props} />
    </AxSelectionContext>,
  );
}

describe("ToolsPanel", () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    // Other tools resolve their API paths while rendering the open sidebar.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: new URL("http://localhost/") },
    });
  });
  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("a physical device's simulator-only tools keep their place and say why", () => {
    const unavailableFeatures = {
      foregroundApp: "The foreground app is not available on a physical device.",
      activity: "Activity metrics are not available on a physical device.",
      appInjection: "Camera injection and network capture are not available on a physical device.",
      deviceSettings: "Simulator settings are not available on a physical device.",
      accessibility: "The accessibility tree is not available on a physical device.",
      location: "Location is not available on a physical device.",
      permissions: "App permissions are not available on a physical device.",
      logs: "Device logs and crash reports are not available on a physical device.",
    };
    const html = renderPanel({ open: true, unavailableFeatures });
    const unavailable = [...html.matchAll(/data-unavailable-tool="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(unavailable).toEqual([
      "Current app",
      "Activity",
      "Network requests",
      "Simulator",
      "Accessibility",
      "Camera",
      "Location",
      "Permissions",
      "Crashes",
    ]);
    expect(html).toContain("Location is not available on a physical device.");
    expect(html).not.toContain("data-simulator-settings");
  });

  test("a simulator's tools have no unavailable card", () => {
    expect(renderPanel({ open: true })).not.toContain("data-unavailable-tool");
  });

  test("uses the shared panel background variable", () => {
    const html = renderPanel();
    expect(html).toContain("background-color:var(--serve-sim-panel-bg)");
  });

  test("includes fold controls in the existing Simulator section for a hinge-capable simulator", () => {
    for (const hingeControls of [
      { supported: true, onChange: noop },
      { angle: 90, pose: "laptop" as const, onChange: noop },
    ]) {
      const html = renderPanel({ open: true, hingeControls });
      const simulatorSection = html.match(
        /<details[^>]*data-simulator-settings=""[^>]*>[\s\S]*?<\/details>/,
      )?.[0];
      expect(simulatorSection).toBeDefined();
      expect(simulatorSection).toContain('aria-label="Fold pose"');
      expect(simulatorSection).toContain('aria-label="Hinge angle"');
      expect(simulatorSection).toContain('aria-label="Table Mode"');
      expect(html.match(/data-simulator-settings=""/g)).toHaveLength(1);
      const sectionSummaries = Array.from(
        html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g),
        ([, summary]) => summary,
      );
      expect(sectionSummaries.some((summary) => />Fold</.test(summary ?? ""))).toBe(false);
    }
  });

  test("omits fold controls without hinge capability, even when stale media has an angle", () => {
    for (const hingeControls of [
      undefined,
      { supported: false, angle: 90, onChange: noop },
      { onChange: noop },
    ]) {
      const html = renderPanel({ open: true, hingeControls });
      expect(html).not.toContain('aria-label="Fold pose"');
      expect(html).not.toContain('aria-label="Hinge angle"');
      expect(html).not.toContain('aria-label="Table Mode"');
    }
  });

  test("does not mount fold controls while the sidebar is closed", () => {
    const html = renderPanel({ hingeControls: { supported: true, onChange: noop } });
    expect(html).not.toContain('aria-label="Fold pose"');
  });
});
