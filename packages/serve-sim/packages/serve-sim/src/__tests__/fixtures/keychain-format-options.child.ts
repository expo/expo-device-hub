import { expect, spyOn, test } from "bun:test";
import { runHostActionAsync } from "../../host-actions";
import * as keychain from "../../keychain";
import { keychainDeleteOperations, keychainSetOperations } from "../../keychain";
import { UDID } from "../helpers";

test("react-native-keychain refuses a separate service option", () => {
  expect(() =>
    keychainSetOperations("react-native-keychain", [["auth", "synthetic"]], { service: "other" }),
  ).toThrow("takes no service");
});

test.each(["expo-secure-store", "generic-password"] as const)(
  "%s refuses a username option",
  (format) => {
    expect(() =>
      keychainSetOperations(format, [["token", "synthetic"]], {
        service: "auth",
        username: "alice",
      }),
    ).toThrow("takes no username");
  },
);

test("valid credentials preserve service and username after an option refusal", () => {
  expect(() =>
    keychainSetOperations("react-native-keychain", [[" auth ", "synthetic"]], { service: "bad" }),
  ).toThrow("takes no service");
  const [operation] = keychainSetOperations("react-native-keychain", [[" auth ", "synthetic"]], {
    username: " alice ",
  });
  expect(operation).toMatchObject({
    service: " auth ",
    account: Buffer.from(" alice ").toString("base64"),
    data: Buffer.from("synthetic").toString("base64"),
    clears: [{ service: " auth " }],
  });
});

test("KeychainAccess refuses missing context and then accepts default or explicit services", () => {
  expect(() => keychainSetOperations("keychain-access", [["token", "synthetic"]], {})).toThrow(
    "needs a service or the app's bundle ID",
  );
  expect(() => keychainDeleteOperations("keychain-access", ["token"], {})).toThrow(
    "needs a service or the app's bundle ID",
  );
  expect(
    keychainSetOperations("keychain-access", [["token", "synthetic"]], {
      bundleId: "com.example.app",
    })[0],
  ).toMatchObject({ service: "com.example.app" });
  expect(
    keychainDeleteOperations("keychain-access", ["token"], {
      bundleId: "com.example.app",
      service: " auth ",
    })[0],
  ).toEqual([
    { op: "delete", service: " auth ", account: Buffer.from("token").toString("base64") },
  ]);
});

test.each([
  "expo-secure-store",
  "generic-password",
  "react-native-keychain",
  "keychain-access",
] as const)("%s refuses a key prefix", (format) => {
  expect(() =>
    keychainSetOperations(format, [["token", "synthetic"]], {
      ...(format === "generic-password" ? { service: "auth" } : {}),
      keyPrefix: " ks_ ",
    }),
  ).toThrow("takes no key prefix");
});

test("KeychainSwift refuses incompatible options and then preserves an exact prefix", () => {
  expect(() =>
    keychainSetOperations("keychain-swift", [["token", "synthetic"]], { service: "auth" }),
  ).toThrow("takes no service");
  expect(() =>
    keychainDeleteOperations("keychain-swift", ["token"], { username: "alice" }),
  ).toThrow("takes no username");
  const account = Buffer.from(" ks_  token ").toString("base64");
  expect(
    keychainSetOperations("keychain-swift", [[" token ", "synthetic"]], { keyPrefix: " ks_ " })[0],
  ).toMatchObject({ account, clears: [{ account }] });
  expect(
    keychainDeleteOperations("keychain-swift", [" token "], { keyPrefix: " ks_ " })[0],
  ).toEqual([{ op: "delete", account }]);
});

test("KeychainSwift controls accept an explicit empty prefix for set, delete, and list", async () => {
  const stubs = [
    spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: true, keys: [] }),
    spyOn(keychain, "deleteKeychainValues").mockResolvedValue({ applied: true, keys: [] }),
    spyOn(keychain, "listKeychainKeys").mockResolvedValue([]),
  ];
  try {
    for (const [action, params] of [
      ["keychain.set", { values: { token: "synthetic" } }],
      ["keychain.delete", { keys: ["token"] }],
      ["keychain.list", {}],
    ] as const) {
      const result = await runHostActionAsync(
        {
          action,
          params: {
            udid: UDID,
            bundleId: "com.example.app",
            format: "keychain-swift",
            keyPrefix: "",
            ...params,
          },
        },
        "false",
      );
      expect(result.exitCode).toBe(0);
    }
    for (const stub of stubs) {
      expect(stub).toHaveBeenCalledTimes(1);
      expect(stub.mock.calls[0]?.[0]).toMatchObject({
        format: "keychain-swift",
        options: { keyPrefix: "" },
      });
    }
  } finally {
    for (const stub of stubs) stub.mockRestore();
  }
});
