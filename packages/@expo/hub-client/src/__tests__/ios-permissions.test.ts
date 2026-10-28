import { expect, test } from "bun:test";
import { iosPermissionsBackend, parseIosPermissions } from "../ios-permissions";
import { type HostActionResult } from "../exec-ws";

test("writes read state back, rather than treating a success ACK as a grant", async () => {
  const calls: unknown[] = [];
  const backend = iosPermissionsBackend(async (name, params) => {
    calls.push([name, params]);
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(
        name === "permissions.list"
          ? { permissions: [{ id: "notifications", label: "Notifications", state: "denied" }] }
          : { ok: true },
      ),
    };
  }, "device");
  expect((await backend.write("app", "notifications", "grant"))[0].state).toBe("denied");
  expect(calls).toEqual([
    [
      "permissions.set",
      { udid: "device", bundleId: "app", service: "notifications", action: "grant" },
    ],
    ["permissions.list", { udid: "device", bundleId: "app" }],
  ]);
  await backend.reset("app");
  expect(calls.slice(-2).map((c: any) => c[0])).toEqual([
    "permissions.resetAll",
    "permissions.list",
  ]);
});

test("service failures and malformed or old readbacks surface as errors", async () => {
  let result: HostActionResult = { exitCode: 1, stderr: "private API unavailable", stdout: "" };
  const backend = iosPermissionsBackend(async () => result, "device");
  await expect(backend.write("app", "notifications", "grant")).rejects.toThrow(
    "private API unavailable",
  );
  result = { exitCode: 0, stderr: "", stdout: "{}" };
  await expect(backend.list("app")).rejects.toThrow("Update serve-sim");
  expect(() =>
    parseIosPermissions({ permissions: [{ id: "camera", label: "Camera", state: "success" }] }),
  ).toThrow();
});
