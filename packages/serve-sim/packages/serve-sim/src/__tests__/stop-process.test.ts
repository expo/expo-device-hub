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
    expect(result).toEqual({ exitCode: 1, signalCode: null, forced: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("server shutdown reports an external SIGKILL during finalization", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), 800));
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    const stopping = stopProcess(child.pid!, child, 2_000);
    await Bun.sleep(100);
    child.kill("SIGKILL");
    expect(await stopping).toEqual({ exitCode: null, signalCode: "SIGKILL", forced: false });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("server shutdown force-kills an unresponsive child after the default grace", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    const started = Date.now();
    expect((await stopProcess(child.pid!, child)).forced).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
