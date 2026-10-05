import { describe, expect, test } from "bun:test";

async function runCli(...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      new URL("../src/cli.ts", import.meta.url).pathname,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("CLI --token", () => {
  // A client sends the token as a header, a query, a cookie, or a subprotocol,
  // so the CLI refuses one that cannot travel unchanged in all of them.
  test.each(["", "a,b", "with space", "YWJjZA==", "café", "end\n"])(
    "refuses %p before opening a device",
    async (token) => {
      const result = await runCli("--serial", "emulator-test", "--token", token);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--token must be one or more letters, digits");
    },
  );

  test("takes a base64url token", async () => {
    // An invalid --max-size stops after the token check, before capture opens.
    const result = await runCli(
      "--serial",
      "emulator-test",
      "--token",
      "jJ3k_Qx-9Zp2",
      "--max-size",
      "invalid",
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--max-size");
    expect(result.stderr).not.toContain("--token must be");
  });
});
