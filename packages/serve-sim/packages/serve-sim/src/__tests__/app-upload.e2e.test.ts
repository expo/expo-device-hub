import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { runHostActionAsync } from "../host-actions";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();
const fixture = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const bundleId = "dev.expo.serve-sim.launch-fixture";
const ready = udid !== null && existsSync(fixture);
requireE2E("app fixture upload", ready);
const uploadId = `app-upload-e2e-${process.pid}.json`;
const action = (name: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action: name, params: { udid: udid!, bundleId, ...params } }, "serve-sim");

beforeAll(() => {
  if (ready) execFileSync("xcrun", ["simctl", "install", udid!, fixture], { timeout: 60_000 });
}, 60_000);
afterAll(async () => {
  if (!ready) return;
  await action("app.stop");
  await runHostActionAsync({ action: "upload.remove", params: { uploadId } }, "serve-sim");
  execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 60_000 });
}, 60_000);

test.skipIf(!ready)("seeds a stopped app's data container and preserves it through launch and deep link", async () => {
  const payload = '{"session":"fixture-only"}';
  expect((await action("app.launch")).exitCode).toBe(0);
  expect((await action("app.stop")).exitCode).toBe(0);
  expect((await runHostActionAsync({ action: "upload.append", params: { uploadId, data: Buffer.from(payload).toString("base64"), first: true } }, "serve-sim")).exitCode).toBe(0);
  expect((await action("app.file.upload", { uploadId, relativePath: "Documents/upload-fixture/session.json" })).exitCode).toBe(0);
  const container = (await action("app.container", { type: "data" })).stdout.trim();
  expect(readFileSync(join(container, "Documents/upload-fixture/session.json"), "utf8")).toBe(payload);
  expect((await action("app.launch", { launchArgs: ["-StorageSeed", "1"] })).exitCode).toBe(0);
  expect((await action("app.openUrl", { url: "serve-sim-fixture://storage-seeded" })).exitCode).toBe(0);
  let launches = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    try { launches = readFileSync(join(container, "Documents/launches.tsv"), "utf8"); } catch {}
    if (launches.includes("storage-seeded") && launches.includes("-StorageSeed")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(launches).toContain("-StorageSeed");
  expect(launches).toContain("storage-seeded");
  const read = await action("app.file.read", { relativePath: "Documents/upload-fixture/session.json" });
  expect(Buffer.from(read.stdout, "base64").toString()).toBe(payload);
  expect((await action("app.file.remove", { relativePath: "Documents/upload-fixture/session.json" })).exitCode).toBe(0);
  rmSync(join(container, "Documents/upload-fixture"), { recursive: true, force: true });
}, 60_000);
