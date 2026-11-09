import { describe, expect, test } from "bun:test";

import { type HostActionOptions, type HostActionParams, type HostActionResult } from "../exec-ws";
import {
  deleteIosKeychainValues,
  listIosKeychainKeys,
  setIosKeychainValues,
} from "../ios-keychain";
import { type KeychainWriteResult } from "../types";

const UDID = "ABC-123";
const APP = "com.example.app";

const reply = (stdout: unknown, exitCode = 0, stderr = ""): HostActionResult => ({
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr,
  exitCode,
});

function fakeRun(result: HostActionResult) {
  const calls: Array<{ action: string; params?: HostActionParams; options?: HostActionOptions }> =
    [];
  const run = async (
    action: string,
    params?: HostActionParams,
    options?: HostActionOptions,
  ): Promise<HostActionResult> => {
    calls.push({ action, params, options });
    return result;
  };
  return { run, calls };
}

const APPLIED: KeychainWriteResult = {
  applied: true,
  keys: [{ key: "accessToken", status: 0, ok: true, message: "ok" }],
};

describe("setIosKeychainValues", () => {
  test("sends the values as parameters and returns per-key results", async () => {
    const { run, calls } = fakeRun(reply(APPLIED));
    expect(await setIosKeychainValues(run, UDID, APP, { accessToken: "tok" })).toEqual(APPLIED);
    expect(calls).toEqual([
      {
        action: "keychain.set",
        params: { udid: UDID, bundleId: APP, values: { accessToken: "tok" }, relaunch: false },
        options: { timeoutMs: 120_000 },
      },
    ]);
  });

  test("waits longer for a relaunch and passes keychainService", async () => {
    const { run, calls } = fakeRun(reply(APPLIED));
    await setIosKeychainValues(run, UDID, APP, { a: "1" }, { relaunch: true, service: "auth" });
    expect(calls[0]).toMatchObject({
      params: { service: "auth", relaunch: true },
      options: { timeoutMs: 300_000 },
    });
  });

  test("passes react-native-keychain's username", async () => {
    const { run, calls } = fakeRun(reply(APPLIED));
    await setIosKeychainValues(
      run,
      UDID,
      APP,
      { [APP]: "pw" },
      { format: "react-native-keychain", username: "alice" },
    );
    expect(calls[0]?.params).toMatchObject({ format: "react-native-keychain", username: "alice" });
  });

  test("passes the format", async () => {
    const { run, calls } = fakeRun(reply(APPLIED));
    await setIosKeychainValues(
      run,
      UDID,
      APP,
      { a: "1" },
      { format: "generic-password", service: "svc" },
    );
    expect(calls[0]?.params).toMatchObject({ format: "generic-password", service: "svc" });
  });

  test("returns per-key failures that also failed the action", async () => {
    const failed: KeychainWriteResult = {
      applied: true,
      keys: [{ key: "a", status: -34018, ok: false, message: "no entitlement" }],
    };
    const { run } = fakeRun(reply(failed, 1));
    expect(await setIosKeychainValues(run, UDID, APP, { a: "1" })).toEqual(failed);
  });

  test("returns a write the app applies at its next launch", async () => {
    const { run } = fakeRun(reply({ applied: false }));
    expect(await setIosKeychainValues(run, UDID, APP, { a: "1" })).toEqual({ applied: false });
  });

  test("rejects with serve-sim's last error line", async () => {
    const { run } = fakeRun(reply("", 1, "first\nKeychain access is unavailable.\n"));
    await expect(setIosKeychainValues(run, UDID, APP, { a: "1" })).rejects.toThrow(
      "Keychain access is unavailable.",
    );
  });
});

for (const lost of ["exec-ws timeout", "exec-ws closed", "exec-ws error"]) {
  test(`a lost reply (${lost}) says the change may still apply`, async () => {
    const run = async (): Promise<HostActionResult> => {
      throw new Error(lost);
    };
    await expect(setIosKeychainValues(run, UDID, APP, { a: "1" })).rejects.toThrow(
      "Lost the connection to serve-sim before it answered. The change may still apply",
    );
  });
}

describe("deleteIosKeychainValues", () => {
  test("sends the keys as a list", async () => {
    const { run, calls } = fakeRun(reply(APPLIED));
    await deleteIosKeychainValues(run, UDID, APP, ["accessToken"]);
    expect(calls[0]).toMatchObject({
      action: "keychain.delete",
      params: { udid: UDID, bundleId: APP, keys: ["accessToken"], relaunch: false },
    });
  });
});

describe("listIosKeychainKeys", () => {
  test("returns the keys", async () => {
    const { run, calls } = fakeRun(reply({ keys: ["a", "b"] }));
    expect(await listIosKeychainKeys(run, UDID, APP)).toEqual(["a", "b"]);
    expect(calls[0]).toMatchObject({
      action: "keychain.list",
      params: { udid: UDID, bundleId: APP },
    });
  });

  test("rejects when the app did not answer or the reply is unreadable", async () => {
    await expect(
      listIosKeychainKeys(fakeRun(reply("", 1, "com.example.app did not answer.")).run, UDID, APP),
    ).rejects.toThrow("did not answer");
    await expect(listIosKeychainKeys(fakeRun(reply({ keys: [1] })).run, UDID, APP)).rejects.toThrow(
      "unreadable",
    );
  });
});

test("a malformed write reply rejects with serve-sim's error or a fallback", async () => {
  for (const stdout of [
    "nope",
    { applied: true, keys: [{ key: "a", status: 0, message: "ok" }] },
  ]) {
    await expect(
      setIosKeychainValues(fakeRun(reply(stdout, 1)).run, UDID, APP, { a: "1" }),
    ).rejects.toThrow("Could not set the keychain values.");
  }
});
