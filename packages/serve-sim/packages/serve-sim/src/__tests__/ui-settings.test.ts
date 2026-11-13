import { describe, expect, test } from "bun:test";
import { HOST_CLOCK } from "../clock";
import { HOST_TIME_ZONE } from "../time-zone";
import {
  CONTENT_SIZE_CATEGORIES,
  UI_OPTIONS,
  normalizeUiValue,
  parseUiArgs,
  readClock,
  readTimeZone,
  writeClock,
  writeTimeZone,
  type ClockDeps,
  type SimExec,
  type TimeZoneDeps,
} from "../ui-settings";

const UDID = "0F4E3A48-8F26-4A5D-9C7A-1B2C3D4E5F60";
const launchctl = (...args: string[]) => ["simctl", "spawn", UDID, "launchctl", ...args];
const GETENV = launchctl("getenv", "TZ");
const UNSETENV = launchctl("unsetenv", "TZ");
const setenv = (zone: string) => launchctl("setenv", "TZ", zone);

type Scripted = Array<[argv: string[], reply: string | Error]>;

function scriptedExec(script: Scripted): SimExec {
  return async (_file, args) => {
    const entry = script.find(([argv]) => argv.join("\0") === args.join("\0"));
    if (!entry) throw new Error(`unexpected xcrun ${args.join(" ")}`);
    if (entry[1] instanceof Error) throw entry[1];
    return entry[1];
  };
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
    expect(parseUiArgs(["text-size", "accessibility-medium"]).value).toBe("accessibility-medium");
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
        "clock",
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
    expect(CONTENT_SIZE_CATEGORIES[11]).toBe("accessibility-extra-extra-extra-large");
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
    expect(parseUiArgs(["time-zone"])).toEqual({
      command: "get",
      option: "time-zone",
      json: false,
    });
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
    const exec = scriptedExec([[GETENV, "Asia/Tokyo"]]);
    expect(await readTimeZone(UDID, exec)).toBe("Asia/Tokyo");
  });

  test("maps an unset TZ (empty getenv output) to host", async () => {
    const exec = scriptedExec([[GETENV, ""]]);
    expect(await readTimeZone(UDID, exec)).toBe(HOST_TIME_ZONE);
  });

  test("surfaces simctl failures", async () => {
    const exec = scriptedExec([[GETENV, new Error("Invalid device: nope")]]);
    await expect(readTimeZone(UDID, exec)).rejects.toThrow(/Invalid device/);
  });
});

function timeZoneDeps(script: Scripted, capability: Error | null = null) {
  const exec = scriptedExec(script);
  const steps: Array<string[] | string> = [];
  const deps: TimeZoneDeps = {
    exec: async (file, args) => {
      steps.push(args);
      return exec(file, args);
    },
    writeZoneFile: (_udid, zone) => void steps.push(`file ${zone}`),
    setCapability: async (_udid, enabled) => {
      steps.push(`capability ${enabled ? "on" : "off"}`);
      if (capability) throw capability;
    },
  };
  return { deps, steps };
}

describe("writeTimeZone", () => {
  // TZ first: an app that starts between the two steps gets the new zone, and its dylib skips
  // the older file. The other order leaves that app in the old zone.
  test("sets TZ, writes the zone file and enables the capability, without restarting SpringBoard", async () => {
    const { deps, steps } = timeZoneDeps([
      [GETENV, ""],
      [setenv("Asia/Tokyo"), ""],
    ]);
    await writeTimeZone(UDID, "Asia/Tokyo", deps);
    expect(steps).toEqual([GETENV, setenv("Asia/Tokyo"), "file Asia/Tokyo", "capability on"]);
  });

  test("keeps the zone file for host, so loaded dylibs unset TZ, and disables the capability", async () => {
    const { deps, steps } = timeZoneDeps([
      [GETENV, "Asia/Tokyo"],
      [UNSETENV, ""],
    ]);
    await writeTimeZone(UDID, HOST_TIME_ZONE, deps);
    expect(steps).toEqual([GETENV, UNSETENV, `file ${HOST_TIME_ZONE}`, "capability off"]);
  });

  test("still applies an unchanged zone", async () => {
    const { deps, steps } = timeZoneDeps([
      [GETENV, "Asia/Tokyo"],
      [setenv("Asia/Tokyo"), ""],
    ]);
    await writeTimeZone(UDID, "Asia/Tokyo", deps);
    expect(steps).toContain("capability on");
  });

  test("puts the previous zone back when setenv fails", async () => {
    const { deps, steps } = timeZoneDeps([
      [GETENV, "Europe/Berlin"],
      [setenv("Asia/Tokyo"), new Error("launchctl: Could not set environment")],
      [setenv("Europe/Berlin"), ""],
    ]);
    await expect(writeTimeZone(UDID, "Asia/Tokyo", deps)).rejects.toThrow(/Could not set/);
    expect(steps).toEqual([
      GETENV,
      setenv("Asia/Tokyo"),
      "file Europe/Berlin",
      setenv("Europe/Berlin"),
    ]);
  });

  test("puts the previous zone back when the capability cannot be enabled", async () => {
    const { deps, steps } = timeZoneDeps(
      [
        [GETENV, ""],
        [setenv("Asia/Tokyo"), ""],
        [UNSETENV, ""],
      ],
      new Error("Capability loader not built"),
    );
    await expect(writeTimeZone(UDID, "Asia/Tokyo", deps)).rejects.toThrow(/not built/);
    expect(steps.slice(-2)).toEqual([`file ${HOST_TIME_ZONE}`, UNSETENV]);
  });

  test("runs one change at a time per device, so two callers cannot interleave", async () => {
    const steps: string[] = [];
    let launchdTz = "";
    const deps = (tag: string): TimeZoneDeps => ({
      exec: async (_file, args) => {
        await Bun.sleep(20);
        const verb = args[4];
        if (verb === "getenv") return launchdTz;
        if (verb === "setenv") launchdTz = args[6]!;
        steps.push(`${tag} ${verb}`);
        return "";
      },
      writeZoneFile: () => void steps.push(`${tag} file`),
      setCapability: async () => {
        await Bun.sleep(20);
        steps.push(`${tag} capability`);
      },
    });
    await Promise.all([
      writeTimeZone(UDID, "Asia/Tokyo", deps("a")),
      writeTimeZone(UDID, "Europe/Berlin", deps("b")),
    ]);
    const first = steps[0]!.split(" ")[0];
    const second = first === "a" ? "b" : "a";
    expect(steps).toEqual([
      `${first} setenv`,
      `${first} file`,
      `${first} capability`,
      `${second} setenv`,
      `${second} file`,
      `${second} capability`,
    ]);
  });
});

