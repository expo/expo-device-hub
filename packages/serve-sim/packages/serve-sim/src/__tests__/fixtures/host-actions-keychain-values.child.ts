import { afterEach, expect, spyOn, test } from "bun:test";
import { describeHostActions, runHostActionAsync } from "../../host-actions";
import * as keychain from "../../keychain";
import { UDID } from "../helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function writer() {
  const set = spyOn(keychain, "setKeychainValues").mockImplementation(async (_target, entries) => ({
    applied: true,
    keys: entries.map(([key]) => ({ key, status: 0, ok: true, message: "ok" })),
  }));
  restores.push(() => set.mockRestore());
  return set;
}

const run = (values: unknown) =>
  runHostActionAsync(
    {
      action: "keychain.set",
      params: { udid: UDID, bundleId: "com.example.app", values },
    },
    "false",
  );

test("controls preserve a sole __proto__ credential", async () => {
  const set = writer();
  const result = await run(JSON.parse('{"__proto__":"synthetic"}'));
  expect(result.exitCode).toBe(0);
  expect(set.mock.calls[0]?.[1]).toEqual([["__proto__", "synthetic"]]);
  expect(JSON.parse(result.stdout).keys.map(({ key }: { key: string }) => key)).toEqual([
    "__proto__",
  ]);
  expect(result.stdout).not.toContain("synthetic");
});

test("controls never silently omit object-property credential names", async () => {
  const set = writer();
  const values = JSON.parse(
    '{"__proto__":"first","constructor":"second","prototype":"third","token":"fourth"}',
  );
  expect((await run(values)).exitCode).toBe(0);
  expect(set.mock.calls[0]?.[1]).toEqual(Object.entries(values));
});

test.each([
  '{"__proto__":1,"token":"synthetic"}',
  '{"__proto__":null,"token":"synthetic"}',
  '{"__proto__":{},"token":"synthetic"}',
])("controls reject non-string values before IO: %s", async (input) => {
  const set = writer();
  await expect(run(JSON.parse(input))).rejects.toThrow("values");
  expect(set).not.toHaveBeenCalled();
});

test("controls apply the value-length limit to __proto__", async () => {
  const set = writer();
  const values = Object.fromEntries([
    ["__proto__", "x".repeat(256 * 1024 + 1)],
    ["token", "synthetic"],
  ]);
  await expect(run(values)).rejects.toThrow("values");
  expect(set).not.toHaveBeenCalled();
});

function valuesAtCount(count: number) {
  return Object.fromEntries([
    ["__proto__", "synthetic"],
    ...Array.from({ length: count - 1 }, (_, i) => [`key${i}`, "synthetic"]),
  ]);
}

test("controls accept all 200 credentials at the count limit", async () => {
  const set = writer();
  expect((await run(valuesAtCount(200))).exitCode).toBe(0);
  expect(set.mock.calls[0]?.[1]).toHaveLength(200);
});

test("controls count __proto__ toward the 200-credential limit", async () => {
  const set = writer();
  await expect(run(valuesAtCount(201))).rejects.toThrow("values");
  expect(set).not.toHaveBeenCalled();
});

test("controls retain key limits and require a nonempty values object", async () => {
  const set = writer();
  for (const values of [
    {},
    [],
    null,
    "synthetic",
    { "": "synthetic" },
    { ["x".repeat(1025)]: "synthetic" },
  ]) {
    await expect(run(values)).rejects.toThrow("values");
  }
  expect(set).not.toHaveBeenCalled();
});

test("the control catalog keeps an object-shaped credential schema", () => {
  const action = describeHostActions()["keychain.set"];
  expect(action?.properties?.values).toMatchObject({
    type: "object",
    propertyNames: { type: "string", minLength: 1, maxLength: 1024 },
    additionalProperties: { type: "string", maxLength: 256 * 1024 },
  });
});
