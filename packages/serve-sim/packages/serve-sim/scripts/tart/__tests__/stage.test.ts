import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTartConfig } from "../guest";
import { resolveTestFiles } from "../stage";

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

describe("resolveTestFiles", () => {
  test("defaults to every pasteboard and clipboard test that exists", () => {
    const root = mkdtempSync(join(tmpdir(), "tart-tests-"));
    mkdirSync(join(root, "src", "__tests__"), { recursive: true });
    for (const name of [
      "pasteboard-copy.e2e.test.ts",
      "pasteboard-inject.e2e.test.ts",
      "pasteboard-endpoint.test.ts",
      "sim-clipboard.test.ts",
      "sim-clipboard.e2e.test.ts",
      "pasteboard-sim.ts",
      "unrelated.test.ts",
    ]) {
      writeFileSync(join(root, "src", "__tests__", name), "");
    }
    expect(resolveTestFiles(root, [])).toEqual([
      "src/__tests__/pasteboard-copy.e2e.test.ts",
      "src/__tests__/pasteboard-endpoint.test.ts",
      "src/__tests__/pasteboard-inject.e2e.test.ts",
      "src/__tests__/sim-clipboard.e2e.test.ts",
      "src/__tests__/sim-clipboard.test.ts",
    ]);
  });

  test("uses explicit files instead of the default", () => {
    expect(resolveTestFiles("/pkg", ["src/__tests__/foo.test.ts"])).toEqual([
      "src/__tests__/foo.test.ts",
    ]);
  });
});
