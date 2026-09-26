import { describe, expect, test } from "bun:test";
import { HOST_TIME_ZONE } from "../time-zone";
import {
  CONTENT_SIZE_CATEGORIES,
  UI_OPTIONS,
  normalizeUiValue,
  parseUiArgs,
  readTimeZone,
  writeTimeZone,
  type SimExec,
} from "../ui-settings";

const UDID = "0F4E3A48-8F26-4A5D-9C7A-1B2C3D4E5F60";
const launchctl = (...args: string[]) => ["simctl", "spawn", UDID, "launchctl", ...args];
const GETENV = launchctl("getenv", "TZ");
const UNSETENV = launchctl("unsetenv", "TZ");
const KICKSTART = launchctl("kickstart", "-k", "user/foreground/com.apple.SpringBoard");
const setenv = (zone: string) => launchctl("setenv", "TZ", zone);

type Scripted = Array<[argv: string[], reply: string | Error]>;

function scriptedExec(script: Scripted) {
  const calls: string[][] = [];
  const exec: SimExec = async (_file, args) => {
    calls.push(args);
    const entry = script.find(([argv]) => argv.join("\0") === args.join("\0"));
    if (!entry) throw new Error(`unexpected xcrun ${args.join(" ")}`);
    if (entry[1] instanceof Error) throw entry[1];
    return entry[1];
  };
  return { exec, calls };
}

describe("parseUiArgs", () => {
  test("no args requests status", () => {
    expect(parseUiArgs([])).toEqual({ command: "status", json: false });
  });

  test("status with --json and -d", () => {
    expect(parseUiArgs(["status", "--json", "-d", "ABC"])).toEqual({
      command: "status",
      json: true,
      device: "ABC",
    });
  });

  test("get a single option", () => {
    expect(parseUiArgs(["appearance"])).toEqual({
      command: "get",
      option: "appearance",
      json: false,
    });
  });

  test("set an option with a value", () => {
    expect(parseUiArgs(["appearance", "dark", "-d", "ABC"])).toEqual({
      command: "set",
      option: "appearance",
      value: "dark",
      device: "ABC",
      json: false,
    });
  });

  test("unknown option is an error", () => {
    expect(parseUiArgs(["sound", "50"]).error).toMatch(/unknown option/i);
  });

  test("dangling -d/--device flag is an error", () => {
    expect(parseUiArgs(["appearance", "-d"]).error).toMatch(/requires a value/i);
    expect(parseUiArgs(["status", "--device"]).error).toMatch(/requires a value/i);
  });

  test("invalid value is an error", () => {
    expect(parseUiArgs(["appearance", "blue"]).error).toMatch(/invalid value/i);
  });

  test("color filter accepts vision-deficiency aliases", () => {
    expect(parseUiArgs(["color-filter", "protanopia"]).value).toBe("red-green");
    expect(parseUiArgs(["color-filter", "deuteranopia"]).value).toBe("green-red");
    expect(parseUiArgs(["color-filter", "tritanopia"]).value).toBe("blue-yellow");
    expect(parseUiArgs(["color-filter", "grayscale"]).value).toBe("grayscale");
  });

  test("text-size accepts categories and increment/decrement", () => {
    expect(parseUiArgs(["text-size", "large"]).value).toBe("large");
    expect(parseUiArgs(["text-size", "accessibility-medium"]).value).toBe(
      "accessibility-medium",
    );
    expect(parseUiArgs(["text-size", "increment"]).value).toBe("increment");
    expect(parseUiArgs(["text-size", "giant"]).error).toMatch(/invalid value/i);
  });
});

describe("normalizeUiValue", () => {
  test("toggles accept on/off synonyms", () => {
    for (const v of ["on", "true", "enabled", "1", "yes"]) {
      expect(normalizeUiValue("reduce-motion", v)).toBe("on");
    }
    for (const v of ["off", "false", "disabled", "0", "no"]) {
      expect(normalizeUiValue("reduce-motion", v)).toBe("off");
    }
  });

  test("non-toggle options pass through canonical values only", () => {
    expect(normalizeUiValue("liquid-glass", "tinted")).toBe("tinted");
    expect(normalizeUiValue("liquid-glass", "frosted")).toBeNull();
  });
});

