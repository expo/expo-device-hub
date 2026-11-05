import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_CLOCK } from "../clock";
import { HOST_TIME_ZONE } from "../time-zone";
import {
  ClockControl,
  isIosRuntime,
  latestWins,
  SimulatorSettingsTool,
  StaleClockControls,
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
      "Fold pose",
      "Hinge angle",
      "Table Mode",
      "Preview mode",
      "Cache screen on fold",
      "Preview size",
      "Appearance",
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

  test("follows a daylight saving change on an open page", () => {
    const label = (at: string) =>
      timeZoneOptions(new Date(at)).find((o) => o.value === "America/New_York")?.label;
    expect(label("2026-10-30T12:00:00Z")).toBe("America/New York (GMT-4)");
    expect(label("2026-11-02T12:00:00Z")).toBe("America/New York (GMT-5)");
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

  test("after a change, shows a warning icon and a restart icon button instead of a note", () => {
    const html = renderToStaticMarkup(<StaleClockControls disabled={false} onRestart={() => {}} />);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="[^"]*status bar[^"]*"/);
    // Icon only: the button holds the reload icon and no text.
    expect(html).toMatch(
      /<button[^>]*aria-label="Restart SpringBoard"[^>]*><svg[\s\S]*?<\/svg><\/button>/,
    );
  });

  test("renders a Time Zone row naming the current zone, disabled until state arrives", () => {
    const html = renderToStaticMarkup(<SimulatorSettingsTool udid="ABC" runtime="iOS-26-4" />);
    expect(html).toContain('data-setting-row="Time Zone"');
    expect(html).toContain("Host default");
    expect(html).toMatch(/<button[^>]*aria-label="Time Zone"[^>]* disabled=""/);
  });
});

describe("date and time", () => {
  const render = (value: string, zone = "Asia/Tokyo") =>
    renderToStaticMarkup(
      <ClockControl value={value} zone={zone} disabled={false} onChange={() => {}} />,
    );

  test("shows the host time with no warning or reset", () => {
    const html = render(HOST_CLOCK);
    expect(html).toContain("Host default");
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("Back to the host time");
  });

  test("shows a set time in the simulator's zone, with a warning and a reset button", () => {
    const html = render("2030-01-01T09:00:12+09:00");
    expect(html).toContain("2030-01-01 09:00");
    expect(html).toContain('value="2030-01-01T09:00"');
    expect(html).toMatch(/role="img"[^>]*aria-label="[^"]*status bar[^"]*"/);
    expect(html).toMatch(/<button[^>]*aria-label="Back to the host time"[^>]*><svg/);
  });

  test("opens at the simulator's time, or empty when only the host knows its zone", () => {
    expect(render(HOST_CLOCK, "Asia/Tokyo")).toMatch(/value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
    expect(render(HOST_CLOCK, HOST_TIME_ZONE)).toContain('value=""');
    // A zone this browser cannot read must not take the section down.
    expect(render(HOST_CLOCK, "unsupported")).toContain('value=""');
  });

  test("shows a clock it could not read as unavailable, and can still reset it", () => {
    const html = render("unsupported");
    expect(html).toContain("Unavailable");
    expect(html).toMatch(/<button[^>]*aria-label="Date &amp; Time"[^>]* disabled=""/);
    expect(html).toContain("Back to the host time");
  });

  test("labels a time reported in UTC as UTC", () => {
    expect(render("1971-01-01T00:00:01Z")).toContain("1971-01-01 00:00 UTC");
  });

  test("renders a Date & Time row after Time Zone", () => {
    const html = renderToStaticMarkup(<SimulatorSettingsTool udid="ABC" runtime="iOS-26-4" />);
    const rows = Array.from(html.matchAll(/data-setting-row="([^"]+)"/g), ([, label]) => label);
    expect(rows.indexOf("Date &amp; Time")).toBe(rows.indexOf("Time Zone") + 1);
  });
});

describe("latestWins", () => {
  test("runs one task at a time, then only the latest, each bound when it was queued", async () => {
    const ran: string[] = [];
    let release = () => {};
    const enqueue = latestWins();
    enqueue(() => new Promise<void>((resolve) => (release = () => (ran.push("a"), resolve()))));
    enqueue(async () => void ran.push("b"));
    enqueue(async () => void ran.push("c"));
    release();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(ran).toEqual(["a", "c"]);
  });
});
