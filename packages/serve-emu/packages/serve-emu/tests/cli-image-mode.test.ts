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

describe("CLI gRPC image modes", () => {
  test("documents RGB888 while retaining the PNG default", async () => {
    const result = await runCli("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--grpc-image-mode <png|mmap|rgb888>");
    expect(result.stdout).toContain("default: png");
    expect(result.stdout).toContain("RGB888 sends raw pixels over gRPC");
  });

  test.each(["png", "mmap", "rgb888"])(
    "accepts %s before validating encoder options",
    async (mode) => {
      // An explicit serial bypasses discovery; invalid max-size stops before
      // opening a capture session, so this runs without adb or an emulator.
      const result = await runCli(
        "--serial",
        "emulator-test",
        "--stream-mode",
        "grpc-screenshot",
        "--grpc-image-mode",
        mode,
        "--max-size",
        "invalid",
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--max-size");
      expect(result.stderr).not.toContain("--grpc-image-mode must be");
    },
  );

  test("rejects unsupported image modes before opening capture", async () => {
    const result = await runCli("--grpc-image-mode", "rgb");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "--grpc-image-mode must be one of: png, mmap, rgb888",
    );
  });
});
