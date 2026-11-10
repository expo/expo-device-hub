import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sidebar } from "../dashboard/Sidebar";
import { type Device } from "../dashboard/data";
import { SidebarToggle } from "../components/SidebarToggle";

// The sidebar glyph is a rounded square with a divider; the close glyph is two crossing lines.
const SIDEBAR_GLYPH = /<rect[^>]*rx="2"/;

describe("SidebarToggle", () => {
  test("draws the sidebar glyph by default", () => {
    const markup = renderToStaticMarkup(<SidebarToggle onClick={() => {}} />);

    expect(markup).toContain('aria-label="Toggle sidebar"');
    expect(markup).toMatch(SIDEBAR_GLYPH);
  });

  test("draws an X and says it closes when icon is close", () => {
    const markup = renderToStaticMarkup(<SidebarToggle icon="close" onClick={() => {}} />);

    expect(markup).toContain('aria-label="Close sidebar"');
    expect(markup).not.toContain('aria-label="Toggle sidebar"');
    expect(markup).not.toMatch(SIDEBAR_GLYPH);
  });
});

describe("Sidebar toggle glyph", () => {
  const sidebar = (toggleIcon?: "sidebar" | "close") =>
    renderToStaticMarkup(
      <Sidebar
        simulators={[]}
        emulators={[]}
        recentSimulators={[]}
        recentEmulators={[]}
        simulatorOptions={{ runtimes: [] }}
        emulatorOptions={{ runtimes: [] }}
        selectedId=""
        onSelect={() => {}}
        onToggle={() => {}}
        toggleIcon={toggleIcon}
      />,
    );

  test("keeps the sidebar glyph unless asked for a close glyph", () => {
    expect(sidebar()).toContain('aria-label="Toggle sidebar"');
    expect(sidebar("sidebar")).toContain('aria-label="Toggle sidebar"');
  });

  test("shows the close glyph for a dismissed overlay", () => {
    const markup = sidebar("close");

    expect(markup).toContain('aria-label="Close sidebar"');
    expect(markup).not.toContain('aria-label="Toggle sidebar"');
  });
});

// A single-device session renders the sidebar this way: its one device, then the inspector.
test("a sidebar without an add handler lists devices above the inspector, without add controls", () => {
  const pinned: Device = {
    id: "pinned",
    name: "iPhone 17 Pro",
    version: "iOS 26.5",
    platform: "ios",
    booted: true,
    physical: false,
    supported: true,
    deviceFrame: null,
  };
  const markup = renderToStaticMarkup(
    <Sidebar
      simulators={[pinned]}
      emulators={[]}
      recentSimulators={[]}
      recentEmulators={[]}
      simulatorOptions={{ runtimes: [] }}
      emulatorOptions={{ runtimes: [] }}
      selectedId="pinned"
      onSelect={() => {}}
      onToggle={() => {}}
      platform="ios"
    >
      <div>Device inspector</div>
    </Sidebar>,
  );
  expect(markup).toContain("Device inspector");
  expect(markup.indexOf("iPhone 17 Pro")).toBeGreaterThan(-1);
  expect(markup.indexOf("iPhone 17 Pro")).toBeLessThan(markup.indexOf("Device inspector"));
  expect(markup).not.toContain('aria-label="Add simulator"');
});
