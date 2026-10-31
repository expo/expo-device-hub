import { describe, expect, test } from "bun:test";
import type { CapabilityController } from "../capability-session";
import { describeHostActions, runHostActionAsync } from "../host-actions";
import { UDID } from "./helpers";

function fakeController(fail?: string) {
  const enabled = { clipboard: true, keychain: true };
  const calls: unknown[][] = [];
  const controller: CapabilityController = {
    list: () => [
      { name: "clipboard", enabled: enabled.clipboard },
      { name: "keychain", enabled: enabled.keychain },
    ],
    async set(udid, name, value) {
      calls.push([udid, name, value]);
      if (fail) throw new Error(fail);
      enabled[name] = value;
    },
    allows: (_udid, name) => enabled[name],
  };
  return { controller, calls };
}

const run = (action: string, params: object, controller?: CapabilityController) =>
  runHostActionAsync(
    { action, params: { udid: UDID.toLowerCase(), ...params } },
    "false",
    undefined,
    undefined,
    controller,
  );

describe("capability host actions", () => {
  test("are in the action catalog with the capabilities a preview switches", () => {
    const catalog = describeHostActions();
    expect(catalog["capabilities.list"]).toMatchObject({ required: ["udid"] });
    expect(catalog["capabilities.set"]).toMatchObject({
      required: ["udid", "name", "enabled"],
      properties: { name: { enum: ["clipboard", "keychain"] } },
    });
  });

  test("set switches one capability and replies with every capability's state", async () => {
    const { controller, calls } = fakeController();
    const result = await run("capabilities.set", { name: "keychain", enabled: false }, controller);
    expect(calls).toEqual([[UDID, "keychain", false]]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      capabilities: [
        { name: "clipboard", enabled: true },
        { name: "keychain", enabled: false },
      ],
    });
  });

  test("list reads without switching", async () => {
    const { controller, calls } = fakeController();
    const result = await run("capabilities.list", {}, controller);
    expect(calls).toEqual([]);
    expect(JSON.parse(result.stdout).capabilities).toHaveLength(2);
  });

  test("a refused change and a missing preview server fail with a reason", async () => {
    const { controller } = fakeController("This server started with keychain disabled.");
    expect(
      await run("capabilities.set", { name: "keychain", enabled: true }, controller),
    ).toMatchObject({ exitCode: 1, stderr: "This server started with keychain disabled." });
    expect(await run("capabilities.list", {})).toMatchObject({
      exitCode: 1,
      stderr: "Only a serve-sim preview server can switch capabilities.",
    });
  });

  test("other capabilities are not switchable", async () => {
    const { controller } = fakeController();
    await expect(
      run("capabilities.set", { name: "networkCapture", enabled: true }, controller),
    ).rejects.toThrow("capabilities.set: name Invalid option");
  });

  test("keychain actions refuse a device where this server turned keychain off", async () => {
    const { controller } = fakeController();
    await run("capabilities.set", { name: "keychain", enabled: false }, controller);
    expect(await run("keychain.list", { bundleId: "com.example.app" }, controller)).toMatchObject({
      exitCode: 1,
      stderr: `Keychain access is off for ${UDID} on this server, by --disable keychain or capabilities.set.`,
    });
  });
});
