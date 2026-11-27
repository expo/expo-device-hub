// The keychain dylib, loaded by the capability loader, writes items that the app's own
// SecItemCopyMatching then reads, both while the app runs and on its next launch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { releaseSessionSync } from "../launch-manager";
import { runKeychainOperations, type KeychainOperation } from "../sim-keychain";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const KEY = "accessToken";

const udid = e2eDevice();
const ready = udid !== null && existsSync(FIXTURE) && existsSync(CLI);
requireE2E("keychain round trip", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function terminate(): void {
  try {
    simctl(["terminate", udid!, APP]);
  } catch {}
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
// The attributes expo-secure-store uses, which the fixture reads.
const ITEM = {
  service: "app:no-auth",
  account: b64(KEY),
  generic: b64(KEY),
  attributesAsData: true,
};
const set = (value: string): Extract<KeychainOperation, { op: "set" }> => ({
  op: "set",
  ...ITEM,
  data: b64(value),
  accessible: "whenUnlocked",
});

function dataContainer(): string {
  return simctl(["get_app_container", udid!, APP, "data"]).trim();
}

function seenValues(): string[] {
  try {
    return readFileSync(join(dataContainer(), "Documents/launches.tsv"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("keychain\t"))
      .map((line) => line.split("\t")[2]!);
  } catch {
    return [];
  }
}

/** The fixture records each change, so the last line is what the app reads now. */
async function waitForLastSeen(
  expected: string,
  { after = 0, timeoutMs = 20_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let values = seenValues();
  while ((values.length <= after || values.at(-1) !== expected) && Date.now() < deadline) {
    await Bun.sleep(200);
    values = seenValues();
  }
  expect(values.length).toBeGreaterThan(after);
  expect(values.at(-1)).toBe(expected);
}

function launch(...readbackArgs: string[]): void {
  simctl(["launch", udid!, APP, "-ServeSimFixtureKeychain", KEY, ...readbackArgs]);
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("keychain round trip", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let server: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    tempState = useTempStateDir();
    expect(readInsert(udid!)).toBe("");
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    simctl(["install", udid!, FIXTURE]);
    const port = await freePortAsync();
    // The built npm entry point must arm the real helper without a capability flag.
    server = Bun.spawn(["node", CLI, udid!, "--port", String(port), "--quiet"], {
      env: { ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    const deadline = Date.now() + 60_000;
    while (server.exitCode === null && server.signalCode === null && Date.now() < deadline) {
      if (readInsert(udid!)) return;
      await Bun.sleep(250);
    }
    throw new Error("Built serve-sim did not arm its capability loader");
  }, 120_000);

  afterAll(async () => {
    try {
      launch();
      await runKeychainOperations(udid!, APP, [{ op: "delete", ...ITEM }], { timeoutMs: 10_000 });
    } finally {
      terminate();
      if (server) {
        server.kill("SIGTERM");
        const deadline = Date.now() + 15_000;
        while (server.exitCode === null && server.signalCode === null && Date.now() < deadline) {
          await Bun.sleep(200);
        }
        if (server.exitCode === null && server.signalCode === null) {
          server.kill("SIGKILL");
          await server.exited;
          releaseSessionSync(udid!, server.pid, () => {});
        }
      }
      try {
        simctl(["uninstall", udid!, APP]);
      } catch {}
      tempState.restore();
    }
    // Swallowing this is how a device stays injected for every test that runs after it.
    expect(readInsert(udid!)).toBe("");
  }, 120_000);

  test("the built CLI loads the Keychain helper by default and a running app reads the write", async () => {
    terminate();
    launch();
    const value = `live-${Date.now()}`;
    // The app needs a moment to load the dylib after it starts.
    const outcome = await runKeychainOperations(udid!, APP, [set(value)], { timeoutMs: 15_000 });
    expect(outcome).toEqual({ applied: true, results: [{ status: 0 }] });
    await waitForLastSeen(`value=${value}`);
  }, 60_000);

  test("set replaces an item stored with another generic value", async () => {
    const other = { ...set("old"), generic: b64("other") };
    expect(await runKeychainOperations(udid!, APP, [other], { timeoutMs: 10_000 })).toEqual({
      applied: true,
      results: [{ status: 0 }],
    });
    const value = `regeneric-${Date.now()}`;
    expect(await runKeychainOperations(udid!, APP, [set(value)], { timeoutMs: 10_000 })).toEqual({
      applied: true,
      results: [{ status: 0 }],
    });
    await waitForLastSeen(`value=${value}`);
  }, 30_000);

  test("a running app still answers after its mailbox was deleted", async () => {
    rmSync(join(dataContainer(), "tmp/serve-sim-keychain"), { recursive: true, force: true });
    const value = `remade-${Date.now()}`;
    expect(await runKeychainOperations(udid!, APP, [set(value)], { timeoutMs: 10_000 })).toEqual({
      applied: true,
      results: [{ status: 0 }],
    });
    await waitForLastSeen(`value=${value}`);
  }, 30_000);

  test("a successful set removes the items it replaces", async () => {
    const legacy = { ...ITEM, service: "app" };
    expect(
      await runKeychainOperations(udid!, APP, [{ op: "set", ...legacy, data: b64("legacy") }], {
        timeoutMs: 10_000,
      }),
    ).toEqual({ applied: true, results: [{ status: 0 }] });
    const value = `replacing-${Date.now()}`;
    expect(
      await runKeychainOperations(udid!, APP, [{ ...set(value), replaces: [legacy] }], {
        timeoutMs: 10_000,
      }),
    ).toEqual({ applied: true, results: [{ status: 0 }] });
    const listed = await runKeychainOperations(udid!, APP, [{ op: "list", service: "app" }], {
      timeoutMs: 10_000,
    });
    expect(listed.applied && listed.results[0]?.items).toEqual([]);
  }, 30_000);

  test("a replacement that can match the target is refused before writing", async () => {
    const group = "SERVESIMFIX.dev.expo.serve-sim.launch-fixture";
    const identities = [
      { target: ITEM, replacement: { ...ITEM, generic: b64("other") } },
      { target: { ...ITEM, accessGroup: group }, replacement: { ...ITEM, accessGroup: group } },
      { target: ITEM, replacement: { ...ITEM, accessGroup: group } },
      { target: { ...ITEM, accessGroup: group }, replacement: ITEM },
      { target: ITEM, replacement: { ...ITEM, attributesAsData: false } },
    ];
    for (const { target, replacement } of identities) {
      const value = `preserved-${Date.now()}`;
      expect(await runKeychainOperations(udid!, APP, [set(value)], { timeoutMs: 10_000 })).toEqual({
        applied: true,
        results: [{ status: 0 }],
      });
      const outcome = await runKeychainOperations(
        udid!,
        APP,
        [{ ...set("must-not-write"), ...target, replaces: [replacement] }],
        { timeoutMs: 10_000 },
      );
      expect(outcome.applied && outcome.results[0]?.status).toBe(-50);
      // List verifies the item still exists. Relaunch for a fresh value read, because the
      // fixture only records changes while it runs and an earlier log entry could be stale.
      const listed = await runKeychainOperations(udid!, APP, [
        { op: "list", service: ITEM.service },
      ]);
      expect(listed.applied && listed.results[0]?.items?.map((item) => item.account)).toContain(
        b64(KEY),
      );
      terminate();
      const after = seenValues().length;
      launch();
      await waitForLastSeen(`value=${value}`, { after });
    }
  }, 60_000);

  test("a set fails when an item it replaces cannot be deleted", async () => {
    // The app has no entitlement for this access group, so the delete fails.
    const unreachable = { ...ITEM, service: "app", accessGroup: "serve-sim.not-this-app" };
    const outcome = await runKeychainOperations(
      udid!,
      APP,
      [{ ...set(`unreplaced-${Date.now()}`), replaces: [unreachable] }],
      { timeoutMs: 10_000 },
    );
    expect(outcome).toEqual({ applied: true, results: [{ status: -34018 }] });
  }, 30_000);

  test("the app drops an expired request unread", async () => {
    const requests = join(dataContainer(), "tmp/serve-sim-keychain/requests");
    const body = { nonce: "expired-e2e", expiresAt: Date.now() - 1, operations: [set("expired")] };
    writeFileSync(join(requests, ".expired.pending"), JSON.stringify(body));
    renameSync(join(requests, ".expired.pending"), join(requests, "000000000000000-expired.json"));
    const deadline = Date.now() + 5_000;
    while (existsSync(join(requests, "000000000000000-expired.json")) && Date.now() < deadline)
      await Bun.sleep(100);
    expect(existsSync(join(requests, "000000000000000-expired.json"))).toBe(false);
    // The app runs requests in order, so once a later one is answered the expired one is done.
    const later = await runKeychainOperations(udid!, APP, [{ op: "list", service: ITEM.service }], {
      timeoutMs: 10_000,
    });
    expect(later.applied).toBe(true);
    expect(
      existsSync(join(dataContainer(), "tmp/serve-sim-keychain/responses/expired-e2e.json")),
    ).toBe(false);
    expect(seenValues().at(-1)).not.toBe("value=expired");
  }, 30_000);

  test("lists keys without values", async () => {
    const outcome = await runKeychainOperations(
      udid!,
      APP,
      [{ op: "list", service: ITEM.service }],
      {
        timeoutMs: 10_000,
      },
    );
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    const [result] = outcome.results;
    expect(result?.status).toBe(0);
    expect(result?.items?.map((item) => item.account)).toContain(b64(KEY));
    // Values are base64 on the wire, so check the shape rather than search for the text.
    for (const item of result?.items ?? []) {
      expect(
        Object.keys(item).every((key) => ["service", "account", "accessGroup"].includes(key)),
      ).toBe(true);
    }
  }, 30_000);

  test("a request made while the app is closed applies on its next launch", async () => {
    terminate();
    const value = `queued-${Date.now()}`;
    const outcome = await runKeychainOperations(udid!, APP, [set(value)], {
      timeoutMs: 1000,
      keepQueued: true,
    });
    expect(outcome).toEqual({ applied: false });
    launch();
    await waitForLastSeen(`value=${value}`);
    // The app deletes a request, which carries the value, as soon as it claims it.
    const requests = join(dataContainer(), "tmp/serve-sim-keychain/requests");
    expect(readdirSync(requests).filter((name) => !name.startsWith("."))).toEqual([]);
  }, 60_000);

  test("delete removes the item the app reads", async () => {
    const outcome = await runKeychainOperations(udid!, APP, [{ op: "delete", ...ITEM }], {
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ applied: true, results: [{ status: 0 }] });
    await waitForLastSeen("status=-25300");
  }, 30_000);

  test("rejects ambiguous writes, deletes, and replacements before changing any item", async () => {
    launch();
    const item = { ...ITEM, service: "group-scope-fixture" };
    const groups = [
      {
        accessGroup: "SERVESIMFIX.dev.expo.serve-sim.launch-fixture",
        value: "before-default-group",
      },
      {
        accessGroup: "SERVESIMFIX.dev.expo.serve-sim.shared-fixture",
        value: "before-shared-group",
      },
    ];
    const targetValue = `before-replacement-${Date.now()}`;
    try {
      expect(await runKeychainOperations(udid!, APP, [set(targetValue)])).toEqual({
        applied: true,
        results: [{ status: 0 }],
      });
      for (const { accessGroup, value } of groups) {
        expect(
          await runKeychainOperations(udid!, APP, [{ ...set(value), ...item, accessGroup }]),
        ).toEqual({ applied: true, results: [{ status: 0 }] });
      }
      const operations: KeychainOperation[] = [
        { ...set("ambiguous"), ...item },
        { op: "delete", ...item },
        { ...set("must-not-write"), replaces: [item] },
      ];
      for (const operation of operations) {
        const outcome = await runKeychainOperations(udid!, APP, [operation]);
        expect(outcome).toMatchObject({
          applied: true,
          results: [{ status: -50, error: "select an accessGroup for this item" }],
        });
      }
      for (const { accessGroup, value } of groups) {
        terminate();
        const after = seenValues().length;
        launch(
          "-ServeSimFixtureKeychainService",
          item.service,
          "-ServeSimFixtureKeychainAccessGroup",
          accessGroup,
        );
        await waitForLastSeen(`value=${value}`, { after });
      }
      terminate();
      const after = seenValues().length;
      launch();
      await waitForLastSeen(`value=${targetValue}`, { after });
    } finally {
      await runKeychainOperations(udid!, APP, [
        ...groups.map(({ accessGroup }) => ({
          op: "delete" as const,
          ...item,
          accessGroup,
        })),
        { op: "delete", ...ITEM },
      ]);
    }
  }, 60_000);
});
