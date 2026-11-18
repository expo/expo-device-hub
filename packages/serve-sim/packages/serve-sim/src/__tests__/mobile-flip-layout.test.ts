import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("presentation starts at the current bounds after width-only resizing", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/mobile-flip-layout.child.tsx", import.meta.url)),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(new TextDecoder().decode(child.stderr)).not.toContain("Warning: An update");
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
