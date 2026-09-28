import { describe, expect, test } from "bun:test";
import { transitionMode } from "../client/simulator/use-simstream-stream";

describe("transitionMode", () => {
  test("defaults to burst so full-screen transitions stay sharp", () => {
    expect(transitionMode("")).toBe("burst");
  });
  test("honors ?transitions= in the URL", () => {
    expect(transitionMode("?transitions=soft")).toBe("soft");
    expect(transitionMode("?token=x&transitions=fps30")).toBe("fps30");
  });
  test("ignores unknown values", () => {
    expect(transitionMode("?transitions=turbo")).toBe("burst");
  });
});
