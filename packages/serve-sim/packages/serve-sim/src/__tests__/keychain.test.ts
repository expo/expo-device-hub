import { describe, expect, test } from "bun:test";
import {
  describeKeychainStatus,
  keychainDeleteOperations,
  keychainKeys,
  keychainSetOperations,
  listKeychainKeys,
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

  test("delete sends all aliases for each SecureStore key together", () => {
    const operations = keychainDeleteOperations("expo-secure-store", ["k", "other"], {
      accessGroup: "TEAM.group",
    });
    expect(operations).toEqual(
      ["k", "other"].map((key) => ({
        op: "delete-aliases",
        items: ["app:no-auth", "app:auth", "app"].map((service) => ({
          service,
          account: b64(key),
          generic: b64(key),
          attributesAsData: true,
          accessGroup: "TEAM.group",
        })),
      })),
    );
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

  test("stores no username", () => {
    expect(() =>
      keychainSetOperations("generic-password", [["user", "pw"]], { service: "s", username: "u" }),
    ).toThrow("The generic-password format takes no username.");
  });

  test("lists keys from its service only", () => {
    const items = [
      { service: "com.example", account: b64("user") },
      { service: "other", account: b64("else") },
    ];
    expect(keychainKeys("generic-password", items, { service: "com.example" })).toEqual(["user"]);
  });
});

describe("react-native-keychain format", () => {
  test("set empties the key's service, then stores the username and password in it", () => {
    expect(
      keychainSetOperations("react-native-keychain", [["com.example.app", "pw"]], {
        username: "alice",
      }),
    ).toEqual([
      {
        op: "set",
        clears: [{ service: "com.example.app" }],
        service: "com.example.app",
        account: b64("alice"),
        data: b64("pw"),
        accessible: "afterFirstUnlock",
      },
    ]);
    const [operation] = keychainSetOperations("react-native-keychain", [["svc", "pw"]], {
      accessGroup: "TEAM.group",
    });
    // No username: react-native-keychain then stores an empty account.
    expect(operation).toMatchObject({
      account: "",
      accessGroup: "TEAM.group",
      clears: [{ service: "svc", accessGroup: "TEAM.group" }],
    });
  });

  test("delete removes every item in the key's service", () => {
    expect(keychainDeleteOperations("react-native-keychain", ["svc"], {})).toEqual([
      { op: "delete", service: "svc" },
    ]);
  });

  test("lists services, as getAllGenericPasswordServices does", () => {
    const items = [
      { service: "svc", account: b64("alice") },
      { service: "app:no-auth", account: b64("k") },
      { service: "svc", account: b64("bob") },
      { service: "", account: b64("swift") },
    ];
    expect(keychainKeys("react-native-keychain", items, {})).toEqual(["app:no-auth", "svc"]);
  });

  test("its keys are services, so it takes no service", () => {
    expect(() =>
      keychainSetOperations("react-native-keychain", [["svc", "pw"]], { service: "x" }),
    ).toThrow("takes no service; its keys are services");
  });
});

test("statuses read as words", () => {
  expect(describeKeychainStatus(0)).toBe("ok");
  expect(describeKeychainStatus(-34018)).toContain("no keychain entitlement");
  expect(describeKeychainStatus(-1)).toBe("keychain error -1");
  expect(describeKeychainStatus(-50, "unknown op")).toContain(
    "Update and restart serve-sim, then reopen the app",
  );
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

test("rejects an explicitly empty access group for set, delete, and list", async () => {
  const options = { accessGroup: "" };
  const format = "expo-secure-store";
  expect(() => keychainSetOperations(format, [["token", "test"]], options)).toThrow(
    "An access group cannot be empty",
  );
  expect(() => keychainDeleteOperations(format, ["token"], options)).toThrow(
    "An access group cannot be empty",
  );
  await expect(
    listKeychainKeys({ format, options, udid: "device", bundleId: "com.example.app" }),
  ).rejects.toThrow("An access group cannot be empty");
});
