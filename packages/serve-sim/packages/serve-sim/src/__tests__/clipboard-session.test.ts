import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createClipboardSession } from "../clipboard-session";
import { capabilityConfigPath, enableCapabilities, isCapabilityEnabled, readLaunchState, releaseSessionSync } from "../launch-manager";
import { writeLaunchState } from "../launch-state";
import { simMiddleware } from "../middleware";
import { clipboardCapability } from "../sim-pasteboard-reader";
import { installShims, recordState, useTempStateDir } from "./helpers";

const UDID = `CLIPBOARD-SESSION-${process.pid}`;
const READER = "/test/libSimPasteboardReader.dylib";
const reader = { name: "clipboard", scope: "allApps" as const, dylib: READER, bundleId: null, ownerPid: process.pid };
let state: ReturnType<typeof useTempStateDir>;
let shims: ReturnType<typeof installShims>;
let prepare: ReturnType<typeof spyOn<typeof clipboardCapability, "setEnabled">>;
let oldCalls: string | undefined;
let oldFailDevice: string | undefined;
let oldOffDevice: string | undefined;

beforeEach(() => {
  state = useTempStateDir();
  oldCalls = process.env.TEST_CLIPBOARD_CALLS;
  oldFailDevice = process.env.TEST_CLIPBOARD_FAIL_DEVICE;
  oldOffDevice = process.env.TEST_CLIPBOARD_OFF_DEVICE;
  process.env.TEST_CLIPBOARD_CALLS = join(state.dir, "calls");
  delete process.env.TEST_CLIPBOARD_FAIL_DEVICE;
  delete process.env.TEST_CLIPBOARD_OFF_DEVICE;
  shims = installShims({ xcrun: `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CLIPBOARD_CALLS, args.join(" ") + "\\n");
if (args[2] === process.env.TEST_CLIPBOARD_FAIL_DEVICE) process.exit(1);
if (args[2] === process.env.TEST_CLIPBOARD_OFF_DEVICE) {
  console.error("Unable to perform operation because device is not booted");
  process.exit(1);
}
if (args[3] === "launchctl") {
  const file = join(dirname(process.env.TEST_CLIPBOARD_CALLS), args[2] + ".env");
  const env = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (args[4] === "getenv") console.log(env[args[5]] ?? "");
  else {
    if (args[4] === "setenv") env[args[5]] = args[6];
    else if (args[4] === "unsetenv") delete env[args[5]];
    writeFileSync(file, JSON.stringify(env));
  }
}
` });
  prepare = spyOn(clipboardCapability, "setEnabled").mockImplementation(async ({ enabled }) =>
    enabled ? { dylib: READER } : null,
  );
});

afterEach(() => {
  delete process.env.TEST_CLIPBOARD_FAIL_DEVICE;
  delete process.env.TEST_CLIPBOARD_OFF_DEVICE;
  for (const device of [UDID, `${UDID}-2`]) releaseSessionSync(device, process.pid, () => {});
  prepare.mockRestore();
  shims.restore();
  state.restore();
  if (oldCalls === undefined) delete process.env.TEST_CLIPBOARD_CALLS;
  else process.env.TEST_CLIPBOARD_CALLS = oldCalls;
  if (oldFailDevice === undefined) delete process.env.TEST_CLIPBOARD_FAIL_DEVICE;
  else process.env.TEST_CLIPBOARD_FAIL_DEVICE = oldFailDevice;
  if (oldOffDevice === undefined) delete process.env.TEST_CLIPBOARD_OFF_DEVICE;
  else process.env.TEST_CLIPBOARD_OFF_DEVICE = oldOffDevice;
});

