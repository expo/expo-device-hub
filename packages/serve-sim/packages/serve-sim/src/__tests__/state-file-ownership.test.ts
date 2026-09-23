import { e2eDevice } from "./e2e-preconditions";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { clearServeSimState, inProcessServeSimState, stateFileForDevice, writeServeSimState } from "../state";
import { freePortAsync, useTempStateDir } from "./helpers";

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");

function statePid(file: string): number {
  return (JSON.parse(readFileSync(file, "utf-8")) as { pid: number }).pid;
}

let tempState: ReturnType<typeof useTempStateDir>;

beforeAll(() => {
  tempState = useTempStateDir();
});

afterAll(() => {
  tempState?.restore();
});

describe("clearServeSimState", () => {
  const device = `OWNERSHIP-${process.pid}`;
  let file: string;

  beforeAll(() => {
    file = stateFileForDevice(device);
  });

  afterEach(() => {
    try { unlinkSync(file); } catch {}
  });

  test("drops the record the caller owns", () => {
    writeServeSimState(inProcessServeSimState(device, 3200));

    clearServeSimState(device, process.pid);

    expect(existsSync(file)).toBe(false);
  });

  test("keeps a successor's record when a late predecessor exits", () => {
    writeServeSimState(inProcessServeSimState(device, 3200));

    clearServeSimState(device, process.pid + 1);

    expect(existsSync(file)).toBe(true);
  });

  test("is a no-op when the device has no record", () => {
    expect(() => clearServeSimState(device, process.pid)).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

const bootedUdid = e2eDevice();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim state ownership e2e (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let stateFile: string;
  let predecessorPid = 0;

  function stopServer(): void {
    execFileSync("bun", ["run", CLI_PATH, "--kill", bootedUdid!], {
      stdio: "pipe", env: { ...process.env }, timeout: 75_000,
    });
  }

  async function startServerAsync(): Promise<number> {
    const port = await freePortAsync();
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", "-p", String(port), bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
      env: { ...process.env },
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout ?? "<none>"}`,
      );
    }
    return statePid(stateFile);
  }

  async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(() => {
    stateFile = stateFileForDevice(bootedUdid!);
    stopServer();
  }, 90_000);

  afterAll(() => {
    if (predecessorPid > 0) {
      try { process.kill(predecessorPid, "SIGCONT"); } catch {}
      try { process.kill(predecessorPid, "SIGKILL"); } catch {}
    }
    stopServer();
  }, 90_000);

  test("a late-exiting server does not unlink its replacement's record", async () => {
    predecessorPid = await startServerAsync();

    process.kill(predecessorPid, "SIGSTOP");
    process.kill(predecessorPid, "SIGTERM");
    // Allow a replacement to start while the predecessor has shutdown pending.
    clearServeSimState(bootedUdid!, predecessorPid);

    const successorPid = await startServerAsync();
    expect(successorPid).not.toBe(predecessorPid);

    process.kill(predecessorPid, "SIGCONT");
    await waitForExit(predecessorPid, 15_000);
    expect(() => process.kill(predecessorPid, 0)).toThrow();

    expect(existsSync(stateFile)).toBe(true);
    expect(statePid(stateFile)).toBe(successorPid);
  }, 120_000);
});
