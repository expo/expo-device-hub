import { describe, expect, test } from "bun:test";
import { avdmanagerPath, resolveAvdmanagerPath, resolveSdkRoot } from "../sdk-paths";

const HOME = "/Users/test";

describe("resolveSdkRoot", () => {
  test("prefers ANDROID_HOME", () => {
    const env = { ANDROID_HOME: "/sdk/home", ANDROID_SDK_ROOT: "/sdk/root" };
    expect(resolveSdkRoot(env, HOME)).toBe("/sdk/home");
  });

  test("falls back to ANDROID_SDK_ROOT", () => {
    expect(resolveSdkRoot({ ANDROID_SDK_ROOT: "/sdk/root" }, HOME)).toBe("/sdk/root");
  });

  test("falls back to the default macOS SDK location", () => {
    expect(resolveSdkRoot({}, HOME)).toBe("/Users/test/Library/Android/sdk");
  });

  test("ignores empty / whitespace env values", () => {
    const env = { ANDROID_HOME: "   ", ANDROID_SDK_ROOT: "" };
    expect(resolveSdkRoot(env, HOME)).toBe("/Users/test/Library/Android/sdk");
  });

  test("trims surrounding whitespace", () => {
    expect(resolveSdkRoot({ ANDROID_HOME: "  /sdk/home  " }, HOME)).toBe("/sdk/home");
  });
});

describe("avdmanagerPath", () => {
  test("appends the cmdline-tools binary subpath", () => {
    expect(avdmanagerPath("/sdk")).toBe("/sdk/cmdline-tools/latest/bin/avdmanager");
  });
});

describe("resolveAvdmanagerPath", () => {
  test("combines SDK resolution with the binary subpath", () => {
    expect(resolveAvdmanagerPath({ ANDROID_HOME: "/sdk/home" }, HOME)).toBe(
      "/sdk/home/cmdline-tools/latest/bin/avdmanager",
    );
  });
});
