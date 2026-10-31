import { describe, expect, test } from "bun:test";
import {
  deleteStatus,
  describeKeychainStatus,
  keychainDeleteOperations,
  keychainKeys,
  keychainSetOperations,
} from "../keychain";
import { parseKeychainEntries } from "../keychain-cli";

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("expo-secure-store format", () => {
  test("set writes the attributes SecureStore reads first", () => {
    expect(keychainSetOperations("expo-secure-store", [["accessToken", "tok"]], {})).toEqual([
      {
        op: "set",
        service: "app:no-auth",
        account: b64("accessToken"),
        generic: b64("accessToken"),
        attributesAsData: true,
        data: b64("tok"),
        accessible: "whenUnlocked",
        replaces: [
          {
            service: "app:auth",
            account: b64("accessToken"),
            generic: b64("accessToken"),
            attributesAsData: true,
          },
          {
            service: "app",
            account: b64("accessToken"),
            generic: b64("accessToken"),
            attributesAsData: true,
          },
        ],
      },
    ]);
  });

  test("set honors keychainService, access group, and accessible", () => {
    const [operation] = keychainSetOperations("expo-secure-store", [["k", "v"]], {
      service: "auth",
      accessGroup: "TEAM.group",
      accessible: "afterFirstUnlock",
    });
    expect(operation).toMatchObject({
      service: "auth:no-auth",
      accessGroup: "TEAM.group",
      accessible: "afterFirstUnlock",
    });
  });

  test("delete removes every alias SecureStore reads", () => {
    const [group] = keychainDeleteOperations("expo-secure-store", ["k"], {});
    expect(group!.map((operation) => operation.op === "delete" && operation.service)).toEqual([
      "app:no-auth",
      "app:auth",
      "app",
    ]);
  });

  test("refuses keys SecureStore refuses", () => {
    expect(() => keychainSetOperations("expo-secure-store", [["a b", "v"]], {})).toThrow(
      "expo-secure-store keys contain only",
    );
  });

  test("lists keys from its services only, once each", () => {
    const items = [
      { service: "app:no-auth", account: b64("b") },
      { service: "app", account: b64("a") },
      { service: "app:auth", account: b64("b") },
      { service: "other", account: b64("c") },
    ];
    expect(keychainKeys("expo-secure-store", items, {})).toEqual(["a", "b"]);
  });
});

describe("generic-password format", () => {
  test("stores the key as a string account in the given service", () => {
    expect(
      keychainSetOperations("generic-password", [["user", "pw"]], { service: "com.example" }),
    ).toEqual([
      {
        op: "set",
        service: "com.example",
        account: b64("user"),
        data: b64("pw"),
        accessible: "afterFirstUnlock",
      },
    ]);
  });

  test("needs a service, and refuses an empty one", () => {
    expect(() => keychainSetOperations("generic-password", [["user", "pw"]], {})).toThrow(
      "The generic-password format needs a service.",
    );
    expect(() =>
      keychainSetOperations("generic-password", [["user", "pw"]], { service: "" }),
    ).toThrow("A service cannot be empty.");
  });

  test("lists keys from its service only", () => {
    const items = [
      { service: "com.example", account: b64("user") },
      { service: "other", account: b64("else") },
    ];
    expect(keychainKeys("generic-password", items, { service: "com.example" })).toEqual(["user"]);
  });
});

test("a delete succeeds when any alias went away and none failed", () => {
  expect(deleteStatus([{ status: -25300 }, { status: 0 }, { status: -25300 }])).toBe(0);
  expect(deleteStatus([{ status: -25300 }, { status: -25300 }])).toBe(-25300);
  expect(deleteStatus([{ status: -25300 }, { status: -34018 }])).toBe(-34018);
  expect(deleteStatus([{ status: 0 }, { status: -34018 }])).toBe(-34018);
});

test("statuses read as words", () => {
  expect(describeKeychainStatus(0)).toBe("ok");
  expect(describeKeychainStatus(-34018)).toContain("no keychain entitlement");
  expect(describeKeychainStatus(-1)).toBe("keychain error -1");
});

describe("parseKeychainEntries", () => {
  test("reads key=value pairs, keeping = inside values", () => {
    expect(parseKeychainEntries(["a=1", "b=x=y"], null)).toEqual([
      ["a", "1"],
      ["b", "x=y"],
    ]);
  });

  test("lets the file override a pair with the same key", () => {
    expect(parseKeychainEntries(["a=1"], '{"a":"2","b":"3"}')).toEqual([
      ["a", "2"],
      ["b", "3"],
    ]);
  });

  test("refuses malformed input", () => {
    expect(() => parseKeychainEntries(["a=1", "secret-token"], null)).toThrow(
      "Expected key=value in entry 2.",
    );
    expect(() => parseKeychainEntries(["secret-token"], null)).not.toThrow("secret-token");
    expect(() => parseKeychainEntries([], '{"a":1}')).toThrow("JSON object of string");
    expect(() => parseKeychainEntries([], "not json")).toThrow("JSON object of string");
    expect(() => parseKeychainEntries([], null)).toThrow("Pass key=value pairs");
  });
});
