import { describe, expect, test } from "bun:test";
import { DEFAULT_SLIM_CATEGORIES, NEVER_SLIM, SLIM_CATEGORIES, resolveSlimProfile } from "../catalog";
import { describeSlim, parseDisabled, parseLoaded, restoreSimulator, slimSimulator, slimStatus } from "../launchd";

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

  test("every label belongs to exactly one category", () => {
    const seen = new Map<string, string>();
    for (const category of SLIM_CATEGORIES) {
      for (const label of category.labels) {
        expect(label).toMatch(/^com\.apple\.[A-Za-z0-9._-]+$/);
        expect(seen.get(label)).toBeUndefined();
        seen.set(label, category.id);
      }
    }
  });

  test("no category contains a service that must stay on", () => {
    expect(Object.keys(NEVER_SLIM)).toContain("com.apple.sharingd");
    const all = resolveSlimProfile("all").labels;
    for (const label of Object.keys(NEVER_SLIM)) expect(all).not.toContain(label);
    // Also by daemon name, in case a runtime moves one under another prefix.
    const names = new Set(Object.keys(NEVER_SLIM).map((l) => l.split(".").pop()!.toLowerCase()));
    for (const label of all) expect(names.has(label.split(".").pop()!.toLowerCase())).toBe(false);
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

  test("list reports loaded services, running or not", () => {
    const loaded = parseLoaded("PID\tStatus\tLabel\n-\t0\tcom.apple.progressd\n17836\t0\tcom.apple.apsd\n");
    expect([...loaded]).toEqual(["com.apple.progressd", "com.apple.apsd"]);
  });
});

/** A fake `simctl` for one device; `ignored` labels accept `disable` but stay enabled. */
function fakeDevice(disabled: string[], running: string[], failing: string[] = [], ignored: string[] = []) {
  // `idle`: loaded without a PID; `launchctl list` shows them with `-`.
  const state = { disabled: new Set(disabled), running: new Set(running), idle: new Set<string>() };
  const calls: string[] = [];
  const reads = { printDisabled: 0 };
  const run = async (args: string[]) => {
    const [, , , verb, target] = args;
    if (verb === "print-disabled") {
      reads.printDisabled++;
      return `disabled services = {\n${[...state.disabled].map((l) => `\t"${l}" => disabled`).join("\n")}\n}`;
    }
    if (verb === "list") {
      const rows = [...[...state.running].map((l) => `101\t0\t${l}`), ...[...state.idle].map((l) => `-\t0\t${l}`)];
      return `PID\tStatus\tLabel\n${rows.join("\n")}`;
    }
    const label = target!.replace("system/", "");
    calls.push(`${verb} ${label}`);
    if (failing.includes(label)) throw Object.assign(new Error("failed"), { stderr: `could not ${verb}\nmore` });
    if (verb === "disable" && !ignored.includes(label)) state.disabled.add(label);
    if (verb === "enable") state.disabled.delete(label);
    if (verb === "bootout") {
      state.running.delete(label);
      state.idle.delete(label);
    }
    return "";
  };
  return { run, calls, reads, state };
}

