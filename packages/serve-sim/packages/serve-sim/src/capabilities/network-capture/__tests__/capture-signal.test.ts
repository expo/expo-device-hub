import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

const ENGINE = join(import.meta.dir, "..", "mitm-engine.ts");

function signalChild(withGracefulHandler: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-capture-signal-"));
  const marker = join(dir, "reaped");
  const script = `
    import { writeFileSync } from "node:fs";
    import { captureReapersForTest } from ${JSON.stringify(ENGINE)};
    let reaped = false;
    captureReapersForTest.add(() => { reaped = true; writeFileSync(${JSON.stringify(marker)}, "1"); });
    ${withGracefulHandler ? `process.on("SIGTERM", () => { console.log("graceful reaped=" + reaped); process.exit(0); });` : ""}
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => {}, 2000);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
  const reaped = existsSync(marker);
  rmSync(dir, { recursive: true, force: true });
  return { stdout: result.stdout, signal: result.signal, reaped };
}

test("leaves the proxy to a graceful signal handler, reaping only at exit", () => {
  const { stdout, reaped } = signalChild(true);
  expect(stdout).toContain("graceful reaped=false");
  expect(reaped).toBe(true);
});

test("reaps and re-raises a signal nothing else handles", () => {
  const { signal, reaped } = signalChild(false);
  expect(reaped).toBe(true);
  expect(signal).toBe("SIGTERM");
});
