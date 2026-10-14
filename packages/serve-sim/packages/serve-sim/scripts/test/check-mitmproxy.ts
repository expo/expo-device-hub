import { spawn } from "node:child_process";
import { once } from "node:events";
import { locateMitmdump, mitmdumpMissingMessage } from "../../src/capture/mitm-engine";

export async function checkMitmproxy(timeoutMs = 60_000): Promise<void> {
  const binary = locateMitmdump();
  if (!binary) throw new Error(mitmdumpMissingMessage(process.env.SERVE_SIM_MITMDUMP));
  const child = spawn(binary, ["--version"], {
    detached: true, stdio: ["ignore", "inherit", "inherit"], timeout: timeoutMs, killSignal: "SIGKILL",
  });
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => {
      stop();
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    // Cleanup must run before a caller's handler can exit the process.
    process.prependListener(signal, handler);
    return [signal, handler] as const;
  });
  try {
    const [status, signal] = await once(child, "exit");
    if (status !== 0) throw new Error(`mitmdump at ${binary} exited with ${signal ?? status}.`);
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    stop();
  }
}

if (import.meta.main) {
  try {
    await checkMitmproxy();
  } catch (error) {
    console.error(`Capture test prerequisite failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
