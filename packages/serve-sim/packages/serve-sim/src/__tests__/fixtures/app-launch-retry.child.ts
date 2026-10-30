import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import * as launchManager from "../../launch-manager";
import { simctlRaw } from "../../simctl";
import { installShims } from "../helpers";

const UDID = "11111111-2222-3333-4444-555555555555";
let shims: ReturnType<typeof installShims>;
beforeAll(() => {
  shims = installShims({ xcrun: "#!/bin/sh\nexec sleep 5\n" });
});
afterAll(() => shims.restore());

// A real simctl timeout, so the retry sees the same error object a stalled call produces.
const timeout = (argument = "DYLD_INSERT_LIBRARIES") =>
  simctlRaw(["spawn", UDID, "launchctl", "getenv", argument], 50).then(
    () => new Error("expected a timeout"),
    (error: Error) => error,
  );
let outcomes: (Error | undefined)[] = [];
let calls = 0;
mock.module("../../launch-manager", () => ({
  ...launchManager,
  launchApp: async () => {
    const outcome = outcomes[calls++];
    if (outcome) throw outcome;
  },
}));
const { runHostActionAsync } = await import("../../host-actions");
spyOn(process.stderr, "write").mockImplementation(() => true);
spyOn(console, "error").mockImplementation(() => {});

const launch = () =>
  runHostActionAsync(
    { action: "app.launch", params: { udid: UDID, bundleId: "com.example.app" } },
    "true",
  );

test.each([
  ["retries a simctl timeout once and then succeeds", async () => [await timeout()], 2, 0],
  [
    "retries a timeout whose arguments contain a newline",
    async () => [await timeout("first\nsecond")],
    2,
    0,
  ],
  ["does not retry a second timeout", async () => [await timeout(), await timeout()], 2, 1],
  [
    "does not retry other failures",
    async () => [new Error("simctl launch: app not installed")],
    1,
    1,
  ],
] as const)("%s", async (_name, failures, expectedCalls, exitCode) => {
  outcomes = await failures();
  calls = 0;
  const result = await launch();
  expect(calls).toBe(expectedCalls);
  expect(result.exitCode).toBe(exitCode);
});
