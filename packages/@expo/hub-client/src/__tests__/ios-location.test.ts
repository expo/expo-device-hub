import { describe, expect, test } from "bun:test";

import { type ExecResult } from "../ios-app-details";
import { clearIosLocation, setIosLocation, simctlFailureMessage } from "../ios-location";

const UDID = "ABC-123";
const FIX = { latitude: 37.3349, longitude: -122.009 };

const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
const failed = (stderr: string): ExecResult => ({ stdout: "", stderr, exitCode: 1 });

function fakeExec(result: ExecResult) {
  const commands: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    return result;
  };
  return { exec, commands };
}

describe("setIosLocation", () => {
  test("emits the simctl set command with a quoted udid and 7-decimal coordinates", async () => {
    const { exec, commands } = fakeExec(ok);

    expect(await setIosLocation(exec, UDID, FIX)).toBe(FIX);
    expect(commands).toEqual(["xcrun simctl location 'ABC-123' set 37.3349000,-122.0090000"]);
  });

  test("rejects on a non-zero exit even though exec resolved", async () => {
    const { exec } = fakeExec(
      failed("An error was encountered processing the command.\nReason: device not booted\n"),
    );

    await expect(setIosLocation(exec, UDID, FIX)).rejects.toThrow("device not booted");
  });
});

describe("clearIosLocation", () => {
  test("emits the simctl clear command with a quoted udid", async () => {
    const { exec, commands } = fakeExec(ok);

    await clearIosLocation(exec, UDID);
    expect(commands).toEqual(["xcrun simctl location 'ABC-123' clear"]);
  });

  test("rejects on a non-zero exit even though exec resolved", async () => {
    const { exec } = fakeExec(failed("Invalid device: ABC-123"));

    await expect(clearIosLocation(exec, UDID)).rejects.toThrow("Invalid device: ABC-123");
  });
});

describe("simctlFailureMessage", () => {
  test("prefers the Reason line over the rest of stderr", () => {
    expect(
      simctlFailureMessage(failed("noise\nReason: Unable to lookup in current state\ntrailing\n")),
    ).toBe("Unable to lookup in current state");
  });

  test("falls back to the last non-empty stderr line", () => {
    expect(simctlFailureMessage(failed("first line\nInvalid device type\n\n"))).toBe(
      "Invalid device type",
    );
  });

  test("falls back to a fixed message when stderr says nothing", () => {
    expect(simctlFailureMessage(failed(""))).toBe("simctl location failed");
    expect(simctlFailureMessage(failed("  \n\n"))).toBe("simctl location failed");
  });
});
