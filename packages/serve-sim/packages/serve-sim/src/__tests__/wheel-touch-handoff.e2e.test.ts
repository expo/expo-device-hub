import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import WebSocket from "ws";
import { WS_MSG_INPUT_ADMITTED } from "../socket/input-protocol";
import { stateFileForDevice, type ServeSimDeviceState } from "../state";
import { parseDetachState } from "./detach-state";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, useTempStateDir } from "./helpers";

// Reuse this fixture against an immutable previous runtime for a failing control.
const CLI_PATH = process.env.SERVE_SIM_TEST_CLI_PATH?.trim() || join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI_PATH) && existsSync(FIXTURE);
requireE2E("wheel-to-touch handoff", ready);
const describeWithSim = ready ? describe : describe.skip;

type ScrollState = {
  offset: number; contacts: number; tracking: boolean; dragging: boolean; decelerating: boolean;
  began: number; ended: number; cancelled: number;
};
type ScrollTouch = { phase: string; x: number; y: number; row: number | null };

describeWithSim(`wheel-to-touch handoff (sim ${udid ?? "<skipped>"})`, () => {
  let state: ServeSimDeviceState;
  let fixtureLog: string;
  let fixturePid = 0;
  let tempState: ReturnType<typeof useTempStateDir> | undefined;
  const sockets: WebSocket[] = [];

  function cli(...args: string[]): string {
    return execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf8", timeout: 105_000, env: { ...process.env },
    });
  }

  function simctl(...args: string[]): string {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8", stdio: "pipe", timeout: 30_000,
    });
  }

  function lines(): string[] {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }

  function events(start: number, kind: string): string[] {
    return lines().slice(start).map((line) => line.split("\t"))
      .filter(([event, pid]) => event === kind && Number(pid) === fixturePid)
      .map(([, , detail]) => detail!);
  }

  function states(start: number): ScrollState[] {
    return events(start, "scroll-state").map((value) => JSON.parse(value) as ScrollState);
  }

  function touches(start: number): ScrollTouch[] {
    return events(start, "scroll-touch").map((value) => JSON.parse(value) as ScrollTouch);
  }

  async function waitFor(read: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!read() && Date.now() < deadline) await Bun.sleep(5);
    expect(read(), what).toBe(true);
  }

  async function launch(): Promise<number> {
    const start = lines().length;
    try { simctl("terminate", udid!, APP); } catch {}
    const launched = simctl("launch", udid!, APP, "--scroll-test");
    const pid = /:\s*(\d+)\s*$/.exec(launched.trim());
    if (!pid) throw new Error(`Could not identify the fixture process: ${launched}`);
    fixturePid = Number(pid[1]);
    await waitFor(() => events(start, "scroll-ready").length === 1 && states(start).length > 0, "table ready");
    return start;
  }

  async function openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(state.wsUrl,
      state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined);
    socket.binaryType = "arraybuffer";
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Input socket was not admitted")), 10_000);
      socket.onmessage = (event) => {
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
        if (bytes?.length === 1 && bytes[0] === WS_MSG_INPUT_ADMITTED) { clearTimeout(timeout); resolve(); }
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error("Input socket failed")); };
      socket.onclose = () => { clearTimeout(timeout); reject(new Error("Input socket closed")); };
    });
    return socket;
  }

  function send(socket: WebSocket, tag: number, payload: object): void {
    socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  }

  async function tap(socket: WebSocket): Promise<void> {
    send(socket, 0x03, { type: "begin", x: 0.15, y: 0.12 });
    await Bun.sleep(20);
    send(socket, 0x03, { type: "end", x: 0.15, y: 0.12 });
  }

  async function released(start: number, count: number): Promise<void> {
    await waitFor(() => {
      const last = states(start).at(-1);
      return !!last && last.began === count && last.ended + last.cancelled === count
        && last.contacts === 0 && !last.tracking && !last.dragging && !last.decelerating;
    }, "UIKit released every touch and stopped scrolling");
    // Retain delayed selections as well as callbacks from the input dispatch itself.
    await Bun.sleep(250);
  }

  async function expectTapSelection(socket: WebSocket, start: number, count: number): Promise<void> {
    const tapStart = lines().length;
    await tap(socket);
    await released(start, count);
    const tapTouches = touches(tapStart);
    const began = tapTouches.filter((touch) => touch.phase === "began");
    expect(began).toHaveLength(1);
    expect(tapTouches.filter((touch) => touch.phase === "ended")).toHaveLength(1);
    expect(tapTouches.filter((touch) => touch.phase === "cancelled")).toHaveLength(0);
    expect(began[0]!.row).not.toBeNull();
    expect(events(tapStart, "scroll-row").map(Number)).toEqual([began[0]!.row!]);
  }

  beforeAll(async () => {
    tempState = useTempStateDir();
    simctl("install", udid!, FIXTURE);
    fixtureLog = join(simctl("get_app_container", udid!, APP, "data").trim(), "Documents/launches.tsv");
    const detach = spawnSync("node", [CLI_PATH, "--detach", "-p", String(await freePortAsync()), udid!], {
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 120_000, env: { ...process.env },
    });
    if (detach.status !== 0 || !detach.stdout) throw new Error(`serve-sim --detach failed: ${detach.stdout}`);
    const printed = parseDetachState<Pick<ServeSimDeviceState, "device">>(detach.stdout);
    expect(printed.device).toBe(udid!);
    state = JSON.parse(readFileSync(stateFileForDevice(udid!), "utf8")) as ServeSimDeviceState;
    expect(state.device).toBe(udid!);
    expect(state.pid).toBeGreaterThan(1);
    expect(state.pid).not.toBe(process.pid);
  }, 180_000);

  afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
  afterAll(() => {
    if (state) try { process.kill(state.pid, "SIGCONT"); } catch {}
    if (tempState) try { cli("--kill", udid!); } catch {}
    try { simctl("terminate", udid!, APP); } catch {}
    try { simctl("uninstall", udid!, APP); } catch {}
    tempState?.restore();
  }, 120_000);

  test("a plain tap selects its row exactly once", async () => {
    const start = await launch();
    await expectTapSelection(await openSocket(), start, 1);
  }, 30_000);

  test("wheel-only scrolling moves without selecting a row, then a settled tap selects", async () => {
    const start = await launch();
    const socket = await openSocket();
    send(socket, 0x0b, { dx: 0, dy: 0.15, x: 0.7, y: 0.8 });
    await released(start, 1);
    expect(events(start, "scroll-pan").length).toBeGreaterThan(0);
    expect(Math.max(...states(start).map((value) => value.offset)) - states(start)[0]!.offset).toBeGreaterThan(20);
    expect(events(start, "scroll-row")).toEqual([]);
    await expectTapSelection(socket, start, 2);
  }, 30_000);

  for (const paused of [false, true]) {
    test(`wheel burst followed by a tap${paused ? " after a paused helper resumes" : ""}`, async () => {
      const socket = await openSocket();
      for (let trial = 0; trial < 10; trial++) {
        const start = await launch();
        for (let index = 0; index < 5; index++) send(socket, 0x0b, { dx: 0, dy: 0.075, x: 0.7, y: 0.8 });
        if (paused) {
          // Queue the probe while the helper is stopped during the first move.
          // Waiting for a fixture receipt can miss the initial native sleep.
          await Bun.sleep(5);
          process.kill(state.pid, "SIGSTOP");
        }
        try {
          await Bun.sleep(paused ? 25 : 50);
          await tap(socket);
          if (paused) await Bun.sleep(10);
        } finally {
          if (paused) process.kill(state.pid, "SIGCONT");
        }
        await released(start, 2);
        const began = touches(start).filter((touch) => touch.phase === "began");
        expect(began).toHaveLength(2);
        const [wheel, probe] = began;
        expect(wheel!.row).not.toBeNull();
        expect(probe!.row).not.toBeNull();
        expect(wheel!.row).not.toBe(probe!.row);
        await waitFor(() => events(start, "scroll-pan").length > 0, "wheel reached UIKit pan recognition");
        const selected = events(start, "scroll-row").map(Number);
        expect(selected).not.toContain(wheel!.row!);
        // This interrupted probe checks selection safety. The settled tap below
        // separately requires successful selection after scrolling has stopped.
        expect(selected.length).toBeLessThanOrEqual(1);
        for (const row of selected) expect(row).toBe(probe!.row!);
        await expectTapSelection(socket, start, 3);
      }
    }, 180_000);
  }
});
