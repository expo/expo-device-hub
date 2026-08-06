import { expect, test } from "bun:test";
import { reportError, result } from "../errors";

test("returns the utility error with the invocation result", () => {
  const error = new Error("devicectl unavailable");
  const captured = reportError("Failed to list devices", error);

  expect(result([], captured)).toEqual({
    value: [],
    error: { message: "Failed to list devices", error },
  });
});
