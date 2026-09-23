import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isIosRuntime, SimulatorSettingsTool } from "../client/components/simulator-settings-tool";

// The in-sim settings helper is an iOS-simulator Mach-O; spawning it inside a
// watchOS / tvOS / visionOS runtime aborts in dyld. The panel gates on the
// device runtime so non-iOS devices never trigger that spawn.
describe("isIosRuntime", () => {
  test("iOS runtimes are supported", () => {
    expect(isIosRuntime("iOS-26-5")).toBe(true);
    expect(isIosRuntime("iOS-18-0")).toBe(true);
  });

  test("non-iOS runtimes are unsupported", () => {
    expect(isIosRuntime("watchOS-11-2")).toBe(false);
    expect(isIosRuntime("tvOS-18-0")).toBe(false);
    expect(isIosRuntime("xrOS-2-0")).toBe(false);
    expect(isIosRuntime("visionOS-2-0")).toBe(false);
  });

  test("unknown/null runtime falls back to supported so the panel still renders", () => {
    expect(isIosRuntime(null)).toBe(true);
    expect(isIosRuntime("")).toBe(true);
  });
});


describe("SimulatorSettingsTool fold controls", () => {
  test("places fold settings first inside the single Simulator section", () => {
    const html = renderToStaticMarkup(
      <SimulatorSettingsTool
        udid="duo"
        runtime="iOS-27-0"
        hingeControls={{ angle: 90, pose: "laptop", tableModeAvailable: true, onChange: () => {} }}
      />,
    );
    const rows = Array.from(html.matchAll(/data-setting-row="([^"]+)"/g), ([, label]) => label);
    expect(rows.slice(0, 7)).toEqual([
      "Fold pose", "Hinge angle", "Table Mode", "Preview mode", "Cache screen on fold", "Preview size", "Appearance",
    ]);
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html.match(/<summary\b/g)).toHaveLength(1);
    expect(html).toMatch(/<summary[^>]*>[\s\S]*?Simulator[\s\S]*?<\/summary>/);
    expect(html).not.toMatch(/<summary[^>]*>[\s\S]*?>Fold</);
  });

  test("starts with Appearance when the device does not support folding", () => {
    const html = renderToStaticMarkup(
      <SimulatorSettingsTool
        udid="phone"
        runtime="iOS-27-0"
        hingeControls={{ supported: false, angle: 90, onChange: () => {} }}
      />,
    );
    const rows = Array.from(html.matchAll(/data-setting-row="([^"]+)"/g), ([, label]) => label);
    expect(rows[0]).toBe("Appearance");
    expect(rows).not.toContain("Fold pose");
    expect(rows).not.toContain("Hinge angle");
    expect(rows).not.toContain("Table Mode");
    expect(rows).not.toContain("Preview mode");
    expect(rows).not.toContain("Cache screen on fold");
    expect(rows).not.toContain("Preview size");
  });
});
