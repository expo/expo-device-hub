import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { describeHostActions, runHostActionAsync } from "../host-actions";
import * as keychain from "../keychain";
import { UDID } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
const run = (action: string, params = {}) =>
  runHostActionAsync(
    { action, params: { udid: UDID.toLowerCase(), bundleId: "com.example.app", ...params } },
    "false",
  );
const TARGET = {
  udid: UDID,
  bundleId: "com.example.app",
  format: "expo-secure-store",
  options: { service: undefined, accessGroup: undefined, accessible: undefined },
};

describe("keychain host actions", () => {
  test("are in the action catalog", () => {
    const catalog = describeHostActions();
    expect(catalog["keychain.set"]).toMatchObject({ required: ["udid", "bundleId", "values"] });
    expect(catalog["keychain.delete"]).toMatchObject({ required: ["udid", "bundleId", "keys"] });
    expect(catalog["keychain.list"]).toMatchObject({ required: ["udid", "bundleId"] });
  });

  test("set passes values in process and returns per-key results", async () => {
    const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({
      applied: true,
      keys: [{ key: "accessToken", status: 0, ok: true, message: "ok" }],
    });
    restores.push(() => set.mockRestore());
    const result = await run("keychain.set", {
      values: { accessToken: "secret-$(nope)" },
      relaunch: true,
    });
    expect(result.exitCode).toBe(0);
    expect(set).toHaveBeenCalledWith(TARGET, [["accessToken", "secret-$(nope)"]], {
      relaunch: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      applied: true,
      keys: [{ key: "accessToken", status: 0, ok: true, message: "ok" }],
    });
  });

  test("a key that failed fails the action but keeps its results", async () => {
    const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({
      applied: true,
      keys: [{ key: "a", status: -34018, ok: false, message: "no entitlement" }],
    });
    restores.push(() => set.mockRestore());
    const result = await run("keychain.set", { values: { a: "1" } });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).keys[0].status).toBe(-34018);
  });

  test("deleting a missing key succeeds", async () => {
    const remove = spyOn(keychain, "deleteKeychainValues").mockResolvedValue({
      applied: true,
      keys: [{ key: "gone", status: -25300, ok: true, message: "not found" }],
    });
    restores.push(() => remove.mockRestore());
    const result = await run("keychain.delete", {
      keys: ["gone"],
      format: "generic-password",
      service: "s",
    });
    expect(result.exitCode).toBe(0);
    expect(remove).toHaveBeenCalledWith(
      { ...TARGET, format: "generic-password", options: { ...TARGET.options, service: "s" } },
      ["gone"],
      { relaunch: false },
    );
  });

  test("list returns keys, and reports an app that did not answer", async () => {
    const list = spyOn(keychain, "listKeychainKeys").mockResolvedValueOnce(["a", "b"]);
    restores.push(() => list.mockRestore());
    expect(JSON.parse((await run("keychain.list")).stdout)).toEqual({ keys: ["a", "b"] });
    list.mockRejectedValueOnce(new Error("com.example.app did not answer."));
    const silent = await run("keychain.list");
    expect(silent.exitCode).toBe(1);
    expect(silent.stderr).toContain("did not answer");
  });

  test("reports service errors on stderr", async () => {
    const set = spyOn(keychain, "setKeychainValues").mockRejectedValue(
      new Error("Keychain access is unavailable."),
    );
    restores.push(() => set.mockRestore());
    const result = await run("keychain.set", { values: { a: "1" } });
    expect(result).toEqual({ stdout: "", stderr: "Keychain access is unavailable.", exitCode: 1 });
  });

  test("validates parameters before IO", async () => {
    const set = spyOn(keychain, "setKeychainValues");
    restores.push(() => set.mockRestore());
    await expect(run("keychain.set", { values: {} })).rejects.toThrow("values");
    await expect(run("keychain.set", { udid: "booted", values: { a: "1" } })).rejects.toThrow(
      "udid",
    );
    await expect(run("keychain.set", { values: { a: "1" }, format: "plist" })).rejects.toThrow(
      "format",
    );
    await expect(run("keychain.delete", { keys: [] })).rejects.toThrow("keys");
    expect(set).not.toHaveBeenCalled();
  });
});
