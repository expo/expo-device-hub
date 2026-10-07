import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runHostActionAsync } from "../host-actions";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();
const fixture = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const bundleId = "dev.expo.serve-sim.launch-fixture";
const ready = udid !== null && existsSync(fixture);
requireE2E("app controls", ready);
const action = (name: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action: name, params: { udid: udid!, bundleId, ...params } }, "serve-sim");
beforeAll(() => {
  if (ready) execFileSync("xcrun", ["simctl", "install", udid!, fixture], { timeout: 60_000 });
}, 60_000);
afterAll(async () => {
  if (!ready) return;
  await action("app.stop");
  execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 60_000 });
}, 60_000);

test.skipIf(!ready)("stops an app, restarts with arguments, and delivers a standalone deep link", async () => {
  expect((await action("app.launch")).exitCode).toBe(0);
  expect((await action("app.stop")).exitCode).toBe(0);
  expect((await action("app.stop")).exitCode).not.toBe(0);
  expect((await action("app.launch", { launchArgs: ["-ControlFixture", "1"] })).exitCode).toBe(0);
  expect((await action("app.openUrl", { udid: udid!.toLowerCase(), url: "serve-sim-fixture://control-fixture" })).exitCode).toBe(0);
  const container = (await action("app.container")).stdout.trim();
  const data = execFileSync("xcrun", ["simctl", "get_app_container", udid!, bundleId, "data"], { encoding: "utf8" }).trim();
  expect(container).toContain(".app");
  let launches = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    try { launches = readFileSync(join(data, "Documents/launches.tsv"), "utf8"); } catch {}
    if (launches.includes("control-fixture") && launches.includes("-ControlFixture")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(launches).toContain("-ControlFixture");
  expect(launches).toContain("control-fixture");
}, 60_000);
