import { expect, test } from "bun:test";
import { keychainSetOperations } from "../../keychain";

test("react-native-keychain refuses a separate service option", () => {
  expect(() =>
    keychainSetOperations("react-native-keychain", [["auth", "synthetic"]], { service: "other" }),
  ).toThrow("takes no service; its keys are services");
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
