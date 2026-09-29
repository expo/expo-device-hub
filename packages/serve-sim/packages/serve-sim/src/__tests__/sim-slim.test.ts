import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SLIM_CATEGORIES, SLIM_CATEGORIES, describeSlim, parseDisabled, parseRunning, resolveSlimProfile,
  restoreSimulator, slimSimulator, slimStatus,
} from "../sim-slim";

describe("profiles", () => {
  test("default is every category above photos", () => {
    const ids = SLIM_CATEGORIES.map((c) => c.id);
    expect([...DEFAULT_SLIM_CATEGORIES]).toEqual(ids.slice(0, ids.indexOf("photos")));
    const profile = resolveSlimProfile();
    expect(profile.categories).toEqual([...DEFAULT_SLIM_CATEGORIES]);
    expect(resolveSlimProfile("default")).toEqual(profile);
    expect(resolveSlimProfile("")).toEqual(profile);
    expect(profile.labels).toContain("com.apple.apsd");
    // What an app under test commonly exercises stays on.
    for (const kept of ["com.apple.assetsd", "com.apple.storekitd", "com.apple.swcd", "com.apple.contactsd"]) {
      expect(profile.labels).not.toContain(kept);
    }
  });

  test("all, lists, aliases, and unknown ids", () => {
    const all = resolveSlimProfile("all");
    expect(all.categories).toEqual(SLIM_CATEGORIES.map((c) => c.id));
    expect(all.labels).toHaveLength(170);
    expect(resolveSlimProfile("photos, push").categories).toEqual(["push", "photos"]);
    expect(resolveSlimProfile("default,photos").categories).toHaveLength(DEFAULT_SLIM_CATEGORIES.length + 1);
    expect(() => resolveSlimProfile("default,pushh")).toThrow(/Unknown slim category "pushh"/);
  });

  test("every label belongs to exactly one category and none is one serve-sim needs", () => {
    const seen = new Map<string, string>();
    for (const category of SLIM_CATEGORIES) {
      for (const label of category.labels) {
        expect(label).toMatch(/^com\.apple\.[A-Za-z0-9._-]+$/);
        expect(seen.get(label)).toBeUndefined();
        seen.set(label, category.id);
      }
    }
    const needed = ["logd", "diagnosticd", "backboardd", "SpringBoard", "runningboardd", "pboard", "kbd", "sharingd",
      "mobilesafari", "accessibility"];
    for (const label of seen.keys()) {
      expect(needed.some((n) => label.split(".").pop()!.toLowerCase() === n.toLowerCase())).toBe(false);
    }
  });
});

describe("launchctl output", () => {
  test("print-disabled accepts both value spellings", () => {
    const disabled = parseDisabled(`
	disabled services = {
		"com.apple.apsd" => disabled
		"com.apple.homed" => enabled
		"com.apple.tipsd" => true
		"com.apple.newsd" => false
	}`);
    expect([...disabled].sort()).toEqual(["com.apple.apsd", "com.apple.tipsd"]);
  });

  test("list keeps only services with a PID", () => {
    const running = parseRunning("PID\tStatus\tLabel\n-\t0\tcom.apple.progressd\n17836\t0\tcom.apple.apsd\n");
    expect([...running]).toEqual(["com.apple.apsd"]);
  });
});

/** A fake `simctl` that holds launchd state for one device and records mutations. */
function fakeDevice(disabled: string[], running: string[], failing: string[] = []) {
  const state = { disabled: new Set(disabled), running: new Set(running) };
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const [, , , verb, target] = args;
    if (verb === "print-disabled") {
      return `disabled services = {\n${[...state.disabled].map((l) => `\t"${l}" => disabled`).join("\n")}\n}`;
    }
    if (verb === "list") return `PID\tStatus\tLabel\n${[...state.running].map((l) => `101\t0\t${l}`).join("\n")}`;
    const label = target!.replace("system/", "");
    calls.push(`${verb} ${label}`);
    if (failing.includes(label)) throw Object.assign(new Error("failed"), { stderr: `could not ${verb}\nmore` });
    if (verb === "disable") state.disabled.add(label);
    if (verb === "enable") state.disabled.delete(label);
    if (verb === "bootout") state.running.delete(label);
    return "";
  };
  return { run, calls, state };
}

describe("slimSimulator", () => {
  const profile = { categories: ["x"], labels: ["com.apple.a", "com.apple.b", "com.apple.c"] };

  test("changes only what is needed and reports it", async () => {
    // a: already off and stopped. b: disabled but still running. c: on and running.
    const device = fakeDevice(["com.apple.a", "com.apple.b"], ["com.apple.b", "com.apple.c"]);
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result).toEqual({ disabled: ["com.apple.c"], stopped: ["com.apple.b", "com.apple.c"], failed: [] });
    expect(device.calls.sort()).toEqual(["bootout com.apple.b", "bootout com.apple.c", "disable com.apple.c"]);
    expect(describeSlim("UDID", profile, result)).toBe("[slim] UDID: x: 1 disabled, 2 stopped");
    // A second run is a no-op.
    const again = await slimSimulator("UDID", profile, device.run);
    expect(again).toEqual({ disabled: [], stopped: [], failed: [] });
    expect(device.calls).toHaveLength(3);
  });

  test("a service that cannot be disabled is left running and reported", async () => {
    const device = fakeDevice([], ["com.apple.b"], ["com.apple.b"]);
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result.failed).toEqual([{ label: "com.apple.b", error: "could not disable" }]);
    expect(result.stopped).toEqual([]);
    expect(device.state.running.has("com.apple.b")).toBe(true);
  });

  test("restore enables only the profile's disabled services, and status counts them", async () => {
    const device = fakeDevice(["com.apple.a", "com.apple.apsd", "com.apple.unrelated"], []);
    const restored = await restoreSimulator("UDID", profile, device.run);
    expect(restored).toEqual({ enabled: ["com.apple.a"], failed: [] });
    expect(device.state.disabled.has("com.apple.unrelated")).toBe(true);
    const status = await slimStatus("UDID", device.run);
    const push = status.find((s) => s.category.id === "push")!;
    expect(push).toMatchObject({ inDefault: true, off: 1 });
    expect(status.find((s) => s.category.id === "photos")).toMatchObject({ inDefault: false, off: 0 });
  });
});
