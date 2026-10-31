// The keychain dylib, loaded by the capability loader, writes items that the app's own
// SecItemCopyMatching then reads, both while the app runs and on its next launch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import WebSocket from "ws";

import type { HostActionResult } from "../host-actions";
import { releaseSessionSync } from "../launch-manager";
import { runKeychainOperations, type KeychainOperation } from "../sim-keychain";
import {
  deleteKeychainValues,
  listKeychainKeys,
  setKeychainValues,
  type KeychainTarget,
  type KeychainWriteSummary,
} from "../keychain";
import { stateFileForDevice, type ServeSimDeviceState } from "../state";
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
const GROUP_ITEM = { ...ITEM, service: "group-scope-fixture" };
const GROUP_FIXTURES = [
  { accessGroup: "SERVESIMFIX.dev.expo.serve-sim.launch-fixture", value: "before-default-group" },
  { accessGroup: "SERVESIMFIX.dev.expo.serve-sim.shared-fixture", value: "before-shared-group" },
];
const FIXTURE_DELETES: KeychainOperation[] = [
  ...GROUP_FIXTURES.map(({ accessGroup }) => ({
    op: "delete" as const,
    ...GROUP_ITEM,
    accessGroup,
  })),
  { op: "delete", ...ITEM },
];
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

function keychainCli(args: string[], input?: string) {
  const child = spawnSync("node", [CLI, "keychain", ...args, "-d", udid!, "--json"], {
    input,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  if (!child.stdout.trim()) throw new Error(child.stderr.trim());
  console.log(`[keychain CLI] exit ${child.status}: ${child.stdout.trim()}`);
  return { status: child.status, output: JSON.parse(child.stdout) };
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("keychain round trip", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let server: ReturnType<typeof Bun.spawn>;
  let serverState: { port: number; token: string };

  beforeAll(async () => {
    tempState = useTempStateDir();
    expect(readInsert(udid!)).toBe("");
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    simctl(["install", udid!, FIXTURE]);
    const port = await freePortAsync();
    // The built npm entry point must arm the real helper without a capability flag.
    server = Bun.spawn(["node", CLI, "--single-device", udid!, "--port", String(port), "--quiet"], {
      env: { ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    const deadline = Date.now() + 60_000;
    const stateFile = stateFileForDevice(udid!);
    while (server.exitCode === null && server.signalCode === null && Date.now() < deadline) {
      if (existsSync(stateFile) && readInsert(udid!)) {
        const state: ServeSimDeviceState = JSON.parse(readFileSync(stateFile, "utf8"));
        expect(state.pid).toBe(server.pid);
        expect(state.port).toBe(port);
        expect(state.device).toBe(udid!);
        if (typeof state.token !== "string" || state.token.length === 0) {
          throw new Error("Built serve-sim did not publish a Controls token");
        }
        serverState = { port: state.port, token: state.token };
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error("Built serve-sim did not publish preview state and arm its capability loader");
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      // A failed readback relaunch can leave the app stopped during per-test cleanup.
      launch();
      const cleanup = await runKeychainOperations(udid!, APP, FIXTURE_DELETES, {
        timeoutMs: 10_000,
      });
      expect(
        cleanup.applied && cleanup.results.every(({ status }) => status === 0 || status === -25300),
        "Fixture Keychain deletions must complete",
      ).toBe(true);
    } catch (error) {
      failures.push(error);
    }

    try {
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
    } catch (error) {
      failures.push(error);
    }

    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    try {
      tempState.restore();
    } catch (error) {
      failures.push(error);
    }

    try {
      expect(readInsert(udid!), "Simulator injection must be cleared after teardown").toBe("");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Keychain Simulator teardown failed");
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
    const targetValue = `before-replacement-${Date.now()}`;
    try {
      expect(await runKeychainOperations(udid!, APP, [set(targetValue)])).toEqual({
        applied: true,
        results: [{ status: 0 }],
      });
      for (const { accessGroup, value } of GROUP_FIXTURES) {
        expect(
          await runKeychainOperations(udid!, APP, [{ ...set(value), ...GROUP_ITEM, accessGroup }]),
        ).toEqual({ applied: true, results: [{ status: 0 }] });
      }
      const operations: KeychainOperation[] = [
        { ...set("ambiguous"), ...GROUP_ITEM },
        { op: "delete", ...GROUP_ITEM },
        { ...set("must-not-write"), replaces: [GROUP_ITEM] },
      ];
      for (const operation of operations) {
        const outcome = await runKeychainOperations(udid!, APP, [operation]);
        expect(outcome).toMatchObject({
          applied: true,
          results: [{ status: -50, error: "select an accessGroup for this item" }],
        });
      }
      for (const { accessGroup, value } of GROUP_FIXTURES) {
        terminate();
        const after = seenValues().length;
        launch(
          "-ServeSimFixtureKeychainService",
          GROUP_ITEM.service,
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
      await runKeychainOperations(udid!, APP, FIXTURE_DELETES);
    }
  }, 60_000);

  const target = (): KeychainTarget => ({
    udid: udid!,
    bundleId: APP,
    format: "expo-secure-store",
    options: {},
  });

  test("the built CLI reads stdin, relaunches a closed app, and reports the result", async () => {
    // Closed, so only the process the relaunch starts can apply the value.
    terminate();
    const value = `relaunched-${Date.now()}`;
    expect(
      keychainCli(["set", APP, "--from-file", "-", "--relaunch"], JSON.stringify({ [KEY]: value })),
    ).toEqual({
      status: 0,
      output: {
        udid,
        bundleId: APP,
        applied: true,
        keys: [{ key: KEY, status: 0, ok: true, message: "ok" }],
      },
    });
    // startApp starts the app without the fixture's argument, so start it with one.
    terminate();
    launch();
    await waitForLastSeen(`value=${value}`);
  }, 60_000);

  test("a closed app queues the change without waiting", async () => {
    terminate();
    const started = Date.now();
    expect(await setKeychainValues(target(), [[KEY, "queued-fast"]])).toEqual({ applied: false });
    expect(Date.now() - started).toBeLessThan(2_500);
    launch();
    await waitForLastSeen("value=queued-fast");
  }, 60_000);

  test("the built CLI lists and deletes SecureStore keys", async () => {
    const listed = keychainCli(["list", APP]);
    expect(listed.status).toBe(0);
    expect(listed.output.keys).toContain(KEY);
    expect(keychainCli(["delete", APP, KEY, "missing"])).toEqual({
      status: 0,
      output: {
        udid,
        bundleId: APP,
        applied: true,
        keys: [
          { key: KEY, status: 0, ok: true, message: "ok" },
          { key: "missing", status: -25300, ok: true, message: "not found" },
        ],
      },
    });
    await waitForLastSeen("status=-25300");
  }, 30_000);

  test.each([
    { scenario: "an alias matches multiple groups", authGroups: GROUP_FIXTURES },
    { scenario: "aliases match different groups", authGroups: GROUP_FIXTURES.slice(1) },
  ])(
    "the built CLI leaves every alias present when $scenario",
    async ({ authGroups }) => {
      launch();
      const service = "secure-store-alias-fixture";
      const entries = [
        { ...ITEM, service: `${service}:no-auth`, accessGroup: GROUP_FIXTURES[0]!.accessGroup },
        ...authGroups.map(({ accessGroup }) => ({
          ...ITEM,
          service: `${service}:auth`,
          accessGroup,
        })),
      ];
      try {
        expect(
          await runKeychainOperations(
            udid!,
            APP,
            entries.map((item) => ({
              ...set("fixture-value"),
              ...item,
            })),
            { timeoutMs: 10_000 },
          ),
        ).toEqual({ applied: true, results: entries.map(() => ({ status: 0 })) });
        expect(keychainCli(["delete", APP, KEY, "--service", service])).toMatchObject({
          status: 1,
          output: {
            applied: true,
            keys: [
              {
                key: KEY,
                status: -50,
                ok: false,
                message: expect.stringContaining("--access-group"),
              },
            ],
          },
        });
        for (const { service, accessGroup } of entries) {
          const created = await runKeychainOperations(udid!, APP, [
            { op: "list", service, accessGroup },
          ]);
          expect(created).toMatchObject({
            applied: true,
            results: [{ status: 0, items: [{ service, accessGroup, account: ITEM.account }] }],
          });
        }
        const [selected, shared] = GROUP_FIXTURES;
        expect(
          keychainCli([
            "delete",
            APP,
            KEY,
            "--service",
            service,
            "--access-group",
            selected!.accessGroup,
          ]),
        ).toMatchObject({
          status: 0,
          output: { applied: true, keys: [{ key: KEY, status: 0, ok: true }] },
        });
        const auth = `${service}:auth`;
        const remaining = await runKeychainOperations(udid!, APP, [{ op: "list", service: auth }]);
        expect(remaining).toMatchObject({
          applied: true,
          results: [{ status: 0, items: [{ service: auth, accessGroup: shared!.accessGroup }] }],
        });
      } finally {
        await runKeychainOperations(
          udid!,
          APP,
          entries.map((item) => ({ op: "delete", ...item })),
        );
      }
    },
    60_000,
  );

  test("single-device Controls set, list, and delete Keychain values without a UDID", async () => {
    terminate();
    launch();
    const value = `host-action-${Date.now()}`;
    const ws = new WebSocket(
      `ws://127.0.0.1:${serverState.port}/exec-ws`,
      `serve-sim.token.${serverState.token}`,
      { handshakeTimeout: 10_000 },
    );
    async function nextReply<T>(): Promise<T> {
      const [message] = await once(ws, "message", { signal: AbortSignal.timeout(15_000) });
      return JSON.parse(String(message));
    }
    async function call(id: number, action: string, params: Record<string, unknown> = {}) {
      const pending = nextReply<HostActionResult & { id: number }>();
      ws.send(JSON.stringify({ id, action, params: { bundleId: APP, ...params } }));
      const reply = await pending;
      expect(reply).toMatchObject({ id, exitCode: 0, stderr: "" });
      return reply.stdout;
    }
    try {
      expect(await nextReply<{ ready: boolean }>()).toMatchObject({ ready: true });
      const beforeWrite = seenValues().length;
      const written = await call(1, "keychain.set", { values: { [KEY]: value } });
      expect(JSON.parse(written)).toMatchObject({
        applied: true,
        keys: [{ key: KEY, ok: true }],
      });
      expect(written).not.toContain(value);
      await waitForLastSeen(`value=${value}`, { after: beforeWrite });

      const listed = await call(2, "keychain.list");
      expect(JSON.parse(listed)).toEqual({ keys: [KEY] });

      const beforeDelete = seenValues().length;
      const removed = await call(3, "keychain.delete", { keys: [KEY] });
      expect(JSON.parse(removed)).toMatchObject({
        applied: true,
        keys: [{ key: KEY, ok: true }],
      });
      await waitForLastSeen("status=-25300", { after: beforeDelete });
    } finally {
      ws.terminate();
    }
  }, 60_000);

  test("react-native-keychain keeps one credential per service", async () => {
    const service = `dev.expo.serve-sim.e2e-${process.pid}`;
    const credential = (username?: string): KeychainTarget => ({
      ...target(),
      format: "react-native-keychain",
      options: username === undefined ? {} : { username },
    });
    const accounts = async () => {
      const outcome = await runKeychainOperations(udid!, APP, [{ op: "list", service }], {
        timeoutMs: 10_000,
      });
      return outcome.applied ? outcome.results[0]?.items?.map((item) => item.account) : null;
    };
    const ok: KeychainWriteSummary = {
      applied: true,
      keys: [{ key: service, status: 0, ok: true, message: "ok" }],
    };
    // Without a username the library stores an empty account.
    expect(await setKeychainValues(credential(), [[service, "pw0"]])).toEqual(ok);
    expect(await accounts()).toEqual([""]);
    expect(await setKeychainValues(credential("alice"), [[service, "pw1"]])).toEqual(ok);
    expect(await setKeychainValues(credential("bob"), [[service, "pw2"]])).toEqual(ok);
    expect(await accounts()).toEqual([b64("bob")]);
    expect(await listKeychainKeys(credential())).toContain(service);
    expect(await deleteKeychainValues(credential(), [service])).toEqual(ok);
    expect(await accounts()).toEqual([]);
  }, 30_000);
});
