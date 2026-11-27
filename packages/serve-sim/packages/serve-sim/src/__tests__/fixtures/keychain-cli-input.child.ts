import { expect, spyOn, test } from "bun:test";
import { parseKeychainEntries } from "../../keychain-cli";
import { deleteKeychainValues, keychainSetOperations, setKeychainValues } from "../../keychain";
import * as simKeychain from "../../sim-keychain";

test("JSON and pair input preserve a __proto__ credential", () => {
  const entries = parseKeychainEntries([], '{"__proto__":"synthetic"}');
  expect(entries).toEqual(parseKeychainEntries(["__proto__=synthetic"], null));
  expect(entries).toEqual([["__proto__", "synthetic"]]);
  for (const format of ["expo-secure-store", "generic-password"] as const) {
    const [operation] = keychainSetOperations(format, entries, { service: "auth" });
    expect(operation).toMatchObject({
      op: "set",
      account: Buffer.from("__proto__").toString("base64"),
    });
  }
});

test("mixed JSON credentials never silently omit object-property names", () => {
  expect(
    parseKeychainEntries(
      [],
      '{"__proto__":"first","constructor":"second","prototype":"third","token":"fourth"}',
    ),
  ).toEqual([
    ["__proto__", "first"],
    ["constructor", "second"],
    ["prototype", "third"],
    ["token", "fourth"],
  ]);
});

test.each([
  '{"__proto__":1,"token":"synthetic"}',
  '{"__proto__":null,"token":"synthetic"}',
  '{"__proto__":{},"token":"synthetic"}',
])("refuses every non-string JSON credential: %s", (input) => {
  expect(() => parseKeychainEntries([], input)).toThrow("JSON object of string keys and values");
});

test("JSON preserves file-over-pair precedence for __proto__", () => {
  expect(parseKeychainEntries(["__proto__=pair"], '{"__proto__":"file"}')).toEqual([
    ["__proto__", "file"],
  ]);
});

test("JSON file input must be an object", () => {
  for (const input of ["[]", "null", '"synthetic"', "1"]) {
    expect(() => parseKeychainEntries([], input)).toThrow("JSON object of string keys and values");
  }
});

test("write summaries explain ambiguous access groups without echoing native error text", async () => {
  const ambiguous = { status: -50, error: "select an accessGroup for this item" };
  const run = spyOn(simKeychain, "runKeychainOperations")
    .mockResolvedValueOnce({
      applied: true,
      results: [ambiguous, { ...ambiguous, status: -1 }, { status: -50, error: "unexpected" }],
    })
    .mockResolvedValueOnce({
      applied: true,
      results: [ambiguous],
    });
  const target = {
    udid: "device",
    bundleId: "com.example.app",
    format: "expo-secure-store",
    options: {},
  } as const;
  const hint =
    "multiple access groups match this item. Specify --access-group in the CLI or accessGroup in Controls";
  try {
    expect(
      await setKeychainValues(target, [
        ["a", "1"],
        ["b", "2"],
        ["c", "3"],
      ]),
    ).toEqual({
      applied: true,
      keys: [
        { key: "a", status: -50, ok: false, message: hint },
        { key: "b", status: -1, ok: false, message: "keychain error -1" },
        { key: "c", status: -50, ok: false, message: "invalid attributes" },
      ],
    });
    expect(await deleteKeychainValues(target, ["a"])).toEqual({
      applied: true,
      keys: [{ key: "a", status: -50, ok: false, message: hint }],
    });
  } finally {
    run.mockRestore();
  }
});