describe("slimSimulator", () => {
  const profile = { categories: ["x"], labels: ["com.apple.a", "com.apple.b", "com.apple.c"] };

  test("changes only what is needed and reports it", async () => {
    // a: already off and unloaded. b: disabled but still running. c: on and running.
    const device = fakeDevice(["com.apple.a", "com.apple.b"], ["com.apple.b", "com.apple.c"]);
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result).toEqual({ disabled: ["com.apple.c"], unloaded: ["com.apple.b", "com.apple.c"], failed: [] });
    expect(device.calls.sort()).toEqual(["bootout com.apple.b", "bootout com.apple.c", "disable com.apple.c"]);
    expect(describeSlim("UDID", profile, result)).toBe("[slim] UDID: x: 1 disabled, 2 unloaded");
    // The disable was read back once.
    expect(device.reads.printDisabled).toBe(2);
    // A second run is a no-op and skips the read-back.
    const again = await slimSimulator("UDID", profile, device.run);
    expect(again).toEqual({ disabled: [], unloaded: [], failed: [] });
    expect(device.calls).toHaveLength(3);
    expect(device.reads.printDisabled).toBe(3);
  });

  test("a disable that exits 0 but does not show in print-disabled is reported and not booted out", async () => {
    const device = fakeDevice([], ["com.apple.a", "com.apple.b"], [], ["com.apple.a"]);
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result).toEqual({
      disabled: ["com.apple.b", "com.apple.c"],
      unloaded: ["com.apple.b"],
      failed: [{ label: "com.apple.a", error: "disable did not take: not in print-disabled" }],
    });
    expect(device.state.running.has("com.apple.a")).toBe(true);
  });

  test("workers bounds how many launchctl calls run at a time", async () => {
    const labels = Array.from({ length: 10 }, (_, i) => `com.apple.s${i}`);
    const wide = { categories: ["x"], labels };
    for (const [workers, expected] of [[1, 1], [4, 4]] as const) {
      const device = fakeDevice([], labels);
      let active = 0;
      let peak = 0;
      // Only disable and bootout count; the two reads at the start run together by design.
      const run = async (args: string[]) => {
        const mutation = args[3] === "disable" || args[3] === "bootout";
        if (mutation) peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (mutation) active--;
        return device.run(args);
      };
      const result = await slimSimulator("UDID", wide, run, workers);
      expect(result.disabled).toHaveLength(10);
      expect(result.unloaded).toHaveLength(10);
      expect(peak).toBe(expected);
    }
  });

  test("a loaded service is booted out even when it is not running", async () => {
    // b is disabled and idle: launchd could still start it on demand while it stays loaded.
    const device = fakeDevice(["com.apple.a", "com.apple.b"], []);
    device.state.idle.add("com.apple.b");
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result).toEqual({ disabled: ["com.apple.c"], unloaded: ["com.apple.b"], failed: [] });
    expect(device.state.idle.size).toBe(0);
  });

  test("a service that cannot be disabled is left running and reported", async () => {
    const device = fakeDevice([], ["com.apple.b"], ["com.apple.b"]);
    const result = await slimSimulator("UDID", profile, device.run);
    expect(result.failed).toEqual([{ label: "com.apple.b", error: "could not disable" }]);
    expect(result.unloaded).toEqual([]);
    expect(device.state.running.has("com.apple.b")).toBe(true);
  });

  test("restore enables only the profile's disabled services, and status counts them", async () => {
    const device = fakeDevice(["com.apple.a", "com.apple.apsd", "com.apple.unrelated"], []);
    const restored = await restoreSimulator("UDID", profile, device.run);
    expect(restored).toEqual({ enabled: ["com.apple.a"], failed: [] });
    expect(device.state.disabled.has("com.apple.unrelated")).toBe(true);
    const status = await slimStatus("UDID", device.run);
    const push = status.find((s) => s.category.id === "push")!;
    expect(push).toMatchObject({ inDefault: true, off: 1, disabledButLoaded: 0 });
    expect(status.find((s) => s.category.id === "photos")).toMatchObject({ inDefault: false, off: 0 });
  });

  test("status does not count a disabled service that is still loaded as off", async () => {
    const device = fakeDevice(["com.apple.apsd"], []);
    device.state.idle.add("com.apple.apsd");
    const push = (await slimStatus("UDID", device.run)).find((s) => s.category.id === "push")!;
    expect(push).toMatchObject({ off: 0, disabledButLoaded: 1 });
  });

  test("a service that loads while the labels are disabled is booted out too", async () => {
    // An app launched next to the slim loads c after the first read, while a is disabled.
    const device = fakeDevice([], ["com.apple.a"]);
    const run = async (args: string[]) => {
      if (args[3] === "disable" && args[4] === "system/com.apple.a") device.state.idle.add("com.apple.c");
      return device.run(args);
    };
    const result = await slimSimulator("UDID", profile, run);
    expect(result.unloaded).toEqual(["com.apple.a", "com.apple.c"]);
    expect(device.state.idle.size + device.state.running.size).toBe(0);
  });
});
