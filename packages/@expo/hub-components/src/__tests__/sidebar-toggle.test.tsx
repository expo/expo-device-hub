import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sidebar } from "../dashboard/Sidebar";
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

test("an inspector-only sidebar omits device lists and their empty-state messages", () => {
  const markup = renderToStaticMarkup(
    <Sidebar
      simulators={[]}
      emulators={[]}
      recentSimulators={[]}
      recentEmulators={[]}
      simulatorOptions={{ runtimes: [] }}
      emulatorOptions={{ runtimes: [] }}
      selectedId="locked"
      onSelect={() => {}}
      showDeviceLists={false}
      onToggle={() => {}}
      toggleIcon="close"
    >
      <div>Clipboard inspector</div>
    </Sidebar>,
  );
  expect(markup).toContain("Clipboard inspector");
  expect(markup).toContain('aria-label="Close sidebar"');
  expect(markup).not.toContain("No booted");
  expect(markup).not.toContain("Simulators");
  expect(markup).not.toContain("Emulators");
});
