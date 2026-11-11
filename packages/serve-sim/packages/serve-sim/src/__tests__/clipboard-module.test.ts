import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("fresh Clipboard imports and construction leave process handlers untouched", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/clipboard-module-import.child.ts", import.meta.url)),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  );
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  expect(Buffer.from(result.stdout).toString()).toContain("without installing process handlers");
});
