import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMitmproxy } from "../../scripts/test/check-mitmproxy";

const CHECK = join(import.meta.dir, "../../scripts/test/check-mitmproxy.ts");
const E2E = join(import.meta.dir, "../../scripts/test/e2e.sh");

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-preflight-test-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function probe(binary: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CHECK], {
    env: { ...process.env, ...env, SERVE_SIM_MITMDUMP: binary }, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("preflight rejects a missing override without falling back to an installed proxy", async () => {
  await fixture(async dir => {
    const result = await probe(join(dir, "missing"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SERVE_SIM_MITMDUMP points at");
  });
});

test("preflight runs the selected override with --version and reports its output", async () => {
  await fixture(async dir => {
    const binary = join(dir, "selected");
    const marker = join(dir, "arguments");
    writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$1" > "$SERVE_SIM_PREFLIGHT_MARKER"\nprintf "mitmproxy fixture version\\n"\n', { mode: 0o755 });
    writeFileSync(join(dir, "mitmdump"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const result = await probe(binary, { PATH: dir, SERVE_SIM_PREFLIGHT_MARKER: marker });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("--version");
    expect(result.stdout).toContain("mitmproxy fixture version");
  });
});

test("preflight propagates a broken executable's status and diagnostics", async () => {
  await fixture(async dir => {
    const binary = join(dir, "broken");
    writeFileSync(binary, '#!/bin/sh\nprintf "fixture startup failure\\n" >&2\nexit 17\n', { mode: 0o755 });
    const result = await probe(binary);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("exited with 17");
    expect(result.stderr).toContain("fixture startup failure");
  });
});

test("preflight bounds an executable that never responds", async () => {
  await fixture(async dir => {
    const binary = join(dir, "hung");
    writeFileSync(binary, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
    const original = process.env.SERVE_SIM_MITMDUMP;
    process.env.SERVE_SIM_MITMDUMP = binary;
    try {
      await expect(checkMitmproxy(100)).rejects.toThrow("SIGKILL");
    } finally {
      if (original === undefined) delete process.env.SERVE_SIM_MITMDUMP;
      else process.env.SERVE_SIM_MITMDUMP = original;
    }
  });
});

function running(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

function kill(pid: number) {
  try { process.kill(pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function expectStopped(pid: number) {
  for (let attempt = 0; attempt < 40 && running(pid); attempt++) await Bun.sleep(25);
  expect(running(pid)).toBe(false);
}

for (const hang of [false, true]) {
  test(`preflight stops launcher descendants after ${hang ? "timeout" : "success"}`, async () => {
    await fixture(async dir => {
      const binary = join(dir, "launcher");
      const marker = join(dir, "pid");
      writeFileSync(binary, `#!/bin/sh\n/bin/sleep 30 &\nprintf '%s' "$!" > '${marker}'\n${hang ? "exec /bin/sleep 30" : "exit 0"}\n`, { mode: 0o755 });
      const original = process.env.SERVE_SIM_MITMDUMP;
      process.env.SERVE_SIM_MITMDUMP = binary;
      let pid: number | undefined;
      try {
        if (hang) await expect(checkMitmproxy(500)).rejects.toThrow("SIGKILL");
        else await checkMitmproxy(500);
        pid = Number(readFileSync(marker, "utf8"));
        expect(pid).toBeGreaterThan(0);
        await expectStopped(pid);
      } finally {
        if (pid) kill(pid);
        if (original === undefined) delete process.env.SERVE_SIM_MITMDUMP;
        else process.env.SERVE_SIM_MITMDUMP = original;
      }
    });
  });
}

for (const [signal, code, external] of [
  ["SIGINT", 130, false], ["SIGTERM", 143, false], ["SIGHUP", 129, false], ["SIGTERM", 99, true],
] as const) {
  test(`preflight cleans up on ${signal}${external ? " before an existing exit handler" : " sent only to Bun"}`, async () => {
    await fixture(async dir => {
      const binary = join(dir, "launcher");
      const marker = join(dir, "pids");
      writeFileSync(binary, `#!/bin/sh\n/bin/sleep 30 &\nprintf '%s %s' "$$" "$!" > '${marker}'\nwait\n`, { mode: 0o755 });
      const driver = join(dir, "driver.ts");
      writeFileSync(driver, `import { checkMitmproxy } from ${JSON.stringify(CHECK)};\nprocess.on("SIGTERM", () => process.exit(99));\nawait checkMitmproxy();\n`);
      const child = Bun.spawn([process.execPath, external ? driver : CHECK], {
        env: { ...process.env, SERVE_SIM_MITMDUMP: binary }, stdout: "ignore", stderr: "ignore",
      });
      let pids: number[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (let attempt = 0; attempt < 100 && !Bun.file(marker).size; attempt++) await Bun.sleep(10);
        pids = readFileSync(marker, "utf8").split(" ").map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
        expect(pids).toHaveLength(2);
        for (const pid of pids) expect(pid).toBeGreaterThan(0);
        process.kill(child.pid, signal);
        const result = await Promise.race([
          child.exited,
          new Promise(resolve => { timer = setTimeout(() => resolve("still running"), 1500); }),
        ]);
        expect(result).toBe(code);
        for (const pid of pids) await expectStopped(pid);
      } finally {
        clearTimeout(timer);
        if (running(child.pid)) kill(child.pid);
        await child.exited;
        for (const pid of pids) kill(pid);
      }
    });
  });
}

test("the full local E2E entry fails before building fixtures when mitmproxy is missing", async () => {
  await fixture(async dir => {
    // The wrapper sees only this fake device. Any fixture build is blocked as well.
    writeFileSync(join(dir, "xcrun"), '#!/bin/sh\nprintf \'{"udid" : "preflight-probe"}\\n\'\n', { mode: 0o755 });
    writeFileSync(join(dir, "bash"), "#!/bin/sh\necho unexpected-fixture-build >&2\nexit 91\n", { mode: 0o755 });
    const child = Bun.spawn(["/bin/bash", E2E], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SERVE_SIM_TEST_UDID: "preflight-probe", SERVE_SIM_MITMDUMP: join(dir, "missing") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Capture test prerequisite failed");
    expect(stderr).not.toContain("unexpected-fixture-build");
  });
});
