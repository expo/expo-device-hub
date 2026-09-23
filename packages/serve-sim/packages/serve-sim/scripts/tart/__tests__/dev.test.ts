import { spawn } from "bun";
import { describe, expect, test } from "bun:test";
import { guestPreviewScript, waitGone } from "../dev";
import { shellEscape, SSH_OPTS, sshTunnelArgs } from "../guest";

describe("tart-dev", () => {
  test("guest preview cds to the share and runs bun dev.ts", () => {
    const share = "/Volumes/My Shared Files/serve-sim/packages/serve-sim";
    const script = guestPreviewScript(share, 3200);
    expect(script).toContain(`cd ${shellEscape(share)}`);
    expect(script).toContain("exec bun run dev.ts");
    expect(script).toContain("export PORT=3200");
    expect(script).not.toContain("simpb");
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("bun install");
  });

  test("tunnels guest loopback onto the host port", () => {
    expect(sshTunnelArgs("expo@192.168.64.4", 3200, 3200)).toEqual([
      "ssh",
      ...SSH_OPTS,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "3200:127.0.0.1:3200",
      "expo@192.168.64.4",
    ]);
  });
});

describe("waitGone", () => {
  test("returns once both children are gone", async () => {
    const serve = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const tunnel = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    serve.kill("SIGTERM");
    tunnel.kill("SIGTERM");

    const started = Date.now();
    await waitGone(serve, tunnel, 1000);

    expect(Date.now() - started).toBeLessThan(500);
    expect(serve.signalCode).toBe("SIGTERM");
    expect(tunnel.signalCode).toBe("SIGTERM");
  });

  test("kills a child that ignores SIGTERM", async () => {
    const ignoresTerm = 'trap "" TERM; echo armed; while :; do sleep 0.2; done';
    const serve = spawn(["bash", "-c", ignoresTerm], { stdout: "pipe", stderr: "ignore" });
    const armed = serve.stdout.getReader();
    await armed.read();
    armed.releaseLock();
    const tunnel = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    serve.kill("SIGTERM");
    tunnel.kill("SIGTERM");

    await waitGone(serve, tunnel, 200);

    expect(serve.signalCode).toBe("SIGKILL");
    expect(tunnel.signalCode).toBe("SIGTERM");
  });
});
