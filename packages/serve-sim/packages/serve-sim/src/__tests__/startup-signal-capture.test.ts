import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["enable", "launch", "bind"])(
  "startup SIGTERM cleans up capture before preview ownership: %s",
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), "startup-signal-capture-"));
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/startup-signal-capture.child.ts")],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          REPRO_PHASE: phase,
          SERVE_SIM_STATE_DIR: directory,
          SERVE_SIM_CAPTURE_CA_DIR: join(directory, "capture-ca"),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data) => {
      stdout += data;
    });
    child.stderr!.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    const events = () =>
      existsSync(join(directory, "events.ndjson"))
        ? readFileSync(join(directory, "events.ndjson"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    const waitUntil = async (ready: () => boolean) => {
      for (let i = 0; i < 300 && !ready() && child.exitCode === null; i++) await Bun.sleep(10);
      expect(ready(), `stdout: ${stdout}\nstderr: ${stderr}`).toBe(true);
    };
    try {
      await waitUntil(() => stdout.includes("startup-ready"));
      expect(events().find((event) => event.name === "startup-ready")).toMatchObject({
        armed: true,
        capturing: true,
        listeners: 2,
      });
      child.kill("SIGTERM");
      await waitUntil(() => events().some((event) => event.name === "disable-requested"));
      child.stdin!.end("finish-startup");
      expect(await exited).toEqual([0, null]);
      expect(events().map((event) => event.name)).toContain("disable-complete");
      expect(events().map((event) => event.name)).toContain("disarm");
      expect(events().at(-1)).toMatchObject({ name: "exit", capturing: false, armed: false });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  8000,
);
