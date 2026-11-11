import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  cameraStateDir,
  cameraHelperBundlesFile,
  cameraHelperPidFile,
  cameraHelperSocketFile,
  ensureHelperWithSource,
  readInjectedCameraBundles,
  recordInjectedBundle,
} from "../capabilities/camera";

const devices: string[] = [];
function ownDevice(): string {
  const udid = randomUUID();
  devices.push(udid);
  mkdirSync(cameraStateDir(), { recursive: true });
  return udid;
}
afterAll(() => {
  for (const udid of devices) {
    for (const path of [
      cameraHelperPidFile(udid),
      cameraHelperBundlesFile(udid),
      cameraHelperSocketFile(udid),
    ]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

test("reuses a live helper despite forceBuild and preserves switch rejection errors", async () => {
  const udid = ownDevice();
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let reply: { ok?: boolean; error?: string } = { ok: true };
  const commands: unknown[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      commands.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      socket.end(JSON.stringify(reply) + "\n");
    });
  });
  try {
    await ready;
    if (!child.pid) throw new Error("Fixture child has no PID");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cameraHelperSocketFile(udid), resolve);
    });
    writeFileSync(cameraHelperPidFile(udid), String(child.pid));
    const opts = {
      udid,
      source: { kind: "image" as const, arg: "/fixture/image" },
      forceBuild: true,
    };
    const result = await ensureHelperWithSource(opts);
    expect(result.helperPid).toBe(child.pid);
    expect(result.relaunched).toBe(false);
    expect(result.shmName).toMatch(/^\/serve-sim-cam-[0-9a-f]{8}$/);
    expect(commands).toEqual([{ action: "switch", source: "image", arg: "/fixture/image" }]);
    reply = { ok: false, error: "fixture refused" };
    await expect(ensureHelperWithSource(opts)).rejects.toThrow("fixture refused");
    reply = {};
    await expect(ensureHelperWithSource(opts)).rejects.toThrow("helper rejected switch");
  } finally {
    try {
      unlinkSync(cameraHelperPidFile(udid));
    } catch {}
    try {
      child.kill();
    } catch {}
    await exited;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

test("deduplicates bundles for the current helper PID and preserves another device", () => {
  const udid = ownDevice();
  const other = ownDevice();
  writeFileSync(cameraHelperPidFile(udid), "111");
  writeFileSync(cameraHelperPidFile(other), "222");
  recordInjectedBundle(udid, "app.first", 111);
  recordInjectedBundle(udid, "app.second", 111);
  recordInjectedBundle(udid, "app.first", 111);
  recordInjectedBundle(other, "app.other", 222);
  expect(readInjectedCameraBundles(udid)).toEqual(["app.first", "app.second"]);
  writeFileSync(cameraHelperPidFile(udid), "333");
  recordInjectedBundle(udid, "app.new", 333);
  expect(readInjectedCameraBundles(udid)).toEqual(["app.new"]);
  expect(readInjectedCameraBundles(other)).toEqual(["app.other"]);
});
