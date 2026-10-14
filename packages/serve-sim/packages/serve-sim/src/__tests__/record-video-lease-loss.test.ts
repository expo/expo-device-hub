import { expect, test } from "bun:test";
import { join } from "node:path";

for (const mode of ["transient", "signal", "host-exit"]) {
  test(`lease failure ${mode} stops heartbeats and reconciles owned finalization promptly`, async () => {
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
      expect(result.puts).toBe(1);
      expect(result.saved).toBe(true);
      if (mode !== "host-exit") {
        expect(result.deletes).toBe(1);
        expect(result.firstDeleteDelayMs).toBeLessThan(5_000);
      }
      if (mode === "transient") expect(result.error).toContain("Recording ended before a stop was requested");
      else expect(result.error).toBeNull();
    } finally { clearTimeout(timer); child.kill(); }
  }, 15_000);
}
