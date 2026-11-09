import { expect, test } from "bun:test";
import { parseKeychainEntries } from "../../keychain-cli";
import { keychainSetOperations } from "../../keychain";

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
