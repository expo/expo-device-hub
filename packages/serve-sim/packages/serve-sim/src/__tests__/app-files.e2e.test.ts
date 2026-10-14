import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runHostActionAsync } from "../host-actions";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();
const fixture = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const bundleId = "dev.expo.serve-sim.launch-fixture";
const ready = udid !== null && existsSync(fixture);
requireE2E("app data files", ready);
const action = (name: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action: name, params: { udid: udid!, bundleId, ...params } }, "serve-sim");
let setup: string | undefined;
beforeAll(async () => {
  if (!ready) return;
  execFileSync("xcrun", ["simctl", "install", udid!, fixture], { timeout: 60_000 });
  await action("app.stop");
}, 60_000);
afterAll(() => {
  if (setup) rmSync(setup, { recursive: true, force: true });
  if (ready) execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 60_000 });
}, 60_000);

test.skipIf(!ready)("reads, lists and removes files from the selected Simulator app data container", async () => {
  const container = await action("app.container", { type: "data" });
  expect(container.exitCode).toBe(0);
  setup = join(container.stdout.trim(), "Documents/file-api-fixture");
  mkdirSync(setup, { recursive: true });
  writeFileSync(join(setup, "session.json"), '{"session":"fixture"}');
  expect(JSON.parse((await action("app.file.list", { relativePath: "Documents/file-api-fixture" })).stdout)).toEqual([{name:"session.json",type:"file"}]);
  const read = await action("app.file.read", { relativePath: "Documents/file-api-fixture/session.json" });
  expect(read.exitCode).toBe(0);
  expect(Buffer.from(read.stdout,"base64").toString()).toBe('{"session":"fixture"}');
  expect((await action("app.file.remove", { relativePath: "Documents/file-api-fixture/session.json" })).exitCode).toBe(0);
  expect(existsSync(join(setup,"session.json"))).toBe(false);
  expect((await action("app.file.remove", { relativePath: "Documents/file-api-fixture" })).exitCode).toBe(1);
}, 60_000);
