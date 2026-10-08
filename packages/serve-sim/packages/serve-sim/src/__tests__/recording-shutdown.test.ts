import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecordingShutdown } from "../shutdown-budget";

test.each([false, true])("server shutdown preserves pending finalization and cleans up after success/failure=%s", async fails => {
  const directory = mkdtempSync(join(tmpdir(), "recording-shutdown-"));
  const device = "00000000-0000-0000-0000-000000000288";
  const state = join(directory, `server-${device}.json`);
  const output = join(directory, "recording.mp4");
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/recording-shutdown-server.child.ts")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SERVE_SIM_STATE_DIR: directory, RECORDING_SHUTDOWN_FAIL: fails ? "1" : "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", data => { stdout += data; });
  child.stderr!.on("data", data => { stderr += data; });
  const killer = setTimeout(() => child.kill("SIGKILL"), 4_000);
  const report = join(directory, `recording-shutdown-failed-${child.pid}.json`);
  const events = () => existsSync(join(directory, "events.ndjson"))
    ? readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const waitUntil = async (ready: () => boolean) => {
    for (let i = 0; i < 200 && !ready() && child.exitCode === null; i++) await Bun.sleep(10);
    expect(ready(), `stdout: ${stdout}\nstderr: ${stderr}`).toBe(true);
  };
  try {
    await waitUntil(() => stdout.includes('"port":'));
    const { port } = JSON.parse(stdout.trim());
    const started = await fetch(`http://127.0.0.1:${port}/helper/${device}/recording/video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: true, output: directory, recordingId: "deadline-test" }),
    });
    expect(await started.json()).toEqual({ recording: true });
    child.kill("SIGTERM");
    await waitUntil(() => stderr.includes("Recording shutdown exceeded 65 seconds"));
    expect(stderr).toContain(`PID ${child.pid}`);
    expect(child.exitCode).toBeNull();
    expect(JSON.parse(readFileSync(state, "utf8")).pid).toBe(child.pid);
    expect(readFileSync(output, "utf8")).toBe("unfinished");
    expect(existsSync(report)).toBe(false);
    expect(events().map(event => event.name)).toEqual(["writer-start"]);
    const exited = once(child, "exit");
    child.stdin!.write("finish");
    expect(await exited).toEqual([1, null]);
    expect(readFileSync(output, "utf8")).toBe("finished");
    expect(existsSync(join(directory, "session.json"))).toBe(!fails);
    expect(existsSync(state)).toBe(false);
    const failure = JSON.parse(readFileSync(report, "utf8"));
    expect(failure.pid).toBe(child.pid);
    expect(failure.errors.join("\n")).toContain("Recording shutdown exceeded 65 seconds");
    if (fails) expect(failure.errors.join("\n")).toContain("delayed native finish failed");
    expect(events().map(event => event.name)).toEqual(["writer-start", "writer-finish", "capture-disable", "device-disarm"]);
    for (const event of events().slice(2)) {
      expect(event.statePresent).toBe(true);
      expect(event.reportPresent).toBe(true);
    }
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([true, false])("early recording completion preserves success=%s without a timeout", async success => {
  let completed: boolean | undefined;
  await runRecordingShutdown({
    finishRecordings: async () => success,
    completeShutdown: async result => { completed = result; },
    onTimeout: () => { throw new Error("Completed shutdown must clear its deadline"); },
    timeoutMs: 50,
  });
  await Bun.sleep(75);
  expect(completed).toBe(success);
});

test("the recording deadline excludes cleanup after the writer completes", async () => {
  await runRecordingShutdown({
    finishRecordings: async () => true,
    completeShutdown: async () => { await Bun.sleep(75); },
    onTimeout: () => { throw new Error("Cleanup has its own shutdown budget"); },
    timeoutMs: 25,
  });
});
