import { describe, expect, test } from "bun:test";
import { join } from "path";

// Needs no simulator: the dylib ships for iOS, but the parsing is the same code.
const RUNNER = join(import.meta.dir, "../../Sources/ServeSimCapabilityLoader/tests/run.sh");

describe("capability loader C", () => {
  test("parses its config without memory errors or analyzer findings", async () => {
    const proc = Bun.spawn(["bash", RUNNER], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(`${stdout}${stderr}`).not.toContain("FAIL ");
    expect(code).toBe(0);
    expect(stdout).toContain("analyzer clean");
  }, 120_000);
});