const NOW = Date.UTC(2026, 10, 3);

function clockDeps(zone = HOST_TIME_ZONE, capability: Error | null = null) {
  const steps: string[] = [];
  const deps: ClockDeps = {
    now: () => NOW,
    readZone: async () => zone,
    hostZone: () => "Europe/Berlin",
    readOffset: () => 5_000,
    writeOffset: (_udid, offset) => void steps.push(`offset ${offset}`),
    setCapability: async (_udid, enabled) => {
      steps.push(`capability ${enabled ? "on" : "off"}`);
      if (capability) throw capability;
    },
  };
  return { deps, steps };
}

describe("writeClock", () => {
  // The offset first: a dylib that loads when the capability turns on finds its directory.
  test("writes the offset to a time in UTC, then enables the capability", async () => {
    const { deps, steps } = clockDeps();
    await writeClock(UDID, "2026-11-04T00:00:00Z", deps);
    expect(steps).toEqual(["offset 86400000", "capability on"]);
  });

  test("reads a time without a zone in the simulator's zone", async () => {
    const { deps, steps } = clockDeps("Asia/Tokyo");
    await writeClock(UDID, "2026-11-03T10:00:00", deps);
    expect(steps[0]).toBe("offset 3600000");
  });

  test("names no host zone when it refuses a time in it", async () => {
    const { deps } = clockDeps();
    // Berlin skips 02:30 on 2030-03-31; the reason may go to a remote caller.
    await expect(writeClock(UDID, "2030-03-31T02:30", deps)).rejects.toThrow(
      "2030-03-31T02:30 does not exist in the host's zone: daylight saving time skips it. Choose another time.",
    );
  });

  test("reads it in the Mac's zone when the simulator uses the Mac's", async () => {
    const { deps, steps } = clockDeps();
    // Berlin is UTC+1 in November.
    await writeClock(UDID, "2026-11-03T02:00:00", deps);
    expect(steps[0]).toBe("offset 3600000");
  });

  test("host writes no offset, so loaded dylibs return, then disables the capability", async () => {
    const { deps, steps } = clockDeps();
    await writeClock(UDID, HOST_CLOCK, deps);
    expect(steps).toEqual(["offset 0", "capability off"]);
  });

  test("a failed host reset preserves the shifted time reported to callers", async () => {
    const failure = new Error("capability configuration could not be withdrawn");
    const { deps, steps } = clockDeps("Asia/Tokyo", failure);
    let offset = 60_000;
    deps.readOffset = () => offset;
    deps.writeOffset = (_udid, value) => {
      offset = value;
      steps.push(`offset ${value}`);
    };
    deps.clockEnabled = () => true;
    const before = await readClock(UDID, deps);

    await expect(writeClock(UDID, HOST_CLOCK, deps)).rejects.toBe(failure);

    expect(await readClock(UDID, deps)).toBe(before);
    expect(steps).toEqual(["offset 0", "capability off", "offset 60000"]);
  });

  test("host can still be reset when the simulator's zone cannot be read", async () => {
    const { deps, steps } = clockDeps();
    deps.readZone = async () => {
      throw new Error("simctl timed out");
    };
    await writeClock(UDID, HOST_CLOCK, deps);
    expect(steps).toEqual(["offset 0", "capability off"]);
  });

  test("leaves the capability enabled if the host offset cannot be written", async () => {
    const { deps, steps } = clockDeps();
    const failure = new Error("offset file cannot be replaced");
    deps.writeOffset = () => {
      throw failure;
    };
    await expect(writeClock(UDID, HOST_CLOCK, deps)).rejects.toBe(failure);
    expect(steps).toEqual([]);
  });

  test("preserves the capability failure if restoring the offset also fails", async () => {
    const failure = new Error("capability configuration could not be withdrawn");
    const { deps, steps } = clockDeps(HOST_TIME_ZONE, failure);
    deps.writeOffset = (_udid, offset) => {
      if (offset !== 0) throw new Error("offset file cannot be restored");
      steps.push(`offset ${offset}`);
    };
    await expect(writeClock(UDID, HOST_CLOCK, deps)).rejects.toBe(failure);
    expect(steps).toEqual(["offset 0", "capability off"]);
  });

  test("serializes a reset after an in-flight set, leaving the clock at host time", async () => {
    const { deps, steps } = clockDeps();
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const pending = new Promise<void>((resolve) => (finish = resolve));
    deps.setCapability = async (_udid, enabled) => {
      steps.push(`capability ${enabled ? "on" : "off"}`);
      if (enabled) {
        started();
        await pending;
      }
    };
    const set = writeClock(UDID, "2026-11-04T00:00:00Z", deps);
    await entered;
    const reset = writeClock(UDID, HOST_CLOCK, deps);
    finish();
    await Promise.all([set, reset]);
    expect(steps).toEqual(["offset 86400000", "capability on", "offset 0", "capability off"]);
  });

  test("puts the previous offset back when no session owns the device", async () => {
    const { deps, steps } = clockDeps(HOST_TIME_ZONE, new Error("needs a serve-sim session"));
    await expect(writeClock(UDID, "2026-11-04T00:00:00Z", deps)).rejects.toThrow(/session/);
    expect(steps).toEqual(["offset 86400000", "capability on", "offset 5000"]);
  });

  test("needs no zone for a time that names its own", async () => {
    const { deps, steps } = clockDeps();
    deps.readZone = async () => {
      throw new Error("simctl timed out");
    };
    await writeClock(UDID, "2026-11-04T00:00:00Z", deps);
    expect(steps).toEqual(["offset 86400000", "capability on"]);
  });

  test("refuses a time before 1970", async () => {
    const { deps, steps } = clockDeps();
    await expect(writeClock(UDID, "1969-12-31T23:59:00Z", deps)).rejects.toThrow(/1970/);
    expect(steps).toEqual([]);
  });

  test("refuses a wall time that daylight saving time skips in the simulator's zone", async () => {
    const { deps, steps } = clockDeps("America/New_York");
    await expect(writeClock(UDID, "2030-03-10T02:30", deps)).rejects.toThrow(
      /does not exist in America\/New_York/,
    );
    expect(steps).toEqual([]);
  });

  test("refuses a time more than about 200 years away", async () => {
    const { deps, steps } = clockDeps();
    await expect(writeClock(UDID, "2299-01-01T00:00:00Z", deps)).rejects.toThrow(/200 years/);
    expect(steps).toEqual([]);
  });
});

