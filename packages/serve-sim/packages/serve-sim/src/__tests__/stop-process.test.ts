import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { stopProcess } from "../stop-process";

test("server shutdown waits for finalization and reports the child failure", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => setTimeout(() => process.exit(1), 800));
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    const started = Date.now();
    const result = await stopProcess(child.pid!, child, 2_000);
    expect(result).toEqual({ exitCode: 1, forced: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("server shutdown force-kills a child after the finalization deadline", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    expect((await stopProcess(child.pid!, child, 100)).forced).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
