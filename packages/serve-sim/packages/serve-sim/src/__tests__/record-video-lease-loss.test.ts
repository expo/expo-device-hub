import { expect, test } from "bun:test";
import { join } from "node:path";

for (const mode of ["transient", "transport", "definitive", "definitive-body-error", "definitive-body-pending", "signal", "pending-stop", "host-exit", "host-exit-failed", "ambiguous-stop-failed", "stop-missed-lease", "stop-rejected"]) {
  test(`recording lease recovery handles ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/record-video-lease-loss.child.ts")], {
      env: { ...process.env, LEASE_LOSS_CASE: mode }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      const line = stdout.split("\n").find(line => line.startsWith("LEASE_LOSS_RESULT "));
      const result = JSON.parse(line!.slice("LEASE_LOSS_RESULT ".length));
      if (mode === "transient" || mode === "transport") expect(result.puts).toBeGreaterThan(1);
      else expect(result.puts).toBe(1);
      expect(result.saved).toBe(mode !== "stop-rejected");
      if (!mode.startsWith("host-exit")) {
        if (mode === "ambiguous-stop-failed" || mode === "stop-missed-lease" || mode === "stop-rejected") expect(result.deletes).toBeGreaterThanOrEqual(1);
        else expect(result.deletes).toBe(1);
        if (mode === "transient" || mode === "transport") {
          expect(result.firstDeleteDelayMs).toBeGreaterThanOrEqual(15_000);
          expect(result.firstDeleteDelayMs).toBeLessThan(20_000);
        } else expect(result.firstDeleteDelayMs).toBeLessThan(5_000);
      }
      if (mode.startsWith("definitive")) expect(result.error).toContain("Recording ended before a stop was requested");
      else if (mode === "stop-rejected") expect(result.error).toContain("confirmed native stop error");
      else if (mode.endsWith("failed")) expect(result.error).toContain("Hardware encoder failed");
      else expect(result.error).toBeNull();
    } finally { clearTimeout(timer); child.kill(); }
  }, 15_000);
}
