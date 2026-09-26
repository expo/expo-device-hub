import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_TIME_ZONE } from "../time-zone";
import {
  isIosRuntime,
  SimulatorSettingsTool,
  timeZoneChoices,
  timeZoneOptions,
} from "../client/components/simulator-settings-tool";

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

describe("time zone picker", () => {
  test("lists the host default first, then every zone with its offset", () => {
    const options = timeZoneOptions();
    expect(options[0]).toEqual({ value: HOST_TIME_ZONE, label: "Host default" });
    expect(options.find((o) => o.value === "Asia/Tokyo")?.label).toBe("Asia/Tokyo (GMT+9)");
    expect(options.find((o) => o.value === "America/Los_Angeles")?.label).toMatch(
      /^America\/Los Angeles \(GMT-[78]\)$/,
    );
  });

  test("keeps a zone this browser does not list selectable", () => {
    const options = timeZoneOptions();
    expect(timeZoneChoices(options, "Asia/Tokyo")).toBe(options);
    const choices = timeZoneChoices(options, "Legacy/Alias");
    expect(choices.at(-1)).toEqual({ value: "Legacy/Alias", label: "Legacy/Alias" });
  });

  test("renders an unreadable status as a plain label, not a pickable zone", () => {
    expect(timeZoneChoices(timeZoneOptions(), "unsupported")).toEqual([
      { value: "unsupported", label: "Unavailable" },
    ]);
  });

  test("renders a Time Zone row naming the current zone, disabled until state arrives", () => {
    const html = renderToStaticMarkup(
      <SimulatorSettingsTool udid="ABC" runtime="iOS-26-4" />,
    );
    expect(html).toContain('data-setting-row="Time Zone"');
    expect(html).toContain("Host default");
    expect(html).toMatch(/<button[^>]*aria-label="Time Zone"[^>]* disabled=""/);
    expect(html).not.toContain("Restarting SpringBoard");
  });
});
