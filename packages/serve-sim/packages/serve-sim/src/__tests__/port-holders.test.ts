import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { findOwnListeners } from "../ports";
import { recordState, useTempStateDir } from "./helpers";

const FOREIGN_PORT = 48831;
const OURS_PORT = 48832;
const STALE_PORT = 48833;
const SPACED_PORT = 48834;

let tempState: ReturnType<typeof useTempStateDir>;

beforeAll(() => {
  tempState = useTempStateDir();
});

afterAll(() => {
  tempState?.restore();
});

/** A listener on loopback only. Its command line is deliberately varied; nothing should read it. */
async function withListenerAsync(
  name: string,
  port: number,
  run: (pid: number, scratch: string) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "serve-sim-ports-"));
  const script = join(scratch, name);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(
    script,
    `require("net").createServer(() => {}).listen(${port}, "127.0.0.1", () => console.log("up"));`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} never listened`)), 5000);
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
    });
    await run(child.pid!, scratch);
  } finally {
    child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function withRecordedListenerAsync(
  name: string,
  udid: string,
  port: number,
  recordedPort: number,
  run: (pid: number) => Promise<void>,
): Promise<void> {
  await withListenerAsync(name, port, async (pid) => {
    const forget = recordState(udid, pid, recordedPort);
    try {
      await run(pid);
    } finally {
      forget();
    }
  });
}

describe("who serve-sim is willing to kill for a port", () => {
  // The preview picks the port, and a wildcard bind reports a loopback-held port as free, so
  // without an ownership check a request for someone else's port SIGKILLs whatever listens there.
  it("does not target a process it never recorded", async () => {
    await withListenerAsync("ngrok.js", FOREIGN_PORT, async () => {
      expect(findOwnListeners(FOREIGN_PORT)).toEqual([]);
    });
  }, 15_000);

  it("targets a helper it recorded on that port", async () => {
    await withRecordedListenerAsync("helper.js", "PORTS-TEST-OURS", OURS_PORT, OURS_PORT, async (pid) => {
      expect(findOwnListeners(OURS_PORT)).toEqual([pid]);
    });
  }, 15_000);

  it("does not target a recorded pid whose state names another port", async () => {
    await withRecordedListenerAsync(
      "helper.js",
      "PORTS-TEST-STALE",
      STALE_PORT,
      STALE_PORT + 1,
      async () => {
        expect(findOwnListeners(STALE_PORT)).toEqual([]);
      },
    );
  }, 15_000);

  it("targets a helper whose path contains a space", async () => {
    await withRecordedListenerAsync(
      join("My Repos", "serve-sim", "dist", "serve-sim.js"),
      "PORTS-TEST-SPACED",
      SPACED_PORT,
      SPACED_PORT,
      async (pid) => {
        expect(findOwnListeners(SPACED_PORT)).toEqual([pid]);
      },
    );
  }, 15_000);

  it("names a foreign holder by pid, without its command line", async () => {
    await withListenerAsync("ngrok.js", FOREIGN_PORT, async (pid, scratch) => {
      const said: string[] = [];
      const real = console.log;
      console.log = (...args: unknown[]) => void said.push(args.join(" "));
      try {
        findOwnListeners(FOREIGN_PORT);
      } finally {
        console.log = real;
      }
      const message = said.join("\n");
      expect(message).toContain(String(pid));
      expect(message).not.toContain("ngrok.js");
      expect(message).not.toContain(scratch);
    });
  }, 15_000);
});