describe("readClock", () => {
  test("reports host without an offset, else the shifted time now in the simulator's zone", async () => {
    const deps = (offset: number, zone: string, enabled = true): ClockDeps => ({
      readOffset: () => offset,
      now: () => NOW,
      readZone: async () => zone,
      hostZone: () => "Europe/Berlin",
      clockEnabled: () => enabled,
    });
    expect(await readClock(UDID, deps(0, "Asia/Tokyo"))).toBe(HOST_CLOCK);
    expect(await readClock(UDID, deps(60_000, "Asia/Tokyo"))).toBe("2026-11-03T09:01:00+09:00");
    expect(await readClock(UDID, deps(60_000, HOST_TIME_ZONE))).toBe("2026-11-03T01:01:00+01:00");
  });

  test("reports UTC when the simulator's zone cannot be read, so the time can still be reset", async () => {
    const value = await readClock(UDID, {
      readOffset: () => 60_000,
      now: () => NOW,
      readZone: async () => {
        throw new Error("simctl timed out");
      },
      clockEnabled: () => true,
    });
    expect(value).toBe("2026-11-03T00:01:00Z");
  });

  // The file outlives the session; apps launched after it use the host time.
  test("reports host once the session that set the time has ended", async () => {
    expect(
      await readClock(UDID, {
        readOffset: () => 60_000,
        now: () => NOW,
        readZone: async () => "Asia/Tokyo",
        clockEnabled: () => false,
      }),
    ).toBe(HOST_CLOCK);
  });
});

describe("the clock option", () => {
  test("parses a time and host, and lists what it accepts on a bad value", () => {
    expect(parseUiArgs(["clock", "2030-01-01T09:00"])).toMatchObject({
      command: "set",
      option: "clock",
      value: "2030-01-01T09:00:00",
    });
    expect(normalizeUiValue("clock", "reset")).toBe(HOST_CLOCK);
    expect(parseUiArgs(["clock", "tomorrow"])).toMatchObject({
      error: expect.stringMatching(/host/),
    });
  });
});
