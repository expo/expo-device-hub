import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

import { recordingShutdownGraceMs, stopForStreamReplacement, stopProcess } from "../stop-process";
import { useTempStateDir } from "./helpers";

test("shutdown extends its grace only when the helper reports an active recording", async () => {
  let active = true;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}/recording/video`;
    expect(await recordingShutdownGraceMs(url)).toBe(65_000);
    active = false;
    expect(await recordingShutdownGraceMs(url)).toBe(500);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("stream replacement waits for recording and returns its shutdown error", async () => {
  const stateDir = useTempStateDir();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"active":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      setTimeout(() => {
        fs.writeFileSync(require("node:path").join(process.env.SERVE_SIM_STATE_DIR,
          "recording-shutdown-failed-" + process.pid + ".json"),
          JSON.stringify({ errors: ["MP4 finalization failed"] }));
        process.exit(1);
      }, 100);
    });
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    const replacement = await stopForStreamReplacement({
      pid: child.pid!, device: "replacement-test", port: address.port,
      url: `http://127.0.0.1:${address.port}`,
      streamUrl: `http://127.0.0.1:${address.port}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    });
    expect(replacement.forced).toBe(false);
    expect(replacement.recordingError).toContain("MP4 finalization failed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    server.close();
    stateDir.restore();
  }
});

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