describe("clipboard session", () => {
  test("initializes each device once, including simultaneous requests, without restarting apps", async () => {
    const clipboard = createClipboardSession();
    await Promise.all([clipboard.initialize(UDID), clipboard.initialize(UDID), clipboard.initialize(`${UDID}-2`)]);
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe(`all\t${READER}\t\t0\n`);
    const calls = readFileSync(process.env.TEST_CLIPBOARD_CALLS!, "utf8");
    expect(calls).not.toContain("simctl terminate");
    expect(calls).not.toContain("simctl launch");
    await clipboard.dispose();
    expect(readLaunchState(UDID)).toBeNull();
    expect(readLaunchState(`${UDID}-2`)).toBeNull();
  });

  test("uses an existing CLI reader without taking its cleanup ownership", async () => {
    await enableCapabilities(UDID, null, [reader], { relaunch: false });
    writeLaunchState(UDID, { ...readLaunchState(UDID)!, sessionPids: [process.pid] });
    prepare.mockClear();
    const clipboard = createClipboardSession();
    await clipboard.initialize(UDID);
    await clipboard.dispose();
    expect(prepare).not.toHaveBeenCalled();
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    expect(readLaunchState(UDID)?.sessionPids).toEqual([process.pid]);
  });

  test("retries failed initialization after a wait and restores launchd setup after an external device boot", async () => {
    let time = 0;
    prepare.mockRejectedValueOnce(new Error("reader could not load"));
    const clipboard = createClipboardSession(true, { now: () => time });
    await expect(clipboard.initialize(UDID)).rejects.toThrow("reader could not load");
    time += 5_000;
    await clipboard.initialize(UDID);
    writeFileSync(join(state.dir, `${UDID}.env`), "{}");
    time += 30_000;
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    await clipboard.dispose();
  });

  test("re-checks a finished setup at most once every 30 seconds", async () => {
    let time = 0;
    const getenvCalls = () => readFileSync(process.env.TEST_CLIPBOARD_CALLS!, "utf8").split("\n")
      .filter((line) => line.includes("launchctl getenv")).length;
    const clipboard = createClipboardSession(true, { now: () => time });
    await clipboard.initialize(UDID);
    const afterSetup = getenvCalls();
    time += 29_999;
    await Promise.all([clipboard.initialize(UDID), clipboard.initialize(UDID), clipboard.initialize(UDID)]);
    expect(getenvCalls()).toBe(afterSetup);

    time += 1;
    await clipboard.initialize(UDID);
    expect(getenvCalls()).toBeGreaterThan(afterSetup);
    expect(prepare).toHaveBeenCalledTimes(1);
    await clipboard.dispose();
  });

  test("waits longer after each failed setup and does not retry in between", async () => {
    let time = 0;
    prepare.mockRejectedValueOnce(new Error("reader could not load"))
      .mockRejectedValueOnce(new Error("reader could not load"));
    const clipboard = createClipboardSession(true, { now: () => time });
    await expect(clipboard.initialize(UDID)).rejects.toThrow("reader could not load");
    time += 4_999;
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(1);

    time += 1;
    await expect(clipboard.initialize(UDID)).rejects.toThrow("reader could not load");
    time += 9_999;
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(2);

    time += 1;
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    await clipboard.dispose();
  });

  test("a reboot retries a failed setup without waiting", async () => {
    prepare.mockRejectedValueOnce(new Error("reader could not load"));
    const clipboard = createClipboardSession(true, { now: () => 0 });
    await expect(clipboard.initialize(UDID)).rejects.toThrow("reader could not load");
    await clipboard.initialize(UDID, true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    await clipboard.dispose();
  });

  test("reinitializes if another action removed the reader", async () => {
    const clipboard = createClipboardSession();
    await clipboard.initialize(UDID);
    writeLaunchState(UDID, { launchArgs: [], capabilities: {} });
    await clipboard.initialize(UDID);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    await clipboard.dispose();
  });

  test("an explicit disable removes an armed reader and does not restart apps", async () => {
    await enableCapabilities(UDID, null, [reader], { relaunch: false });
    const clipboard = createClipboardSession(false);
    await clipboard.initialize(UDID);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(false);
    expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe("");
    expect(readFileSync(process.env.TEST_CLIPBOARD_CALLS!, "utf8")).not.toContain("simctl terminate");
    await clipboard.dispose();
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("disposal leaves another capability and its loader ownership intact", async () => {
    const clipboard = createClipboardSession();
    await clipboard.initialize(UDID);
    await enableCapabilities(UDID, null, [{ name: "camera", dylib: "/camera.dylib", scope: "allApps" }], { relaunch: false });
    await clipboard.dispose();
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(false);
    expect(readLaunchState(UDID)?.capabilities.camera?.ownerPid).toBe(process.pid);
    expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toContain("/camera.dylib");
  });

  test("disposal waits for pending initialization before withdrawing it", async () => {
    let proceed!: () => void;
    const blocked = new Promise<void>((resolve) => { proceed = resolve; });
    prepare.mockImplementationOnce(async () => {
      await blocked;
      return { dylib: READER };
    });
    const clipboard = createClipboardSession();
    const initialized = clipboard.initialize(UDID);
    let disposed = false;
    const disposal = clipboard.dispose().then(() => { disposed = true; });
    await Bun.sleep(10);
    expect(disposed).toBe(false);
    proceed();
    await Promise.all([initialized, disposal]);
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("a reboot during pending initialization configures the new boot afterwards", async () => {
    let proceed!: () => void;
    const blocked = new Promise<void>((resolve) => { proceed = resolve; });
    const order: string[] = [];
    prepare.mockImplementationOnce(async () => {
      await blocked;
      order.push("before reboot");
      return { dylib: READER };
    }).mockImplementationOnce(async () => {
      order.push("after reboot");
      return { dylib: READER };
    });
    const clipboard = createClipboardSession();
    const pending = clipboard.initialize(UDID);
    const rebooted = clipboard.initialize(UDID, true);
    proceed();
    await Promise.all([pending, rebooted]);
    expect(order).toEqual(["before reboot", "after reboot"]);
    await clipboard.dispose();
  });

  test("an explicit disable withdraws stale config left by an exited reader owner", async () => {
    await enableCapabilities(UDID, null, [reader], { relaunch: false });
    writeLaunchState(UDID, { launchArgs: [], capabilities: { clipboard: { ...reader, ownerPid: 2_147_483_647 } } });
    const clipboard = createClipboardSession(false);
    await clipboard.initialize(UDID);
    expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe("");
    await clipboard.dispose();
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("disposal reports a failed device and still releases the other devices", async () => {
    const clipboard = createClipboardSession();
    await clipboard.initialize(UDID);
    await clipboard.initialize(`${UDID}-2`);
    process.env.TEST_CLIPBOARD_FAIL_DEVICE = UDID;
    await expect(clipboard.dispose()).rejects.toThrow("Could not release the clipboard session");
    expect(readLaunchState(`${UDID}-2`)).toBeNull();
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    delete process.env.TEST_CLIPBOARD_FAIL_DEVICE;
    await clipboard.dispose();
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("disposal clears saved ownership after the simulator has shut down", async () => {
    const clipboard = createClipboardSession();
    await clipboard.initialize(UDID);
    process.env.TEST_CLIPBOARD_OFF_DEVICE = UDID;
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await clipboard.dispose();
      expect(readLaunchState(UDID)).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});

describe("clipboard in the preview middleware", () => {
  const apiRequest = () => new Request("http://localhost:3200/.sim/api");

  test("answers /api without waiting for the setup it starts", async () => {
    const forgetState = recordState(UDID, process.pid, 3200);
    let proceed!: () => void;
    const blocked = new Promise<void>((resolve) => { proceed = resolve; });
    prepare.mockImplementationOnce(async () => {
      await blocked;
      return { dylib: READER };
    });
    const middleware = simMiddleware({ device: UDID });
    try {
      expect((await middleware(apiRequest()))?.status).toBe(200);
      expect(isCapabilityEnabled(UDID, "clipboard")).toBe(false);
      proceed();
      for (let attempt = 0; attempt < 200 && !isCapabilityEnabled(UDID, "clipboard"); attempt++) await Bun.sleep(10);
      expect(isCapabilityEnabled(UDID, "clipboard")).toBe(true);
    } finally {
      proceed();
      await middleware.dispose();
      forgetState();
    }
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("an unmanaged middleware neither sets up nor removes the session's reader", async () => {
    await enableCapabilities(UDID, null, [reader], { relaunch: false });
    const armed = readLaunchState(UDID);
    const forgetState = recordState(UDID, process.pid, 3200);
    const callsBefore = readFileSync(process.env.TEST_CLIPBOARD_CALLS!, "utf8");
    const middleware = simMiddleware({ device: UDID, clipboard: "unmanaged" });
    try {
      expect((await middleware(apiRequest()))?.status).toBe(200);
      await Bun.sleep(50);
      await middleware.dispose();
      expect(prepare).not.toHaveBeenCalled();
      expect(readLaunchState(UDID)).toEqual(armed);
      const calls = readFileSync(process.env.TEST_CLIPBOARD_CALLS!, "utf8").slice(callsBefore.length);
      expect(calls).not.toContain("launchctl");
    } finally {
      forgetState();
    }
  });
});

describe("clipboard release at process exit", () => {
  const env = () => JSON.parse(readFileSync(join(state.dir, `${UDID}.env`), "utf8")) as Record<string, string>;

  // A host like the Hub: it sets up the reader, and its SIGINT handler ends with process.exit.
  async function runHost(beforeExit = "", { handlesSigint = true } = {}) {
    const script = `
      const { createClipboardSession } = await import(${JSON.stringify(join(import.meta.dir, "../clipboard-session.ts"))});
      const { clipboardCapability } = await import(${JSON.stringify(join(import.meta.dir, "../sim-pasteboard-reader.ts"))});
      clipboardCapability.setEnabled = async ({ enabled }) => enabled ? { dylib: ${JSON.stringify(READER)} } : null;
      const clipboard = createClipboardSession();
      await clipboard.initialize(${JSON.stringify(UDID)});
      ${beforeExit}
      ${handlesSigint ? `process.on("SIGINT", () => process.exit(0));` : ""}
      console.log("ready");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
        void exited.then(() => reject(new Error(`host exited before it was ready: ${stderr}`)));
      });
      const armed = env();
      const started = Date.now();
      child.kill("SIGINT");
      const { code, signal } = await exited;
      return { armed, code, signal, stderr, exitMs: Date.now() - started };
    } finally {
      child.kill("SIGKILL");
    }
  }

  test("releases the setup when the host exits", async () => {
    const { armed, code } = await runHost();
    expect(code).toBe(0);
    expect(armed.DYLD_INSERT_LIBRARIES).toContain("libServeSimCapabilityLoader.dylib");
    expect(armed.SERVE_SIM_CAPABILITIES_CONFIG).toBeDefined();
    expect(env().DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env().SERVE_SIM_CAPABILITIES_CONFIG).toBeUndefined();
    expect(existsSync(join(state.dir, `launch-${UDID}.json`))).toBe(false);
  });

  // LLP 0010: an unhandled signal ends the process without an `exit` event, so nothing is released.
  test("keeps the setup when the host dies from a signal it does not handle", async () => {
    const { armed, code, signal } = await runHost("", { handlesSigint: false });
    expect(code).toBeNull();
    expect(signal).toBe("SIGINT");
    expect(armed.DYLD_INSERT_LIBRARIES).toContain("libServeSimCapabilityLoader.dylib");
    expect(env().DYLD_INSERT_LIBRARIES).toBe(armed.DYLD_INSERT_LIBRARIES);
  });

  test("skips a device that dispose already released", async () => {
    const calls = process.env.TEST_CLIPBOARD_CALLS!;
    const { code } = await runHost(`
      await clipboard.dispose();
      require("fs").appendFileSync(${JSON.stringify(calls)}, "disposed\\n");
    `);
    expect(code).toBe(0);
    expect(readFileSync(calls, "utf8").split("disposed\n")[1]).toBe("");
  });

  test("logs and exits when its own update still holds the device lock", async () => {
    const lock = join(state.dir, `launch-${UDID}.lock`);
    const { armed, code, stderr } = await runHost(`
      require("fs").writeFileSync(${JSON.stringify(lock)}, String(process.pid));
    `).finally(() => rmSync(lock, { force: true }));
    expect(code).toBe(0);
    expect(stderr).toContain(`Could not release the clipboard reader on ${UDID} at exit`);
    expect(env().DYLD_INSERT_LIBRARIES).toBe(armed.DYLD_INSERT_LIBRARIES);
  });

  test("gives up on a lock that another process holds after 5 s", async () => {
    const lock = join(state.dir, `launch-${UDID}.lock`);
    const { code, stderr, exitMs } = await runHost(`
      require("fs").writeFileSync(${JSON.stringify(lock)}, String(process.ppid));
    `).finally(() => rmSync(lock, { force: true }));
    expect(code).toBe(0);
    expect(stderr).toContain(`Could not release the clipboard reader on ${UDID} at exit`);
    expect(exitMs).toBeGreaterThanOrEqual(5_000);
    expect(exitMs).toBeLessThan(10_000);
  }, 20_000);
});
