import { describe, expect, test } from "bun:test";
import { loadTartConfig } from "../guest";

describe("tart config", () => {
  test("resolves the serve-sim package as pkgDir", () => {
    const config = loadTartConfig();
    expect(config.pkgDir.endsWith("packages/serve-sim")).toBe(true);
    expect(config.vm).toBe(process.env.TART_VM ?? "tahoe-xcode");
  });

  test("rejects a TART_USER that is not a unix name", () => {
    const previous = process.env.TART_USER;
    process.env.TART_USER = "expo; rm -rf /";
    try {
      expect(() => loadTartConfig()).toThrow(/invalid TART_USER/);
    } finally {
      if (previous === undefined) delete process.env.TART_USER;
      else process.env.TART_USER = previous;
    }
  });
});
