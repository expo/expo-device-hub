import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adoptSession } from "../session-owner";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";
import { useTempStateDir } from "./helpers";

const first = "00000000-0000-0000-0000-000000000601";
const extra = "00000000-0000-0000-0000-000000000602";
const fresh = "00000000-0000-0000-0000-000000000603";
const version = JSON.parse(
  readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
).version;

test.each([
  { selection: "prepared extra", selected: extra },
  { selection: "unprepared device", selected: fresh },
])(
  "orphan adopts $selection with the real manager and default Clipboard",
  async ({ selected }) => {
    const state = useTempStateDir();
    const originalSimpb = process.env.SERVE_SIM_SIMPB_DIR;
    process.env.SERVE_SIM_SIMPB_DIR = join(state.dir, "warm-selected-assets");
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/warm-selected-device.child.ts")],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const childTimeout = setTimeout(terminate, 10_000);
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (data) => {
      stdout += data;
    });
    child.stderr!.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    const waitFor = async (predicate: () => boolean) => {
      for (let step = 0; step < 500 && !predicate() && child.exitCode === null; step++)
        await Bun.sleep(10);
      expect(predicate(), stderr).toBe(true);
    };
    const file = (prefix: string, udid: string, extension = "json") =>
      join(state.dir, `${prefix}-${udid}.${extension}`);
    const read = (prefix: string, udid: string) =>
      JSON.parse(readFileSync(file(prefix, udid), "utf8"));
    const commands = (): string[][] =>
      readFileSync(join(state.dir, "warm-selected-native.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const mutations = (udid: string) =>
      commands().filter(
        (args) =>
          args[0] === "spawn" &&
          args[1] === udid &&
          args[2] === "launchctl" &&
          (args[3] === "setenv" || args[3] === "unsetenv"),
      );
    try {
      await waitFor(() => stdout.includes('"port"') && existsSync(file("server", extra)));
      const initial = read("server", first);
      const warmed = read("server", extra);
      expect(warmed).toMatchObject({ pid: child.pid, port: initial.port, token: initial.token });
      for (const udid of [first, extra]) {
        expect(read("launch", udid).capabilities.clipboard).toMatchObject({
          ownerPid: child.pid,
          scope: "allApps",
          loadDelayMs: 0,
        });
      }
      expect(existsSync(file("launch", fresh))).toBe(false);
      const selectedMutations = mutations(selected).length;
      const selectedConfig =
        selected === extra
          ? readFileSync(file("capabilities", selected, "conf"), "utf8")
          : undefined;
      const adopted = await adoptSession(selected, version, "127.0.0.1", initial.port, {
        device: selected,
        singleDevice: selected,
        stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
        corsOrigins: [],
        frameAncestors: [],
        disableShare: false,
        networkCapture: false,
        networkCaptureFields: [],
      });
      expect(adopted).toMatchObject({ device: selected, port: initial.port });
      expect(read("server", selected)).toMatchObject({
        device: selected,
        pid: child.pid,
        port: initial.port,
        token: initial.token,
      });
      expect(read("launch", selected)).toMatchObject({
        exclusivePid: child.pid,
        sessionPids: [child.pid],
        capabilities: { clipboard: { ownerPid: child.pid, scope: "allApps" } },
      });
      const config = readFileSync(file("capabilities", selected, "conf"), "utf8");
      expect(config).toContain("libSimPasteboardReader.dylib");
      if (selected === extra) {
        expect(config).toBe(selectedConfig!);
        expect(mutations(selected)).toHaveLength(selectedMutations);
      } else {
        expect(commands()).toContainEqual(["boot", fresh]);
        expect(mutations(fresh).length).toBeGreaterThan(0);
      }
      const ready = await fetch(`http://127.0.0.1:${initial.port}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: "ready", device: selected });
      const retired = [first, extra].filter((udid) => udid !== selected);
      await waitFor(() => retired.every((udid) => !existsSync(file("launch", udid))));
      for (const udid of retired) {
        expect(existsSync(file("server", udid))).toBe(false);
        expect(existsSync(file("capabilities", udid, "conf"))).toBe(false);
        expect(
          commands().filter((args) => args[0] === "shutdown" && args[1] === udid),
        ).toHaveLength(1);
      }
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      expect((await exited)[0], stderr).toBe(0);
      expect(existsSync(file("launch", selected))).toBe(false);
      expect(existsSync(file("capabilities", selected, "conf"))).toBe(false);
      expect(existsSync(file("server", selected))).toBe(false);
      expect(existsSync(join(state.dir, `owner-port-${initial.port}.json`))).toBe(false);
    } finally {
      clearTimeout(childTimeout);
      if (child.exitCode === null && child.signalCode === null) {
        terminate();
        await exited;
      }
      if (forceKill) clearTimeout(forceKill);
      if (originalSimpb === undefined) delete process.env.SERVE_SIM_SIMPB_DIR;
      else process.env.SERVE_SIM_SIMPB_DIR = originalSimpb;
      state.restore();
    }
  },
  15_000,
);
