import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { GuestMetricsRecorder } from "./guest-metrics";

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
interface CaptureDeps {
  isVm(): Promise<boolean>;
  start(path: string): Promise<{ finishAsync(): Promise<string> }>;
  wait(ms: number): Promise<unknown>;
}
const defaults: CaptureDeps = {
  async isVm() {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { timeout: 5000 });
    return stdout.trim() === "1";
  },
  start: (path) => GuestMetricsRecorder.startAsync(path),
  wait: delay,
};

/** Expected refusals contain only fixed, safe-to-return diagnostics. */
export class GuestProfileCaptureError extends Error {}

/** One bounded collection across all control sockets in this preview process. */
export class GuestProfileCapture {
  private active = false;
  constructor(private readonly deps: CaptureDeps = defaults) {}

  async capture(seconds: number): Promise<string> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error("Profile duration must be 1-30 seconds");
    if (this.active) throw new GuestProfileCaptureError("A guest profile is already running");
    this.active = true;
    let directory: string | undefined;
    try {
      if (!(await this.deps.isVm())) throw new GuestProfileCaptureError("Remote guest profiling requires a VM");
      directory = await mkdtemp(join(tmpdir(), "serve-sim-guest-profile-"));
      const path = join(directory, "guest.ndjson");
      const recorder = await this.deps.start(path);
      try { await this.deps.wait(seconds * 1000); }
      finally { await recorder.finishAsync(); }
      if ((await stat(path)).size > MAX_RESPONSE_BYTES) throw new GuestProfileCaptureError("Guest profile exceeds the 16 MiB response limit; use a shorter duration");
      return await readFile(path, "utf8");
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.active = false; }
    }
  }
}

export const guestProfileCapture = new GuestProfileCapture();
