import { describe, expect, test } from "bun:test";

import { isAlreadyShutDown } from "../device";

describe("isAlreadyShutDown", () => {
  test("recognises simctl's sentence for a device that is already off", () => {
    expect(
      isAlreadyShutDown(
        new Error(
          "Command failed: xcrun simctl shutdown ABC\nAn error was encountered processing the command " +
            "(domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to shutdown device in current " +
            "state: Shutdown\n",
        ),
      ),
    ).toBe(true);
  });

  test("does not treat a missing device as a device that shut down", () => {
    // execFile puts the command line in the message, so matching a bare `shutdown` matches every failure.
    expect(
      isAlreadyShutDown(new Error("Command failed: xcrun simctl shutdown ABC\nInvalid device: ABC\n")),
    ).toBe(false);
  });

  test("does not swallow a timeout", () => {
    expect(isAlreadyShutDown(new Error("Command failed: xcrun simctl shutdown ABC\nETIMEDOUT"))).toBe(
      false,
    );
  });
});
