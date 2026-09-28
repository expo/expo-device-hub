import { expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer } from "http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const cli = join(import.meta.dir, "../../dist/serve-sim.js");
const udid = "record-video-interruption-test";

async function interruptedStart(saveVideo: boolean, gated: boolean, stopStatus = 200): Promise<{ code: number | null; stdout: string; stderr: string; deletes: number; manifest: string }> {
  const root = mkdtempSync(join(tmpdir(), "record-video-cli-test-"));
  const state = join(root, "state");
  const bin = join(root, "bin");
  const output = join(root, "output");
  const manifest = join(output, "session.json");
  mkdirSync(state);
  mkdirSync(bin);
  // Keep the CLI's stale-device check inside this fixture. Otherwise, a booted
  // CI simulator makes it SIGTERM the test runner PID stored in the fake state.
  const xcrun = join(bin, "xcrun");
  writeFileSync(xcrun, `#!/bin/sh
case "$*" in
  "simctl list devices booted -j") ;;
  *) echo "unexpected xcrun call: $*" >&2; exit 1 ;;
esac
printf '%s\\n' '{"devices":{"test":[{"udid":"${udid}","state":"Booted"}]}}'
`);
  chmodSync(xcrun, 0o755);
  let postArrived: () => void = () => {};
  const posted = new Promise<void>(resolve => { postArrived = resolve; });
  let recordingId = "";
  let stoppedId = "";
  let authorization: string | undefined;
  let deletes = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      authorization = req.headers.authorization;
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      recordingId = (JSON.parse(body) as { recordingId: string }).recordingId;
      postArrived();
      if (stopStatus !== 200) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ recording: true }));
      }
      return;
    }
    if (req.method === "DELETE") {
      deletes++;
      stoppedId = String(req.headers["x-recording-id"]);
      if (stopStatus !== 200) {
        res.writeHead(stopStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "recording_stop_failed" }));
        return;
      }
      if (saveVideo) {
        mkdirSync(output);
        writeFileSync(join(output, "recording.mp4"), "saved recording");
        writeFileSync(manifest, "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ manifest }));
      } else {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cancelled: true }));
      }
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  const port = address.port;
  writeFileSync(join(state, `server-${udid}.json`), JSON.stringify({
    pid: process.pid, port, device: udid, ...(gated ? { token: "test-token" } : {}),
    url: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  }));
  const child = spawn("node", [cli, "record-video", "--udid", udid, "--output", output], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SERVE_SIM_STATE_DIR: state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await Promise.race([
      posted,
      Bun.sleep(10_000).then(() => { throw new Error(`start POST did not arrive: ${stderr}`); }),
    ]);
    if (stopStatus !== 200) {
      await Promise.race([
        (async () => { while (!stderr.includes("serve-sim:recording-started")) await Bun.sleep(10); })(),
        Bun.sleep(10_000).then(() => { throw new Error(`recording did not start: ${stderr}`); }),
      ]);
    }
    child.kill("SIGINT");
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      }),
      Bun.sleep(10_000).then(() => { throw new Error(`record-video did not exit: ${stderr}`); }),
    ]);
    expect(stoppedId).toBe(recordingId);
    expect(authorization).toBe(gated ? "Bearer test-token" : undefined);
    expect(existsSync(manifest)).toBe(saveVideo);
    return { code, stdout, stderr, deletes, manifest };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("record-video works without a token and reports a saved recording when SIGINT interrupts its start response", async () => {
  const result = await interruptedStart(true, false);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(result.manifest);
  expect(result.deletes).toBe(1);
}, 20_000);

test("record-video uses the token and reports cancellation when SIGINT arrives before a recording exists", async () => {
  const result = await interruptedStart(false, true);
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain(result.manifest);
  expect(result.deletes).toBe(1);
}, 20_000);

test("record-video reports a definite stop failure without waiting for a manifest", async () => {
  const result = await interruptedStart(false, false, 500);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Recording stop failed (500)");
  expect(result.deletes).toBeGreaterThan(0);
}, 20_000);
