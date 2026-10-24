import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
  renameSync,
} from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { join } from "path";

const PKG = join(import.meta.dir, "../..");
const CLI = join(PKG, "dist/serve-sim.js");
const APP = join(PKG, "dist/simperm/SimPermissionsFixture.app");
const BUNDLE = "dev.expo.serve-sim.permissions-fixture";
const udid = e2eDevice();
const ready = Boolean(udid && existsSync(CLI) && existsSync(APP));
requireE2E("permissions.e2e", ready);
const T = 150_000;
function sim(...args: string[]) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 30_000 });
}
function cli(...args: string[]) {
  return execFileSync("node", [CLI, "permissions", ...args, "-d", udid!], {
    encoding: "utf8",
    timeout: 60_000,
  });
}
function list() {
  return JSON.parse(cli("list", BUNDLE));
}
let documents: string;
function state() {
  return JSON.parse(readFileSync(join(documents, "state.json"), "utf8"));
}
function writeCommand(directory: string, value: object) {
  const temporary = join(directory, `command-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, join(directory, "command.json"));
}
function command(action: string, tag?: string) {
  writeCommand(documents, { action, tag });
}
async function eventually(check: () => boolean) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    try {
      if (check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(check()).toBe(true);
}
function springboard() {
  return sim("spawn", udid!, "launchctl", "list")
    .split("\n")
    .filter((line) => /springboard/i.test(line));
}

describe.skipIf(!ready)("service-backed permissions (real Simulator)", () => {
  beforeAll(async () => {
    sim("install", udid!, APP);
    documents = join(sim("get_app_container", udid!, BUNDLE, "data").trim(), "Documents");
    cli("reset", "all", BUNDLE);
    cli("grant", "notifications", BUNDLE);
    const pid = Number(sim("launch", udid!, BUNDLE).trim().split(":").at(-1));
    await eventually(() => state().pid === pid && state().notifications === 2);
    // A normal request initializes notification capabilities, including on 27.1.
    command("request");
    await eventually(() => state().events.some((e: any) => e.event === "request" && e.granted));
    await eventually(() => state().alertSetting === 2);
  }, T);
  afterAll(() => {
    if (!documents) return;
    try {
      sim("terminate", udid!, BUNDLE);
    } catch {}
    sim("uninstall", udid!, BUNDLE);
  }, T);

  test(
    "notification grant/denial/reset and delivery change live, with idempotent calls",
    async () => {
      const initial = state();
      const sb = springboard();
      expect(sb.length).toBeGreaterThan(0);
      for (const [index, [action, status]] of (
        [
          ["grant", 2],
          ["revoke", 1],
          ["grant", 2],
          ["reset", 0],
          ["grant", 2],
        ] as const
      ).entries()) {
        cli(action, "notifications", BUNDLE);
        cli(action, "notifications", BUNDLE);
        await eventually(() => state().notifications === status);
        expect(list().notifications.authorizationStatus).toBe(status);
        const tag = `permission-${index}`;
        command("schedule", tag);
        if (status === 2) await eventually(() => state().delivered.includes(tag));
        else {
          await eventually(() =>
            state().events.some((e: any) => e.event === "schedule" && e.tag === tag),
          );
          await new Promise((r) => setTimeout(r, 1500));
          expect(state().delivered).not.toContain(tag);
        }
        expect(state().pid).toBe(initial.pid);
        expect(state().launchCount).toBe(initial.launchCount);
        expect(springboard()).toEqual(sb);
      }
    },
    T,
  );

  test.each(["camera", "microphone"])(
    "%s changes use tccd without killing the running app",
    async (permission) => {
      const initial = state();
      for (const [action, raw, publicValue] of [
        ["grant", 2, 3],
        ["revoke", 0, 2],
        ["reset", undefined, 0],
      ] as const) {
        cli(action, permission, BUNDLE);
        cli(action, permission, BUNDLE);
        expect(list().tcc[permission]).toBe(raw);
        await eventually(() => state()[permission] === publicValue);
        expect(state().pid).toBe(initial.pid);
        expect(state().launchCount).toBe(initial.launchCount);
      }
    },
    T,
  );

  test.each(["calendar", "reminders"])(
    "%s service changes preserve the app and public state applies after relaunch",
    async (permission) => {
      for (const [action, raw, expected] of [
        ["grant", 2, 3],
        ["revoke", 0, 2],
        ["reset", undefined, 0],
      ] as const) {
        const initial = state();
        cli(action, permission, BUNDLE);
        expect(list().tcc[permission]).toBe(raw);
        const finished = Date.now() / 1000;
        await eventually(() => state().timestamp > finished);
        expect(state().pid).toBe(initial.pid);
        expect(state().launchCount).toBe(initial.launchCount);
        console.log("EventKit before relaunch", {
          permission,
          action,
          public: state()[permission],
          stored: raw,
        });
        // A retained EKEventStore can cache authorization even though tccd changed.
        sim("terminate", udid!, BUNDLE);
        const pid = Number(sim("launch", udid!, BUNDLE).trim().split(":").at(-1));
        await eventually(() => state().pid === pid && state()[permission] === expected);
      }
    },
    T,
  );

  test(
    "Photos full/limited grants remain distinct and apply after app relaunch",
    async () => {
      cli("grant", "photos", BUNDLE);
      expect(list().tcc.photos).toBe(2);
      await eventually(() => state().photos === 3);
      cli("grant", "photos", BUNDLE, "--value", "limited");
      console.log("Photos authorization before relaunch", {
        public: state().photos,
        stored: list().tcc.photos,
      });
      sim("terminate", udid!, BUNDLE);
      const pid = Number(sim("launch", udid!, BUNDLE).trim().split(":").at(-1));
      await eventually(() => state().pid === pid && state().photos === 4);
      expect(list().permissions.find((p: any) => p.id === "photos").state).toBe("limited");
      cli("reset", "photos", BUNDLE);
      expect(list().tcc.photos).toBeUndefined();
      sim("terminate", udid!, BUNDLE);
      const resetPid = Number(sim("launch", udid!, BUNDLE).trim().split(":").at(-1));
      await eventually(() => state().pid === resetPid && state().photos === 0);
    },
    T,
  );

  test(
    "location changes confirm service and public state without restarting the app",
    async () => {
      const initial = state();
      for (const [action, value, expected] of [
        ["grant", "always", 4],
        ["grant", "inuse", 2],
        ["revoke", undefined, 1],
        ["reset", undefined, 0],
      ] as const) {
        cli(action, "location", BUNDLE, ...(value ? ["--value", value] : []));
        await eventually(() => (list().location?.Authorization ?? 0) === expected);
        const publicValue = expected === 4 ? 3 : expected === 2 ? 4 : expected === 1 ? 2 : 0;
        await eventually(() => state().location === publicValue);
        expect(state().pid).toBe(initial.pid);
        expect(state().launchCount).toBe(initial.launchCount);
      }
    },
    T,
  );

  test(
    "reset all clears service state and a fresh CLI process reads it",
    async () => {
      const initial = state();
      cli("grant", "camera", BUNDLE);
      cli("grant", "notifications", BUNDLE);
      cli("grant", "location", BUNDLE, "--value", "always");
      await eventually(() => state().location === 3);
      cli("reset", "all", BUNDLE);
      const finished = Date.now() / 1000;
      const result = list();
      expect(result.tcc.camera).toBeUndefined();
      expect(result.notifications.authorizationStatus).toBe(0);
      expect(result.permissions.every((p: any) => p.state === "undetermined")).toBe(true);
      await eventually(
        () =>
          state().timestamp > finished &&
          state().camera === 0 &&
          state().notifications === 0 &&
          state().location === 0,
      );
      expect(state().pid).toBe(initial.pid);
      expect(state().launchCount).toBe(initial.launchCount);
    },
    T,
  );

  test(
    "critical and ordinary notification grants have separate readback",
    () => {
      cli("grant", "notifications", BUNDLE, "--value", "critical");
      expect(list().notifications.critical).toBe(true);
      cli("grant", "notifications", BUNDLE);
      expect(list().notifications.critical).toBe(false);
    },
    T,
  );

  test(
    "reset of an unknown notification section is a no-op",
    () => {
      const unknown = `dev.expo.permissions.absent-${randomUUID()}`;
      cli("reset", "notifications", unknown);
      expect(JSON.parse(cli("list", unknown)).notifications).toBeNull();
    },
    T,
  );

  test(
    "a fresh pre-grant is authorization; a normal request initializes presentation",
    async () => {
      const bundle = "dev.expo.permissions.fresh-fixture";
      const dir = mkdtempSync(join(tmpdir(), "permission-fresh-"));
      const app = join(dir, "Fresh.app");
      try {
        cpSync(APP, app, { recursive: true });
        execFileSync("/usr/libexec/PlistBuddy", [
          "-c",
          `Set :CFBundleIdentifier ${bundle}`,
          join(app, "Info.plist"),
        ]);
        execFileSync("codesign", ["--force", "--sign", "-", app]);
        cli("grant", "notifications", bundle);
        sim("install", udid!, app);
        const pid = Number(sim("launch", udid!, bundle).trim().split(":").at(-1));
        const documents = join(sim("get_app_container", udid!, bundle, "data").trim(), "Documents");
        const read = () => JSON.parse(readFileSync(join(documents, "state.json"), "utf8"));
        await eventually(() => read().pid === pid && read().notifications === 2);
        // Authorization alone does not promise an enabled alert setting on a fresh app.
        console.log("fresh notification authorization", {
          status: read().notifications,
          alertSetting: read().alertSetting,
        });
        writeCommand(documents, { action: "request" });
        await eventually(
          () =>
            read().events.some((e: any) => e.event === "request" && e.granted) &&
            read().alertSetting === 2,
        );
        writeCommand(documents, { action: "schedule", tag: "fresh-delivery" });
        await eventually(() => read().delivered.includes("fresh-delivery"));
        expect(read().pid).toBe(pid);
        expect(read().launchCount).toBe(1);
      } finally {
        try {
          sim("terminate", udid!, bundle);
        } catch {}
        try {
          sim("uninstall", udid!, bundle);
        } catch {}
        sim("launch", udid!, BUNDLE);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "the compiled CLI locates its packaged helper",
    () => {
      cli("grant", "notifications", BUNDLE);
      const result = JSON.parse(
        execFileSync(join(PKG, "dist/serve-sim"), ["permissions", "list", BUNDLE, "-d", udid!], {
          encoding: "utf8",
          timeout: 30_000,
        }),
      );
      expect(result.notifications.authorizationStatus).toBe(2);
    },
    T,
  );

  test(
    "the native helper rejects unknown actions and failed TCC requests",
    () => {
      cli("grant", "notifications", BUNDLE);
      const helper = join(PKG, "dist/simperm/serve-sim-permissions");
      for (const args of [
        ["notifications", "unknown", BUNDLE],
        ["tcc", "grant", BUNDLE, "", "kTCCServiceNotReal"],
      ]) {
        const result = spawnSync("xcrun", ["simctl", "spawn", udid!, helper, ...args], {
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Unknown permission action|TCC grant failed/);
      }
      expect(list().notifications.authorizationStatus).toBe(2);
    },
    T,
  );

  test(
    "unknown permission fails without changing state",
    () => {
      cli("grant", "notifications", BUNDLE);
      expect(() => cli("grant", "telepathy", BUNDLE)).toThrow();
      expect(list().notifications.authorizationStatus).toBe(2);
    },
    T,
  );
});
