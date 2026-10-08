import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

import { requireE2E } from "./e2e-preconditions";

// Drives the built CLI. Every case here is rejected before a device is touched,
// so it needs no simulator, only the built bundle.
const CLI = join(import.meta.dir, "../../dist/serve-sim.js");

requireE2E("launch flags", existsSync(CLI));

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe.skipIf(!existsSync(CLI))("launch flags", () => {
  test("validates the installation path without a launch identifier", async () => {
    const { code, stderr } = await runCli(["--install-app-path", CLI]);
    expect(code).toBe(1);
    expect(stderr).toContain("--install-app-path needs an existing .app directory");
  });

  test("rejects an installation path that is not an app directory", async () => {
    const { code, stderr } = await runCli([
      "--install-app-path", CLI, "--launch-app-identifier", "dev.example.app",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--install-app-path needs an existing .app directory");
  });

  test.each([
    [["--install-app-path", CLI], "--install-app-path needs an existing .app directory"],
    [["--install-app-path", CLI, "--launch-app-identifier", "dev.example.app"], "--install-app-path needs an existing .app directory"],
  ])("quiet installation validation reports JSON for %j", async (args, diagnostic) => {
    const { code, stdout } = await runCli(["--quiet", ...args]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: expect.stringContaining(diagnostic) });
  });

  test("rejects an invalid capture proxy before touching a simulator, without exposing credentials", async () => {
    const { code, stderr } = await runCli(["--network-capture-proxy", "socks://user:cli-secret@proxy:8899"]);
    expect(code).toBe(1);
    expect(stderr).toContain("HTTP proxy URL");
    expect(stderr).not.toContain("cli-secret");
  });

  test("accepts direct and authenticated capture proxy launch arguments", async () => {
    for (const proxy of ["none", "http://user:cli-secret@proxy:8899"]) {
      const { code, stderr } = await runCli(["--network-capture-proxy", proxy, "--transport", "invalid"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--transport must be one of");
      expect(stderr).not.toContain("HTTP proxy URL");
      expect(stderr).not.toContain("cli-secret");
    }
  });

  test.each(["--detach", "--no-preview"])("rejects configured upstreams with %s without exposing credentials", async (mode) => {
    for (const proxy of ["http://proxy:8899", "http://user:cli-secret@proxy:8899"]) {
      const { code, stderr } = await runCli(["--network-capture-proxy", proxy, mode]);
      expect(code).toBe(1);
      expect(stderr).toContain("--network-capture-proxy needs the preview server");
      expect(stderr).not.toContain("cli-secret");
    }
  });

  test.each(["--detach", "--no-preview"])("quiet upstream rejection reports JSON with %s", async (mode) => {
    const { code, stdout, stderr } = await runCli(["--quiet", "--network-capture-proxy", "http://user:cli-secret@proxy:8899", mode]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: expect.stringContaining("--network-capture-proxy needs the preview server") });
    expect(stdout + stderr).not.toContain("cli-secret");
  });

  test.each(["--detach", "--no-preview"])("allows omitted or explicitly direct upstream with %s", async (mode) => {
    for (const proxyArgs of [[], ["--network-capture-proxy", "none"]]) {
      // This later validation stops before device selection and proves the upstream check allowed it.
      const { code, stderr } = await runCli([...proxyArgs, mode, "--require-token"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--require-token needs the preview server");
      expect(stderr).not.toContain("--network-capture-proxy needs");
    }
  });

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

  test("rejects network capture on a public host without the token gate", async () => {
    const { code, stderr } = await runCli(["--network-capture", "--host", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--network-capture on --host 0.0.0.0 needs --require-token");
  });

  test("rejects capture enabled as a capability on a public host without the token gate", async () => {
    // Capabilities are applied before the preview server starts, so this must be refused up front.
    const { code, stderr } = await runCli(["--enable", "networkCapture", "--host", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--enable networkCapture on --host 0.0.0.0 needs --require-token");
  });

  test("does not refuse capture that --disable turns back off", async () => {
    // --disable wins, so nothing captures and a public preview needs no token for it. A device that
    // does not exist stops the run right after the check, with or without a simulator to serve.
    const { code, stderr } = await runCli([
      "NOT-A-DEVICE", "--enable", "networkCapture", "--disable", "networkCapture", "--host", "0.0.0.0",
    ]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("needs --require-token");
  });

  test("rejects network capture in the run modes that would record nothing", async () => {
    // Both exit once the helpers are up, and the proxy lives in this process, so capture would stop with it.
    for (const mode of ["--detach", "--no-preview"]) {
      const { code, stderr } = await runCli(["--network-capture", mode]);
      expect(code).toBe(1);
      expect(stderr).toContain("--network-capture needs the preview server");
    }
  });
});
