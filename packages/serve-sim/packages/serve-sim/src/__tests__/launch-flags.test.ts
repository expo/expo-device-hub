import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

import { requireE2E } from "./e2e-preconditions";

// Drives the built CLI. Every case here is rejected before a device is touched,
// so it needs no simulator, only the built bundle.
const CLI = join(import.meta.dir, "../../dist/serve-sim.js");

requireE2E("launch flags", existsSync(CLI));

async function runCli(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["node", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe.skipIf(!existsSync(CLI))("launch flags", () => {
  test("rejects an empty app identifier", async () => {
    const { code, stderr } = await runCli(["--launch-app-identifier", ""]);
    expect(code).toBe(1);
    expect(stderr).toContain("needs an app bundle identifier");
  });

  test("rejects launch arguments with no app to launch", async () => {
    const { code, stderr } = await runCli(["--launch-arg", "-Foo"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Pass --launch-app-identifier");
  });

  test("rejects a URL with no app to open it in", async () => {
    const { code, stderr } = await runCli(["--open-url", "exp://127.0.0.1:8081"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Pass --launch-app-identifier");
  });

  test("rejects an app launch that --detach would silently skip", async () => {
    const { code, stderr } = await runCli([
      "--detach",
      "--launch-app-identifier",
      "dev.expo.serve-sim.launch-fixture",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--launch-app-identifier");
    expect(stderr).toContain("drop --detach");
  });

  test("names every flag that --detach would silently skip", async () => {
    const { code, stderr } = await runCli([
      "--detach",
      "--launch-app-identifier",
      "dev.expo.serve-sim.launch-fixture",
      "--launch-arg",
      "-Foo",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--launch-app-identifier, --launch-arg need the foreground session");
  });

  test("rejects a URL that is not a URL", async () => {
    const { code, stderr } = await runCli([
      "--launch-app-identifier",
      "dev.expo.serve-sim.launch-fixture",
      "--open-url",
      "not-a-url",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("Invalid URL 'not-a-url'");
  });
});