describe("option catalogue", () => {
  test("covers every sidebar option", () => {
    expect(Object.keys(UI_OPTIONS).sort()).toEqual(
      [
        "appearance",
        "color-filter",
        "hardware-keyboard",
        "time-zone",
        "increase-contrast",
        "liquid-glass",
        "reduce-motion",
        "reduce-transparency",
        "show-borders",
        "text-size",
        "voiceover",
      ].sort(),
    );
  });

  test("content size categories span standard and accessibility ranges", () => {
    expect(CONTENT_SIZE_CATEGORIES).toHaveLength(12);
    expect(CONTENT_SIZE_CATEGORIES[0]).toBe("extra-small");
    expect(CONTENT_SIZE_CATEGORIES[3]).toBe("large");
    expect(CONTENT_SIZE_CATEGORIES[11]).toBe(
      "accessibility-extra-extra-extra-large",
    );
  });
});

describe("time-zone option", () => {
  test("takes IANA zones, canonicalized, or host", () => {
    expect(parseUiArgs(["time-zone", "europe/berlin", "-d", "ABC"])).toEqual({
      command: "set",
      option: "time-zone",
      value: "Europe/Berlin",
      device: "ABC",
      json: false,
    });
    expect(parseUiArgs(["time-zone", "host"]).value).toBe(HOST_TIME_ZONE);
    expect(parseUiArgs(["time-zone"])).toEqual({ command: "get", option: "time-zone", json: false });
  });

  test("names the accepted forms rather than listing 450 zones", () => {
    const { error } = parseUiArgs(["time-zone", "Mars/Olympus_Mons"]);
    expect(error).toMatch(/invalid value for time-zone: Mars\/Olympus_Mons/);
    expect(error).toMatch(/IANA zone/);
  });

  test("normalizes through the zone normalizer", () => {
    expect(normalizeUiValue("time-zone", "asia/tokyo")).toBe("Asia/Tokyo");
    expect(normalizeUiValue("time-zone", "system")).toBe(HOST_TIME_ZONE);
    expect(normalizeUiValue("time-zone", "nowhere")).toBeNull();
  });
});

describe("readTimeZone", () => {
  test("returns the TZ launchd reports", async () => {
    const { exec } = scriptedExec([[GETENV, "Asia/Tokyo"]]);
    expect(await readTimeZone(UDID, exec)).toBe("Asia/Tokyo");
  });

  test("maps an unset TZ (empty getenv output) to host", async () => {
    const { exec } = scriptedExec([[GETENV, ""]]);
    expect(await readTimeZone(UDID, exec)).toBe(HOST_TIME_ZONE);
  });

  test("surfaces simctl failures", async () => {
    const { exec } = scriptedExec([[GETENV, new Error("Invalid device: nope")]]);
    await expect(readTimeZone(UDID, exec)).rejects.toThrow(/Invalid device/);
  });
});

describe("writeTimeZone", () => {
  test("sets TZ and restarts SpringBoard", async () => {
    const { exec, calls } = scriptedExec([
      [GETENV, ""],
      [setenv("Asia/Tokyo"), ""],
      [KICKSTART, ""],
    ]);
    expect(await writeTimeZone(UDID, "Asia/Tokyo", exec)).toBe(true);
    expect(calls).toEqual([GETENV, setenv("Asia/Tokyo"), KICKSTART]);
  });

  test("clears TZ for host and restarts SpringBoard", async () => {
    const { exec, calls } = scriptedExec([
      [GETENV, "Asia/Tokyo"],
      [UNSETENV, ""],
      [KICKSTART, ""],
    ]);
    expect(await writeTimeZone(UDID, HOST_TIME_ZONE, exec)).toBe(true);
    expect(calls).toEqual([GETENV, UNSETENV, KICKSTART]);
  });

  test("leaves launchd alone when the zone is already set", async () => {
    const { exec, calls } = scriptedExec([[GETENV, "Asia/Tokyo"]]);
    expect(await writeTimeZone(UDID, "Asia/Tokyo", exec)).toBe(false);
    expect(calls).toEqual([GETENV]);
  });

  test("does not restart SpringBoard when setenv fails", async () => {
    const { exec, calls } = scriptedExec([
      [GETENV, ""],
      [setenv("Asia/Tokyo"), new Error("launchctl: Could not set environment")],
    ]);
    await expect(writeTimeZone(UDID, "Asia/Tokyo", exec)).rejects.toThrow(/Could not set/);
    expect(calls).not.toContainEqual(KICKSTART);
  });

  test("rolls TZ back when the restart fails", async () => {
    const { exec, calls } = scriptedExec([
      [GETENV, "Europe/Berlin"],
      [setenv("Asia/Tokyo"), ""],
      [KICKSTART, new Error("Could not find service")],
      [setenv("Europe/Berlin"), ""],
    ]);
    await expect(writeTimeZone(UDID, "Asia/Tokyo", exec)).rejects.toThrow(/Could not find service/);
    expect(calls).toEqual([GETENV, setenv("Asia/Tokyo"), KICKSTART, setenv("Europe/Berlin")]);
  });
});
